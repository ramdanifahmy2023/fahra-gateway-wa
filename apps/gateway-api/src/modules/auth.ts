import { randomUUID } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sha256, withTransaction } from "@ocgw/shared";
import { ApiError } from "../errors.js";
import { writeAudit } from "../audit.js";
import {
  createAccessToken,
  issueRefreshToken,
  requireAdmin,
  tokenMetadata,
} from "../security.js";

const loginSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
});
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(512) });
const changeSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "Password baru harus berbeda",
  });

const dummyHashPromise = hash("ocgw-invalid-user-timing-equalizer", {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  force_password_change: boolean;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
};

function normalizeUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    forcePasswordChange: row.force_password_change,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const input = loginSchema.parse(request.body);
      const result = await app.context.db.query<UserRow>(
        "SELECT * FROM admin_users WHERE lower(email) = $1",
        [input.email],
      );
      const user = result.rows[0];
      const candidateHash = user?.password_hash ?? (await dummyHashPromise);
      const passwordValid = await verify(candidateHash, input.password).catch(
        () => false,
      );
      const locked = Boolean(
        user?.locked_until &&
        new Date(user.locked_until).getTime() > Date.now(),
      );
      if (!user || !user.is_active || !passwordValid || locked) {
        if (user && !locked) {
          await withTransaction(app.context.db, async (client) => {
            await client.query(
              `UPDATE admin_users SET failed_login_attempts=failed_login_attempts+1,locked_until=CASE WHEN failed_login_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now() WHERE id=$1`,
              [user.id],
            );
            await writeAudit(client, request, {
              action: "auth.login_failed",
              resourceType: "admin_user",
              resourceId: user.id,
              metadata: { email: input.email },
              actorType: "anonymous",
              result: "denied",
            });
          });
        } else {
          await writeAudit(app.context.db, request, {
            action: "auth.login_failed",
            resourceType: "admin_user",
            ...(user ? { resourceId: user.id } : {}),
            metadata: { email: input.email },
            actorType: "anonymous",
            result: "denied",
          });
        }
        throw new ApiError(401, "LOGIN_INVALID", "Email atau password salah");
      }
      const principal = normalizeUser(user);
      const accessToken = await createAccessToken(
        principal,
        app.context.env.JWT_SECRET,
      );
      const refresh = await withTransaction(app.context.db, async (client) => {
        await client.query(
          `UPDATE admin_users SET failed_login_attempts=0,locked_until=NULL,last_login_at=now(),updated_at=now() WHERE id=$1`,
          [user.id],
        );
        const issued = await issueRefreshToken(client, user.id);
        await writeAudit(client, request, {
          action: "auth.login",
          resourceType: "admin_user",
          resourceId: user.id,
          actorType: "admin",
          actorId: user.id,
        });
        return issued;
      });
      return {
        data: {
          accessToken,
          refreshToken: refresh.token,
          expiresIn: tokenMetadata.accessExpiresInSeconds,
          refreshExpiresIn: tokenMetadata.refreshExpiresInSeconds,
          user: principal,
        },
      };
    },
  );

  app.post(
    "/api/v1/auth/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request) => {
      const input = refreshSchema.parse(request.body);
      const response = await withTransaction(app.context.db, async (client) => {
        const result = await client.query<{
          id: string;
          user_id: string;
          family_id: string | null;
          expires_at: Date;
          revoked_at: Date | null;
          replaced_by: string | null;
          email: string;
          force_password_change: boolean;
          is_active: boolean;
        }>(
          `SELECT t.id,t.user_id,t.family_id,t.expires_at,t.revoked_at,t.replaced_by,u.email,u.force_password_change,u.is_active
         FROM admin_refresh_tokens t JOIN admin_users u ON u.id=t.user_id
         WHERE t.token_hash=$1 FOR UPDATE OF t`,
          [sha256(input.refreshToken)],
        );
        const row = result.rows[0];
        if (!row) return { invalid: true as const };
        if (row.revoked_at) {
          if (row.family_id) {
            await client.query(
              `UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,'reuse_detected') WHERE family_id=$1`,
              [row.family_id],
            );
            await writeAudit(client, request, {
              action: "auth.refresh_reuse_detected",
              resourceType: "admin_user",
              resourceId: row.user_id,
              result: "denied",
              metadata: { familyId: row.family_id },
            });
          }
          return { invalid: true as const };
        }
        if (
          new Date(row.expires_at).getTime() <= Date.now() ||
          !row.is_active
        ) {
          await client.query(
            `UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,'expired_or_inactive') WHERE id=$1`,
            [row.id],
          );
          return { invalid: true as const };
        }
        const principal = {
          id: row.user_id,
          email: row.email,
          forcePasswordChange: row.force_password_change,
        };
        const next = await issueRefreshToken(
          client,
          row.user_id,
          row.family_id ?? randomUUID(),
        );
        await client.query(
          `UPDATE admin_refresh_tokens SET revoked_at=now(),revoke_reason='rotated',replaced_by=$2,last_used_at=now() WHERE id=$1`,
          [row.id, next.id],
        );
        return {
          invalid: false as const,
          accessToken: await createAccessToken(
            principal,
            app.context.env.JWT_SECRET,
          ),
          refreshToken: next.token,
          expiresIn: tokenMetadata.accessExpiresInSeconds,
          refreshExpiresIn: tokenMetadata.refreshExpiresInSeconds,
          user: principal,
        };
      });
      if (response.invalid)
        throw new ApiError(
          401,
          "REFRESH_INVALID",
          "Refresh token tidak valid, kedaluwarsa, atau telah digunakan",
        );
      return { data: response };
    },
  );

  app.post("/api/v1/auth/logout", async (request) => {
    const input = refreshSchema.parse(request.body);
    await withTransaction(app.context.db, async (client) => {
      await client.query(
        `UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,'logout') WHERE token_hash=$1`,
        [sha256(input.refreshToken)],
      );
      await writeAudit(client, request, {
        action: "auth.logout",
        resourceType: "admin_session",
      });
    });
    return { data: { loggedOut: true } };
  });

  app.get("/api/v1/auth/me", { preHandler: requireAdmin }, async (request) => ({
    data: { user: request.admin },
  }));

  app.post(
    "/api/v1/auth/change-password",
    { preHandler: requireAdmin },
    async (request) => {
      const input = changeSchema.parse(request.body);
      const admin = request.admin;
      if (!admin)
        throw new ApiError(401, "AUTH_REQUIRED", "Autentikasi diperlukan");
      const userId = admin.id;
      const current = await app.context.db.query<{ password_hash: string }>(
        "SELECT password_hash FROM admin_users WHERE id=$1",
        [userId],
      );
      const existingHash = current.rows[0]?.password_hash;
      if (
        !existingHash ||
        !(await verify(existingHash, input.currentPassword))
      ) {
        throw new ApiError(
          400,
          "PASSWORD_CURRENT_INVALID",
          "Password saat ini salah",
        );
      }
      const passwordHash = await hash(input.newPassword, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
        outputLen: 32,
      });
      const refresh = await withTransaction(app.context.db, async (client) => {
        await client.query(
          `UPDATE admin_users SET password_hash=$2,force_password_change=false,password_changed_at=now(),updated_at=now() WHERE id=$1`,
          [userId, passwordHash],
        );
        await client.query(
          "UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1",
          [userId],
        );
        await writeAudit(client, request, {
          action: "auth.password_changed",
          resourceType: "admin_user",
          resourceId: userId,
        });
        return issueRefreshToken(client, userId);
      });
      const principal = {
        id: userId,
        email: admin.email,
        forcePasswordChange: false,
      };
      return {
        data: {
          changed: true,
          accessToken: await createAccessToken(
            principal,
            app.context.env.JWT_SECRET,
          ),
          refreshToken: refresh.token,
          expiresIn: tokenMetadata.accessExpiresInSeconds,
          refreshExpiresIn: tokenMetadata.refreshExpiresInSeconds,
          requestId: request.id,
        },
      };
    },
  );
}

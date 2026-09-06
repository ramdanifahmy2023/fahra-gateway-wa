import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { constantTimeEqual, sha256 } from "@ocgw/shared";
import type { AppContext, AdminPrincipal } from "./types.js";
import { ApiError } from "./errors.js";

const accessTtlSeconds = 15 * 60;
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

function jwtKey(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
}

export async function createAccessToken(
  principal: AdminPrincipal,
  secret: string,
): Promise<string> {
  return new SignJWT({
    email: principal.email,
    fpc: principal.forcePasswordChange,
    role: "admin",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(principal.id)
    .setIssuer("openclaw-whatsapp-gateway")
    .setAudience("openclaw-dashboard")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${accessTtlSeconds}s`)
    .sign(jwtKey(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AdminPrincipal> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(secret), {
      issuer: "openclaw-whatsapp-gateway",
      audience: "openclaw-dashboard",
      algorithms: ["HS256"],
    });
    if (!payload.sub || typeof payload.email !== "string")
      throw new Error("invalid claims");
    return {
      id: payload.sub,
      email: payload.email,
      forcePasswordChange: payload.fpc === true,
    };
  } catch {
    throw new ApiError(
      401,
      "TOKEN_INVALID",
      "Token akses tidak valid atau kedaluwarsa",
    );
  }
}

export async function issueRefreshToken(
  db: Pool | PoolClient,
  userId: string,
  familyId: string = randomUUID(),
): Promise<{ id: string; token: string; expiresAt: Date; familyId: string }> {
  const id = randomUUID();
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + refreshTtlMs);
  await db.query(
    `INSERT INTO admin_refresh_tokens (id, user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, familyId, sha256(token), expiresAt],
  );
  return { id, token, expiresAt, familyId };
}

export async function requireAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const context = request.server.context as AppContext;
  const token = bearer(request);
  if (!token)
    throw new ApiError(401, "AUTH_REQUIRED", "Autentikasi admin diperlukan");
  const principal = await verifyAccessToken(token, context.env.JWT_SECRET);
  const row = await context.db.query<{
    is_active: boolean;
    force_password_change: boolean;
  }>("SELECT is_active, force_password_change FROM admin_users WHERE id = $1", [
    principal.id,
  ]);
  if (!row.rows[0]?.is_active)
    throw new ApiError(401, "ACCOUNT_INACTIVE", "Akun admin tidak aktif");
  request.admin = {
    ...principal,
    forcePasswordChange: row.rows[0].force_password_change,
  };
  request.authType = "admin";
}

export async function requireAdminReady(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAdmin(request, reply);
  if (request.admin?.forcePasswordChange) {
    throw new ApiError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "Password wajib diubah sebelum melanjutkan",
    );
  }
}

export async function requireInternal(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const context = request.server.context as AppContext;
  const header = request.headers["x-internal-api-key"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !constantTimeEqual(provided, context.env.INTERNAL_API_KEY)) {
    throw new ApiError(
      401,
      "INTERNAL_AUTH_INVALID",
      "Internal API key tidak valid",
    );
  }
  const remote = request.ip.replace(/^::ffff:/, "");
  if (
    !["127.0.0.1", "::1"].includes(remote) &&
    context.env.NODE_ENV === "production"
  ) {
    throw new ApiError(
      403,
      "LOOPBACK_REQUIRED",
      "Internal API hanya menerima koneksi loopback",
    );
  }
  request.authType = "internal";
}

export const tokenMetadata = {
  accessExpiresInSeconds: accessTtlSeconds,
  refreshExpiresInSeconds: refreshTtlMs / 1000,
};

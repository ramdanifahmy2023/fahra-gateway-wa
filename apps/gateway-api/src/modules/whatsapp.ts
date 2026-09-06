import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { enqueueJob, withTransaction } from "@ocgw/shared";
import { requireAdminReady } from "../security.js";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";

const actionSchema = z.object({
  action: z.enum(["connect", "disconnect", "restart", "logout", "sync-groups"]),
});

async function readQr(
  app: FastifyInstance,
): Promise<{ qr: string; expiresAt: string } | null> {
  try {
    const parsed = JSON.parse(
      await readFile(
        join(app.context.env.dataDir, "whatsapp", "qr.json"),
        "utf8",
      ),
    ) as { qr?: unknown; expiresAt?: unknown };
    if (typeof parsed.qr !== "string" || typeof parsed.expiresAt !== "string")
      return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return { qr: parsed.qr, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function registerWhatsAppRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/v1/whatsapp/status",
    { preHandler: requireAdminReady },
    async () => {
      const [result, session] = await Promise.all([
        app.context.db.query(
          `SELECT status,phone_number,jid,last_connected_at,last_disconnected_at,last_error,reconnect_attempt,updated_at
           FROM whatsapp_connection ORDER BY updated_at DESC LIMIT 1`,
        ),
        app.context.db.query<{ has_session: boolean; updated_at: Date | null }>(
          `SELECT EXISTS(SELECT 1 FROM whatsapp_auth_state) AS has_session,
                  MAX(updated_at) AS updated_at
             FROM whatsapp_auth_state`,
        ),
      ]);
      const qr = await readQr(app);
      const sessionState = session.rows[0];
      return {
        data: {
          connection: result.rows[0] ?? { status: "disconnected" },
          hasSession: sessionState?.has_session ?? false,
          sessionUpdatedAt: sessionState?.updated_at ?? null,
          qrAvailable: Boolean(qr),
          qrExpiresAt: qr?.expiresAt ?? null,
        },
      };
    },
  );

  app.get(
    "/api/v1/whatsapp/qr",
    { preHandler: requireAdminReady },
    async () => {
      const qr = await readQr(app);
      if (!qr)
        throw new ApiError(
          404,
          "QR_NOT_AVAILABLE",
          "QR belum tersedia atau sudah kedaluwarsa",
        );
      const dataUrl = await QRCode.toDataURL(qr.qr, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 360,
      });
      return { data: { dataUrl, expiresAt: qr.expiresAt } };
    },
  );

  app.post(
    "/api/v1/whatsapp/actions",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = actionSchema.parse(request.body);
      const id = await withTransaction(app.context.db, async (client) => {
        const jobId = await enqueueJob(client, {
          queue: "whatsapp-control",
          type: input.action,
          payload: {
            requestedBy: request.admin?.id,
            requestedAt: new Date().toISOString(),
          },
          dedupeKey: `wa-control:${input.action}:${Math.floor(Date.now() / 10_000)}`,
          maxAttempts: 5,
        });
        await writeAudit(client, request, {
          action: `whatsapp.${input.action}`,
          resourceType: "whatsapp_connection",
          resourceId: jobId,
        });
        return jobId;
      });
      return reply.code(202).send({ data: { jobId: id, accepted: true } });
    },
  );

  app.get(
    "/api/v1/groups",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = z
        .object({
          search: z.string().max(100).optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);
      const params: unknown[] = [];
      const where = query.search
        ? (params.push(`%${query.search}%`),
          `WHERE name ILIKE $${params.length}`)
        : "";
      params.push(query.limit, (query.page - 1) * query.limit);
      const result = await app.context.db.query(
        `SELECT jid,name,participant_count,agent_is_participant,last_synced_at,created_at,updated_at,
       count(*) OVER()::int AS total FROM whatsapp_groups ${where} ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const total = Number(result.rows[0]?.total ?? 0);
      return {
        data: result.rows.map(({ total: _total, ...row }) => row),
        meta: { page: query.page, limit: query.limit, total },
      };
    },
  );
  app.post(
    "/api/v1/groups/sync",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const id = await withTransaction(app.context.db, async (client) => {
        const jobId = await enqueueJob(client, {
          queue: "whatsapp-control",
          type: "sync-groups",
          payload: {
            requestedBy: request.admin?.id,
            requestedAt: new Date().toISOString(),
          },
          dedupeKey: `sync-groups:${Math.floor(Date.now() / 10_000)}`,
          maxAttempts: 5,
        });
        await writeAudit(client, request, {
          action: "whatsapp.groups_sync",
          resourceType: "whatsapp_group",
          resourceId: jobId,
        });
        return jobId;
      });
      return reply.code(202).send({ data: { jobId: id, status: "queued" } });
    },
  );
}

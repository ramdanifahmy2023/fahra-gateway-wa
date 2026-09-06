import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { requireAdminReady } from "../security.js";

const textSchema = z.object({
  text: z.string().trim().min(1).max(700),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#25D366"),
  font: z.number().int().min(0).max(5).default(1),
});

const mediaSchema = z.object({
  uploadId: z.uuid(),
  type: z.enum(["image", "video"]),
  caption: z.string().trim().max(700).optional(),
});

function baileysEndpoint(app: FastifyInstance, path: string): URL {
  const host = app.context.env.BAILEYS_HEALTH_HOST === "::1"
    ? "[::1]"
    : app.context.env.BAILEYS_HEALTH_HOST;
  return new URL(
    path,
    `http://${host}:${app.context.env.BAILEYS_HEALTH_PORT}`,
  );
}

function responseMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === "string") return error.message;
  }
  return undefined;
}

export function parseAcceptedStatusResponse(
  payload: unknown,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(502, "STATUS_RESPONSE_INVALID", "Respons Baileys tidak valid");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") {
    throw new ApiError(502, "STATUS_RESPONSE_INVALID", "Identitas Status tidak tersedia");
  }
  const result = data as Record<string, unknown>;
  if (
    result.status !== "accepted" ||
    result.remoteJid !== "status@broadcast" ||
    typeof result.waMessageId !== "string" ||
    result.waMessageId.length === 0 ||
    typeof result.audienceCount !== "number" ||
    result.audienceCount < 1
  ) {
    throw new ApiError(502, "STATUS_RESPONSE_INVALID", "Baileys tidak mengonfirmasi Status secara lengkap");
  }
  return result;
}

async function postToBaileys(
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(baileysEndpoint(app, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-api-key": app.context.env.INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new ApiError(
      502,
      "STATUS_SEND_AMBIGUOUS",
      "Koneksi ke service Baileys terputus. Status tidak dicoba ulang otomatis karena hasil pengiriman ambigu.",
      { cause: error instanceof Error ? error.message : "connection failed" },
    );
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new ApiError(
      response.status >= 500 ? 502 : response.status,
      "STATUS_SEND_FAILED",
      responseMessage(payload) ?? `Baileys menolak Status (HTTP ${response.status})`,
    );
  }
  return parseAcceptedStatusResponse(payload);
}

async function auditAccepted(
  app: FastifyInstance,
  request: FastifyRequest,
  type: "text" | "image" | "video",
  result: Record<string, unknown>,
  uploadId?: string,
): Promise<void> {
  await writeAudit(app.context.db, request, {
    action: `whatsapp.status_${type}_sent`,
    resourceType: "whatsapp_status",
    ...(uploadId ? { resourceId: uploadId } : {}),
    metadata: {
      type,
      audienceCount: result.audienceCount,
      remoteJid: "status@broadcast",
    },
  });
}

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/status/text",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = textSchema.parse(request.body);
      const result = await postToBaileys(app, "/internal/status/text", input);
      await auditAccepted(app, request, "text", result);
      return reply.code(202).send({ data: result });
    },
  );

  app.post(
    "/api/v1/status/media",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = mediaSchema.parse(request.body);
      const upload = await app.context.db.query<{
        stored_name: string;
        mime_type: string;
      }>(
        `UPDATE uploads
            SET status='consumed',expires_at=NULL
          WHERE id=$1 AND status='pending'
        RETURNING stored_name,mime_type`,
        [input.uploadId],
      );
      const file = upload.rows[0];
      if (!file) {
        const exists = await app.context.db.query(
          `SELECT 1 FROM uploads WHERE id=$1`,
          [input.uploadId],
        );
        if (!exists.rowCount)
          throw new ApiError(404, "UPLOAD_NOT_FOUND", "Upload tidak ditemukan");
        throw new ApiError(409, "UPLOAD_ALREADY_USED", "Upload ini sudah pernah dipakai");
      }
      const allowed =
        input.type === "image"
          ? ["image/jpeg", "image/png", "image/webp"]
          : ["video/mp4"];
      if (!allowed.includes(file.mime_type)) {
        throw new ApiError(
          415,
          "STATUS_MEDIA_TYPE_INVALID",
          input.type === "image"
            ? "Status gambar hanya menerima JPEG, PNG, atau WebP"
            : "Status video hanya menerima MP4",
        );
      }
      const result = await postToBaileys(
        app,
        input.type === "image"
          ? "/internal/status/image"
          : "/internal/status/video",
        {
          filePath: file.stored_name,
          mimeType: file.mime_type,
          ...(input.caption ? { caption: input.caption } : {}),
        },
      );
      await auditAccepted(app, request, input.type, result, input.uploadId);
      return reply.code(202).send({ data: result });
    },
  );
}

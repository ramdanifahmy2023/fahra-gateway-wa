import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { enqueueJob, withTransaction } from "@ocgw/shared";
import { requireAdminReady, requireInternal } from "../security.js";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { validateUploadContent } from "../upload-policy.js";

const textMessage = z.object({
  to: z.string().min(5).max(100),
  type: z.literal("text").default("text"),
  text: z.string().min(1).max(65_536),
  replyTo: z.string().min(1).max(200).optional(),
  replyToParticipant: z.string().min(1).max(200).optional(),
});
const mediaMessage = z.object({
  to: z.string().min(5).max(100),
  type: z.enum(["image", "document", "video"]),
  uploadId: z.uuid(),
  caption: z.string().max(4096).optional(),
  fileName: z.string().max(255).optional(),
  voiceNote: z.never().optional(),
  replyTo: z.string().min(1).max(200).optional(),
  replyToParticipant: z.string().min(1).max(200).optional(),
});
const audioMessage = z.object({
  to: z.string().min(5).max(100),
  type: z.literal("audio"),
  uploadId: z.uuid(),
  voiceNote: z.boolean().default(false),
  caption: z.never().optional(),
  fileName: z.string().max(255).optional(),
  replyTo: z.string().min(1).max(200).optional(),
  replyToParticipant: z.string().min(1).max(200).optional(),
});
const sendSchema = z.discriminatedUnion("type", [
  textMessage,
  mediaMessage,
  audioMessage,
]);
const reactionSchema = z
  .object({ emoji: z.string().max(32).nullable().optional() })
  .strict();
const typingSchema = z
  .object({ durationSeconds: z.coerce.number().int().min(1).max(15) })
  .strict();
export type OutboundMessageInput = z.infer<typeof sendSchema>;

export function parseOutboundMessage(value: unknown): OutboundMessageInput {
  return sendSchema.parse(value);
}

export function outboundQueueType(type: OutboundMessageInput["type"]): string {
  if (type === "text") return "send-text";
  if (type === "image") return "send-image";
  if (type === "video") return "send-video";
  if (type === "audio") return "send-audio";
  return "send-document";
}

function textBody(input: OutboundMessageInput): string | null {
  if (input.type === "text") return input.text;
  if (input.type === "audio") return null;
  return input.caption ?? null;
}

export function normalizeReactionEmoji(value: unknown): string | null {
  const emoji = reactionSchema.parse({ emoji: value }).emoji?.trim() ?? "";
  if (emoji === "") return null;
  const pictographic = /\p{Extended_Pictographic}/u.test(emoji);
  const regionalFlag = /^\p{Regional_Indicator}{2}$/u.test(emoji);
  const keycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(emoji);
  const emojiOnly = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3|[#*0-9])+$/u.test(
    emoji,
  );
  if ((!pictographic && !regionalFlag && !keycap) || !emojiOnly) {
    throw new ApiError(422, "REACTION_INVALID", "Reaction wajib berupa emoji");
  }
  return emoji;
}

export function parseTypingDuration(value: unknown): number {
  return typingSchema.parse(value).durationSeconds;
}

const receiptStatuses = [
  "sent",
  "delivered",
  "read",
  "failed",
  "retrying",
  "dead",
] as const;

export function aggregateReceiptTotals(
  rows: ReadonlyArray<{ status: string; count: number | string }>,
): Record<(typeof receiptStatuses)[number], number> {
  const totals = Object.fromEntries(
    receiptStatuses.map((status) => [status, 0]),
  ) as Record<(typeof receiptStatuses)[number], number>;
  for (const row of rows) {
    const status = row.status === "dead_letter" ? "dead" : row.status;
    if (!receiptStatuses.includes(status as (typeof receiptStatuses)[number])) {
      continue;
    }
    const count = Number(row.count);
    if (Number.isFinite(count) && count > 0) {
      totals[status as (typeof receiptStatuses)[number]] += count;
    }
  }
  return totals;
}

export function safeQueueFailureReason(value: unknown): string {
  const error = typeof value === "string" ? value.toLowerCase() : "";
  if (/disconnect|not connected|connection/.test(error))
    return "WhatsApp terputus saat job diproses.";
  if (/timeout|timed out|aborted/.test(error))
    return "Pemrosesan melewati batas waktu.";
  if (/media|mime|upload|file|path/.test(error))
    return "Media tidak valid atau tidak dapat dibaca.";
  if (/unsupported|not supported/.test(error))
    return "Tipe aksi tidak didukung oleh worker.";
  if (/target|message id|jid/.test(error))
    return "Target pesan WhatsApp tidak lagi tersedia.";
  if (/rate|429|throttl/.test(error))
    return "WhatsApp membatasi laju pengiriman sementara.";
  return "Job gagal. Periksa log operasional internal untuk detail aman.";
}

export function validateOutboundMediaType(
  input: Exclude<OutboundMessageInput, { type: "text" }>,
  mimeType: string,
): void {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]!.trim();
  if (input.type === "video" && normalized !== "video/mp4") {
    throw new ApiError(422, "MEDIA_TYPE_INVALID", "Video wajib memakai format MP4");
  }
  if (input.type === "audio") {
    if (!new Set(["audio/ogg", "audio/mpeg"]).has(normalized)) {
      throw new ApiError(
        422,
        "MEDIA_TYPE_INVALID",
        "Audio wajib memakai format OGG Opus atau MP3",
      );
    }
    if (input.voiceNote && normalized !== "audio/ogg") {
      throw new ApiError(
        422,
        "VOICE_NOTE_FORMAT_INVALID",
        "Voice note wajib memakai format OGG Opus",
      );
    }
  }
}

export function normalizeJid(value: string): string {
  const trimmed = value.trim();
  if (
    /^[\d-]+@g\.us$/.test(trimmed) ||
    /^\d+@(s\.whatsapp\.net|lid)$/.test(trimmed)
  )
    return trimmed;
  if (trimmed.includes("@") || !/^\+?[\d\s().-]+$/.test(trimmed)) {
    throw new ApiError(
      422,
      "JID_INVALID",
      "Nomor atau JID WhatsApp tidak valid",
    );
  }
  const phone = trimmed.replace(/^\+/, "").replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    throw new ApiError(
      422,
      "JID_INVALID",
      "Nomor atau JID WhatsApp tidak valid",
    );
  return `${phone}@s.whatsapp.net`;
}

export async function queueOutboundMessage(
  app: FastifyInstance,
  input: OutboundMessageInput,
  options: {
    idempotencyKey?: string;
    actor?: string;
    request?: FastifyRequest;
  } = {},
): Promise<{ messageId: string; jobId: string }> {
  const remoteJid = normalizeJid(input.to);
  const messageId = randomUUID();
  let file:
    | { stored_name: string; original_name: string; mime_type: string }
    | undefined;
  return withTransaction(app.context.db, async (client) => {
    if (options.idempotencyKey) {
      // Serialize the check-and-create section so two concurrent retries with
      // the same key both receive the same logical message instead of one
      // request failing on the partial unique index.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [options.idempotencyKey, 712_209_447],
      );
      const existing = await client.query<{
        id: string;
        queue_job_id: string | null;
        remote_jid: string;
        message_type: string;
        text_body: string | null;
        media: Record<string, unknown>;
        payload: Record<string, unknown>;
      }>(
        `SELECT id,queue_job_id,remote_jid,message_type,text_body,media,payload
         FROM whatsapp_messages WHERE idempotency_key=$1 AND direction='outbound'`,
        [options.idempotencyKey],
      );
      const existingMessage = existing.rows[0];
      if (existingMessage) {
        const sameRequest =
          existingMessage.remote_jid === remoteJid &&
          existingMessage.message_type === input.type &&
          existingMessage.text_body === textBody(input) &&
          (existingMessage.payload?.replyTo ?? null) ===
            (input.replyTo ?? null) &&
          (existingMessage.payload?.replyToParticipant ?? null) ===
            (input.replyToParticipant ?? null) &&
          (input.type === "text" ||
            (existingMessage.media?.uploadId === input.uploadId &&
              existingMessage.media?.fileName ===
                (input.fileName ?? existingMessage.media?.originalName) &&
              (input.type !== "audio" ||
                Boolean(existingMessage.media?.voiceNote) === input.voiceNote)));
        if (!sameRequest) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key sudah digunakan untuk payload pesan yang berbeda",
          );
        }
        if (!existingMessage.queue_job_id) {
          throw new ApiError(
            409,
            "MESSAGE_QUEUE_MISSING",
            "Pesan idempotent ada tetapi antreannya tidak dapat dipulihkan otomatis",
          );
        }
        return {
          messageId: existingMessage.id,
          jobId: existingMessage.queue_job_id,
        };
      }
    }
    await assertContactOutboundAllowed(client, remoteJid);
    if (input.type !== "text") {
      const result = await client.query<{
        stored_name: string;
        original_name: string;
        mime_type: string;
      }>(
        `SELECT stored_name,original_name,mime_type FROM uploads
         WHERE id=$1 AND status='ready' FOR UPDATE`,
        [input.uploadId],
      );
      file = result.rows[0];
      if (!file)
        throw new ApiError(
          404,
          "UPLOAD_NOT_FOUND",
          "File upload tidak ditemukan",
        );
      validateOutboundMediaType(input, file.mime_type);
    }
    const payload =
      input.type === "text"
        ? {
            messageId,
            remoteJid,
            text: input.text,
            replyTo: input.replyTo,
            replyToParticipant: input.replyToParticipant,
          }
        : {
            messageId,
            remoteJid,
            filePath: file!.stored_name,
            mimeType: file!.mime_type,
            fileName: input.fileName ?? file!.original_name,
            caption: input.type === "audio" ? undefined : input.caption,
            voiceNote: input.type === "audio" ? input.voiceNote : undefined,
            replyTo: input.replyTo,
            replyToParticipant: input.replyToParticipant,
          };
    const jobId = await enqueueJob(client, {
      queue: "whatsapp-outbound",
      type: outboundQueueType(input.type),
      payload,
      dedupeKey: `message:${messageId}`,
      maxAttempts: 8,
    });
    await client.query(
      `INSERT INTO whatsapp_messages
       (id,wa_message_id,remote_jid,participant_jid,direction,message_type,text_body,media,payload,status,error,
        queue_job_id,idempotency_key,received_at,sent_at,created_at,updated_at)
       VALUES ($1,NULL,$2,NULL,'outbound',$3,$4,$5::jsonb,$6::jsonb,'queued',NULL,$7,$8,NULL,NULL,now(),now())`,
      [
        messageId,
        remoteJid,
        input.type,
        textBody(input),
        JSON.stringify(
          input.type === "text"
            ? {}
            : {
                uploadId: input.uploadId,
                mimeType: file!.mime_type,
                originalName: file!.original_name,
                fileName: input.fileName ?? file!.original_name,
                ...(input.type === "audio"
                  ? { voiceNote: input.voiceNote }
                  : {}),
              },
        ),
        JSON.stringify({
          requestedBy: options.actor ?? "admin",
          replyTo: input.replyTo ?? null,
          replyToParticipant: input.replyToParticipant ?? null,
        }),
        jobId,
        options.idempotencyKey ?? null,
      ],
    );
    if (input.type !== "text") {
      await client.query(
        `UPDATE uploads SET status='consumed',expires_at=NULL WHERE id=$1`,
        [input.uploadId],
      );
    }
    if ((options.actor ?? "admin") !== "openclaw") {
      await client.query(
        `INSERT INTO contact_memory(remote_jid,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply,last_message_at)
         VALUES($1,$2,'manual reply','admin',false,now())
         ON CONFLICT(remote_jid) DO UPDATE SET ai_paused_until=EXCLUDED.ai_paused_until,ai_pause_reason=EXCLUDED.ai_pause_reason,handled_by=EXCLUDED.handled_by,needs_admin_reply=false,updated_at=now()`,
        [remoteJid, new Date("9999-12-31T23:59:59.000Z")],
      );
      await client.query(
        `WITH cancelled AS (
           UPDATE queue_jobs SET status='failed',last_error='Dibatalkan karena admin mengambil alih manual mode',updated_at=now()
           WHERE queue_name='openclaw-events' AND status='pending' AND payload->>'remoteJid'=$1
           RETURNING id
         )
         UPDATE whatsapp_messages SET processing_state='ignored',error='Manual mode aktif',updated_at=now()
         WHERE queue_job_id IN (SELECT id FROM cancelled)`,
        [remoteJid],
      );
    }
    if (options.request) {
      await writeAudit(client, options.request, {
        action: "message.queued",
        resourceType: "whatsapp_message",
        resourceId: messageId,
        metadata: { type: input.type },
      });
    }
    return { messageId, jobId };
  });
}

export async function assertContactOutboundAllowed(
  client: { query: <T extends Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  remoteJid: string,
): Promise<void> {
  const contact = await client.query<{ do_not_contact: boolean }>(
    "SELECT do_not_contact FROM contact_memory WHERE remote_jid=$1",
    [remoteJid],
  );
  if (contact.rows[0]?.do_not_contact === true) {
    throw new ApiError(
      409,
      "CONTACT_DO_NOT_CONTACT",
      "Pengiriman diblokir karena kontak berstatus do not contact",
    );
  }
}

export function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value)
    throw new ApiError(
      428,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Header Idempotency-Key wajib diisi untuk pengiriman pesan",
    );
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value))
    throw new ApiError(
      422,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key tidak valid",
    );
  return value;
}

export async function registerMessageRoutes(
  app: FastifyInstance,
): Promise<void> {
  const uploadHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const part = await request.file({
      limits: { fileSize: app.context.env.UPLOAD_MAX_BYTES, files: 1 },
    });
    if (!part) throw new ApiError(422, "FILE_REQUIRED", "File wajib diunggah");
    const buffer = await part.toBuffer();
    if (buffer.length > app.context.env.UPLOAD_MAX_BYTES)
      throw new ApiError(413, "FILE_TOO_LARGE", "Ukuran file melewati batas");
    const id = randomUUID();
    const safeOriginal =
      basename(part.filename)
        .replace(/[^\p{L}\p{N}._ -]/gu, "_")
        .slice(0, 255) || "file";
    try {
      validateUploadContent(part.mimetype, safeOriginal, buffer);
    } catch (error) {
      throw new ApiError(
        415,
        "FILE_CONTENT_UNSUPPORTED",
        error instanceof Error ? error.message : "Isi file tidak didukung",
      );
    }
    const extension = safeOriginal.includes(".")
      ? `.${safeOriginal
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "")}`
      : "";
    const storedName = `${id}${extension}`;
    const uploadDirectory = join(app.context.env.dataDir, "uploads");
    await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(uploadDirectory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      (directoryInfo.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        directoryInfo.uid !== process.getuid())
    )
      throw new ApiError(500, "UPLOAD_DIRECTORY_UNSAFE", "Direktori upload tidak aman");
    const target = join(uploadDirectory, storedName);
    try {
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(buffer);
        const info = await handle.stat();
        if (!info.isFile() || info.size !== buffer.length || (info.mode & 0o077) !== 0)
          throw new Error("File upload berubah saat ditulis");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await withTransaction(app.context.db, async (client) => {
        await client.query(
          `INSERT INTO uploads(id,original_name,stored_name,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            id,
            safeOriginal,
            storedName,
            part.mimetype,
            buffer.length,
            createHash("sha256").update(buffer).digest("hex"),
          ],
        );
        await writeAudit(client, request, {
          action: "upload.created",
          resourceType: "upload",
          resourceId: id,
          metadata: { mimeType: part.mimetype, size: buffer.length },
        });
      });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return reply.code(201).send({
      data: {
        id,
        fileName: safeOriginal,
        mimeType: part.mimetype,
        size: buffer.length,
      },
    });
  };
  app.post("/api/v1/uploads", { preHandler: requireAdminReady }, uploadHandler);
  app.post("/internal/uploads", { preHandler: requireInternal }, uploadHandler);

  const sendHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOutboundMessage(request.body);
    const key = requireIdempotencyKey(request);
    const actor = request.admin?.id;
    const result = await queueOutboundMessage(app, input, {
      idempotencyKey: key,
      request,
      ...(actor ? { actor } : {}),
    });
    return reply.code(202).send({ data: { ...result, status: "queued" } });
  };
  app.post("/api/v1/messages", { preHandler: requireAdminReady }, sendHandler);
  app.post(
    "/api/v1/messages/send",
    { preHandler: requireAdminReady },
    sendHandler,
  );

  app.get(
    "/api/v1/messages",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          direction: z.enum(["inbound", "outbound"]).optional(),
          status: z.string().max(30).optional(),
          jid: z.string().max(100).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          search: z.string().max(100).optional(),
        })
        .parse(request.query);
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (query.direction) {
        values.push(query.direction);
        clauses.push(`direction=$${values.length}`);
      }
      if (query.status) {
        values.push(query.status);
        clauses.push(`(status=$${values.length} OR processing_state=$${values.length})`);
      }
      if (query.jid) {
        values.push(`%${query.jid}%`);
        clauses.push(`remote_jid ILIKE $${values.length}`);
      }
      if (query.from) {
        values.push(query.from);
        clauses.push(`COALESCE(received_at,sent_at,created_at) >= $${values.length}`);
      }
      if (query.to) {
        const to = new Date(query.to);
        to.setDate(to.getDate() + 1);
        values.push(to);
        clauses.push(`COALESCE(received_at,sent_at,created_at) < $${values.length}`);
      }
      if (query.search) {
        values.push(`%${query.search}%`);
        clauses.push(
          `(text_body ILIKE $${values.length} OR remote_jid ILIKE $${values.length})`,
        );
      }
      values.push(query.limit, (query.page - 1) * query.limit);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const result = await app.context.db.query(
        `SELECT id,wa_message_id,remote_jid,participant_jid,direction,message_type,text_body,media,status,processing_state,error,
       attempts,queue_job_id,received_at,sent_at,delivered_at,read_at,created_at,updated_at,count(*) OVER()::int total
       FROM whatsapp_messages ${where} ORDER BY COALESCE(received_at,sent_at,created_at) DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      const total = Number(result.rows[0]?.total ?? 0);
      return {
        data: result.rows.map(({ total: _total, ...row }) => row),
        meta: { page: query.page, limit: query.limit, total },
      };
    },
  );

  app.get(
    "/api/v1/messages/conversations",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        direction: z.enum(["inbound", "outbound"]).optional(),
        needsAdminReply: z.coerce.boolean().optional(),
        status: z.string().max(30).optional(),
        jid: z.string().max(100).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        search: z.string().max(100).optional(),
      }).parse(request.query);
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (query.direction) { values.push(query.direction); clauses.push(`m.direction=$${values.length}`); }
      if (query.needsAdminReply) { clauses.push(`cm.needs_admin_reply=true`); }
      if (query.status) { values.push(query.status); clauses.push(`(m.status=$${values.length} OR m.processing_state=$${values.length})`); }
      if (query.jid) { values.push(`%${query.jid}%`); clauses.push(`m.remote_jid ILIKE $${values.length}`); }
      if (query.from) { values.push(query.from); clauses.push(`COALESCE(m.received_at,m.sent_at,m.created_at) >= $${values.length}`); }
      if (query.to) {
        const to = new Date(query.to);
        to.setDate(to.getDate() + 1);
        values.push(to);
        clauses.push(`COALESCE(m.received_at,m.sent_at,m.created_at) < $${values.length}`);
      }
      if (query.search) { values.push(`%${query.search}%`); clauses.push(`(m.text_body ILIKE $${values.length} OR m.remote_jid ILIKE $${values.length} OR cm.candidate_name ILIKE $${values.length})`); }
      values.push(query.limit, (query.page - 1) * query.limit);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const result = await app.context.db.query(
        `WITH filtered AS (
           SELECT m.* FROM whatsapp_messages m LEFT JOIN contact_memory cm ON cm.remote_jid=m.remote_jid ${where}
         ), latest AS (
           SELECT DISTINCT ON (remote_jid) * FROM filtered ORDER BY remote_jid, COALESCE(received_at,sent_at,created_at) DESC
         ), counts AS (
           SELECT remote_jid,count(*)::int total_messages,
             count(*) FILTER (WHERE status IN ('failed','dead','dead_letter') OR processing_state='failed')::int failed_messages
           FROM filtered GROUP BY remote_jid
         )
         SELECT l.remote_jid,cm.candidate_name,cm.recruitment_stage,cm.form_submitted,cm.ai_paused_until,cm.ai_pause_reason,cm.handled_by,cm.needs_admin_reply,l.id last_message_id,l.direction last_direction,l.message_type last_message_type,l.text_body last_text,l.status,l.processing_state,l.error,COALESCE(l.received_at,l.sent_at,l.created_at) last_at,c.total_messages,c.failed_messages,count(*) OVER()::int total
         FROM latest l JOIN counts c USING(remote_jid) LEFT JOIN contact_memory cm USING(remote_jid)
         ORDER BY last_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      const total = Number(result.rows[0]?.total ?? 0);
      return { data: result.rows.map(({ total: _total, ...row }) => row), meta: { page: query.page, limit: query.limit, total } };
    },
  );

  app.get(
    "/api/v1/messages/analytics/receipts",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = z
        .object({
          days: z.coerce.number().int().min(1).max(31).default(7),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        })
        .parse(request.query);
      const to = query.to ?? new Date();
      const from = query.from ?? new Date(to.getTime() - query.days * 86_400_000);
      if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 31 * 86_400_000) {
        throw new ApiError(422, "WINDOW_INVALID", "Window receipt wajib 1 sampai 31 hari");
      }
      const result = await app.context.db.query<{
        day: string;
        status: string;
        count: number;
      }>(
        `SELECT date_trunc('day', occurred_at)::date AS day,status,count(*)::int AS count
           FROM message_delivery_events
          WHERE occurred_at >= $1 AND occurred_at < $2
          GROUP BY 1,2 ORDER BY 1 DESC,2 ASC`,
        [from, to],
      );
      return {
        data: { ...aggregateReceiptTotals(result.rows), series: result.rows },
        meta: { from: from.toISOString(), to: to.toISOString() },
      };
    },
  );

  app.get(
    "/api/v1/messages/queue/failed",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = z
        .object({
          hours: z.coerce.number().int().min(1).max(168).default(24),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);
      const since = new Date(Date.now() - query.hours * 3_600_000);
      const result = await app.context.db.query<{
        job_id: string;
        message_id: string | null;
        job_type: string;
        status: string;
        attempts: number;
        max_attempts: number;
        last_error: string | null;
        created_at: Date;
        updated_at: Date;
        failed_at: Date | null;
      }>(
        `SELECT q.id AS job_id,m.id AS message_id,q.job_type,q.status,q.attempts,q.max_attempts,
                q.last_error,q.created_at,q.updated_at,q.failed_at
           FROM queue_jobs q
           LEFT JOIN LATERAL (
             SELECT id FROM whatsapp_messages
              WHERE queue_job_id=q.id
              ORDER BY created_at DESC LIMIT 1
           ) m ON TRUE
          WHERE q.queue_name='whatsapp-outbound'
            AND q.status IN ('failed','dead','dead_letter','retrying')
            AND q.updated_at >= $1
          ORDER BY q.updated_at DESC LIMIT $2`,
        [since, query.limit],
      );
      return {
        data: result.rows.map(({ last_error, ...row }) => ({
          jobId: row.job_id,
          messageId: row.message_id,
          jobType: row.job_type,
          status: row.status,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          failedAt: row.failed_at,
          safeReason: safeQueueFailureReason(last_error),
        })),
        meta: { since: since.toISOString(), limit: query.limit },
      };
    },
  );

  const queueInboundAction = async (
    request: FastifyRequest,
    id: string,
    action: "reaction" | "mark-read" | "typing",
    details: { emoji?: string | null; durationSeconds?: number } = {},
  ) => withTransaction(app.context.db, async (client) => {
    const target = await client.query<{
      id: string;
      wa_message_id: string | null;
      remote_jid: string;
      participant_jid: string | null;
    }>(
      `SELECT id,wa_message_id,remote_jid,participant_jid
         FROM whatsapp_messages
        WHERE id=$1 AND direction='inbound'
        FOR SHARE`,
      [id],
    );
    const row = target.rows[0];
    if (!row) throw new ApiError(404, "MESSAGE_NOT_FOUND", "Pesan inbound tidak ditemukan");
    if (!row.wa_message_id) throw new ApiError(409, "MESSAGE_TARGET_UNAVAILABLE", "Target WhatsApp tidak tersedia untuk pesan ini");
    const actionId = randomUUID();
    const bucket = action === "typing" ? `:${Math.floor(Date.now() / 15_000)}` : "";
    const paramsHash = createHash("sha256")
      .update(JSON.stringify({ action, emoji: details.emoji ?? null, durationSeconds: details.durationSeconds ?? null, bucket }))
      .digest("hex")
      .slice(0, 24);
    const dedupeKey = `message-action:${action}:${id}:${paramsHash}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [dedupeKey, 441_902_113]);
    if (action === "reaction") {
      const existing = await client.query<{ id: string; queue_job_id: string }>(
        `SELECT id,queue_job_id FROM whatsapp_messages WHERE dedupe_key=$1 AND direction='outbound'`,
        [dedupeKey],
      );
      if (existing.rows[0]) return { messageId: existing.rows[0].id, jobId: existing.rows[0].queue_job_id, status: "queued" };
    }
    const payload = {
      messageId: actionId,
      remoteJid: row.remote_jid,
      targetMessageId: row.id,
      targetWaMessageId: row.wa_message_id,
      targetParticipantJid: row.participant_jid,
      ...(details.emoji !== undefined ? { emoji: details.emoji } : {}),
      ...(details.durationSeconds ? { durationSeconds: details.durationSeconds } : {}),
    };
    const jobId = await enqueueJob(client, {
      queue: "whatsapp-outbound",
      type: `message-${action}`,
      payload,
      dedupeKey,
      maxAttempts: action === "typing" ? 3 : 8,
    });
    if (action === "reaction") {
      await client.query(
        `INSERT INTO whatsapp_messages
         (id,wa_message_id,remote_jid,participant_jid,direction,message_type,text_body,media,payload,status,error,
          queue_job_id,dedupe_key,received_at,sent_at,created_at,updated_at)
         VALUES ($1,NULL,$2,NULL,'outbound','reaction',$3,'{}'::jsonb,$4::jsonb,'queued',NULL,$5,$6,NULL,NULL,now(),now())`,
        [actionId, row.remote_jid, details.emoji ?? null, JSON.stringify({ targetMessageId: row.id }), jobId, dedupeKey],
      );
    }
    await writeAudit(client, request, {
      action: `message.${action}.queued`,
      resourceType: "whatsapp_message",
      resourceId: id,
      metadata: { jobId, hasEmoji: details.emoji !== undefined, durationSeconds: details.durationSeconds ?? null },
    });
    return { messageId: action === "reaction" ? actionId : id, jobId, status: "queued" };
  });

  app.post(
    "/api/v1/messages/:id/reaction",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = reactionSchema.parse(request.body ?? {});
      const result = await queueInboundAction(request, id, "reaction", {
        emoji: normalizeReactionEmoji(body.emoji),
      });
      return reply.code(202).send({ data: result });
    },
  );

  app.post(
    "/api/v1/messages/:id/mark-read",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const result = await queueInboundAction(request, id, "mark-read");
      return reply.code(202).send({ data: result });
    },
  );

  app.post(
    "/api/v1/messages/:id/typing",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const result = await queueInboundAction(request, id, "typing", {
        durationSeconds: parseTypingDuration(request.body ?? {}),
      });
      return reply.code(202).send({ data: result });
    },
  );

  app.get(
    "/api/v1/messages/:id",
    { preHandler: requireAdminReady },
    async (request) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const result = await app.context.db.query(
        "SELECT * FROM whatsapp_messages WHERE id=$1",
        [id],
      );
      if (!result.rows[0])
        throw new ApiError(404, "MESSAGE_NOT_FOUND", "Pesan tidak ditemukan");
      return { data: result.rows[0] };
    },
  );

  app.post(
    "/api/v1/messages/:id/retry",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const result = await withTransaction(app.context.db, async (client) => {
        const message = await client.query<{
          queue_job_id: string | null;
          status: string;
          direction: "inbound" | "outbound";
          processing_state: string;
        }>(
          "SELECT queue_job_id,status,direction,processing_state FROM whatsapp_messages WHERE id=$1 FOR UPDATE",
          [id],
        );
        const row = message.rows[0];
        if (!row)
          throw new ApiError(404, "MESSAGE_NOT_FOUND", "Pesan tidak ditemukan");
        const retryable =
          row.direction === "outbound"
            ? ["failed", "dead", "dead_letter"].includes(row.status)
            : row.processing_state === "failed";
        if (!retryable || !row.queue_job_id)
          throw new ApiError(
            409,
            "MESSAGE_NOT_RETRYABLE",
            "Pesan belum berada pada status gagal yang dapat dipulihkan",
          );
        await client.query(
          `UPDATE queue_jobs SET status='pending',attempts=0,available_at=now(),locked_at=NULL,locked_by=NULL,
         lock_expires_at=NULL,last_error=NULL,completed_at=NULL,failed_at=NULL,updated_at=now() WHERE id=$1`,
          [row.queue_job_id],
        );
        await client.query(
          `UPDATE whatsapp_messages SET status=CASE WHEN direction='outbound' THEN 'queued' ELSE status END,processing_state=CASE WHEN direction='inbound' THEN 'forward_queued' ELSE processing_state END,attempts=0,error=NULL,updated_at=now() WHERE id=$1`,
          [id],
        );
        await writeAudit(client, request, {
          action: "message.retry",
          resourceType: "whatsapp_message",
          resourceId: id,
        });
        return row.queue_job_id;
      });
      return reply
        .code(202)
        .send({ data: { messageId: id, jobId: result, status: "queued" } });
    },
  );
}

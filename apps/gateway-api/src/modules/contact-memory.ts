import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction } from "@ocgw/shared";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { requireAdminReady } from "../security.js";

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(100).optional(),
});
const jidParam = z.object({ jid: z.string().min(5).max(100) });
const updateSchema = z
  .object({
    displayName: z.string().max(120).nullable().optional(),
    candidateName: z.string().max(120).nullable().optional(),
    recruitmentStage: z
      .enum(["new", "asked_job", "form_link_sent", "form_submitted", "under_review"])
      .optional(),
    formSubmitted: z.boolean().optional(),
    lastSummary: z.string().max(500).optional(),
    aiPausedUntil: z.string().datetime().nullable().optional(),
    aiPauseReason: z.string().max(120).optional(),
    handledBy: z.string().max(120).optional(),
    needsAdminReply: z.boolean().optional(),
  })
  .strict();

export async function registerContactMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/contact-memory", { preHandler: requireAdminReady }, async (request) => {
    const query = listQuery.parse(request.query);
    const values: unknown[] = [];
    const where = query.search
      ? (values.push(`%${query.search}%`),
        `WHERE remote_jid ILIKE $1 OR display_name ILIKE $1 OR candidate_name ILIKE $1 OR last_summary ILIKE $1`)
      : "";
    values.push(query.limit, (query.page - 1) * query.limit);
    const result = await app.context.db.query(
      `SELECT remote_jid AS id,remote_jid,display_name,candidate_name,recruitment_stage,form_submitted,last_summary,last_message_at,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply,revision,created_at,updated_at,count(*) OVER()::int total
       FROM contact_memory ${where} ORDER BY COALESCE(last_message_at,updated_at,created_at) DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      data: result.rows.map(({ total: _total, ...row }) => row),
      meta: { ...query, total: Number(result.rows[0]?.total ?? 0) },
    };
  });

  app.put("/api/v1/contact-memory/:jid", { preHandler: requireAdminReady }, async (request) => {
    const { jid } = jidParam.parse(request.params);
    const input = updateSchema.parse(request.body);
    const result = await withTransaction(app.context.db, async (client) => {
      const updated = await client.query(
        `UPDATE contact_memory SET
          display_name=COALESCE($2,display_name),
          candidate_name=COALESCE($3,candidate_name),
          recruitment_stage=COALESCE($4,recruitment_stage),
          form_submitted=COALESCE($5,form_submitted),
          last_summary=COALESCE($6,last_summary),
          ai_paused_until=CASE WHEN $7::timestamptz IS NULL AND $8::boolean THEN NULL ELSE COALESCE($7::timestamptz,ai_paused_until) END,
          ai_pause_reason=COALESCE($9,ai_pause_reason),
          handled_by=COALESCE($10,handled_by),
          needs_admin_reply=COALESCE($11,needs_admin_reply),
          revision=revision+1,
          updated_at=now()
         WHERE remote_jid=$1 RETURNING remote_jid AS id,remote_jid,display_name,candidate_name,recruitment_stage,form_submitted,last_summary,last_message_at,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply,revision,created_at,updated_at`,
        [
          jid,
          input.displayName ?? null,
          input.candidateName ?? null,
          input.recruitmentStage ?? null,
          input.formSubmitted ?? null,
          input.lastSummary ?? null,
          input.aiPausedUntil ?? null,
          Object.prototype.hasOwnProperty.call(input, "aiPausedUntil") && input.aiPausedUntil === null,
          input.aiPauseReason ?? null,
          input.handledBy ?? null,
          input.needsAdminReply ?? null,
        ],
      );
      if (!updated.rows[0]) throw new ApiError(404, "CONTACT_MEMORY_NOT_FOUND", "Memory kontak tidak ditemukan");
      await writeAudit(client, request, { action: "contact_memory.updated", resourceType: "contact_memory", resourceId: jid });
      return updated.rows[0];
    });
    return { data: result };
  });


  app.post("/api/v1/contact-memory/:jid/manual-mode", { preHandler: requireAdminReady }, async (request) => {
    const { jid } = jidParam.parse(request.params);
    const input = z.object({ durationMinutes: z.number().int().min(1).max(1440).nullable().optional(), reason: z.string().max(120).optional() }).parse(request.body ?? {});
    const pausedUntil = input.durationMinutes ? new Date(Date.now() + input.durationMinutes * 60_000) : new Date("9999-12-31T23:59:59.000Z");
    const result = await withTransaction(app.context.db, async (client) => {
      const updated = await client.query(
        `INSERT INTO contact_memory(remote_jid,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply,last_message_at)
         VALUES($1,$2,$3,$4,true,now())
         ON CONFLICT(remote_jid) DO UPDATE SET ai_paused_until=EXCLUDED.ai_paused_until,ai_pause_reason=EXCLUDED.ai_pause_reason,handled_by=EXCLUDED.handled_by,needs_admin_reply=true,updated_at=now()
         RETURNING remote_jid AS id,remote_jid,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply`,
        [jid, pausedUntil, input.reason ?? "manual", request.admin?.id ?? "admin"],
      );
      await client.query(
        `WITH cancelled AS (
           UPDATE queue_jobs SET status='failed',last_error='Dibatalkan karena manual mode aktif',updated_at=now()
           WHERE queue_name='openclaw-events' AND status='pending' AND payload->>'remoteJid'=$1
           RETURNING id
         )
         UPDATE whatsapp_messages SET processing_state='ignored',error='Manual mode aktif',updated_at=now()
         WHERE queue_job_id IN (SELECT id FROM cancelled)`,
        [jid],
      );
      await writeAudit(client, request, { action: "contact_memory.manual_mode_enabled", resourceType: "contact_memory", resourceId: jid });
      return updated.rows[0];
    });
    return { data: result };
  });

  app.post("/api/v1/contact-memory/:jid/ai-mode", { preHandler: requireAdminReady }, async (request) => {
    const { jid } = jidParam.parse(request.params);
    const result = await withTransaction(app.context.db, async (client) => {
      const updated = await client.query(
        `INSERT INTO contact_memory(remote_jid,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply,last_message_at)
         VALUES($1,NULL,'','',false,now())
         ON CONFLICT(remote_jid) DO UPDATE SET ai_paused_until=NULL,ai_pause_reason='',handled_by='',needs_admin_reply=false,updated_at=now()
         RETURNING remote_jid AS id,remote_jid,ai_paused_until,ai_pause_reason,handled_by,needs_admin_reply`,
        [jid],
      );
      await writeAudit(client, request, { action: "contact_memory.ai_mode_enabled", resourceType: "contact_memory", resourceId: jid });
      return updated.rows[0];
    });
    return { data: result };
  });

  app.delete("/api/v1/contact-memory/:jid", { preHandler: requireAdminReady }, async (request, reply) => {
    const { jid } = jidParam.parse(request.params);
    await withTransaction(app.context.db, async (client) => {
      const deleted = await client.query("DELETE FROM contact_memory WHERE remote_jid=$1", [jid]);
      if (!deleted.rowCount) throw new ApiError(404, "CONTACT_MEMORY_NOT_FOUND", "Memory kontak tidak ditemukan");
      await writeAudit(client, request, { action: "contact_memory.deleted", resourceType: "contact_memory", resourceId: jid });
    });
    return reply.code(204).send();
  });
}

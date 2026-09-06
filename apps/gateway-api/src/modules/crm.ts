import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTransaction } from "@ocgw/shared";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { requireAdminReady } from "../security.js";

const crmStatusValues = ["new", "open", "waiting_human", "waiting_customer", "resolved", "closed"] as const;
const priorityValues = ["low", "normal", "high", "urgent"] as const;
const consentStatusValues = ["unknown", "granted", "denied", "revoked"] as const;
const aiModeOverrideValues = ["inherit", "off", "suggest_only", "assist"] as const;
const aiModeValues = ["off"] as const;

type CrmSettingKey = keyof CrmConfig;

type SettingRow = { key: string; value: unknown };

export type CrmConfig = {
  "crm.enabled": boolean;
  "crm.ai.enabled": false;
  "crm.ai.mode": "off";
  "crm.default_sla_hours": number;
  "crm.default_status": (typeof crmStatusValues)[number];
  "crm.default_priority": (typeof priorityValues)[number];
  "crm.default_ai_override": (typeof aiModeOverrideValues)[number];
  "crm.notes_required_on_close": boolean;
  "crm.human_override_required": boolean;
  "crm.allow_auto_reply": false;
};

export const defaultCrmConfig: CrmConfig = {
  "crm.enabled": false,
  "crm.ai.enabled": false,
  "crm.ai.mode": "off",
  "crm.default_sla_hours": 24,
  "crm.default_status": "open",
  "crm.default_priority": "normal",
  "crm.default_ai_override": "inherit",
  "crm.notes_required_on_close": false,
  "crm.human_override_required": true,
  "crm.allow_auto_reply": false,
};

const configValueSchemas = {
  "crm.enabled": z.boolean(),
  "crm.ai.enabled": z.literal(false),
  "crm.ai.mode": z.enum(aiModeValues),
  "crm.default_sla_hours": z.number().int().min(1).max(720),
  "crm.default_status": z.enum(crmStatusValues),
  "crm.default_priority": z.enum(priorityValues),
  "crm.default_ai_override": z.enum(aiModeOverrideValues),
  "crm.notes_required_on_close": z.boolean(),
  "crm.human_override_required": z.boolean(),
  "crm.allow_auto_reply": z.literal(false),
} satisfies Record<CrmSettingKey, z.ZodType>;

export const crmConfigUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    "crm.enabled": configValueSchemas["crm.enabled"].optional(),
    "crm.ai.enabled": configValueSchemas["crm.ai.enabled"].optional(),
    "crm.ai.mode": configValueSchemas["crm.ai.mode"].optional(),
    "crm.default_sla_hours": configValueSchemas["crm.default_sla_hours"].optional(),
    "crm.default_status": configValueSchemas["crm.default_status"].optional(),
    "crm.default_priority": configValueSchemas["crm.default_priority"].optional(),
    "crm.default_ai_override": configValueSchemas["crm.default_ai_override"].optional(),
    "crm.notes_required_on_close": configValueSchemas["crm.notes_required_on_close"].optional(),
    "crm.human_override_required": configValueSchemas["crm.human_override_required"].optional(),
    "crm.allow_auto_reply": configValueSchemas["crm.allow_auto_reply"].optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), {
    message: "Minimal satu pengaturan CRM wajib diubah",
  });

export function parseCrmConfigUpdate(input: unknown): z.infer<typeof crmConfigUpdateSchema> {
  return crmConfigUpdateSchema.parse(input);
}

export function parseCrmContactUpdate(input: unknown): z.infer<typeof contactUpdateSchema> {
  return contactUpdateSchema.parse(input);
}

export function resolveCrmConfig(rows: SettingRow[]): CrmConfig {
  const resolved: CrmConfig = { ...defaultCrmConfig };
  for (const row of rows) {
    if (!(row.key in configValueSchemas)) continue;
    const key = row.key as CrmSettingKey;
    const parsed = configValueSchemas[key].safeParse(row.value);
    if (parsed.success) resolved[key] = parsed.data as never;
  }
  return resolved;
}

const contactListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().min(1).max(100).optional(),
  crmStatus: z.enum(crmStatusValues).optional(),
  priority: z.enum(priorityValues).optional(),
  consentStatus: z.enum(consentStatusValues).optional(),
  assigneeUserId: z.uuid().optional(),
  doNotContact: z.coerce.boolean().optional(),
  tagId: z.uuid().optional(),
  aiModeOverride: z.enum(aiModeOverrideValues).optional(),
});
const jidParam = z.object({ jid: z.string().min(1).max(200) });
const tagParam = z.object({ tagId: z.uuid() });
const noteParam = z.object({ noteId: z.uuid() });
const contactUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    crmStatus: z.enum(crmStatusValues).optional(),
    priority: z.enum(priorityValues).optional(),
    assigneeUserId: z.uuid().nullable().optional(),
    slaDueAt: z.string().datetime().nullable().optional(),
    consentStatus: z.enum(consentStatusValues).optional(),
    consentSource: z.string().trim().max(200).optional(),
    doNotContact: z.boolean().optional(),
    doNotContactReason: z.string().trim().min(1).max(500).optional(),
    aiModeOverride: z.enum(aiModeOverrideValues).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.doNotContact === true && !value.doNotContactReason)
      context.addIssue({ code: "custom", path: ["doNotContactReason"], message: "Required when doNotContact is true" });
    if (value.doNotContact !== true && value.doNotContactReason)
      context.addIssue({ code: "custom", path: ["doNotContactReason"], message: "Only allowed when doNotContact is true" });
  });
const tagInputSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#8E8E93"),
    description: z.string().trim().max(500).default(""),
  })
  .strict();
const noteInputSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeJid(input: string): string {
  let jid: string;
  try {
    jid = decodeURIComponent(input);
  } catch {
    throw new ApiError(422, "JID_INVALID", "JID tidak valid");
  }
  if (!/^[^\s/]{5,100}$/.test(jid)) throw new ApiError(422, "JID_INVALID", "JID tidak valid");
  return jid;
}

async function assertCrmEnabled(app: FastifyInstance): Promise<void> {
  const settings = await app.context.db.query<SettingRow>(
    "SELECT key,value FROM app_settings WHERE key = ANY($1::text[]) AND is_secret=false",
    [Object.keys(defaultCrmConfig)],
  );
  if (!resolveCrmConfig(settings.rows)["crm.enabled"])
    throw new ApiError(409, "CRM_DISABLED", "Aktifkan CRM dari CRM Settings sebelum mengubah data");
}

function encodeContact(row: Record<string, unknown>): Record<string, unknown> {
  const remoteJid = String(row.remote_jid);
  const { remote_jid: _remoteJid, total: _total, ...rest } = row;
  return { id: hashId(remoteJid), remoteJid, jidHash: hashId(remoteJid), ...rest };
}

async function auditCrmMutation(
  request: FastifyRequest,
  db: Parameters<typeof writeAudit>[0],
  input: { action: string; resourceType: string; resourceId?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await writeAudit(db, request, input);
}

export async function registerCrmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/crm/config", { preHandler: requireAdminReady }, async () => {
    const [settings, state] = await Promise.all([
      app.context.db.query<SettingRow>(
        "SELECT key,value FROM app_settings WHERE key = ANY($1::text[]) AND is_secret=false",
        [Object.keys(defaultCrmConfig)],
      ),
      app.context.db.query<{ revision: number }>("SELECT revision FROM crm_config_state WHERE singleton_key=true"),
    ]);
    return { data: { revision: Number(state.rows[0]?.revision ?? 1), config: resolveCrmConfig(settings.rows) } };
  });

  app.put("/api/v1/crm/config", { preHandler: requireAdminReady }, async (request) => {
    const input = parseCrmConfigUpdate(request.body);
    const changed = Object.entries(input).filter(([key]) => key !== "expectedRevision") as [CrmSettingKey, unknown][];
    const result = await withTransaction(app.context.db, async (client) => {
      const state = await client.query<{ revision: number }>(
        "SELECT revision FROM crm_config_state WHERE singleton_key=true FOR UPDATE",
      );
      const revision = Number(state.rows[0]?.revision ?? 1);
      if (revision !== input.expectedRevision)
        throw new ApiError(409, "REVISION_CONFLICT", "Konfigurasi CRM telah berubah; muat ulang sebelum menyimpan");
      for (const [key, value] of changed) {
        await client.query(
          `INSERT INTO app_settings(key,value,is_secret,description,updated_at)
           VALUES($1,$2::jsonb,false,'CRM Lite setting',now())
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,is_secret=false,revision=app_settings.revision+1,updated_at=now()`,
          [key, JSON.stringify(value)],
        );
      }
      const updated = await client.query<{ revision: number }>(
        "UPDATE crm_config_state SET revision=revision+1,updated_by=$1,updated_at=now() WHERE singleton_key=true RETURNING revision",
        [request.admin?.id ?? null],
      );
      await auditCrmMutation(request, client, {
        action: "crm.config.updated",
        resourceType: "crm_config",
        metadata: { keys: changed.map(([key]) => key) },
      });
      const settings = await client.query<SettingRow>(
        "SELECT key,value FROM app_settings WHERE key = ANY($1::text[]) AND is_secret=false",
        [Object.keys(defaultCrmConfig)],
      );
      return { revision: Number(updated.rows[0]?.revision ?? revision + 1), config: resolveCrmConfig(settings.rows) };
    });
    return { data: result };
  });

  app.get("/api/v1/crm/contacts", { preHandler: requireAdminReady }, async (request) => {
    const query = contactListQuery.parse(request.query);
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace("?", `$${values.length}`));
    };
    if (query.search) add("(remote_jid ILIKE ? OR display_name ILIKE ? OR candidate_name ILIKE ? OR last_summary ILIKE ?)", `%${query.search}%`);
    if (query.crmStatus) add("crm_status=?", query.crmStatus);
    if (query.priority) add("priority=?", query.priority);
    if (query.consentStatus) add("consent_status=?", query.consentStatus);
    if (query.assigneeUserId) add("assignee_user_id=?::uuid", query.assigneeUserId);
    if (query.doNotContact !== undefined) add("do_not_contact=?", query.doNotContact);
    if (query.tagId) add("EXISTS (SELECT 1 FROM crm_contact_tags ctf WHERE ctf.remote_jid=cm.remote_jid AND ctf.tag_id=?::uuid)", query.tagId);
    if (query.aiModeOverride) add("ai_mode_override=?", query.aiModeOverride);
    const searchIndex = query.search ? values.findIndex((value) => value === `%${query.search}%`) + 1 : 0;
    if (query.search)
      where[0] = `(cm.remote_jid ILIKE $${searchIndex} OR cm.display_name ILIKE $${searchIndex} OR cm.candidate_name ILIKE $${searchIndex} OR cm.last_summary ILIKE $${searchIndex})`;
    values.push(query.limit, (query.page - 1) * query.limit);
    const result = await app.context.db.query(
      `SELECT cm.remote_jid,cm.display_name,cm.candidate_name,cm.crm_status AS "crmStatus",cm.priority,cm.assignee_user_id AS "assigneeUserId",a.email AS "assigneeLabel",cm.sla_due_at AS "slaDueAt",cm.consent_status AS "consentStatus",cm.do_not_contact AS "doNotContact",cm.do_not_contact_reason AS "doNotContactReason",cm.do_not_contact_at AS "doNotContactAt",cm.ai_mode_override AS "aiModeOverride",cm.needs_admin_reply AS "needsAdminReply",cm.last_message_at AS "lastMessageAt",cm.revision,cm.updated_at AS "updatedAt",COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL),'[]'::jsonb) AS tags,count(*) OVER()::int total
       FROM contact_memory cm
       LEFT JOIN admin_users a ON a.id=cm.assignee_user_id
       LEFT JOIN crm_contact_tags ct ON ct.remote_jid=cm.remote_jid
       LEFT JOIN crm_tags t ON t.id=ct.tag_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY cm.remote_jid,a.email
       ORDER BY COALESCE(cm.sla_due_at,cm.last_message_at,cm.updated_at) DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { data: result.rows.map(encodeContact), meta: { page: query.page, limit: query.limit, total: Number(result.rows[0]?.total ?? 0) } };
  });

  app.put("/api/v1/crm/contacts/:jid", { preHandler: requireAdminReady }, async (request) => {
    await assertCrmEnabled(app);
    const jid = decodeJid(jidParam.parse(request.params).jid);
    const input = parseCrmContactUpdate(request.body);
    const result = await withTransaction(app.context.db, async (client) => {
      const current = await client.query<{ revision: number }>("SELECT revision FROM contact_memory WHERE remote_jid=$1 FOR UPDATE", [jid]);
      if (!current.rows[0]) throw new ApiError(404, "CONTACT_NOT_FOUND", "Kontak tidak ditemukan");
      if (Number(current.rows[0].revision) !== input.expectedRevision)
        throw new ApiError(409, "REVISION_CONFLICT", "Kontak telah berubah; muat ulang sebelum menyimpan");
      if (input.crmStatus === "closed") {
        const closePolicy = await client.query<{ required: boolean; note_count: number }>(
          `SELECT
             COALESCE((SELECT (value #>> '{}')::boolean FROM app_settings WHERE key='crm.notes_required_on_close' AND is_secret=false),false) AS required,
             (SELECT count(*)::int FROM crm_internal_notes WHERE remote_jid=$1 AND deleted_at IS NULL) AS note_count`,
          [jid],
        );
        if (closePolicy.rows[0]?.required && Number(closePolicy.rows[0].note_count) < 1)
          throw new ApiError(422, "CRM_CLOSE_NOTE_REQUIRED", "Tambahkan catatan internal sebelum menutup kontak");
      }
      const dncTouched = Object.prototype.hasOwnProperty.call(input, "doNotContact");
      const updated = await client.query(
        `UPDATE contact_memory SET
          crm_status=COALESCE($2,crm_status),
          priority=COALESCE($3,priority),
          assignee_user_id=CASE WHEN $4::boolean THEN $5::uuid ELSE assignee_user_id END,
          sla_due_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE sla_due_at END,
          consent_status=COALESCE($8,consent_status),
          consent_source=CASE WHEN $9::boolean THEN $10 ELSE consent_source END,
          do_not_contact=CASE WHEN $11::boolean THEN $12 ELSE do_not_contact END,
          do_not_contact_reason=CASE WHEN $11::boolean THEN CASE WHEN $12 THEN $13 ELSE '' END ELSE do_not_contact_reason END,
          do_not_contact_at=CASE WHEN $11::boolean THEN CASE WHEN $12 THEN now() ELSE NULL END ELSE do_not_contact_at END,
          do_not_contact_by=CASE WHEN $11::boolean THEN CASE WHEN $12 THEN $14::uuid ELSE NULL END ELSE do_not_contact_by END,
          ai_mode_override=COALESCE($15,ai_mode_override),
          revision=revision+1,updated_at=now()
         WHERE remote_jid=$1
         RETURNING remote_jid,display_name,candidate_name,crm_status AS "crmStatus",priority,assignee_user_id AS "assigneeUserId",sla_due_at AS "slaDueAt",consent_status AS "consentStatus",consent_source AS "consentSource",do_not_contact AS "doNotContact",do_not_contact_reason AS "doNotContactReason",do_not_contact_at AS "doNotContactAt",ai_mode_override AS "aiModeOverride",revision,updated_at AS "updatedAt"`,
        [
          jid,
          input.crmStatus ?? null,
          input.priority ?? null,
          Object.prototype.hasOwnProperty.call(input, "assigneeUserId"),
          input.assigneeUserId ?? null,
          Object.prototype.hasOwnProperty.call(input, "slaDueAt"),
          input.slaDueAt ?? null,
          input.consentStatus ?? null,
          Object.prototype.hasOwnProperty.call(input, "consentSource"),
          input.consentSource ?? "",
          dncTouched,
          input.doNotContact ?? false,
          input.doNotContactReason ?? "",
          request.admin?.id ?? null,
          input.aiModeOverride ?? null,
        ],
      );
      await auditCrmMutation(request, client, {
        action: "crm.contact.updated",
        resourceType: "crm_contact",
        resourceId: hashId(jid),
        metadata: { fields: Object.keys(input).filter((key) => key !== "expectedRevision"), jidHash: hashId(jid) },
      });
      return encodeContact(updated.rows[0]!);
    });
    return { data: result };
  });

  app.get("/api/v1/crm/tags", { preHandler: requireAdminReady }, async () => ({
    data: (await app.context.db.query("SELECT id,name,color,description,revision,created_at,updated_at FROM crm_tags ORDER BY name")).rows,
  }));

  app.post("/api/v1/crm/tags", { preHandler: requireAdminReady }, async (request, reply) => {
    await assertCrmEnabled(app);
    const input = tagInputSchema.parse(request.body);
    const inserted = await withTransaction(app.context.db, async (client) => {
      const result = await client.query(
        "INSERT INTO crm_tags(id,name,color,description,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,color,description,revision,created_at,updated_at",
        [randomUUID(), input.name, input.color, input.description, request.admin?.id ?? null],
      );
      await auditCrmMutation(request, client, { action: "crm.tag.created", resourceType: "crm_tag", resourceId: String(result.rows[0]!.id) });
      return result.rows[0];
    });
    return reply.code(201).send({ data: inserted });
  });

  app.put("/api/v1/crm/contacts/:jid/tags/:tagId", { preHandler: requireAdminReady }, async (request) => {
    await assertCrmEnabled(app);
    const jid = decodeJid(jidParam.parse(request.params).jid);
    const { tagId } = tagParam.parse(request.params);
    await withTransaction(app.context.db, async (client) => {
      await client.query("INSERT INTO crm_contact_tags(remote_jid,tag_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [jid, tagId, request.admin?.id ?? null]);
      await auditCrmMutation(request, client, { action: "crm.contact_tag.added", resourceType: "crm_contact", resourceId: hashId(jid), metadata: { jidHash: hashId(jid), tagId } });
    });
    return { data: { id: encodeURIComponent(jid), tagId } };
  });

  app.delete("/api/v1/crm/contacts/:jid/tags/:tagId", { preHandler: requireAdminReady }, async (request, reply) => {
    await assertCrmEnabled(app);
    const jid = decodeJid(jidParam.parse(request.params).jid);
    const { tagId } = tagParam.parse(request.params);
    await withTransaction(app.context.db, async (client) => {
      const deleted = await client.query("DELETE FROM crm_contact_tags WHERE remote_jid=$1 AND tag_id=$2", [jid, tagId]);
      if (!deleted.rowCount) throw new ApiError(404, "CONTACT_TAG_NOT_FOUND", "Tag kontak tidak ditemukan");
      await auditCrmMutation(request, client, { action: "crm.contact_tag.deleted", resourceType: "crm_contact", resourceId: hashId(jid), metadata: { jidHash: hashId(jid), tagId } });
    });
    return reply.code(204).send();
  });

  app.get("/api/v1/crm/contacts/:jid/notes", { preHandler: requireAdminReady }, async (request) => {
    const jid = decodeJid(jidParam.parse(request.params).jid);
    const rows = await app.context.db.query(
      "SELECT id,body,revision,created_by AS \"createdBy\",created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM crm_internal_notes WHERE remote_jid=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
      [jid],
    );
    return { data: rows.rows };
  });

  app.post("/api/v1/crm/contacts/:jid/notes", { preHandler: requireAdminReady }, async (request, reply) => {
    await assertCrmEnabled(app);
    const jid = decodeJid(jidParam.parse(request.params).jid);
    const input = noteInputSchema.parse(request.body);
    const inserted = await withTransaction(app.context.db, async (client) => {
      const result = await client.query(
        "INSERT INTO crm_internal_notes(id,remote_jid,body,created_by) VALUES($1,$2,$3,$4) RETURNING id,body,revision,created_by AS \"createdBy\",created_at AS \"createdAt\",updated_at AS \"updatedAt\"",
        [randomUUID(), jid, input.body, request.admin?.id ?? null],
      );
      await auditCrmMutation(request, client, { action: "crm.note.created", resourceType: "crm_note", resourceId: String(result.rows[0]!.id), metadata: { jidHash: hashId(jid), noteLength: input.body.length } });
      return result.rows[0];
    });
    return reply.code(201).send({ data: inserted });
  });

  app.delete("/api/v1/crm/notes/:noteId", { preHandler: requireAdminReady }, async (request, reply) => {
    await assertCrmEnabled(app);
    const { noteId } = noteParam.parse(request.params);
    await withTransaction(app.context.db, async (client) => {
      const updated = await client.query<{ remote_jid: string }>(
        "UPDATE crm_internal_notes SET deleted_at=now(),deleted_by=$2,updated_at=now(),revision=revision+1 WHERE id=$1 AND deleted_at IS NULL RETURNING remote_jid",
        [noteId, request.admin?.id ?? null],
      );
      if (!updated.rowCount) throw new ApiError(404, "NOTE_NOT_FOUND", "Catatan tidak ditemukan");
      await auditCrmMutation(request, client, { action: "crm.note.deleted", resourceType: "crm_note", resourceId: noteId, metadata: { jidHash: hashId(updated.rows[0]!.remote_jid) } });
    });
    return reply.code(204).send();
  });
}

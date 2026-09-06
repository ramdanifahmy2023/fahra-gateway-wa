import { randomUUID } from "node:crypto";
import { constants, type ReadStream, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueueJob, withTransaction } from "@ocgw/shared";
import { requireAdminReady } from "../security.js";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  level: z.string().max(20).optional(),
  service: z.string().max(100).optional(),
  search: z.string().max(100).optional(),
});
const localOpenClawUrl = z.url().refine(
  (value) => {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(host) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/chat/completions"
    );
  },
  {
    message:
      "OpenClaw URL wajib http loopback dengan path /v1/chat/completions",
  },
);
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("id-ID", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Timezone IANA tidak valid" },
  );
const settingsSchema = z
  .object({
    agentMention: z.string().max(100).optional(),
    timezone: timezone.optional(),
    messageRetentionDays: z.number().int().min(1).max(3650).optional(),
    openclawUrl: localOpenClawUrl.optional(),
    processGroupMentionsOnly: z.literal(true).optional(),
  })
  .strict();
const canonicalBackupFilename =
  /^openclaw-gateway-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.ocgwb$/;

function assertOwnedRegularBackup(information: Stats): void {
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1 ||
    (information.mode & 0o077) !== 0
  ) {
    throw new ApiError(
      500,
      "BACKUP_ARTIFACT_INVALID",
      "Artifact backup tidak aman",
    );
  }
  if (
    typeof process.getuid === "function" &&
    information.uid !== process.getuid()
  ) {
    throw new ApiError(
      500,
      "BACKUP_ARTIFACT_INVALID",
      "Artifact backup bukan milik user workspace",
    );
  }
}

export async function openBackupDownload(
  backupsRoot: string,
  filename: string,
  backupId: string,
): Promise<ReadStream> {
  const match = canonicalBackupFilename.exec(filename);
  if (!match || match[1] !== backupId.toLowerCase()) {
    throw new ApiError(500, "BACKUP_PATH_INVALID", "Path backup tidak valid");
  }

  const artifactPath = join(backupsRoot, filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathInformation = await lstat(artifactPath);
    assertOwnedRegularBackup(pathInformation);
    handle = await open(
      artifactPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedInformation = await handle.stat();
    assertOwnedRegularBackup(openedInformation);
    if (
      openedInformation.dev !== pathInformation.dev ||
      openedInformation.ino !== pathInformation.ino
    ) {
      throw new ApiError(
        500,
        "BACKUP_ARTIFACT_CHANGED",
        "Artifact backup berubah saat dibuka",
      );
    }
    const stream = handle.createReadStream({ autoClose: true });
    handle = undefined;
    return stream;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "BACKUP_ARTIFACT_INVALID",
      "Artifact backup tidak dapat dibuka dengan aman",
    );
  }
}

export async function registerOperationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/v1/dashboard/overview",
    { preHandler: requireAdminReady },
    async () => {
      const [
        connection,
        messages,
        failed,
        queue,
        knowledge,
        tools,
        jobs,
        series,
      ] = await Promise.all([
        app.context.db.query(
          "SELECT status,phone_number,jid,last_connected_at,last_error,updated_at FROM whatsapp_connection ORDER BY updated_at DESC LIMIT 1",
        ),
        app.context.db.query(
          `SELECT count(*) FILTER (WHERE created_at>=now()-interval '24 hours')::int AS total_24h,count(*) FILTER (WHERE direction='inbound' AND created_at>=now()-interval '24 hours')::int AS inbound_24h,count(*) FILTER (WHERE direction='outbound' AND created_at>=now()-interval '24 hours')::int AS outbound_24h FROM whatsapp_messages`,
        ),
        app.context.db.query(
          `SELECT count(*)::int AS count FROM whatsapp_messages WHERE status IN ('failed','dead','dead_letter') OR processing_state='failed'`,
        ),
        app.context.db.query(
          `SELECT count(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending,count(*) FILTER (WHERE status='dead_letter')::int AS dead_letter FROM queue_jobs`,
        ),
        app.context.db.query(
          "SELECT count(*)::int count FROM knowledge_items WHERE enabled=true",
        ),
        app.context.db.query(
          "SELECT count(*)::int count FROM agent_tools WHERE enabled=true",
        ),
        app.context.db.query(
          "SELECT count(*)::int count FROM agent_jobs WHERE enabled=true",
        ),
        app.context.db.query(
          `SELECT date_trunc('hour',created_at) AS bucket,count(*) FILTER(WHERE direction='inbound')::int inbound,count(*) FILTER(WHERE direction='outbound')::int outbound FROM whatsapp_messages WHERE created_at>=now()-interval '24 hours' GROUP BY 1 ORDER BY 1`,
        ),
      ]);
      return {
        data: {
          whatsapp: connection.rows[0] ?? { status: "disconnected" },
          messages: messages.rows[0],
          failedMessages: failed.rows[0]?.count ?? 0,
          queue: queue.rows[0],
          inventory: {
            knowledge: knowledge.rows[0]?.count ?? 0,
            tools: tools.rows[0]?.count ?? 0,
            jobs: jobs.rows[0]?.count ?? 0,
          },
          activity: series.rows,
        },
      };
    },
  );

  app.get(
    "/api/v1/logs",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = pageQuery.parse(request.query);
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (query.level) {
        values.push(query.level);
        clauses.push(`level=$${values.length}`);
      }
      if (query.service) {
        values.push(query.service);
        clauses.push(`service=$${values.length}`);
      }
      if (query.search) {
        values.push(`%${query.search}%`);
        clauses.push(
          `(message ILIKE $${values.length} OR event ILIKE $${values.length})`,
        );
      }
      values.push(query.limit, (query.page - 1) * query.limit);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const result = await app.context.db.query(
        `SELECT id,level,service,event,message,created_at,count(*) OVER()::int total FROM operational_logs ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return {
        data: result.rows.map(({ total: _total, ...row }) => row),
        meta: {
          page: query.page,
          limit: query.limit,
          total: Number(result.rows[0]?.total ?? 0),
        },
      };
    },
  );
  app.get(
    "/api/v1/audit-logs",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = pageQuery.parse(request.query);
      const values = [query.limit, (query.page - 1) * query.limit];
      const result = await app.context.db.query(
        `SELECT id,actor_type,actor_id,action,resource_type,resource_id,ip_address,user_agent,metadata,created_at,count(*) OVER()::int total FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        values,
      );
      return {
        data: result.rows.map(({ total: _total, ...row }) => row),
        meta: {
          page: query.page,
          limit: query.limit,
          total: Number(result.rows[0]?.total ?? 0),
        },
      };
    },
  );

  const settingMap: Record<string, string> = {
    agentMention: "agent.mention_name",
    timezone: "locale.timezone",
    messageRetentionDays: "messages.retention_days",
    openclawUrl: "openclaw.url",
    processGroupMentionsOnly: "whatsapp.mention_only",
  };
  app.get("/api/v1/settings", { preHandler: requireAdminReady }, async () => {
    const result = await app.context.db.query(
      `SELECT key,value FROM app_settings WHERE is_secret=false ORDER BY key`,
    );
    const stored = Object.fromEntries(
      result.rows.map((row) => [row.key, row.value]),
    );
    const data = Object.fromEntries(
      Object.entries(settingMap).map(([friendly, key]) => [
        friendly,
        stored[key] ??
          (
            {
              timezone: "Asia/Jakarta",
              messageRetentionDays: 90,
              processGroupMentionsOnly: true,
              openclawUrl: app.context.env.OPENCLAW_WEBHOOK_URL,
              agentMention: "",
            } as Record<string, unknown>
          )[friendly],
      ]),
    );
    data.processGroupMentionsOnly = true;
    return { data };
  });
  app.put(
    "/api/v1/settings",
    { preHandler: requireAdminReady },
    async (request) => {
      const body = z.record(z.string(), z.unknown()).parse(request.body);
      const candidate =
        body.settings &&
        typeof body.settings === "object" &&
        !Array.isArray(body.settings)
          ? body.settings
          : body;
      const allowed = settingsSchema.parse(candidate) as Record<
        string,
        unknown
      >;
      if (!Object.keys(allowed).length)
        throw new ApiError(
          422,
          "SETTINGS_EMPTY",
          "Tidak ada pengaturan yang dikenali",
        );
      allowed.processGroupMentionsOnly = true;
      await withTransaction(app.context.db, async (client) => {
        for (const [key, value] of Object.entries(allowed)) {
          await client.query(
            `INSERT INTO app_settings(key,value,is_secret,updated_at) VALUES($1,$2::jsonb,false,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,is_secret=false,revision=app_settings.revision+1,updated_at=now()`,
            [settingMap[key], JSON.stringify(value)],
          );
        }
        await writeAudit(client, request, {
          action: "settings.updated",
          resourceType: "app_settings",
          metadata: { keys: Object.keys(allowed) },
        });
      });
      return { data: { updated: Object.keys(allowed) } };
    },
  );

  app.get("/api/v1/backups", { preHandler: requireAdminReady }, async () => {
    const records = await app.context.db.query(
      `SELECT id,operation,filename AS "fileName",status,size_bytes AS "sizeBytes",checksum,error,artifact_path AS "artifactPath",metadata,created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt" FROM backup_records ORDER BY created_at DESC LIMIT 100`,
    );
    return { data: records.rows };
  });
  app.post(
    "/api/v1/backups",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const id = randomUUID();
      const queueJobId = await withTransaction(
        app.context.db,
        async (client) => {
          await client.query(
            `INSERT INTO backup_records(id,filename,status,created_at,initiated_by) VALUES($1,$2,'queued',now(),$3)`,
            [id, `pending-${id}.ocgwb`, request.admin?.id ?? null],
          );
          const jobId = await enqueueJob(client, {
            queue: "maintenance",
            type: "backup-create",
            payload: { backupId: id, requestedBy: request.admin?.id },
            maxAttempts: 2,
          });
          await writeAudit(client, request, {
            action: "backup.queued",
            resourceType: "backup",
            resourceId: id,
          });
          return jobId;
        },
      );
      return reply
        .code(202)
        .send({ data: { id, queueJobId, status: "queued" } });
    },
  );
  app.get(
    "/api/v1/backups/:id/download",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const record = await app.context.db.query<{
        filename: string;
        status: string;
        operation: string;
      }>("SELECT filename,status,operation FROM backup_records WHERE id=$1", [
        id,
      ]);
      const row = record.rows[0];
      if (!row || row.operation !== "backup" || row.status !== "completed")
        throw new ApiError(404, "BACKUP_NOT_FOUND", "Backup tidak ditemukan");
      const stream = await openBackupDownload(
        join(app.context.env.dataDir, "backups"),
        row.filename,
        id,
      );
      reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${row.filename}"`)
        .header("cache-control", "no-store");
      return reply.send(stream);
    },
  );
  app.post(
    "/api/v1/backups/:id/restore",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id: sourceBackupId } = z
        .object({ id: z.uuid() })
        .parse(request.params);
      z.object({ confirmation: z.literal("RESTORE") }).parse(request.body);
      const restoreOperationId = randomUUID();
      const queueJobId = await withTransaction(
        app.context.db,
        async (client) => {
          const record = await client.query<{
            filename: string;
            status: string;
            operation: string;
          }>(
            "SELECT filename,status,operation FROM backup_records WHERE id=$1 FOR SHARE",
            [sourceBackupId],
          );
          const source = record.rows[0];
          if (
            !source ||
            source.operation !== "backup" ||
            source.status !== "completed"
          )
            throw new ApiError(
              409,
              "BACKUP_NOT_READY",
              "Backup belum siap dipulihkan",
            );
          const sourceFilename = basename(source.filename);
          if (
            sourceFilename !== source.filename ||
            !sourceFilename.endsWith(".ocgwb")
          )
            throw new ApiError(
              409,
              "BACKUP_PATH_INVALID",
              "Artifact backup tidak valid",
            );
          await client.query(
            `INSERT INTO backup_records(id,operation,filename,status,artifact_path,initiated_by,metadata,created_at,started_at) VALUES($1,'restore',$2,'queued',$3,$4,$5::jsonb,now(),now())`,
            [
              restoreOperationId,
              `restore-${restoreOperationId}.operation`,
              sourceFilename,
              request.admin?.id ?? null,
              JSON.stringify({ sourceBackupId, sourceFilename }),
            ],
          );
          const jobId = await enqueueJob(client, {
            queue: "maintenance",
            type: "backup-restore",
            payload: {
              sourceBackupId,
              filename: sourceFilename,
              restoreOperationId,
              requestedBy: request.admin?.id,
            },
            maxAttempts: 1,
          });
          await writeAudit(client, request, {
            action: "backup.restore_queued",
            resourceType: "restore_operation",
            resourceId: restoreOperationId,
            metadata: { sourceBackupId },
          });
          return jobId;
        },
      );
      return reply.code(202).send({
        data: {
          id: restoreOperationId,
          sourceBackupId,
          queueJobId,
          status: "queued",
        },
      });
    },
  );
}

import { randomUUID } from "node:crypto";

import { BufferJSON, type proto } from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import type { ServiceConfig } from "./config.js";
import type { OpenClawInboundEvent } from "./openclaw-client.js";
import type { ParsedInboundMessage } from "./message-parser.js";
import { quoteIdentifier, splitIdentifier } from "./sql-identifier.js";

export interface ClaimedJob {
  readonly id: string;
  readonly queueName: string;
  readonly jobType: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly aggregateId: string | null;
  readonly payload: OpenClawInboundEvent;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface GroupSnapshot {
  readonly jid: string;
  readonly name: string;
  readonly ownerJid: string | null;
  readonly participantCount: number;
  readonly agentIsParticipant: boolean;
  readonly metadata: Record<string, unknown>;
}

export interface SingletonLease {
  release(): Promise<void>;
}

const REQUIRED_TABLES: Record<string, readonly string[]> = {
  auth: ["scope", "key", "value_encrypted", "updated_at"],
  messages: [
    "id",
    "wa_message_id",
    "remote_jid",
    "participant_jid",
    "direction",
    "message_type",
    "text_body",
    "media",
    "payload",
    "status",
    "error",
    "mentions",
    "agent_mentioned",
    "processing_state",
    "attempts",
    "queue_job_id",
    "received_at",
    "sent_at",
  ],
  queue: [
    "id",
    "queue_name",
    "job_type",
    "payload",
    "status",
    "attempts",
    "max_attempts",
    "available_at",
    "locked_at",
    "locked_by",
    "lock_expires_at",
    "last_error",
    "completed_at",
  ],
  groups: [
    "jid",
    "name",
    "owner_jid",
    "participant_count",
    "agent_is_participant",
    "metadata",
    "last_synced_at",
  ],
  outbox: [
    "id",
    "event_type",
    "aggregate_type",
    "aggregate_id",
    "payload",
    "status",
    "attempts",
    "max_attempts",
    "available_at",
    "delivered_at",
    "last_error",
    "idempotency_key",
    "correlation_id",
  ],
  connection: [
    "id",
    "singleton_key",
    "phone_number",
    "jid",
    "display_name",
    "status",
    "session_generation",
    "reconnect_attempt",
    "last_connected_at",
    "last_disconnected_at",
    "last_seen_at",
    "last_error",
  ],
  connectionEvents: [
    "id",
    "account_id",
    "event_type",
    "reason_code",
    "retry_number",
    "metadata",
    "occurred_at",
  ],
};

export function createPool(config: ServiceConfig, logger: Logger): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "openclaw-baileys-service",
  };
  if (config.databaseSslMode !== "disable") {
    poolConfig.ssl = {
      rejectUnauthorized: config.databaseSslMode === "verify-full",
    };
  }
  const pool = new Pool(poolConfig);
  pool.on("error", (error) =>
    logger.error({ err: error }, "Idle PostgreSQL client error"),
  );
  return pool;
}

export class WhatsAppRepository {
  private readonly messagesTable: string;
  private readonly queueTable: string;
  private readonly groupsTable: string;
  private readonly outboxTable: string;
  private readonly connectionTable: string;
  private readonly connectionEventsTable: string;

  public constructor(
    private readonly pool: Pool,
    private readonly config: ServiceConfig,
  ) {
    this.messagesTable = quoteIdentifier(config.messagesTable);
    this.queueTable = quoteIdentifier(config.queueTable);
    this.groupsTable = quoteIdentifier(config.groupsTable);
    this.outboxTable = quoteIdentifier(config.outboxTable);
    this.connectionTable = quoteIdentifier(config.connectionTable);
    this.connectionEventsTable = quoteIdentifier(config.connectionEventsTable);
  }

  public async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async listStatusAudienceJids(limit = 5_000): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 5_000));
    const result = await this.pool.query<{ remote_jid: string }>(
      `SELECT DISTINCT remote_jid
         FROM ${this.messagesTable}
        WHERE remote_jid LIKE '%@s.whatsapp.net'
        ORDER BY remote_jid
        LIMIT $1`,
      [boundedLimit],
    );
    return result.rows.map((row) => row.remote_jid);
  }

  public async acquireSingletonLease(
    onLost: (error: Error) => void,
  ): Promise<SingletonLease> {
    const client = await this.pool.connect();
    let result: { rows: Array<{ acquired: boolean }> };
    try {
      result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('openclaw-baileys-service')) AS acquired`,
      );
    } catch (error) {
      client.release();
      throw error;
    }
    if (!result.rows[0]?.acquired) {
      client.release();
      throw new Error(
        `Another Baileys service owns session scope ${this.config.sessionScope}`,
      );
    }
    let released = false;
    const handleError = (error: Error): void => {
      if (!released) onLost(error);
    };
    client.on("error", handleError);
    return {
      release: async () => {
        if (released) return;
        released = true;
        client.off("error", handleError);
        try {
          await client.query(
            `SELECT pg_advisory_unlock(hashtext('openclaw-baileys-service'))`,
          );
        } finally {
          client.release();
        }
      },
    };
  }

  public async operationalLog(
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO operational_logs (level, service, event, message, context, created_at)
       VALUES ($1, 'baileys-service', $2, $3, $4::jsonb, NOW())`,
      [level, event, message, JSON.stringify(context)],
    );
  }

  public async updateConnection(
    status:
      | "logged_out"
      | "qr_pending"
      | "connecting"
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "auth_failed",
    details: {
      readonly jid?: string | null;
      readonly displayName?: string | null;
      readonly error?: string | null;
      readonly reconnectAttempt?: number;
      readonly incrementGeneration?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const jid = details.jid ?? null;
    const phoneNumber = jid ? (jid.split("@")[0]?.split(":")[0] ?? null) : null;
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO ${this.connectionTable} AS current_connection
        (id, singleton_key, phone_number, jid, display_name, status, session_generation, reconnect_attempt,
         last_connected_at, last_disconnected_at, last_seen_at, last_error, created_at, updated_at)
       VALUES ($1, TRUE, $2, $3, $4, $5, CASE WHEN $8 THEN 1 ELSE 0 END, $7,
               CASE WHEN $5 = 'connected' THEN NOW() ELSE NULL END,
               CASE WHEN $5 IN ('disconnected','logged_out','auth_failed') THEN NOW() ELSE NULL END,
               NOW(), $6, NOW(), NOW())
       ON CONFLICT (singleton_key) DO UPDATE
         SET phone_number = CASE WHEN EXCLUDED.status = 'logged_out' THEN NULL ELSE COALESCE(EXCLUDED.phone_number, current_connection.phone_number) END,
             jid = CASE WHEN EXCLUDED.status = 'logged_out' THEN NULL ELSE COALESCE(EXCLUDED.jid, current_connection.jid) END,
             display_name = COALESCE(EXCLUDED.display_name, current_connection.display_name),
             status = EXCLUDED.status,
             session_generation = current_connection.session_generation + CASE WHEN $8 THEN 1 ELSE 0 END,
             reconnect_attempt = $7,
             last_connected_at = CASE WHEN EXCLUDED.status = 'connected' THEN NOW() ELSE current_connection.last_connected_at END,
             last_disconnected_at = CASE WHEN EXCLUDED.status IN ('disconnected','logged_out','auth_failed') THEN NOW() ELSE current_connection.last_disconnected_at END,
             last_seen_at = NOW(), last_error = $6, updated_at = NOW()
       RETURNING id`,
      [
        id,
        phoneNumber,
        jid,
        details.displayName ?? null,
        status,
        details.error?.slice(0, 1_000) ?? null,
        Math.max(0, details.reconnectAttempt ?? 0),
        details.incrementGeneration ?? false,
      ],
    );
    return result.rows[0]?.id ?? id;
  }

  public async touchConnection(): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.connectionTable} SET last_seen_at = NOW(), updated_at = NOW() WHERE singleton_key = TRUE`,
    );
  }

  public async recordConnectionEvent(
    eventType:
      | "qr"
      | "connecting"
      | "open"
      | "close"
      | "reconnect_scheduled"
      | "logged_out"
      | "error",
    reasonCode: string | null,
    retryNumber: number,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.connectionEventsTable}
        (id, account_id, event_type, reason_code, retry_number, metadata, occurred_at)
       VALUES ($1, (SELECT id FROM ${this.connectionTable} WHERE singleton_key = TRUE LIMIT 1), $2, $3, $4, $5::jsonb, NOW())`,
      [
        randomUUID(),
        eventType,
        reasonCode,
        Math.max(0, retryNumber),
        JSON.stringify(metadata),
      ],
    );
  }

  public async assertContract(): Promise<void> {
    const configured = {
      auth: this.config.authTable,
      messages: this.config.messagesTable,
      queue: this.config.queueTable,
      groups: this.config.groupsTable,
      outbox: this.config.outboxTable,
      connection: this.config.connectionTable,
      connectionEvents: this.config.connectionEventsTable,
    };
    for (const [kind, tableName] of Object.entries(configured)) {
      const parsed = splitIdentifier(tableName);
      const result = await this.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [parsed.schema, parsed.table],
      );
      const available = new Set(result.rows.map((row) => row.column_name));
      const missing = (REQUIRED_TABLES[kind] ?? []).filter(
        (column) => !available.has(column),
      );
      if (missing.length > 0) {
        throw new Error(
          `Database contract mismatch for ${tableName}; missing columns: ${missing.join(", ")}`,
        );
      }
    }
  }

  public async persistInbound(
    message: ParsedInboundMessage,
  ): Promise<{ inserted: boolean; forwarded: boolean; eventId?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const messageId = randomUUID();
      const eventId = randomUUID();
      const correlationId = randomUUID();
      const payload = {
        pushName: message.pushName,
        mentionedJids: message.mentionedJids,
        messageType: message.messageType,
        media: message.media,
      };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${this.messagesTable}
          (id, wa_message_id, remote_jid, participant_jid, direction, message_type, text_body, media, payload,
           status, received_at, mentions, agent_mentioned, processing_state, dedupe_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7::jsonb, $8::jsonb,
                 CASE WHEN $13 THEN 'received' ELSE 'ignored' END,
                 $9, $10::text[], $11,
                 CASE WHEN $13 THEN 'forward_queued' ELSE 'ignored' END,
                 $12, NOW(), NOW())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          messageId,
          message.waMessageId,
          message.remoteJid,
          message.participantJid,
          message.messageType,
          message.text,
          JSON.stringify(message.media ?? {}),
          JSON.stringify(payload),
          message.timestamp,
          message.mentionedJids,
          message.agentMentioned,
          `inbound:${message.remoteJid}:${message.waMessageId}`,
          message.shouldForward,
        ],
      );
      if (!inserted.rows[0]) {
        await client.query("COMMIT");
        return { inserted: false, forwarded: false };
      }
      if (!message.shouldForward) {
        await client.query("COMMIT");
        return { inserted: true, forwarded: false };
      }

      const event: OpenClawInboundEvent = {
        eventId,
        waMessageId: message.waMessageId,
        remoteJid: message.remoteJid,
        isGroup: message.isGroup,
        text: message.text,
        messageType:
          message.messageType === "unknown" ? "text" : message.messageType,
        media: message.media ?? {},
        timestamp: message.timestamp.toISOString(),
        payload,
        ...(message.participantJid
          ? { participantJid: message.participantJid }
          : {}),
        ...(message.quotedMessageId
          ? { quotedMessageId: message.quotedMessageId }
          : {}),
        ...(message.participantJid
          ? { replyToParticipant: message.participantJid }
          : {}),
      };
      await client.query(
        `INSERT INTO ${this.outboxTable}
          (id, event_type, aggregate_type, aggregate_id, payload, status, attempts, max_attempts, available_at,
           idempotency_key, correlation_id, created_at, updated_at)
         VALUES ($1, 'whatsapp.message.received', 'whatsapp_message', $2, $3::jsonb, 'pending', 0, 8, NOW(), $4, $5, NOW(), NOW())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          eventId,
          messageId,
          JSON.stringify(event),
          `wa-event:${message.remoteJid}:${message.waMessageId}`,
          correlationId,
        ],
      );
      await client.query("COMMIT");
      return { inserted: true, forwarded: true, eventId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimJob(
    workerId: string,
    leaseSeconds: number,
    includeOutbound: boolean,
  ): Promise<ClaimedJob | null> {
    const result = await this.pool.query<{
      id: string;
      queue_name: string;
      job_type: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH candidate AS (
         SELECT id FROM ${this.queueTable}
          WHERE (queue_name = 'whatsapp-control' OR ($3::boolean AND queue_name = 'whatsapp-outbound'))
            AND status IN ('pending', 'available', 'retrying')
            AND attempts < max_attempts
            AND available_at <= NOW()
          ORDER BY priority ASC, available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       , claimed AS (
       UPDATE ${this.queueTable} AS job
          SET status = 'processing', attempts = job.attempts + 1, locked_at = NOW(), locked_by = $1,
              lock_expires_at = NOW() + ($2 * INTERVAL '1 second'), updated_at = NOW()
         FROM candidate
        WHERE job.id = candidate.id
       RETURNING job.id, job.queue_name, job.job_type, job.payload, job.attempts, job.max_attempts
       ), attempt AS (
         INSERT INTO queue_job_attempts (job_id, attempt_number, worker_id, started_at)
         SELECT id, attempts, $1, NOW() FROM claimed
         ON CONFLICT (job_id, attempt_number) DO NOTHING
       )
       SELECT id, queue_name, job_type, payload, attempts, max_attempts FROM claimed`,
      [workerId, leaseSeconds, includeOutbound],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      queueName: row.queue_name,
      jobType: row.job_type,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  public async completeJob(job: ClaimedJob, workerId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const completed = await client.query(
        `UPDATE ${this.queueTable}
            SET status = 'completed', completed_at = NOW(), locked_at = NULL, locked_by = NULL,
                lock_expires_at = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
        [job.id, workerId],
      );
      if (completed.rowCount !== 1) {
        throw new Error(`Queue lease lost before completion: ${job.id}`);
      }
      await this.finishAttemptWithClient(
        client,
        job,
        workerId,
        "completed",
        null,
        null,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async failJob(
    job: ClaimedJob,
    workerId: string,
    error: string,
    dead: boolean,
    backoffMs: number,
  ): Promise<void> {
    const status = dead ? "dead_letter" : "retrying";
    const failed = await this.pool.query(
      `UPDATE ${this.queueTable}
          SET status = $3, available_at = CASE WHEN $3 = 'retrying' THEN NOW() + ($4 * INTERVAL '1 millisecond') ELSE available_at END,
              failed_at = CASE WHEN $3 = 'dead_letter' THEN NOW() ELSE failed_at END,
              locked_at = NULL, locked_by = NULL, lock_expires_at = NULL, last_error = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [job.id, workerId, status, backoffMs, error.slice(0, 1_000)],
    );
    if (failed.rowCount !== 1) {
      throw new Error(`Queue lease lost before failure: ${job.id}`);
    }
    await this.finishAttempt(
      job,
      workerId,
      dead ? "dead" : "retry",
      error,
      backoffMs,
    );
  }

  public async recoverStaleJobs(forceOwnedJobs = false): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.queueTable}
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
              available_at = NOW(), failed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE failed_at END,
              locked_at = NULL, locked_by = NULL, lock_expires_at = NULL,
              last_error = 'Recovered expired worker lease', updated_at = NOW()
        WHERE queue_name IN ('whatsapp-outbound', 'whatsapp-control')
          AND status IN ('locked', 'processing')
          AND ($1::boolean OR COALESCE(lock_expires_at, locked_at) < NOW())`,
      [forceOwnedJobs],
    );
    return result.rowCount ?? 0;
  }

  public async extendJobLease(
    job: ClaimedJob,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.queueTable}
          SET lock_expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
        WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [job.id, workerId, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  public async markOutboundSent(
    databaseMessageId: string | undefined,
    queueJobId: string,
    attempts: number,
    remoteJid: string,
    waMessageId: string,
    messageType: "text" | "image" | "document" | "video" | "audio" | "reaction",
    text: string | null,
    media: Record<string, unknown>,
    baileysMessage: proto.IMessage | null | undefined,
  ): Promise<string> {
    const messageId = validUuid(databaseMessageId)
      ? databaseMessageId
      : randomUUID();
    const serializedMessage = baileysMessage
      ? (JSON.parse(
          JSON.stringify(baileysMessage, BufferJSON.replacer),
        ) as Record<string, unknown>)
      : null;
    const payload = { baileysMessage: serializedMessage };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.messagesTable} AS current_message
          (id, wa_message_id, remote_jid, direction, message_type, text_body, media, payload, status, sent_at,
           processing_state, attempts, retry_count, queue_job_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'outbound', $4, $5, $6::jsonb, $7::jsonb, 'sent', NOW(), 'forwarded', $8, $8, $9, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE
           SET wa_message_id = EXCLUDED.wa_message_id, remote_jid = EXCLUDED.remote_jid,
               message_type = EXCLUDED.message_type, text_body = EXCLUDED.text_body,
               media = current_message.media || EXCLUDED.media,
               payload = current_message.payload || EXCLUDED.payload,
               status = 'sent', error = NULL, sent_at = NOW(),
               attempts = GREATEST(current_message.attempts, EXCLUDED.attempts),
               retry_count = GREATEST(current_message.retry_count, EXCLUDED.retry_count),
               queue_job_id = EXCLUDED.queue_job_id, updated_at = NOW()`,
        [
          messageId,
          waMessageId,
          remoteJid,
          messageType,
          text,
          JSON.stringify(media),
          JSON.stringify(payload),
          Math.max(1, attempts),
          queueJobId,
        ],
      );
      await client.query("COMMIT");
      // The message row is the replay fence. Delivery-event observability must
      // never turn a successful WhatsApp send into a queue retry/resend.
      await this.recordDelivery(messageId, "sent").catch(() => undefined);
      return messageId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // COMMIT can succeed server-side while the client loses its response.
      // Confirm the durable fence before surfacing an error that would retry.
      const confirmed = await this.pool
        .query<{ id: string }>(
          `SELECT id FROM ${this.messagesTable}
          WHERE id=$1 AND queue_job_id=$2 AND wa_message_id=$3
            AND status IN ('sent','delivered','read')`,
          [messageId, queueJobId, waMessageId],
        )
        .then((result) => result.rows[0])
        .catch(() => undefined);
      if (confirmed) {
        await this.recordDelivery(messageId, "sent").catch(() => undefined);
        return messageId;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async markOutboundAttempt(
    databaseMessageId: string | undefined,
    queueJobId: string,
    attempts: number,
    status: "processing" | "retrying" | "dead_letter",
    error: string | null,
  ): Promise<void> {
    if (!validUuid(databaseMessageId)) {
      return;
    }
    const result = await this.pool.query<{ status: string }>(
      `UPDATE ${this.messagesTable}
          SET status = CASE WHEN status IN ('sent','delivered','read') THEN status ELSE $2 END,
              error = CASE WHEN status IN ('sent','delivered','read') THEN error ELSE $3 END,
              attempts = GREATEST(attempts, $4), retry_count = GREATEST(retry_count, $4),
              queue_job_id = $5,
              updated_at = NOW()
        WHERE id = $1
       RETURNING status`,
      [
        databaseMessageId,
        status,
        error?.slice(0, 1_000) ?? null,
        Math.max(1, attempts),
        queueJobId,
      ],
    );
    if (result.rows[0]?.status === status && status !== "processing") {
      await this.recordDelivery(databaseMessageId, status);
    }
  }

  public async outboundAlreadySent(
    databaseMessageId: string | undefined,
    queueJobId: string,
  ): Promise<boolean> {
    if (!validUuid(databaseMessageId)) {
      return false;
    }
    const result = await this.pool.query<{ sent: boolean }>(
      `SELECT (status IN ('sent','delivered','read')) AS sent
         FROM ${this.messagesTable}
        WHERE id = $1 AND queue_job_id = $2`,
      [databaseMessageId, queueJobId],
    );
    return result.rows[0]?.sent ?? false;
  }

  public async updateDelivery(
    remoteJid: string,
    waMessageId: string,
    status: "sent" | "delivered" | "read" | "failed",
    alternateRemoteJid?: string,
  ): Promise<void> {
    const remoteJids = alternateRemoteJid
      ? [remoteJid, alternateRemoteJid]
      : [remoteJid];
    const result = await this.pool.query<{ id: string }>(
      `UPDATE ${this.messagesTable}
          SET status = CASE
                WHEN $3 = 'read' THEN 'read'
                WHEN $3 = 'delivered' AND status <> 'read' THEN 'delivered'
                WHEN $3 = 'sent' AND status IN ('queued','processing','retrying') THEN 'sent'
                WHEN $3 = 'failed' AND status NOT IN ('delivered','read') THEN 'failed'
                ELSE status END,
              delivered_at = CASE WHEN $3 = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              read_at = CASE WHEN $3 = 'read' THEN COALESCE(read_at, NOW()) ELSE read_at END,
              updated_at = NOW()
        WHERE direction = 'outbound' AND remote_jid = ANY($1::text[]) AND wa_message_id = $2
       RETURNING id`,
      [remoteJids, waMessageId, status],
    );
    if (result.rows[0]) {
      await this.recordDelivery(result.rows[0].id, status);
    }
  }

  public async getStoredMessage(
    remoteJid: string,
    waMessageId: string,
    alternateRemoteJid?: string,
  ): Promise<proto.IMessage | undefined> {
    const remoteJids = alternateRemoteJid
      ? [remoteJid, alternateRemoteJid]
      : [remoteJid];
    const result = await this.pool.query<{
      payload: { baileysMessage?: unknown };
    }>(
      `SELECT payload FROM ${this.messagesTable}
        WHERE direction = 'outbound' AND remote_jid = ANY($1::text[]) AND wa_message_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [remoteJids, waMessageId],
    );
    const stored = result.rows[0]?.payload?.baileysMessage;
    if (!stored) {
      return undefined;
    }
    return JSON.parse(
      JSON.stringify(stored),
      BufferJSON.reviver,
    ) as proto.IMessage;
  }

  public async upsertGroups(groups: readonly GroupSnapshot[]): Promise<void> {
    if (groups.length === 0) {
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const group of groups) {
        await client.query(
          `INSERT INTO ${this.groupsTable}
            (jid, name, owner_jid, participant_count, agent_is_participant, metadata, last_synced_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW(), NOW())
           ON CONFLICT (jid) DO UPDATE
             SET name = EXCLUDED.name, owner_jid = EXCLUDED.owner_jid,
                 participant_count = EXCLUDED.participant_count, agent_is_participant = EXCLUDED.agent_is_participant,
                 metadata = EXCLUDED.metadata, last_synced_at = NOW(), updated_at = NOW()`,
          [
            group.jid,
            group.name,
            group.ownerJid,
            group.participantCount,
            group.agentIsParticipant,
            JSON.stringify(group.metadata),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimOutbox(): Promise<ClaimedOutboxEvent | null> {
    const result = await this.pool.query<{
      id: string;
      aggregate_id: string | null;
      payload: OpenClawInboundEvent;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH candidate AS (
         SELECT id FROM ${this.outboxTable}
          WHERE event_type = 'whatsapp.message.received'
            AND status IN ('pending', 'retrying') AND available_at <= NOW()
            AND attempts < max_attempts
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE ${this.outboxTable} AS event
          SET status = 'processing', attempts = event.attempts + 1, updated_at = NOW()
         FROM candidate WHERE event.id = candidate.id
       RETURNING event.id, event.aggregate_id, event.payload, event.attempts, event.max_attempts`,
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          aggregateId: row.aggregate_id,
          payload: row.payload,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
        }
      : null;
  }

  public async completeOutbox(
    event: ClaimedOutboxEvent,
    responseStatus: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.outboxTable}
          SET status = 'delivered', delivered_at = NOW(), last_error = NULL, response_status = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'processing'`,
      [event.id, responseStatus],
    );
    // Gateway owns forward_queued/forwarded/responded/failed. A transport-level
    // 2xx must not overwrite a newer bridge state (especially responded/failed).
  }

  public async failOutbox(
    event: ClaimedOutboxEvent,
    error: string,
    dead: boolean,
    backoffMs: number,
  ): Promise<void> {
    const status = dead ? "dead" : "retrying";
    await this.pool.query(
      `UPDATE ${this.outboxTable}
          SET status = $2, available_at = CASE WHEN $2 = 'retrying' THEN NOW() + ($3 * INTERVAL '1 millisecond') ELSE available_at END,
              last_error = $4, updated_at = NOW()
        WHERE id = $1 AND status = 'processing'`,
      [event.id, status, backoffMs, error.slice(0, 1_000)],
    );
    if (dead && event.aggregateId) {
      await this.pool.query(
        `UPDATE ${this.messagesTable} SET processing_state = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
        [event.aggregateId, error.slice(0, 1_000)],
      );
    }
  }

  public async recoverOutbox(forceOwnedEvents = false): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.outboxTable}
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retrying' END,
              available_at = NOW(), last_error = 'Recovered after worker restart', updated_at = NOW()
        WHERE event_type = 'whatsapp.message.received' AND status = 'processing'
          AND ($1::boolean OR updated_at < NOW() - INTERVAL '2 minutes')`,
      [forceOwnedEvents],
    );
    return result.rowCount ?? 0;
  }

  private async finishAttempt(
    job: ClaimedJob,
    workerId: string,
    outcome: "completed" | "retry" | "dead",
    error: string | null,
    backoffMs: number | null,
  ): Promise<void> {
    await this.finishAttemptWithClient(
      this.pool,
      job,
      workerId,
      outcome,
      error,
      backoffMs,
    );
  }

  private async finishAttemptWithClient(
    client: Pick<PoolClient, "query">,
    job: ClaimedJob,
    workerId: string,
    outcome: "completed" | "retry" | "dead",
    error: string | null,
    backoffMs: number | null,
  ): Promise<void> {
    await client.query(
      `UPDATE queue_job_attempts
          SET finished_at = NOW(), outcome = $4, error_message = $5, backoff_ms = $6
        WHERE job_id = $1 AND attempt_number = $2 AND worker_id = $3`,
      [
        job.id,
        job.attempts,
        workerId,
        outcome,
        error?.slice(0, 1_000) ?? null,
        backoffMs,
      ],
    );
  }

  private async recordDelivery(
    messageId: string,
    status: string,
  ): Promise<void> {
    await this.recordDeliveryWithClient(this.pool, messageId, status);
  }

  private async recordDeliveryWithClient(
    client: Pick<PoolClient, "query">,
    messageId: string,
    status: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO message_delivery_events (id, message_id, status, occurred_at)
       VALUES ($1, $2, $3, NOW())`,
      [randomUUID(), messageId, status],
    );
  }
}

function validUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  );
}

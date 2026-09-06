import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueueJob, withTransaction } from "@ocgw/shared";
import { requireInternal } from "../security.js";
import {
  parseOutboundMessage,
  queueOutboundMessage,
  requireIdempotencyKey,
} from "./messages.js";
import { writeAudit } from "../audit.js";

const eventTimestamp = z
  .union([z.string().min(1).max(64), z.number().finite()])
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), {
    message: "timestamp event tidak valid",
  });
const inboundSchema = z.object({
  eventId: z.string().min(1).max(200),
  waMessageId: z.string().min(1).max(200),
  remoteJid: z.string().min(5).max(200),
  participantJid: z.string().max(200).nullable().optional(),
  isGroup: z.boolean(),
  text: z.string().max(100_000),
  messageType: z.enum(["text", "image", "document"]).default("text"),
  media: z.record(z.string(), z.unknown()).default({}),
  quotedMessageId: z.string().max(200).nullable().optional(),
  replyToParticipant: z.string().max(200).nullable().optional(),
  timestamp: eventTimestamp,
  payload: z.record(z.string(), z.unknown()).optional(),
});
export async function registerInternalRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/internal/agent/brief",
    { preHandler: requireInternal },
    async () =>
      withTransaction(app.context.db, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const [profile, knowledge] = await Promise.all([
          client.query(
            "SELECT name,persona,jobdesk,system_instruction FROM agent_profile ORDER BY created_at LIMIT 1",
          ),
          client.query(
            "SELECT title,category,content FROM knowledge_items WHERE enabled=true ORDER BY category,title",
          ),
        ]);
        return {
          data: {
            profile: profile.rows[0] ?? null,
            knowledge: knowledge.rows,
          },
        };
      }),
  );
  app.post(
    "/internal/openclaw/event",
    { preHandler: requireInternal },
    async (request, reply) => {
      const input = inboundSchema.parse(request.body);
      const result = await withTransaction(app.context.db, async (client) => {
        const message = await client.query<{ id: string }>(
          `INSERT INTO whatsapp_messages(id,wa_message_id,remote_jid,participant_jid,direction,message_type,text_body,media,payload,status,received_at,created_at,updated_at) VALUES($1,$2,$3,$4,'inbound',$5,$6,$7::jsonb,$8::jsonb,'received',$9,now(),now()) ON CONFLICT(direction,remote_jid,wa_message_id) DO UPDATE SET updated_at=whatsapp_messages.updated_at RETURNING id`,
          [
            randomUUID(),
            input.waMessageId,
            input.remoteJid,
            input.participantJid ?? null,
            input.messageType,
            input.text,
            JSON.stringify(input.media),
            JSON.stringify(input.payload ?? {}),
            input.timestamp,
          ],
        );
        const messageId = message.rows[0]!.id;
        const memory = await client.query<{ ai_paused_until: Date | null }>(
          `INSERT INTO contact_memory(remote_jid,last_message_at,needs_admin_reply)
           VALUES($1,$2,true)
           ON CONFLICT(remote_jid) DO UPDATE SET last_message_at=EXCLUDED.last_message_at,needs_admin_reply=true,updated_at=now()
           RETURNING ai_paused_until`,
          [input.remoteJid, input.timestamp],
        );
        const pausedUntil = memory.rows[0]?.ai_paused_until;
        if (pausedUntil && pausedUntil > new Date()) {
          await client.query(
            `UPDATE whatsapp_messages SET processing_state='ignored',payload=payload||jsonb_build_object('manualMode',true),updated_at=now() WHERE id=$1`,
            [messageId],
          );
          await writeAudit(client, request, {
            action: "internal.openclaw_event_manual_mode_skipped",
            resourceType: "whatsapp_message",
            resourceId: messageId,
            actorType: "internal",
          });
          return { messageId, queueJobId: null };
        }
        const queueJobId = await enqueueJob(client, {
          queue: "openclaw-events",
          type: "whatsapp-mention",
          payload: {
            ...input,
            timestamp: input.timestamp.toISOString(),
            messageId,
          },
          dedupeKey: `openclaw-message:${messageId}`,
          maxAttempts: 8,
        });
        await client.query(
          `UPDATE whatsapp_messages AS message SET queue_job_id=$2,attempts=job.attempts,error=job.last_error,processing_state=CASE WHEN job.status='completed' THEN 'forwarded' WHEN job.status IN ('failed','dead','dead_letter') THEN 'failed' ELSE 'forward_queued' END,updated_at=now() FROM queue_jobs AS job WHERE message.id=$1 AND job.id=$2`,
          [messageId, queueJobId],
        );
        await writeAudit(client, request, {
          action: "internal.openclaw_event_received",
          resourceType: "whatsapp_message",
          resourceId: messageId,
          actorType: "internal",
        });
        return { messageId, queueJobId };
      });
      return reply.code(202).send({ data: { ...result, status: "queued" } });
    },
  );
  app.post(
    "/internal/messages/send",
    { preHandler: requireInternal },
    async (request, reply) => {
      const input = parseOutboundMessage(request.body);
      const result = await queueOutboundMessage(app, input, {
        idempotencyKey: requireIdempotencyKey(request),
        actor: "openclaw",
        request,
      });
      return reply.code(202).send({ data: { ...result, status: "queued" } });
    },
  );
  app.get(
    "/internal/agent/context",
    { preHandler: requireInternal },
    async () =>
      withTransaction(app.context.db, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const [profile, knowledge, tools, jobs, provider, settings] =
          await Promise.all([
            client.query(
              "SELECT id,name,persona,jobdesk,system_instruction,revision,updated_at FROM agent_profile ORDER BY created_at LIMIT 1",
            ),
            client.query(
              "SELECT id,title,category,content,revision,updated_at FROM knowledge_items WHERE enabled=true ORDER BY category,title",
            ),
            client.query(
              "SELECT id,name,description,endpoint,method,config_encrypted,revision,updated_at FROM agent_tools WHERE enabled=true ORDER BY name",
            ),
            client.query(
              "SELECT id,name,instruction,schedule,timezone,revision,updated_at FROM agent_jobs WHERE enabled=true ORDER BY name",
            ),
            client.query(
              "SELECT id,name,provider_type,base_url,api_key_encrypted,model,temperature,max_tokens,revision,updated_at FROM ai_providers WHERE is_active=true ORDER BY updated_at DESC LIMIT 1",
            ),
            client.query(
              `SELECT key,value,revision,updated_at FROM app_settings
               WHERE is_secret=false
                 AND key=ANY($1::text[])
               ORDER BY key`,
              [
                [
                  "agent.mention_name",
                  "locale.timezone",
                  "messages.retention_days",
                  "whatsapp.mention_only",
                ],
              ],
            ),
          ]);
        const publicTools = tools.rows.map((row) => {
          const { config_encrypted, ...tool } = row;
          return { ...tool, hasSecretConfig: Boolean(config_encrypted) };
        });
        const selected = provider.rows[0];
        const providerConfig = selected
          ? {
              id: selected.id,
              name: selected.name,
              providerType: selected.provider_type,
              baseUrl: selected.base_url,
              hasApiKey: Boolean(selected.api_key_encrypted),
              model: selected.model,
              temperature: selected.temperature,
              maxTokens: selected.max_tokens,
              revision: selected.revision,
              updatedAt: selected.updated_at,
            }
          : null;
        const publicSettings = Object.fromEntries(
          settings.rows.map((row) => [
            row.key,
            {
              value: row.value,
              revision: row.revision,
              updatedAt: row.updated_at,
            },
          ]),
        );
        return {
          data: {
            profile: profile.rows[0] ?? null,
            knowledge: knowledge.rows,
            tools: publicTools,
            jobs: jobs.rows,
            aiProvider: providerConfig,
            settings: publicSettings,
            generatedAt: new Date().toISOString(),
          },
        };
      }),
  );
}

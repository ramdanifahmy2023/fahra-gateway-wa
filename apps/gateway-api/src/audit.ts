import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

export async function writeAudit(
  db: Pool | PoolClient,
  request: FastifyRequest | null,
  input: {
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: unknown;
    actorType?: string;
    actorId?: string;
    result?: "success" | "denied" | "failed";
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs
      (id, actor_type, actor_id, action, resource_type, resource_id, request_id, ip_address, user_agent, metadata,result)
     VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10::jsonb,$11)`,
    [
      randomUUID(),
      input.actorType ?? request?.authType ?? "system",
      input.actorId ?? request?.admin?.id ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      request?.id ?? null,
      request?.ip ?? null,
      request?.headers["user-agent"] ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.result ?? "success",
    ],
  );
}

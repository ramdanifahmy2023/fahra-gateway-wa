import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type QueueJob<T = Record<string, unknown>> = {
  id: string;
  queue_name: string;
  job_type: string;
  payload: T;
  status: string;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
};

export async function enqueueJob(
  client: Pool | PoolClient,
  input: {
    queue: string;
    type: string;
    payload: unknown;
    dedupeKey?: string;
    maxAttempts?: number;
    availableAt?: Date;
  },
): Promise<string> {
  const id = randomUUID();
  const result = await client.query<{ id: string }>(
    `INSERT INTO queue_jobs
      (id, queue_name, job_type, payload, status, attempts, max_attempts, available_at, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, $5, $6, $7)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
     DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
     RETURNING id`,
    [
      id,
      input.queue,
      input.type,
      JSON.stringify(input.payload),
      input.maxAttempts ?? 8,
      input.availableAt ?? new Date(),
      input.dedupeKey ?? null,
    ],
  );
  return result.rows[0]?.id ?? id;
}

export function retryDelayMs(attempt: number, capMs = 300_000): number {
  const exponential = Math.min(capMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

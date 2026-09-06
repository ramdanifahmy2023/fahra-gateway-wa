import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import pg, {
  type Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";
import type { Logger } from "pino";
import type { AppEnv } from "./env.js";

const { types } = pg;
types.setTypeParser(20, (value) => Number(value));

export function createDatabasePool(
  env: Pick<AppEnv, "DATABASE_URL" | "DATABASE_SSL" | "DATABASE_POOL_MAX">,
): Pool {
  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    application_name: "openclaw-whatsapp-gateway",
  };
  if (requiresDatabaseSsl(env.DATABASE_URL) && !env.DATABASE_SSL) {
    throw new Error("DATABASE_SSL wajib aktif untuk PostgreSQL non-loopback");
  }
  if (env.DATABASE_SSL) config.ssl = { rejectUnauthorized: true };
  const pool = new pg.Pool(config);
  pool.on("error", (error) =>
    process.stderr.write(`PostgreSQL pool error: ${error.message}\n`),
  );
  return pool;
}

export function requiresDatabaseSsl(connectionString: string): boolean {
  const url = new URL(connectionString);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !["", "127.0.0.1", "localhost", "::1"].includes(host);
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await pool.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function checkDatabase(
  pool: Pool,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = performance.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "unknown database error",
    };
  }
}

const requiredSchemaColumns: Record<string, readonly string[]> = {
  admin_users: ["id", "email", "password_hash", "force_password_change"],
  agent_profile: ["id", "name", "persona", "jobdesk", "system_instruction"],
  knowledge_items: ["id", "title", "category", "content"],
  agent_tools: ["id", "name", "endpoint", "method", "config_encrypted"],
  agent_jobs: ["id", "name", "instruction", "schedule"],
  ai_providers: [
    "id",
    "base_url",
    "api_key_encrypted",
    "model",
    "temperature",
    "max_tokens",
  ],
  app_settings: ["key", "value", "value_encrypted"],
  whatsapp_auth_state: ["scope", "key", "value_encrypted"],
  whatsapp_messages: [
    "id",
    "remote_jid",
    "direction",
    "status",
    "processing_state",
    "queue_job_id",
  ],
  queue_jobs: [
    "id",
    "queue_name",
    "job_type",
    "status",
    "attempts",
    "available_at",
    "dedupe_key",
  ],
  integration_outbox: ["id", "payload", "status", "idempotency_key"],
  audit_logs: ["id", "actor_type", "action", "created_at"],
  uploads: ["id", "stored_name", "sha256", "status"],
};

export type SchemaState = {
  ok: boolean;
  expected: number;
  applied: number;
  missing: string[];
  unexpected: string[];
  checksumMismatches: string[];
  contractErrors: string[];
  error?: string;
};

export async function checkSchemaState(
  pool: Pool,
  migrationsDirectory: string,
): Promise<SchemaState> {
  try {
    const filenames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const expected = new Map<string, string>();
    for (const filename of filenames)
      expected.set(
        filename,
        createHash("sha256")
          .update(await readFile(join(migrationsDirectory, filename)))
          .digest("hex"),
      );
    const rows = await pool.query<{ filename: string; checksum: string }>(
      "SELECT filename,checksum FROM schema_migrations ORDER BY filename",
    );
    const applied = new Map(
      rows.rows.map((row) => [row.filename, row.checksum]),
    );
    const missing = filenames.filter((filename) => !applied.has(filename));
    const unexpected = [...applied.keys()].filter(
      (filename) => !expected.has(filename),
    );
    const checksumMismatches = filenames.filter(
      (filename) =>
        applied.has(filename) &&
        applied.get(filename) !== expected.get(filename),
    );
    const contractErrors: string[] = [];
    for (const [table, columns] of Object.entries(requiredSchemaColumns)) {
      const result = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
        [table],
      );
      const available = new Set(result.rows.map((row) => row.column_name));
      const absent = columns.filter((column) => !available.has(column));
      if (absent.length) contractErrors.push(`${table}: ${absent.join(", ")}`);
    }
    return {
      ok:
        missing.length === 0 &&
        unexpected.length === 0 &&
        checksumMismatches.length === 0 &&
        contractErrors.length === 0,
      expected: filenames.length,
      applied: rows.rowCount ?? rows.rows.length,
      missing,
      unexpected,
      checksumMismatches,
      contractErrors,
    };
  } catch (error) {
    return {
      ok: false,
      expected: 0,
      applied: 0,
      missing: [],
      unexpected: [],
      checksumMismatches: [],
      contractErrors: [],
      error: error instanceof Error ? error.message : "unknown schema error",
    };
  }
}

export async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
  logger?: Logger,
): Promise<string[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [712_209_441]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const filename of files) {
      const source = await readFile(
        join(migrationsDirectory, filename),
        "utf8",
      );
      const checksum = createHash("sha256").update(source).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Checksum migration berubah: ${filename}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(source);
        await client.query(
          "INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
        applied.push(filename);
        logger?.info({ migration: basename(filename) }, "migration applied");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [712_209_441])
      .catch(() => undefined);
    client.release();
  }
}

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { checkDatabase, checkSchemaState } from "@ocgw/shared";
import { requireAdminReady, requireInternal } from "../security.js";

async function integrationState(app: FastifyInstance) {
  const openClawStartedAt = performance.now();
  let openclaw: {
    available: boolean;
    status: string;
    httpStatus: number | null;
    latencyMs: number;
    error: string | null;
  };
  try {
    const response = await fetch(app.context.env.OPENCLAW_HEALTH_URL, {
      ...(app.context.env.OPENCLAW_API_KEY
        ? {
            headers: { "x-openclaw-api-key": app.context.env.OPENCLAW_API_KEY },
          }
        : {}),
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    await response.body?.cancel().catch(() => undefined);
    const available = response.status >= 200 && response.status < 300;
    openclaw = {
      available,
      status: available ? "connected" : "unavailable",
      httpStatus: response.status,
      latencyMs: Math.round(performance.now() - openClawStartedAt),
      error: available ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    openclaw = {
      available: false,
      status: "unavailable",
      httpStatus: null,
      latencyMs: Math.round(performance.now() - openClawStartedAt),
      error: error instanceof Error ? error.message : "connection failed",
    };
  }
  const database = await checkDatabase(app.context.db);
  const migration = database.ok
    ? await checkSchemaState(
        app.context.db,
        join(app.context.env.workspaceRoot, "database", "migrations"),
      )
    : {
        ok: false,
        expected: 0,
        applied: 0,
        missing: [],
        unexpected: [],
        checksumMismatches: [],
        contractErrors: [],
        error: "database unavailable",
      };
  let whatsapp: Record<string, unknown> = { status: "unknown" };
  try {
    const raw = await readFile(
      join(app.context.env.dataDir, "whatsapp", "status.json"),
      "utf8",
    );
    whatsapp = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const row = database.ok
      ? await app.context.db
          .query(
            "SELECT status,phone_number,jid,last_connected_at,last_disconnected_at,last_error,updated_at FROM whatsapp_connection ORDER BY updated_at DESC LIMIT 1",
          )
          .then((result) => result.rows[0])
      : null;
    if (row) whatsapp = row;
  }
  let workspaceWritable = true;
  try {
    await access(app.context.env.dataDir, constants.W_OK);
  } catch {
    workspaceWritable = false;
  }
  return {
    database,
    migrations: migration,
    redis: {
      configured: app.context.redis.configured,
      available: app.context.redis.available,
      mode: app.context.redis.available ? "redis" : "postgresql-fallback",
      error: app.context.redis.error ?? null,
    },
    whatsapp,
    openclaw,
    workspace: { writable: workspaceWritable },
  };
}

export async function registerHealthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/health/live", async () => ({
    status: "ok",
    service: "gateway-api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    const state = await integrationState(app);
    const ok =
      state.database.ok && state.migrations.ok && state.workspace.writable;
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ready" : "not_ready",
      service: "gateway-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/v1/health", { preHandler: requireAdminReady }, async () => ({
    data: await integrationState(app),
  }));
  app.get(
    "/health/integrations",
    { preHandler: requireAdminReady },
    async () => ({ data: await integrationState(app) }),
  );
  app.get("/internal/health", { preHandler: requireInternal }, async () => ({
    data: await integrationState(app),
  }));
}

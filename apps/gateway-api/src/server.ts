import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import {
  connectOptionalRedis,
  createDatabasePool,
  loadEnvironment,
} from "@ocgw/shared";
import { registerAuthRoutes } from "./modules/auth.js";
import { registerHealthRoutes } from "./modules/health.js";
import { registerWhatsAppRoutes } from "./modules/whatsapp.js";
import { registerMessageRoutes } from "./modules/messages.js";
import { registerAgentRoutes } from "./modules/agent.js";
import { registerCatalogRoutes } from "./modules/catalog.js";
import { registerContactMemoryRoutes } from "./modules/contact-memory.js";
import { registerOperationRoutes } from "./modules/operations.js";
import { registerInternalRoutes } from "./modules/internal.js";
import { registerStatusRoutes } from "./modules/status.js";
import { registerCrmRoutes } from "./modules/crm.js";
import { errorPayload } from "./errors.js";

const env = loadEnvironment();
await mkdir(env.dataDir, { recursive: true, mode: 0o700 });
const db = createDatabasePool(env);

const app = Fastify({
  logger: {
    name: "gateway-api",
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-internal-api-key",
        "res.headers.set-cookie",
        "*.password",
        "*.apiKey",
        "*.token",
        "*.secret",
        "*.qr",
      ],
      censor: "[REDACTED]",
    },
  },
  trustProxy: env.TRUST_PROXY,
  bodyLimit: Math.min(env.UPLOAD_MAX_BYTES, 2 * 1024 * 1024),
  genReqId: () => randomUUID(),
});
const logger = app.log;
const redis = await connectOptionalRedis(env.REDIS_URL);
if (redis.error)
  logger.warn(
    { error: redis.error },
    "Redis tidak tersedia; queue PostgreSQL aktif",
  );
app.decorate("context", { env, db, redis, logger });
app.decorateRequest("admin", null);
app.decorateRequest("authType", null);

await app.register(helmet, {
  global: true,
  contentSecurityPolicy: false,
  hsts: false,
  referrerPolicy: { policy: "no-referrer" },
});
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute",
});
await app.register(multipart, {
  limits: { files: 1, fileSize: env.UPLOAD_MAX_BYTES, fields: 10 },
});
app.addHook("onSend", async (request, reply, payload) => {
  reply.header("x-request-id", request.id);
  return payload;
});

await registerAuthRoutes(app);
await registerHealthRoutes(app);
await registerWhatsAppRoutes(app);
await registerMessageRoutes(app);
await registerAgentRoutes(app);
await registerCatalogRoutes(app);
await registerContactMemoryRoutes(app);
await registerOperationRoutes(app);
await registerInternalRoutes(app);
await registerStatusRoutes(app);
await registerCrmRoutes(app);

app.setNotFoundHandler(async (_request, reply) =>
  reply.code(404).send({
    error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan" },
  }),
);
app.setErrorHandler(async (error, request, reply) => {
  const normalized = errorPayload(error);
  if (normalized.statusCode >= 500)
    request.log.error({ err: error }, "request failed");
  else request.log.warn({ code: normalized.payload.error }, "request rejected");
  await reply.code(normalized.statusCode).send(normalized.payload);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "gateway api stopping");
  await app
    .close()
    .catch((error) => logger.error({ err: error }, "fastify close failed"));
  if (redis.client) await redis.client.quit().catch(() => undefined);
  await db.end().catch(() => undefined);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void shutdown(signal));
process.on("unhandledRejection", (error) => {
  logger.fatal({ err: error }, "unhandled rejection");
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
  void shutdown("uncaughtException").finally(() => process.exit(1));
});

try {
  await db.query("SELECT 1");
  await app.listen({ host: env.HOST, port: env.GATEWAY_PORT });
  logger.info(
    {
      host: env.HOST,
      port: env.GATEWAY_PORT,
      redisMode: redis.available ? "redis" : "postgresql-fallback",
    },
    "gateway api started",
  );
} catch (error) {
  logger.fatal({ err: error }, "gateway api startup failed");
  await shutdown("startup-failure");
  process.exit(1);
}

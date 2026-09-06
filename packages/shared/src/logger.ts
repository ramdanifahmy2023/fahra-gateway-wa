import pino, { type Logger } from "pino";
import type { AppEnv } from "./env.js";

const redact = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-internal-api-key",
  "res.headers.set-cookie",
  "*.password",
  "*.password_hash",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.secret",
  "*.qr",
  "*.value_encrypted",
];

export function createLogger(
  env: Pick<AppEnv, "LOG_LEVEL">,
  service: string,
): Logger {
  return pino({
    name: service,
    level: env.LOG_LEVEL,
    base: { service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redact, censor: "[REDACTED]" },
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });
}

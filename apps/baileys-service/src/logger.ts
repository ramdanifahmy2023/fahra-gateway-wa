import fs from "node:fs";
import path from "node:path";

import pino, { type Logger } from "pino";

import type { ServiceConfig } from "./config.js";

export function createLogger(config: ServiceConfig): Logger {
  fs.mkdirSync(config.logsDir, { recursive: true, mode: 0o700 });
  const fileDestination = pino.destination({
    dest: path.join(config.logsDir, "baileys-service.log"),
    mkdir: true,
    sync: false,
  });
  const stream = pino.multistream([
    { level: config.logLevel, stream: process.stdout },
    { level: config.logLevel, stream: fileDestination },
  ]);

  return pino(
    {
      name: "baileys-service",
      level: config.logLevel,
      base: { service: "baileys-service", pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-internal-api-key",
          "headers.authorization",
          "headers.x-internal-api-key",
          "internalApiKey",
          "qr",
          "payload.apiKey",
          "payload.base64",
          "sessionEncryptionKey",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        err: pino.stdSerializers.err,
      },
    },
    stream,
  );
}

import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { quoteIdentifier } from "./sql-identifier.js";

export interface ServiceConfig {
  readonly databaseUrl: string;
  readonly databaseSslMode: "disable" | "require" | "verify-full";
  readonly databasePoolMax: number;
  readonly internalApiKey: string;
  readonly gatewayInternalUrl: URL;
  readonly sessionEncryptionKey: Buffer;
  readonly sessionScope: string;
  readonly dataDir: string;
  readonly whatsappDir: string;
  readonly uploadsDir: string;
  readonly logsDir: string;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly logLevel: string;
  readonly pollIntervalMs: number;
  readonly staleLeaseSeconds: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly reconnectMaxMs: number;
  readonly qrTtlMs: number;
  readonly maxMediaBytes: number;
  readonly authTable: string;
  readonly messagesTable: string;
  readonly queueTable: string;
  readonly groupsTable: string;
  readonly outboxTable: string;
  readonly connectionTable: string;
  readonly connectionEventsTable: string;
}

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function aliasedInteger(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = names.find(
    (name) =>
      environment[name] !== undefined && environment[name]?.trim() !== "",
  );
  return selected
    ? integer(environment, selected, fallback, minimum, maximum)
    : fallback;
}

export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer;
  if (value.startsWith("hex:")) {
    const body = value.slice(4);
    if (!/^[a-f0-9]{64}$/i.test(body)) {
      throw new Error(
        "WHATSAPP_SESSION_ENCRYPTION_KEY hex value must contain exactly 64 hex characters",
      );
    }
    key = Buffer.from(body, "hex");
  } else if (value.startsWith("base64:")) {
    key = decodeBase64Key(value.slice(7));
  } else if (/^[a-f0-9]{64}$/i.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    key = decodeBase64Key(value);
  }

  if (key.length !== 32) {
    throw new Error(
      "WHATSAPP_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  }
  return key;
}

function decodeBase64Key(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(
      "WHATSAPP_SESSION_ENCRYPTION_KEY must be canonical base64 or 64-character hex",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(
      "WHATSAPP_SESSION_ENCRYPTION_KEY must use canonical base64 encoding",
    );
  }
  return decoded;
}

function internalUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:") {
    throw new Error(
      "GATEWAY_INTERNAL_URL must use http on the local workspace network",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("GATEWAY_INTERNAL_URL must resolve explicitly to loopback");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "GATEWAY_INTERNAL_URL cannot contain credentials, query parameters, or fragments",
    );
  }
  return url;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const databaseUrl = required(environment, "DATABASE_URL");
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
    throw new Error("DATABASE_URL must use postgresql:// or postgres://");
  }

  const internalApiKey = required(environment, "INTERNAL_API_KEY");
  if (Buffer.byteLength(internalApiKey) < 32) {
    throw new Error("INTERNAL_API_KEY must contain at least 32 bytes");
  }

  const healthHost = environment.BAILEYS_HEALTH_HOST?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(healthHost.toLowerCase())) {
    throw new Error("BAILEYS_HEALTH_HOST must be loopback");
  }

  const databaseSslBoolean = environment.DATABASE_SSL?.trim().toLowerCase();
  if (
    databaseSslBoolean &&
    !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(
      databaseSslBoolean,
    )
  ) {
    throw new Error("DATABASE_SSL must be a boolean");
  }
  const sslMode =
    environment.DATABASE_SSL_MODE?.trim() ||
    (["true", "1", "yes", "on"].includes(databaseSslBoolean ?? "")
      ? "verify-full"
      : "disable");
  if (!["disable", "require", "verify-full"].includes(sslMode)) {
    throw new Error(
      "DATABASE_SSL_MODE must be disable, require, or verify-full",
    );
  }
  const databaseHost = parsedDatabaseUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["", "127.0.0.1", "localhost", "::1"].includes(databaseHost) && sslMode === "disable") {
    throw new Error("DATABASE_SSL_MODE must not be disable for remote PostgreSQL");
  }
  const logLevel = environment.LOG_LEVEL?.trim() || "info";
  if (
    !["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(
      logLevel,
    )
  ) {
    throw new Error(
      "LOG_LEVEL must be trace, debug, info, warn, error, fatal, or silent",
    );
  }

  const configuredDataDir = environment.DATA_DIR?.trim() || "./data";
  if (path.isAbsolute(configuredDataDir))
    throw new Error(
      "DATA_DIR must be relative to the OpenClaw WhatsApp Gateway workspace",
    );
  const dataDir = path.resolve(PROJECT_ROOT, configuredDataDir);
  const dataRelativeToProject = path.relative(PROJECT_ROOT, dataDir);
  if (
    dataRelativeToProject === "" ||
    dataRelativeToProject.startsWith("..") ||
    path.isAbsolute(dataRelativeToProject)
  ) {
    throw new Error(
      "DATA_DIR must be a directory inside the OpenClaw WhatsApp Gateway workspace",
    );
  }
  let cursor = PROJECT_ROOT;
  for (const component of dataRelativeToProject.split(path.sep)) {
    cursor = path.join(cursor, component);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink())
      throw new Error("DATA_DIR cannot contain symbolic-link components");
  }
  if (existsSync(dataDir)) {
    const realRoot = realpathSync(PROJECT_ROOT);
    const realData = realpathSync(dataDir);
    const realRelative = path.relative(realRoot, realData);
    if (
      !realRelative ||
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    )
      throw new Error("DATA_DIR real path must remain inside the workspace");
  }
  const sessionScope = environment.WHATSAPP_SESSION_SCOPE?.trim() || "primary";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionScope)) {
    throw new Error(
      "WHATSAPP_SESSION_SCOPE must contain 1-64 letters, numbers, underscores, or hyphens",
    );
  }
  const authTable =
    environment.WHATSAPP_AUTH_TABLE?.trim() || "whatsapp_auth_state";
  const messagesTable =
    environment.WHATSAPP_MESSAGES_TABLE?.trim() || "whatsapp_messages";
  const queueTable = environment.QUEUE_JOBS_TABLE?.trim() || "queue_jobs";
  const groupsTable =
    environment.WHATSAPP_GROUPS_TABLE?.trim() || "whatsapp_groups";
  const outboxTable =
    environment.INTEGRATION_OUTBOX_TABLE?.trim() || "integration_outbox";
  const connectionTable =
    environment.WHATSAPP_CONNECTION_TABLE?.trim() || "whatsapp_connection";
  const connectionEventsTable =
    environment.WHATSAPP_CONNECTION_EVENTS_TABLE?.trim() ||
    "whatsapp_connection_events";
  quoteIdentifier(authTable);
  quoteIdentifier(messagesTable);
  quoteIdentifier(queueTable);
  quoteIdentifier(groupsTable);
  quoteIdentifier(outboxTable);
  quoteIdentifier(connectionTable);
  quoteIdentifier(connectionEventsTable);

  return {
    databaseUrl,
    databaseSslMode: sslMode as ServiceConfig["databaseSslMode"],
    databasePoolMax: integer(environment, "DATABASE_POOL_MAX", 10, 3, 50),
    internalApiKey,
    gatewayInternalUrl: internalUrl(
      environment.GATEWAY_INTERNAL_URL?.trim() || "http://127.0.0.1:3100",
    ),
    sessionEncryptionKey: parseEncryptionKey(
      required(environment, "WHATSAPP_SESSION_ENCRYPTION_KEY"),
    ),
    sessionScope,
    dataDir,
    whatsappDir: path.join(dataDir, "whatsapp"),
    uploadsDir: path.join(dataDir, "uploads"),
    logsDir: path.join(dataDir, "logs"),
    healthHost,
    healthPort: integer(environment, "BAILEYS_HEALTH_PORT", 3101, 1, 65_535),
    logLevel,
    pollIntervalMs: aliasedInteger(
      environment,
      ["QUEUE_POLL_INTERVAL_MS", "QUEUE_POLL_MS"],
      1_000,
      100,
      60_000,
    ),
    staleLeaseSeconds: aliasedInteger(
      environment,
      ["QUEUE_STALE_LEASE_SECONDS", "QUEUE_LEASE_SECONDS"],
      60,
      5,
      3_600,
    ),
    retryBaseMs: integer(
      environment,
      "QUEUE_RETRY_BASE_MS",
      1_000,
      100,
      60_000,
    ),
    retryMaxMs: integer(
      environment,
      "QUEUE_RETRY_MAX_MS",
      300_000,
      1_000,
      3_600_000,
    ),
    reconnectMaxMs: integer(
      environment,
      "WHATSAPP_MAX_RECONNECT_DELAY_MS",
      60_000,
      1_000,
      300_000,
    ),
    qrTtlMs: environment.WHATSAPP_QR_TTL_MS
      ? integer(environment, "WHATSAPP_QR_TTL_MS", 60_000, 15_000, 300_000)
      : integer(environment, "WHATSAPP_QR_TTL_SECONDS", 60, 15, 300) * 1_000,
    maxMediaBytes: aliasedInteger(
      environment,
      ["WHATSAPP_MAX_MEDIA_BYTES", "UPLOAD_MAX_BYTES"],
      25 * 1024 * 1024,
      1_024,
      100 * 1024 * 1024,
    ),
    authTable,
    messagesTable,
    queueTable,
    groupsTable,
    outboxTable,
    connectionTable,
    connectionEventsTable,
  };
}

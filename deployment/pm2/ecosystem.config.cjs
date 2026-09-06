"use strict";
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

process.umask(0o077);
const root = path.resolve(__dirname, "../..");

function parseEnv(source) {
  const result = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    result[line.slice(0, index).trim()] = value.replace(/\\n/g, "\n");
  }
  return result;
}

function select(source, keys, overrides = {}) {
  const result = {};
  for (const key of keys)
    if (
      Object.prototype.hasOwnProperty.call(source, key) &&
      source[key] !== undefined
    )
      result[key] = String(source[key]);
  return { ...result, ...overrides };
}

function executable(name) {
  if (name.includes(path.sep)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return path.resolve(name);
    } catch {
      return null;
    }
  }
  for (const directory of String(process.env.PATH || "").split(
    path.delimiter,
  )) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function regularFile(value) {
  try {
    const info = fs.lstatSync(value);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function ownerOnlyFile(value) {
  try {
    const info = fs.lstatSync(value);
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

function usesWorkspaceRedis(environment) {
  try {
    const url = new URL(environment.REDIS_URL);
    return (
      url.protocol === "redis:" &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) &&
      url.port === "56379"
    );
  } catch {
    return false;
  }
}

function cloudflaredVersionInfo(binary) {
  if (!binary) return { version: null, compatible: false };
  let output = "";
  try {
    output = childProcess
      .execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: select(process.env, ["PATH", "HOME"]),
      })
      .trim();
  } catch {
    return { version: null, compatible: false };
  }
  const match = output.match(/(?:^|\s)(\d{4})\.(\d{1,2})\.(\d+)(?:\s|$|[-+])/);
  if (!match) return { version: null, compatible: false };
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  };
  const compatible =
    version.major > 2025 ||
    (version.major === 2025 &&
      (version.minor > 4 || (version.minor === 4 && version.patch >= 0)));
  return { version, compatible };
}

function bunCompatible(binary) {
  if (!binary) return false;
  let output = "";
  try {
    output = childProcess
      .execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: select(process.env, ["PATH", "HOME"]),
      })
      .trim();
  } catch {
    return false;
  }
  const match = output.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/);
  if (!match) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (
    version[0] > 1 ||
    (version[0] === 1 &&
      (version[1] > 2 || (version[1] === 2 && version[2] >= 0)))
  );
}

const envPath = path.join(root, ".env");
if (!ownerOnlyFile(envPath))
  throw new Error(".env wajib regular file owner-only workspace");
const fileEnv = parseEnv(fs.readFileSync(envPath, "utf8"));
const effectiveEnv =
  process.env.OCGW_SANITIZED_SERVICE_ENV === "1"
    ? fileEnv
    : { ...fileEnv, ...process.env };

function compatibilitySecrets(service) {
  const suffix = crypto.randomBytes(24).toString("hex");
  const encryptionKey = crypto.randomBytes(32).toString("base64");
  return {
    JWT_SECRET: `unused-${service}-jwt-${suffix}`,
    INTERNAL_API_KEY: `unused-${service}-internal-${suffix}`,
    SESSION_ENCRYPTION_KEY: encryptionKey,
    WHATSAPP_SESSION_ENCRYPTION_KEY: encryptionKey,
    BACKUP_ENCRYPTION_KEY: encryptionKey,
    BOOTSTRAP_ADMIN_EMAIL: `unused-${service}@invalid.local`,
    BOOTSTRAP_ADMIN_PASSWORD: `unused-${service}-${suffix}`,
    OPENCLAW_API_KEY: "",
    CLOUDFLARE_TUNNEL_TOKEN: "",
    CLOUDFLARE_HOSTNAME: "",
    REDIS_URL: "",
    OCGW_SANITIZED_SERVICE_ENV: "1",
  };
}

function serviceEnvironment(service) {
  const common = select(effectiveEnv, ["NODE_ENV", "LOG_LEVEL", "TZ"]);
  const tls = select(process.env, [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]);
  const database = select(effectiveEnv, [
    "DATABASE_URL",
    "DATABASE_SSL",
    "DATABASE_SSL_MODE",
    "DATABASE_POOL_MAX",
  ]);
  const data = select(effectiveEnv, ["DATA_DIR"]);
  if (service === "gateway")
    return {
      ...common,
      ...tls,
      ...compatibilitySecrets(service),
      ...database,
      ...data,
      ...select(effectiveEnv, [
        "JWT_SECRET",
        "INTERNAL_API_KEY",
        "SESSION_ENCRYPTION_KEY",
        "REDIS_URL",
        "HOST",
        "GATEWAY_PORT",
        "UPLOAD_MAX_BYTES",
        "TRUST_PROXY",
        "OPENCLAW_WEBHOOK_URL",
        "OPENCLAW_HEALTH_URL",
        "OPENCLAW_API_KEY",
      ]),
    };
  if (service === "bridge")
    return {
      ...common,
      ...tls,
      ...compatibilitySecrets(service),
      ...database,
      ...data,
      ...select(effectiveEnv, [
        "INTERNAL_API_KEY",
        "OPENCLAW_WEBHOOK_URL",
        "OPENCLAW_API_KEY",
        "OPENCLAW_TIMEOUT_MS",
        "GATEWAY_INTERNAL_URL",
        "QUEUE_POLL_MS",
        "QUEUE_LEASE_SECONDS",
      ]),
    };
  if (service === "maintenance")
    return {
      ...common,
      ...select(process.env, ["PATH"]),
      ...tls,
      ...compatibilitySecrets(service),
      ...database,
      ...data,
      ...select(effectiveEnv, [
        "BACKUP_ENCRYPTION_KEY",
        "QUEUE_POLL_MS",
        "QUEUE_LEASE_SECONDS",
        "BACKUP_MAX_ARTIFACT_BYTES",
        "BACKUP_MAX_CLEAR_BYTES",
        "BACKUP_MAX_FILE_BYTES",
        "BACKUP_MAX_TOTAL_FILE_BYTES",
        "BACKUP_MAX_FILES",
        "BACKUP_MAX_ROW_BYTES",
        "BACKUP_MAX_TABLE_ROWS",
        "BACKUP_MAX_TOTAL_ROWS",
        "BACKUP_PAGE_ROWS",
        "BACKUP_MAX_WORKING_BYTES",
      ]),
    };
  if (service === "baileys")
    return {
      ...common,
      ...tls,
      OCGW_SANITIZED_SERVICE_ENV: "1",
      ...database,
      ...data,
      ...select(effectiveEnv, [
        "INTERNAL_API_KEY",
        "GATEWAY_INTERNAL_URL",
        "WHATSAPP_SESSION_ENCRYPTION_KEY",
        "WHATSAPP_SESSION_SCOPE",
        "WHATSAPP_AUTH_TABLE",
        "WHATSAPP_MESSAGES_TABLE",
        "QUEUE_JOBS_TABLE",
        "WHATSAPP_GROUPS_TABLE",
        "INTEGRATION_OUTBOX_TABLE",
        "WHATSAPP_CONNECTION_TABLE",
        "WHATSAPP_CONNECTION_EVENTS_TABLE",
        "BAILEYS_HEALTH_HOST",
        "BAILEYS_HEALTH_PORT",
        "QUEUE_POLL_INTERVAL_MS",
        "QUEUE_POLL_MS",
        "QUEUE_STALE_LEASE_SECONDS",
        "QUEUE_LEASE_SECONDS",
        "QUEUE_RETRY_BASE_MS",
        "QUEUE_RETRY_MAX_MS",
        "WHATSAPP_MAX_RECONNECT_DELAY_MS",
        "WHATSAPP_QR_TTL_MS",
        "WHATSAPP_QR_TTL_SECONDS",
        "WHATSAPP_MAX_MEDIA_BYTES",
        "UPLOAD_MAX_BYTES",
      ]),
    };
  throw new Error(`Service environment tidak dikenal: ${service}`);
}

const node = executable("node");
const bunCandidate =
  effectiveEnv.OCGW_RUNTIME === "node" ? null : executable("bun");
const bun = bunCompatible(bunCandidate) ? bunCandidate : null;
const runtime = bun || node;
if (!runtime || !node) throw new Error("Node.js runtime tidak ditemukan");

const logsDirectory = path.join(root, "data/logs");
for (const name of fs.readdirSync(logsDirectory)) {
  const target = path.join(logsDirectory, name);
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Entry log workspace tidak aman: ${name}`);
  fs.chmodSync(target, 0o600);
}

function app(name, script, interpreter, env, args = []) {
  return {
    name,
    cwd: root,
    script,
    interpreter,
    args,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    min_uptime: "10s",
    max_restarts: 15,
    restart_delay: 1000,
    exp_backoff_restart_delay: 100,
    kill_timeout: 20000,
    listen_timeout: 10000,
    max_memory_restart: "768M",
    time: true,
    merge_logs: true,
    treekill: true,
    out_file: path.join(logsDirectory, `${name}.log`),
    error_file: path.join(logsDirectory, `${name}-error.log`),
    env,
  };
}

const apps = [
  app(
    "ocgw-gateway-api",
    path.join(root, "apps/gateway-api/dist/server.js"),
    runtime,
    serviceEnvironment("gateway"),
  ),
  app(
    "ocgw-openclaw-bridge",
    path.join(root, "apps/gateway-api/dist/bridge-worker.js"),
    runtime,
    serviceEnvironment("bridge"),
  ),
  app(
    "ocgw-maintenance",
    path.join(root, "apps/gateway-api/dist/maintenance-worker.js"),
    runtime,
    serviceEnvironment("maintenance"),
  ),
  app(
    "ocgw-baileys",
    path.join(root, "apps/baileys-service/dist/index.js"),
    runtime,
    serviceEnvironment("baileys"),
  ),
];

const redisConfig = path.join(root, ".runtime/redis.conf");
const redis = executable("redis-server");
if (redis && usesWorkspaceRedis(effectiveEnv) && ownerOnlyFile(redisConfig))
  apps.unshift({
    ...app(
      "ocgw-redis",
      redis,
      "none",
      {
        ...select(process.env, ["PATH", "HOME"]),
        OCGW_SANITIZED_SERVICE_ENV: "1",
      },
      [redisConfig],
    ),
    max_memory_restart: "512M",
  });

const dashboardCandidates = [
  path.join(root, "apps/dashboard/.next/standalone/apps/dashboard/server.js"),
  path.join(root, "apps/dashboard/.next/standalone/server.js"),
];
const dashboard = dashboardCandidates.find(regularFile);
if (!dashboard) throw new Error("Dashboard standalone belum dibuild");
apps.push(
  app("ocgw-dashboard", dashboard, node, {
    ...select(effectiveEnv, [
      "NODE_ENV",
      "UPLOAD_MAX_BYTES",
      "DASHBOARD_MAX_BODY_BYTES",
    ]),
    HOSTNAME: "127.0.0.1",
    PORT: effectiveEnv.DASHBOARD_PORT || "3200",
    GATEWAY_API_URL:
      effectiveEnv.GATEWAY_INTERNAL_URL || "http://127.0.0.1:3100",
    NEXT_TELEMETRY_DISABLED: "1",
    OCGW_SANITIZED_SERVICE_ENV: "1",
  }),
);

if (
  effectiveEnv.CLOUDFLARE_TUNNEL_TOKEN &&
  ownerOnlyFile(path.join(root, ".runtime/tunnel-enabled"))
) {
  const local = path.join(root, ".runtime/bin/cloudflared");
  const cloudflared =
    (regularFile(local) ? executable(local) : null) ||
    executable("cloudflared");
  const version = cloudflaredVersionInfo(cloudflared);
  if (
    cloudflared &&
    version.compatible &&
    ownerOnlyFile(path.join(root, ".runtime/cloudflare-token"))
  )
    apps.push({
      ...app(
        "ocgw-cloudflared",
        cloudflared,
        "none",
        {
          ...select(process.env, ["PATH", "HOME"]),
          OCGW_SANITIZED_SERVICE_ENV: "1",
        },
        [
          "tunnel",
          "run",
          "--no-autoupdate",
          "--token-file",
          path.join(root, ".runtime/cloudflare-token"),
        ],
      ),
      max_memory_restart: "256M",
    });
}

module.exports = { apps };

import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudflaredVersionInfo,
  detectRuntime,
  findExecutable,
  parseEnv,
  selectEnvironment,
  workspaceRoot,
} from "./common.mjs";

async function regularFile(path) {
  const info = await lstat(path).catch(() => null);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

async function ownerOnlyFile(path) {
  const info = await lstat(path).catch(() => null);
  return Boolean(
    info?.isFile() &&
    !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()),
  );
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

function compatibilitySecrets(service) {
  // packages/shared currently validates the complete AppEnv for every worker.
  // Give workers non-secret, per-launch compatibility values for fields they do
  // not use instead of leaking the real cross-service keys.
  const suffix = randomBytes(24).toString("hex");
  const encryptionKey = randomBytes(32).toString("base64");
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

function serviceEnvironment(fileEnv, service) {
  const common = selectEnvironment(fileEnv, ["NODE_ENV", "LOG_LEVEL", "TZ"]);
  const tls = selectEnvironment(process.env, [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]);
  const database = selectEnvironment(fileEnv, [
    "DATABASE_URL",
    "DATABASE_SSL",
    "DATABASE_SSL_MODE",
    "DATABASE_POOL_MAX",
  ]);
  const data = selectEnvironment(fileEnv, ["DATA_DIR"]);

  if (service === "gateway") {
    return {
      ...common,
      ...tls,
      ...compatibilitySecrets(service),
      ...database,
      ...data,
      ...selectEnvironment(fileEnv, [
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
  }
  if (service === "bridge") {
    return {
      ...common,
      ...tls,
      ...compatibilitySecrets(service),
      ...database,
      ...data,
      ...selectEnvironment(fileEnv, [
        "INTERNAL_API_KEY",
        "OPENCLAW_WEBHOOK_URL",
        "OPENCLAW_API_KEY",
        "OPENCLAW_TIMEOUT_MS",
        "GATEWAY_INTERNAL_URL",
        "QUEUE_POLL_MS",
        "QUEUE_LEASE_SECONDS",
      ]),
    };
  }
  if (service === "maintenance") {
    return {
      ...common,
      ...selectEnvironment(process.env, ["PATH"]),
      ...tls,
      ...compatibilitySecrets(service),
      ...database,
      ...data,
      ...selectEnvironment(fileEnv, [
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
  }
  if (service === "baileys") {
    return {
      ...common,
      ...tls,
      OCGW_SANITIZED_SERVICE_ENV: "1",
      ...database,
      ...data,
      ...selectEnvironment(fileEnv, [
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
  }
  throw new Error(`Service environment tidak dikenal: ${service}`);
}

export async function serviceSpecs() {
  const envPath = join(workspaceRoot, ".env");
  if (!(await ownerOnlyFile(envPath)))
    throw new Error(
      ".env wajib regular file owner-only sebelum service dimulai",
    );
  const fileEnv = parseEnv(await readFile(envPath, "utf8"));
  const effectiveEnv =
    process.env.OCGW_SANITIZED_SERVICE_ENV === "1"
      ? fileEnv
      : { ...fileEnv, ...process.env };
  const runtime = await detectRuntime();
  const node = await findExecutable("node");
  if (!node) throw new Error("Node.js diperlukan untuk dashboard standalone");
  const preferred =
    effectiveEnv.OCGW_RUNTIME === "node" || !runtime.bunCompatible
      ? node
      : runtime.bunCommand;
  if (!preferred) throw new Error("Runtime Gateway/Baileys tidak ditemukan");

  const specs = [];
  const redisConfig = join(workspaceRoot, ".runtime", "redis.conf");
  const redisServer = await findExecutable("redis-server");
  if (
    redisServer &&
    usesWorkspaceRedis(effectiveEnv) &&
    (await ownerOnlyFile(redisConfig))
  ) {
    specs.push({
      name: "ocgw-redis",
      command: redisServer,
      args: [redisConfig],
      env: {
        ...selectEnvironment(process.env, ["PATH", "HOME"]),
        OCGW_SANITIZED_SERVICE_ENV: "1",
      },
      restart: true,
    });
  }
  specs.push(
    {
      name: "ocgw-gateway-api",
      command: preferred,
      args: [join(workspaceRoot, "apps/gateway-api/dist/server.js")],
      env: serviceEnvironment(effectiveEnv, "gateway"),
      restart: true,
    },
    {
      name: "ocgw-openclaw-bridge",
      command: preferred,
      args: [join(workspaceRoot, "apps/gateway-api/dist/bridge-worker.js")],
      env: serviceEnvironment(effectiveEnv, "bridge"),
      restart: true,
    },
    {
      name: "ocgw-maintenance",
      command: preferred,
      args: [
        join(workspaceRoot, "apps/gateway-api/dist/maintenance-worker.js"),
      ],
      env: serviceEnvironment(effectiveEnv, "maintenance"),
      restart: true,
    },
    {
      name: "ocgw-baileys",
      command: preferred,
      args: [join(workspaceRoot, "apps/baileys-service/dist/index.js")],
      env: serviceEnvironment(effectiveEnv, "baileys"),
      restart: true,
    },
  );

  const nextCli = join(workspaceRoot, "node_modules/next/dist/bin/next");
  if (!(await regularFile(nextCli)))
    throw new Error("Next.js CLI belum tersedia; jalankan npm ci");
  specs.push({
    name: "ocgw-dashboard",
    command: node,
    // Standalone tracing omits Next runtime files on this workspace layout;
    // run the verified workspace build through Next's native launcher.
    args: [nextCli, "start", join(workspaceRoot, "apps/dashboard"), "--hostname", "127.0.0.1", "--port", effectiveEnv.DASHBOARD_PORT || "3200"],
    restart: true,
    env: {
      ...selectEnvironment(effectiveEnv, [
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
    },
  });

  if (effectiveEnv.CLOUDFLARE_TUNNEL_TOKEN) {
    const local = join(workspaceRoot, ".runtime/bin/cloudflared");
    const cloudflared =
      ((await regularFile(local)) ? await findExecutable(local) : null) ||
      (await findExecutable("cloudflared"));
    const version = await cloudflaredVersionInfo(cloudflared);
    if (
      cloudflared &&
      version.compatible &&
      (await ownerOnlyFile(join(workspaceRoot, ".runtime/tunnel-enabled"))) &&
      (await ownerOnlyFile(join(workspaceRoot, ".runtime/cloudflare-token")))
    ) {
      specs.push({
        name: "ocgw-cloudflared",
        command: cloudflared,
        args: [
          "tunnel",
          "--no-autoupdate",
          "run",
          "--token-file",
          join(workspaceRoot, ".runtime/cloudflare-token"),
        ],
        env: {
          ...selectEnvironment(process.env, ["PATH", "HOME"]),
          OCGW_SANITIZED_SERVICE_ENV: "1",
        },
        restart: true,
      });
    }
  }
  return specs;
}

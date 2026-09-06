import { existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { findWorkspaceRoot, workspacePath } from "./workspace.js";

process.umask(0o077);

const bool = z.preprocess(
  (value) =>
    typeof value === "string"
      ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
      : value,
  z.boolean(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);
const loopbackUrl = (requiredPath?: string) =>
  z.url().refine(
    (value) => {
      const url = new URL(value);
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "::1"].includes(host) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!requiredPath || url.pathname === requiredPath)
      );
    },
    {
      message:
        "URL wajib memakai HTTP loopback tanpa credential/query/fragment",
    },
  );
const encryptionKey = z.string().refine(
  (value) => {
    const normalized = value.trim();
    if (/^[a-f\d]{64}$/i.test(normalized)) return true;
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
      normalized.length % 4 !== 0
    )
      return false;
    const decoded = Buffer.from(normalized, "base64");
    return decoded.length === 32 && decoded.toString("base64") === normalized;
  },
  {
    message:
      "key enkripsi harus tepat 32 byte dalam canonical base64 atau 64 karakter hex",
  },
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HOST: z.string().default("127.0.0.1"),
  GATEWAY_PORT: z.coerce.number().int().min(1024).max(65535).default(3100),
  BAILEYS_HEALTH_HOST: z
    .enum(["127.0.0.1", "localhost", "::1"])
    .default("127.0.0.1"),
  BAILEYS_HEALTH_PORT: z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .default(3101),
  DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(3200),
  DATA_DIR: z.string().default("./data"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  REDIS_URL: optionalUrl,
  JWT_SECRET: z.string().min(32),
  INTERNAL_API_KEY: z.string().min(32),
  SESSION_ENCRYPTION_KEY: encryptionKey,
  WHATSAPP_SESSION_ENCRYPTION_KEY: encryptionKey,
  BACKUP_ENCRYPTION_KEY: encryptionKey,
  BOOTSTRAP_ADMIN_EMAIL: z.email().default("ramdanifahmy2023@gmail.com"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(10).max(256),
  OPENCLAW_WEBHOOK_URL: loopbackUrl("/v1/chat/completions").default(
    "http://127.0.0.1:18789/v1/chat/completions",
  ),
  OPENCLAW_HEALTH_URL: loopbackUrl().default("http://127.0.0.1:18789/health"),
  OPENCLAW_API_KEY: z.string().optional().default(""),
  OPENCLAW_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(90_000),
  OPENCLAW_REPLY_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(26_000),
  GATEWAY_INTERNAL_URL: loopbackUrl().default("http://127.0.0.1:3100"),
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional().default(""),
  CLOUDFLARE_HOSTNAME: z.string().optional().default(""),
  QUEUE_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  QUEUE_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  WHATSAPP_QR_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  WHATSAPP_MAX_RECONNECT_DELAY_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(60_000),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(104_857_600)
    .default(26_214_400),
  TRUST_PROXY: bool.default(false),
});

export type AppEnv = z.infer<typeof schema> & {
  workspaceRoot: string;
  dataDir: string;
};

let cached: AppEnv | undefined;

export function loadEnvironment(
  options: { fresh?: boolean; root?: string } = {},
): AppEnv {
  if (cached && !options.fresh) return cached;
  const workspaceRoot = options.root ?? findWorkspaceRoot();
  const envPath = join(workspaceRoot, ".env");
  if (existsSync(envPath))
    loadDotenv({ path: envPath, override: false, quiet: true });
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Konfigurasi environment tidak valid: ${messages}`);
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    !["127.0.0.1", "localhost", "::1"].includes(parsed.data.HOST)
  ) {
    throw new Error(
      "HOST production wajib loopback; gunakan Cloudflare Tunnel sebagai akses outbound",
    );
  }
  const result = {
    ...parsed.data,
    workspaceRoot,
    dataDir: workspacePath(parsed.data.DATA_DIR, workspaceRoot),
  };
  cached = result;
  return result;
}

export function resetEnvironmentForTests(): void {
  cached = undefined;
}

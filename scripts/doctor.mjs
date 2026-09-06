import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cloudflaredVersionInfo,
  databaseSessionAffinity,
  detectRuntime,
  findExecutable,
  minimumBunVersion,
  printCheck,
  readWorkspaceEnv,
  readRestoreHandoff,
  workspaceLogMaxBytes,
  workspaceRoot,
} from "./lib/common.mjs";
import { processStates } from "./lib/process-state.mjs";

process.stdout.write("\nOpenClaw WhatsApp Gateway Doctor\n\n");
const outcomes = [];
function check(ok, label, detail) {
  printCheck(ok, label, detail);
  outcomes.push({ ok, label });
}

const runtime = await detectRuntime();
const runtimeDetail = runtime.selected
  ? runtime.selected.kind === "node" && runtime.bun && !runtime.bunCompatible
    ? `node ${runtime.selected.version}; Bun ${runtime.bun} diabaikan (minimum ${minimumBunVersion.text})`
    : `${runtime.selected.kind} ${runtime.selected.version}`
  : runtime.bun && !runtime.bunCompatible
    ? `Bun ${runtime.bun} tidak kompatibel (minimum ${minimumBunVersion.text}) dan Node tidak ditemukan`
    : "Bun/Node tidak ditemukan";
check(Boolean(runtime.selected), "Runtime", runtimeDetail);

async function secureWorkspace() {
  const paths = [
    ".runtime",
    ".runtime/pids",
    ".runtime/bin",
    ".runtime/locks",
    ".runtime/staging",
    ".runtime/releases",
    ".runtime/postgres-socket",
    "data",
    "data/whatsapp",
    "data/backups",
    "data/uploads",
    "data/logs",
  ];
  const failures = [];
  for (const relative of paths) {
    const path = join(workspaceRoot, relative);
    try {
      await access(path, constants.W_OK);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        failures.push(`${relative} bukan directory aman`);
      if ((info.mode & 0o077) !== 0)
        failures.push(
          `${relative} mode ${(info.mode & 0o777).toString(8)}, perlu 700`,
        );
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        failures.push(`${relative} bukan milik user aktif`);
    } catch (error) {
      failures.push(
        `${relative}: ${error instanceof Error ? error.message : "tidak dapat diakses"}`,
      );
    }
  }
  const envPath = join(workspaceRoot, ".env");
  try {
    const info = await lstat(envPath);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0)
      failures.push(".env wajib regular file mode 600");
  } catch {
    /* belum diinstal */
  }
  for (const name of await readdir(join(workspaceRoot, "data/logs")).catch(
    () => [],
  )) {
    try {
      const info = await lstat(join(workspaceRoot, "data/logs", name));
      if (info.isSymbolicLink() || !info.isFile())
        failures.push(`log ${name} bukan regular file`);
      else if ((info.mode & 0o077) !== 0)
        failures.push(`log ${name} tidak owner-only`);
      else if (info.size > workspaceLogMaxBytes)
        failures.push(
          `log ${name} ${info.size} byte melewati cap ${workspaceLogMaxBytes}`,
        );
    } catch {
      /* race rotasi log */
    }
  }
  return failures;
}
const workspaceFailures = await secureWorkspace();
check(
  workspaceFailures.length === 0,
  "Workspace",
  workspaceFailures.length
    ? "Tidak aman: " + workspaceFailures.slice(0, 3).join("; ")
    : "Writable, owner-only",
);

try {
  const handoff = await readRestoreHandoff({ optional: true });
  check(
    !handoff,
    "Restore Lifecycle",
    handoff
      ? `Operasi ${handoff.operationId} aktif pada phase ${handoff.phase}${handoff.context?.sourceFilename ? `; source ${handoff.context.sourceFilename}` : ""}`
      : "Tidak ada marker restore aktif",
  );
} catch (error) {
  check(
    false,
    "Restore Lifecycle",
    error instanceof Error ? error.message : "Marker restore tidak valid",
  );
}

const env = await readWorkspaceEnv({ optional: true });
const databaseAffinity = databaseSessionAffinity(
  env.DATABASE_URL,
  env.DATABASE_POOL_MODE,
);
let db = null;
try {
  if (!databaseAffinity.ok)
    throw new Error(
      `Endpoint tidak session-affine: ${databaseAffinity.reasons.join("; ")}`,
    );
  const shared = await import(
    pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
  );
  const appEnv = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
  db = shared.createDatabasePool(appEnv);
  const database = await shared.checkDatabase(db);
  const schema = database.ok
    ? await shared.checkSchemaState(
        db,
        join(workspaceRoot, "database/migrations"),
      )
    : null;
  check(
    database.ok && Boolean(schema?.ok),
    "Database",
    database.ok
      ? schema?.ok
        ? `Connected, schema ${schema.applied}/${schema.expected} valid; ${databaseAffinity.confirmed ? "session affinity dikonfirmasi konfigurasi" : "tidak ada marker transaction pool pada URL (deteksi best-effort)"}`
        : `Connected, schema tidak valid: ${schema?.error ?? [...(schema?.missing ?? []), ...(schema?.checksumMismatches ?? []), ...(schema?.contractErrors ?? [])].slice(0, 3).join("; ")}`
      : `Gagal: ${database.error}`,
  );
  if (appEnv.REDIS_URL) {
    const redis = await shared.connectOptionalRedis(appEnv.REDIS_URL);
    check(
      redis.available,
      "Redis",
      redis.available
        ? "Connected"
        : "Tidak tersedia; queue tetap memakai PostgreSQL",
    );
    if (redis.client) await redis.client.quit();
  } else check(true, "Redis", "PostgreSQL persistent queue fallback");
} catch (error) {
  check(
    false,
    "Database",
    error instanceof Error ? error.message : "unavailable",
  );
  check(false, "Redis", "Belum dapat diperiksa");
}

async function reachable(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
    });
    let body = null;
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    )
      body = await response.json().catch(() => null);
    else await response.body?.cancel().catch(() => undefined);
    return { ok: true, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

const state = await processStates();
const online = new Set(
  state.services
    .filter((service) => service.status === "online")
    .map((service) => service.name),
);
const baileysHealth = await reachable(
  `http://127.0.0.1:${env.BAILEYS_HEALTH_PORT || 3101}/health/ready`,
);
const heartbeat =
  baileysHealth.body &&
  typeof baileysHealth.body === "object" &&
  baileysHealth.body.whatsapp &&
  typeof baileysHealth.body.whatsapp === "object"
    ? Date.parse(String(baileysHealth.body.whatsapp.lastHeartbeatAt ?? ""))
    : NaN;
const heartbeatFresh =
  Number.isFinite(heartbeat) && Date.now() - heartbeat < 60_000;
const whatsappOk =
  online.has("ocgw-baileys") && baileysHealth.status === 200 && heartbeatFresh;
check(
  whatsappOk,
  "WhatsApp",
  whatsappOk
    ? `Running; koneksi ${baileysHealth.body?.whatsapp?.state ?? "unknown"}`
    : !online.has("ocgw-baileys")
      ? "Process tidak aktif"
      : baileysHealth.ok
        ? `Health HTTP ${baileysHealth.status}; heartbeat ${heartbeatFresh ? "fresh" : "stale"}`
        : `Health tidak terjangkau: ${baileysHealth.error}`,
);

const openclawUrl =
  env.OPENCLAW_HEALTH_URL ||
  (() => {
    try {
      return new URL(
        "/health",
        new URL(
          env.OPENCLAW_WEBHOOK_URL ||
            "http://127.0.0.1:18789/v1/chat/completions",
        ).origin,
      ).toString();
    } catch {
      return "http://127.0.0.1:18789/health";
    }
  })();
const openclaw = await reachable(openclawUrl, {
  headers: env.OPENCLAW_API_KEY
    ? { authorization: `Bearer ${env.OPENCLAW_API_KEY}` }
    : {},
});
const openclawOk =
  openclaw.ok && openclaw.status >= 200 && openclaw.status < 400;
check(
  openclawOk,
  "OpenClaw",
  openclawOk
    ? `Reachable (HTTP ${openclaw.status})`
    : openclaw.ok
      ? `Health ditolak (HTTP ${openclaw.status})`
      : `Tidak terjangkau: ${openclaw.error}`,
);

const gateway = await reachable(
  `http://127.0.0.1:${env.GATEWAY_PORT || 3100}/health/ready`,
);
check(
  gateway.status === 200,
  "Gateway API",
  gateway.ok ? `HTTP ${gateway.status}` : gateway.error,
);
const dashboard = await reachable(
  `http://127.0.0.1:${env.DASHBOARD_PORT || 3200}/login`,
);
check(
  dashboard.status === 200,
  "Dashboard",
  dashboard.ok ? `HTTP ${dashboard.status}` : dashboard.error,
);

const tunnelConfigured = Boolean(
  env.CLOUDFLARE_TUNNEL_TOKEN && env.CLOUDFLARE_HOSTNAME,
);
const tunnelEnabled = await lstat(
  join(workspaceRoot, ".runtime/tunnel-enabled"),
)
  .then((info) => info.isFile() && !info.isSymbolicLink())
  .catch(() => false);
const cloudflaredBinary = tunnelConfigured
  ? (await lstat(join(workspaceRoot, ".runtime/bin/cloudflared"))
      .then((info) => info.isFile() && !info.isSymbolicLink())
      .catch(() => false))
    ? (await findExecutable(join(workspaceRoot, ".runtime/bin/cloudflared"))) ||
      (await findExecutable("cloudflared"))
    : await findExecutable("cloudflared")
  : null;
const cloudflaredVersion = await cloudflaredVersionInfo(cloudflaredBinary);
let tokenSafe = false;
if (tunnelConfigured) {
  try {
    const tokenPath = join(workspaceRoot, ".runtime/cloudflare-token");
    const info = await lstat(tokenPath);
    const stored = (await readFile(tokenPath, "utf8")).trim();
    tokenSafe =
      info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      createHash("sha256").update(stored).digest("hex") ===
        createHash("sha256").update(env.CLOUDFLARE_TUNNEL_TOKEN).digest("hex");
  } catch {
    tokenSafe = false;
  }
}
const publicDashboard =
  tunnelConfigured && tunnelEnabled
    ? await reachable(`https://${env.CLOUDFLARE_HOSTNAME}/login`)
    : { ok: false };
const tunnelOk =
  tunnelConfigured &&
  cloudflaredVersion.compatible &&
  online.has("ocgw-cloudflared") &&
  tokenSafe &&
  publicDashboard.ok &&
  publicDashboard.status === 200;
const tunnelStaged =
  tunnelConfigured &&
  cloudflaredVersion.compatible &&
  !tunnelEnabled &&
  tokenSafe;
check(
  tunnelOk || tunnelStaged,
  "Cloudflare Tunnel",
  !tunnelConfigured
    ? "Token/hostname belum dikonfigurasi"
    : !cloudflaredBinary
      ? "Binary cloudflared tidak ditemukan; installer tidak mengunduh binary"
      : !cloudflaredVersion.compatible
        ? `Versi ${cloudflaredVersion.version?.text ?? cloudflaredVersion.raw ?? "tidak dikenali"} tidak kompatibel; wajib >=2025.4.0 untuk --token-file`
        : !tokenSafe
          ? "Token file tidak sinkron/aman"
          : tunnelStaged
            ? `Configured dengan cloudflared ${cloudflaredVersion.version.text}; aktivasi ditahan sampai password bootstrap diganti lokal`
            : tunnelOk
              ? `Connected ke ${env.CLOUDFLARE_HOSTNAME} dengan cloudflared ${cloudflaredVersion.version.text} (HTTP ${publicDashboard.status})`
              : !online.has("ocgw-cloudflared")
                ? `Process tidak aktif (cloudflared ${cloudflaredVersion.version.text})`
                : `Edge hostname tidak terjangkau: ${publicDashboard.error ?? publicDashboard.status}`,
);

if (db) await db.end();
const failed = outcomes.filter((item) => !item.ok);
process.stdout.write(
  `\n${failed.length ? `${failed.length} pemeriksaan gagal.` : "Semua pemeriksaan lulus."}\n`,
);
if (failed.length) process.exitCode = 1;

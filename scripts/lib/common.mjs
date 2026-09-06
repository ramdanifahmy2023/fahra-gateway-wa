import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

process.umask(0o077);

export const scriptsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const workspaceRoot = resolve(scriptsDir, "..");
export const restoreHandoffPath = join(
  workspaceRoot,
  ".runtime",
  "restore-handoff.json",
);
export const runnerInstancePath = join(
  workspaceRoot,
  ".runtime",
  "runner-instance.json",
);
export const minimumBunVersion = Object.freeze({
  major: 1,
  minor: 2,
  patch: 0,
  text: "1.2.0",
});
export const workspaceLogMaxBytes = 50 * 1024 * 1024;
const restoreHandoffPhases = new Set([
  "ready",
  "granted",
  "stopping",
  "restoring",
  "committed",
  "starting",
  "verifying",
  "completed",
  "recovery_start",
  "failed",
]);
const restoreHandoffTransitions = Object.freeze({
  ready: new Set(["granted", "failed"]),
  granted: new Set(["stopping", "recovery_start", "failed"]),
  stopping: new Set(["restoring", "recovery_start"]),
  restoring: new Set(["committed", "recovery_start"]),
  committed: new Set(["starting", "recovery_start"]),
  starting: new Set(["verifying", "recovery_start"]),
  verifying: new Set(["completed", "recovery_start"]),
  recovery_start: new Set(["failed"]),
  completed: new Set(),
  failed: new Set(),
});
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Some restricted workspace runtimes intentionally do not expose /proc and
// ship a `ps` binary that cannot inspect the process namespace.  A random,
// process-local token still gives the current process a stable identity for
// journals it owns.  It is never used to declare a remote PID stale.
const localProcessStartToken = `self:${randomBytes(32).toString("base64url")}`;
export const safeInheritedEnvironmentKeys = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

export const managedConfigurationKeys = Object.freeze([
  "NODE_ENV",
  "LOG_LEVEL",
  "HOST",
  "GATEWAY_PORT",
  "DASHBOARD_PORT",
  "DATA_DIR",
  "DATABASE_URL",
  "DATABASE_SSL",
  "DATABASE_SSL_MODE",
  "DATABASE_POOL_MAX",
  "DATABASE_POOL_MODE",
  "REDIS_URL",
  "JWT_SECRET",
  "INTERNAL_API_KEY",
  "SESSION_ENCRYPTION_KEY",
  "WHATSAPP_SESSION_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "BOOTSTRAP_ADMIN_EMAIL",
  "OPENCLAW_WEBHOOK_URL",
  "OPENCLAW_HEALTH_URL",
  "OPENCLAW_API_KEY",
  "OPENCLAW_TIMEOUT_MS",
  "GATEWAY_INTERNAL_URL",
  "CLOUDFLARE_TUNNEL_TOKEN",
  "CLOUDFLARE_HOSTNAME",
  "QUEUE_POLL_MS",
  "QUEUE_POLL_INTERVAL_MS",
  "QUEUE_LEASE_SECONDS",
  "QUEUE_STALE_LEASE_SECONDS",
  "QUEUE_RETRY_BASE_MS",
  "QUEUE_RETRY_MAX_MS",
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
  "WHATSAPP_MAX_RECONNECT_DELAY_MS",
  "WHATSAPP_QR_TTL_MS",
  "WHATSAPP_QR_TTL_SECONDS",
  "WHATSAPP_MAX_MEDIA_BYTES",
  "UPLOAD_MAX_BYTES",
  "DASHBOARD_MAX_BODY_BYTES",
  "TRUST_PROXY",
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
  "OCGW_RUNTIME",
  "OCGW_RUNNER",
]);

/**
 * Session advisory locks are part of the migration, singleton-worker and
 * backup/restore contracts. Transaction/statement poolers cannot preserve
 * those locks between autocommit queries. URL inspection is deliberately a
 * best-effort guard; DATABASE_POOL_MODE=direct|session is an operator
 * assertion for a provider endpoint that is known to be session-affine.
 */
export function databaseSessionAffinity(databaseUrl, declaredMode = "") {
  let url;
  try {
    url = new URL(String(databaseUrl));
  } catch {
    return {
      ok: false,
      confirmed: false,
      reasons: ["DATABASE_URL bukan URL PostgreSQL valid"],
    };
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    return {
      ok: false,
      confirmed: false,
      reasons: ["DATABASE_URL bukan URL PostgreSQL"],
    };
  }

  const mode = String(declaredMode ?? "")
    .trim()
    .toLowerCase();
  const acceptedModes = new Set(["", "direct", "session"]);
  if (!acceptedModes.has(mode)) {
    return {
      ok: false,
      confirmed: false,
      reasons: [
        mode === "transaction" || mode === "statement"
          ? `DATABASE_POOL_MODE=${mode} tidak mendukung session advisory lock`
          : "DATABASE_POOL_MODE hanya boleh kosong, direct, atau session",
      ],
    };
  }

  const queryModes = [];
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase().replaceAll("-", "_");
    if (
      ["pool_mode", "poolmode", "pooler_mode", "pgbouncer_pool_mode"].includes(
        normalizedKey,
      )
    ) {
      queryModes.push(value.trim().toLowerCase());
    }
    if (normalizedKey === "options") {
      const match = value.match(
        /(?:^|\s|=)pool_mode(?:\s|=)+(direct|session|transaction|statement)(?:\s|$)/i,
      );
      if (match) queryModes.push(match[1].toLowerCase());
    }
  }
  const unsafeQueryMode = queryModes.find(
    (value) => value === "transaction" || value === "statement",
  );
  if (unsafeQueryMode) {
    return {
      ok: false,
      confirmed: false,
      reasons: [`DATABASE_URL menyatakan pool_mode=${unsafeQueryMode}`],
    };
  }
  const unknownQueryMode = queryModes.find(
    (value) => value !== "direct" && value !== "session",
  );
  if (unknownQueryMode) {
    return {
      ok: false,
      confirmed: false,
      reasons: [
        `DATABASE_URL memiliki pool_mode tidak dikenal: ${unknownQueryMode}`,
      ],
    };
  }

  const queryConfirmed = queryModes.some(
    (value) => value === "direct" || value === "session",
  );
  const confirmed = mode === "direct" || mode === "session" || queryConfirmed;
  const heuristicReasons = [];
  const hostname = url.hostname.toLowerCase();
  if (hostname.includes("pooler"))
    heuristicReasons.push("hostname mengandung marker endpoint pooler");
  if (["6432", "6543"].includes(url.port))
    heuristicReasons.push(`port ${url.port} umum dipakai transaction pooler`);
  for (const key of ["pgbouncer", "pooler", "connection_pooling"]) {
    if (/^(?:1|true|yes)$/i.test(url.searchParams.get(key) ?? "")) {
      heuristicReasons.push(`query flag ${key} menandai endpoint pooler`);
    }
  }
  return {
    ok: heuristicReasons.length === 0 || confirmed,
    confirmed,
    mode:
      mode ||
      (queryConfirmed
        ? queryModes.find((value) => value === "direct" || value === "session")
        : null),
    reasons: heuristicReasons,
  };
}

export function assertSessionAffineDatabaseUrl(databaseUrl, declaredMode = "") {
  const result = databaseSessionAffinity(databaseUrl, declaredMode);
  if (!result.ok) {
    throw new Error(
      `DATABASE_URL wajib direct/session-affine; transaction/statement pooling tidak didukung: ${result.reasons.join("; ")}. Gunakan endpoint direct/session provider atau set DATABASE_POOL_MODE=session hanya setelah provider mengonfirmasi session affinity.`,
    );
  }
  return result;
}

export function selectEnvironment(source, keys, overrides = {}) {
  const selected = {};
  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(source, key) &&
      source[key] !== undefined
    )
      selected[key] = String(source[key]);
  }
  return { ...selected, ...overrides };
}

export function inheritedEnvironment(source = process.env) {
  return selectEnvironment(source, safeInheritedEnvironmentKeys);
}

export function parseEnv(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    result[key] = value.replace(/\\n/g, "\n");
  }
  return result;
}

export async function readWorkspaceEnv({ optional = false } = {}) {
  try {
    return {
      ...parseEnv(await readFile(join(workspaceRoot, ".env"), "utf8")),
      ...process.env,
    };
  } catch (error) {
    if (optional && error?.code === "ENOENT") return { ...process.env };
    throw error;
  }
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

export async function updateEnvFile(updates) {
  const path = join(workspaceRoot, ".env");
  let source = "";
  const info = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isSymbolicLink() || (info && !info.isFile()))
    throw new Error(".env wajib regular file non-symlink");
  if (info) {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino
      )
        throw new Error(".env berubah saat dibuka");
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }
  const seen = new Set();
  const lines = source.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${quoteEnv(String(updates[match[1]]))}`;
  });
  for (const [key, value] of Object.entries(updates))
    if (!seen.has(key)) lines.push(`${key}=${quoteEnv(String(value))}`);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(
        `${lines.join("\n").replace(/\n+$/, "")}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(path, 0o600);
}

export async function ensureWorkspaceDirectories() {
  for (const relative of [
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
  ]) {
    const target = join(workspaceRoot, relative);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Path state workspace tidak aman: ${relative}`);
    await chmod(target, 0o700);
  }
  const logsDirectory = join(workspaceRoot, "data/logs");
  for (const name of await readdir(logsDirectory).catch(() => [])) {
    const target = join(logsDirectory, name);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`Entry log workspace tidak aman: ${name}`);
    await chmod(target, 0o600);
  }
}

export function assertWorkspaceManagedPath(value, label = "path") {
  const target = resolve(value);
  if (
    target === workspaceRoot ||
    !target.startsWith(`${workspaceRoot}${sep}`)
  ) {
    throw new Error(`${label} wajib berada di dalam workspace`);
  }
  return target;
}

export async function ensurePrivateDirectory(value, label = "directory") {
  const target = assertWorkspaceManagedPath(value, label);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${label} bukan directory regular workspace`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(`${label} bukan milik user aktif`);
  await chmod(target, 0o700);
  return target;
}

export async function writePrivateWorkspaceFile(
  value,
  content,
  label = "state file",
) {
  const target = assertWorkspaceManagedPath(value, label);
  await ensurePrivateDirectory(dirname(target), `${label} parent`);
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    throw new Error(`${label} bukan regular file workspace`);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
    await syncDirectory(dirname(target));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Some otherwise supported filesystems do not expose directory fsync.
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

function runnerInstanceTokenDigest(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export async function writeRunnerInstance(pid, token) {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("PID fallback runner tidak valid");
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") < 32)
    throw new Error("Token instance fallback runner terlalu pendek");
  const record = {
    version: 1,
    workspaceRoot,
    pid,
    tokenDigest: runnerInstanceTokenDigest(token),
    heartbeatAt: new Date().toISOString(),
  };
  await writePrivateWorkspaceFile(
    runnerInstancePath,
    `${JSON.stringify(record)}\n`,
    "fallback runner instance",
  );
  return record;
}

export async function readRunnerInstance({ optional = false } = {}) {
  const info = await lstat(runnerInstancePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) {
    if (optional) return null;
    throw new Error("Fallback runner instance tidak ditemukan");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 4096 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  ) {
    throw new Error("Fallback runner instance wajib regular file owner-only");
  }
  const handle = await open(
    runnerInstancePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > 4096
    )
      throw new Error("Fallback runner instance berubah saat dibuka");
    const record = JSON.parse(await handle.readFile("utf8"));
    if (
      record?.version !== 1 ||
      record.workspaceRoot !== workspaceRoot ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 1 ||
      !/^[a-f0-9]{64}$/i.test(String(record.tokenDigest)) ||
      !Number.isFinite(Date.parse(record.heartbeatAt))
    )
      throw new Error("Fallback runner instance gagal validasi");
    return record;
  } finally {
    await handle.close();
  }
}

export async function runnerInstanceActive(
  pid,
  { expectedToken = null, observe = false, maxAgeMs = 5000 } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const first = await readRunnerInstance({ optional: true });
  const expectedDigest = expectedToken
    ? runnerInstanceTokenDigest(expectedToken)
    : null;
  const valid = (record) => {
    const age = Date.now() - Date.parse(record?.heartbeatAt ?? "");
    return Boolean(
      record &&
      record.pid === pid &&
      (!expectedDigest || record.tokenDigest === expectedDigest) &&
      Number.isFinite(age) &&
      age >= -5000 &&
      age <= maxAgeMs,
    );
  };
  if (!valid(first)) return false;
  if (!observe) return true;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
  const second = await readRunnerInstance({ optional: true });
  return Boolean(
    valid(second) &&
    second.tokenDigest === first.tokenDigest &&
    Date.parse(second.heartbeatAt) > Date.parse(first.heartbeatAt),
  );
}

export async function removeRunnerInstanceIfOwned(pid, token) {
  const record = await readRunnerInstance({ optional: true });
  if (
    record?.pid !== pid ||
    record.tokenDigest !== runnerInstanceTokenDigest(token)
  )
    return false;
  await rm(runnerInstancePath, { force: true });
  await syncDirectory(dirname(runnerInstancePath));
  return true;
}

export async function removeRunnerInstanceIfDead(pid) {
  const record = await readRunnerInstance({ optional: true });
  if (record?.pid !== pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  await rm(runnerInstancePath, { force: true });
  await syncDirectory(dirname(runnerInstancePath));
  return true;
}

export async function enforceWorkspaceLogLimits(
  maxBytes = workspaceLogMaxBytes,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024)
    throw new Error("Batas file log workspace tidak valid");
  const directory = await ensurePrivateDirectory(
    join(workspaceRoot, "data", "logs"),
    "log directory",
  );
  const truncated = [];
  for (const name of await readdir(directory)) {
    const target = assertWorkspaceManagedPath(
      join(directory, name),
      "log path",
    );
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Entry log workspace tidak aman: ${name}`);
    if (info.size <= maxBytes) continue;
    const handle = await open(
      target,
      constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino
      )
        throw new Error(`Log berubah saat dibuka: ${name}`);
      await handle.truncate(0);
      await handle.chmod(0o600);
      await handle.sync();
      truncated.push(name);
    } finally {
      await handle.close();
    }
  }
  if (truncated.length) await syncDirectory(directory);
  return truncated;
}

export function localPostgresStartOptions() {
  const socketDirectory = join(workspaceRoot, ".runtime", "postgres-socket");
  if (/[\r\n]/.test(socketDirectory))
    throw new Error(
      "Path workspace mengandung control character yang tidak didukung PostgreSQL",
    );
  const quotedSocket = /^[A-Za-z0-9_./:@+-]+$/.test(socketDirectory)
    ? socketDirectory
    : `'${socketDirectory.replaceAll("'", "'\\''")}'`;
  return `-h 127.0.0.1 -p 55432 -k ${quotedSocket} -c unix_socket_permissions=0700`;
}

export async function configuredLocalPostgresStartOptions() {
  await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "postgres-socket"),
    "PostgreSQL socket directory",
  );
  const expected = localPostgresStartOptions();
  const configured = await readFile(
    join(workspaceRoot, ".runtime", "postgres-start-options"),
    "utf8",
  )
    .then((value) => value.trim())
    .catch(() => "");
  if (!configured)
    throw new Error(
      "Opsi start PostgreSQL lokal tidak ditemukan; jalankan npm run install untuk hardening ulang",
    );
  if (configured !== expected) {
    throw new Error(
      "Opsi start PostgreSQL lokal tidak cocok dengan private socket workspace",
    );
  }
  return configured;
}

export async function syncTunnelToken(environment) {
  const token = String(environment.CLOUDFLARE_TUNNEL_TOKEN ?? "").trim();
  const hostname = String(environment.CLOUDFLARE_HOSTNAME ?? "").trim();
  if (Boolean(token) !== Boolean(hostname))
    throw new Error(
      "CLOUDFLARE_TUNNEL_TOKEN dan CLOUDFLARE_HOSTNAME wajib diisi bersama",
    );
  if (
    hostname &&
    (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
      hostname,
    ) ||
      hostname.includes(".."))
  ) {
    throw new Error(
      "CLOUDFLARE_HOSTNAME harus berupa hostname DNS tanpa scheme atau path",
    );
  }
  const tokenPath = join(workspaceRoot, ".runtime", "cloudflare-token");
  const existing = await lstat(tokenPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    throw new Error("Path token Cloudflare bukan regular file workspace");
  if (!token) {
    await rm(tokenPath, { force: true });
    if (existing) await syncDirectory(dirname(tokenPath));
    return null;
  }
  const temporary = `${tokenPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, tokenPath);
    await syncDirectory(dirname(tokenPath));
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(tokenPath, 0o600);
  return tokenPath;
}

export async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(name) {
  if (name.includes("/"))
    return (await isExecutable(name)) ? resolve(name) : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function processCommandLine(pid) {
  try {
    return (await readFile(`/proc/${pid}/cmdline`))
      .toString("utf8")
      .replaceAll("\0", " ")
      .trim();
  } catch {
    /* /proc is not portable */
  }
  const ps = await findExecutable("ps");
  if (!ps) return null;
  const result = await run(ps, ["-p", String(pid), "-o", "command="], {
    stdio: "pipe",
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function processStartToken(pid) {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const afterCommand = source
      .slice(source.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return afterCommand[19] || null;
  } catch {
    /* portable ps fallback below */
  }
  const ps = await findExecutable("ps");
  if (!ps) return pid === process.pid ? localProcessStartToken : null;
  const result = await run(ps, ["-p", String(pid), "-o", "lstart="], {
    env: inheritedEnvironment(),
    stdio: "pipe",
    allowFailure: true,
  });
  const started =
    result.code === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
  if (started) return `ps:${started}`;
  return pid === process.pid ? localProcessStartToken : null;
}

export async function getProcessStartToken(pid = process.pid) {
  return processStartToken(pid);
}

export async function processMatches(pid, expectedFragments) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const commandLine = await processCommandLine(pid);
  const fragments = Array.isArray(expectedFragments)
    ? expectedFragments
    : [expectedFragments];
  return Boolean(
    commandLine &&
    fragments.every(
      (fragment) =>
        typeof fragment === "string" && commandLine.includes(fragment),
    ),
  );
}

export async function processIdentityMatches(
  pid,
  expectedFragments,
  expectedStartToken = null,
) {
  if (
    typeof expectedStartToken === "string" &&
    /^handoff:[a-f0-9]{64}$/i.test(expectedStartToken) &&
    pid === process.ppid
  ) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  if (!(await processMatches(pid, expectedFragments))) return false;
  const current = await processStartToken(pid);
  return (
    !expectedStartToken || Boolean(current && current === expectedStartToken)
  );
}

function restoreTokenDigest(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function restoreTokenMatches(token, digest) {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < 32 ||
    !/^[a-f0-9]{64}$/i.test(String(digest))
  )
    return false;
  const actual = Buffer.from(restoreTokenDigest(token), "hex");
  const expected = Buffer.from(String(digest), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateRestoreHandoff(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Restore handoff marker tidak valid");
  if (record.version !== 1 || record.workspaceRoot !== workspaceRoot)
    throw new Error("Restore handoff marker bukan milik workspace ini");
  if (
    !uuidPattern.test(String(record.operationId)) ||
    !uuidPattern.test(String(record.jobId))
  )
    throw new Error("Restore handoff identifier tidak valid");
  if (!/^[a-f0-9]{64}$/i.test(String(record.tokenDigest)))
    throw new Error("Restore handoff token digest tidak valid");
  if (
    !Number.isSafeInteger(record.coordinatorPid) ||
    record.coordinatorPid <= 1 ||
    !Number.isSafeInteger(record.parentPid) ||
    record.parentPid <= 1
  )
    throw new Error("Restore handoff PID tidak valid");
  if (
    typeof record.coordinatorStartToken !== "string" ||
    !record.coordinatorStartToken
  )
    throw new Error("Restore handoff coordinator start token tidak valid");
  if (typeof record.parentStartToken !== "string" || !record.parentStartToken)
    throw new Error("Restore handoff parent start token tidak valid");
  if (!restoreHandoffPhases.has(record.phase))
    throw new Error("Restore handoff phase tidak valid");
  if (
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    throw new Error("Restore handoff timestamp tidak valid");
  return record.context === undefined
    ? record
    : { ...record, context: validateRestoreJournalContext(record.context) };
}

function validateRestoreJournalContext(context) {
  if (context === undefined) return undefined;
  if (!context || typeof context !== "object" || Array.isArray(context))
    throw new Error("Restore journal context tidak valid");
  const sourceFilename = String(context.sourceFilename ?? "");
  const artifactSha256 = String(context.artifactSha256 ?? "").toLowerCase();
  const stageRelativePath = String(context.stageRelativePath ?? "");
  if (
    basename(sourceFilename) !== sourceFilename ||
    !sourceFilename.endsWith(".ocgwb")
  )
    throw new Error("Restore journal source filename tidak valid");
  if (!/^[a-f0-9]{64}$/.test(artifactSha256))
    throw new Error("Restore journal artifact SHA-256 tidak valid");
  const stage = assertWorkspaceManagedPath(
    resolve(workspaceRoot, stageRelativePath),
    "restore journal staging path",
  );
  const canonicalStageRelativePath = relative(workspaceRoot, stage);
  if (stageRelativePath !== canonicalStageRelativePath)
    throw new Error(
      "Restore journal staging path harus canonical workspace-relative",
    );
  if (
    !/^\.restore-stage-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      basename(stage),
    )
  ) {
    throw new Error("Restore journal staging path tidak valid");
  }
  return {
    sourceFilename,
    artifactSha256,
    stageRelativePath: canonicalStageRelativePath,
  };
}

async function removeRestoreJournalStage(record) {
  if (!record.context)
    throw new Error(
      "Restore journal tidak memiliki staging context; cleanup fail-closed",
    );
  const context = validateRestoreJournalContext(record.context);
  const stage = assertWorkspaceManagedPath(
    resolve(workspaceRoot, context.stageRelativePath),
    "restore journal staging cleanup",
  );
  const workspaceInfo = await lstat(workspaceRoot);
  if (
    !workspaceInfo.isDirectory() ||
    workspaceInfo.isSymbolicLink() ||
    (typeof process.getuid === "function" &&
      workspaceInfo.uid !== process.getuid())
  ) {
    throw new Error("Workspace root restore cleanup tidak aman");
  }
  const stageParts = relative(workspaceRoot, stage).split(sep).filter(Boolean);
  let currentParent = workspaceRoot;
  for (const part of stageParts.slice(0, -1)) {
    currentParent = join(currentParent, part);
    const info = await lstat(currentParent);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw new Error(
        "Restore staging parent bukan directory workspace yang aman",
      );
    }
  }
  const rootInfo = await lstat(stage).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return;
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  async function validateTree(target) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error("Restore staging berisi entry non-regular");
    if (
      (info.mode & 0o077) !== 0 ||
      (expectedUid !== null && info.uid !== expectedUid)
    ) {
      throw new Error("Restore staging bukan owner-only");
    }
    if (info.isDirectory()) {
      for (const name of await readdir(target))
        await validateTree(join(target, name));
    }
  }
  await validateTree(stage);
  await rm(stage, { recursive: true, force: true });
  await syncDirectory(dirname(stage));
}

export async function readRestoreHandoff({ optional = false } = {}) {
  const info = await lstat(restoreHandoffPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) {
    if (optional) return null;
    throw new Error("Restore handoff marker tidak ditemukan");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  ) {
    throw new Error("Restore handoff marker wajib regular file owner-only");
  }
  if (info.size > 16_384)
    throw new Error("Restore handoff marker terlalu besar");
  const handle = await open(
    restoreHandoffPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > 16_384
    ) {
      throw new Error("Restore handoff marker berubah saat dibuka");
    }
    return validateRestoreHandoff(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

async function assertCurrentRestoreCoordinator(record, operationId, token) {
  if (
    record.operationId !== operationId ||
    !restoreTokenMatches(token, record.tokenDigest)
  )
    throw new Error("Credential restore handoff tidak valid");
  if (record.coordinatorPid !== process.pid)
    throw new Error("Restore handoff bukan milik coordinator aktif");
  const currentStartToken = await processStartToken(process.pid);
  if (
    !currentStartToken ||
    record.coordinatorStartToken !== currentStartToken
  ) {
    throw new Error("Restore coordinator PID telah digunakan ulang");
  }
}

export async function createRestoreHandoff({
  operationId,
  jobId,
  parentPid,
  token,
  context,
}) {
  if (
    !uuidPattern.test(String(operationId)) ||
    !uuidPattern.test(String(jobId))
  )
    throw new Error("Restore handoff operation/job ID tidak valid");
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 1 ||
    process.ppid !== parentPid
  )
    throw new Error("Restore handoff parent PID tidak valid");
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") < 32)
    throw new Error("Restore handoff token terlalu pendek");
  const detectedParentStartToken = await processStartToken(parentPid);
  const parentOwned = detectedParentStartToken
    ? await processIdentityMatches(
        parentPid,
        ["maintenance-worker.js"],
        detectedParentStartToken,
      )
    : process.ppid === parentPid;
  if (!parentOwned)
    throw new Error(
      "Restore handoff parent bukan maintenance worker aktif/direct parent",
    );
  await ensurePrivateDirectory(
    dirname(restoreHandoffPath),
    "restore handoff directory",
  );
  const coordinatorStartToken = await processStartToken(process.pid);
  const parentStartToken =
    detectedParentStartToken ?? `handoff:${restoreTokenDigest(token)}`;
  if (!coordinatorStartToken)
    throw new Error(
      "Process start token restore tidak dapat diverifikasi; handoff fail-closed",
    );
  const now = new Date().toISOString();
  const record = {
    version: 1,
    workspaceRoot,
    operationId,
    jobId,
    tokenDigest: restoreTokenDigest(token),
    coordinatorPid: process.pid,
    coordinatorStartToken,
    parentPid,
    parentStartToken,
    phase: "ready",
    createdAt: now,
    updatedAt: now,
    ...(context === undefined
      ? {}
      : { context: validateRestoreJournalContext(context) }),
  };
  const temporary = `${restoreHandoffPath}.create-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, restoreHandoffPath);
    await syncDirectory(dirname(restoreHandoffPath));
  } finally {
    await rm(temporary, { force: true });
  }
  return record;
}

export async function createManualRestoreJournal({
  operationId,
  token,
  context,
}) {
  if (!uuidPattern.test(String(operationId)))
    throw new Error("Restore journal operation ID tidak valid");
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") < 32)
    throw new Error("Restore journal token terlalu pendek");
  await ensurePrivateDirectory(
    dirname(restoreHandoffPath),
    "restore journal directory",
  );
  const coordinatorStartToken = await processStartToken(process.pid);
  if (!coordinatorStartToken)
    throw new Error(
      "Process start token restore tidak dapat diverifikasi; journal fail-closed",
    );
  const now = new Date().toISOString();
  const record = {
    version: 1,
    mode: "manual",
    workspaceRoot,
    operationId,
    jobId: operationId,
    tokenDigest: restoreTokenDigest(token),
    coordinatorPid: process.pid,
    coordinatorStartToken,
    parentPid: process.pid,
    parentStartToken: coordinatorStartToken,
    phase: "granted",
    createdAt: now,
    updatedAt: now,
    ...(context === undefined
      ? {}
      : { context: validateRestoreJournalContext(context) }),
  };
  const temporary = `${restoreHandoffPath}.manual-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, restoreHandoffPath);
    await syncDirectory(dirname(restoreHandoffPath));
  } finally {
    await rm(temporary, { force: true });
  }
  return record;
}

export async function transitionRestoreHandoff({
  operationId,
  token,
  from,
  to,
}) {
  if (!restoreHandoffPhases.has(to))
    throw new Error(`Restore handoff target phase tidak valid: ${to}`);
  const record = await readRestoreHandoff();
  await assertCurrentRestoreCoordinator(record, operationId, token);
  const accepted = Array.isArray(from) ? from : [from];
  if (!accepted.includes(record.phase))
    throw new Error(
      `Restore handoff phase ${record.phase}, diharapkan ${accepted.join("|")}`,
    );
  if (!restoreHandoffTransitions[record.phase]?.has(to))
    throw new Error(
      `Transisi restore handoff ${record.phase}->${to} tidak diizinkan`,
    );
  const next = { ...record, phase: to, updatedAt: new Date().toISOString() };
  await writePrivateWorkspaceFile(
    restoreHandoffPath,
    `${JSON.stringify(next)}\n`,
    "restore handoff marker",
  );
  return next;
}

export async function grantRestoreHandoff({ operationId, jobId, token }) {
  const record = await readRestoreHandoff();
  if (
    record.phase !== "ready" ||
    record.operationId !== operationId ||
    record.jobId !== jobId ||
    !restoreTokenMatches(token, record.tokenDigest)
  )
    throw new Error("Restore handoff ready grant tidak valid");
  if (record.parentPid !== process.pid)
    throw new Error("Restore handoff grant bukan milik parent worker");
  const currentStartToken = await processStartToken(process.pid);
  const parentTokenMatches =
    record.parentStartToken === currentStartToken ||
    record.parentStartToken === `handoff:${record.tokenDigest}`;
  if (!parentTokenMatches) {
    throw new Error("Restore handoff parent PID telah digunakan ulang");
  }
  const coordinator =
    (await processIdentityMatches(
      record.coordinatorPid,
      ["scripts/restore.mjs"],
      record.coordinatorStartToken,
    )) ||
    (await processIdentityMatches(
      record.coordinatorPid,
      [join(workspaceRoot, "scripts/restore.mjs")],
      record.coordinatorStartToken,
    ));
  if (!coordinator)
    throw new Error("Restore handoff coordinator tidak valid saat grant");
  const next = {
    ...record,
    phase: "granted",
    updatedAt: new Date().toISOString(),
  };
  await writePrivateWorkspaceFile(
    restoreHandoffPath,
    `${JSON.stringify(next)}\n`,
    "restore handoff marker",
  );
  return next;
}

export async function removeRestoreHandoff({ operationId, token }) {
  const record = await readRestoreHandoff();
  await assertCurrentRestoreCoordinator(record, operationId, token);
  if (!["completed", "failed"].includes(record.phase))
    throw new Error(`Restore handoff belum terminal: ${record.phase}`);
  await removeRestoreJournalStage(record);
  await rm(restoreHandoffPath, { force: true });
  await syncDirectory(dirname(restoreHandoffPath));
}

async function processInstanceDefinitelyGone(pid, expectedStartToken) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  const currentStartToken = await processStartToken(pid);
  return Boolean(
    expectedStartToken &&
    currentStartToken &&
    expectedStartToken !== currentStartToken,
  );
}

export async function assertRestoreLifecycleAuthorization(action) {
  let record = await readRestoreHandoff({ optional: true });
  const token = process.env.OCGW_RESTORE_HANDOFF_TOKEN;
  const operationId = process.env.OCGW_RESTORE_OPERATION_ID;
  if (record) {
    const coordinatorGone = await processInstanceDefinitelyGone(
      record.coordinatorPid,
      record.coordinatorStartToken,
    );
    const safeTerminal = ["completed", "failed"].includes(record.phase);
    const safeGranted = record.phase === "granted";
    const safeReady =
      record.phase === "ready" &&
      (await processInstanceDefinitelyGone(
        record.parentPid,
        record.parentStartToken,
      ));
    if (coordinatorGone && (safeTerminal || safeGranted || safeReady)) {
      const latest = await readRestoreHandoff();
      if (
        latest.operationId !== record.operationId ||
        latest.tokenDigest !== record.tokenDigest ||
        latest.coordinatorPid !== record.coordinatorPid ||
        latest.coordinatorStartToken !== record.coordinatorStartToken ||
        latest.phase !== record.phase
      )
        throw new Error("Restore journal berubah selama safe stale cleanup");
      await removeRestoreJournalStage(latest);
      await rm(restoreHandoffPath, { force: true });
      await syncDirectory(dirname(restoreHandoffPath));
      record = null;
    }
  }
  if (!record) {
    if (token || operationId)
      throw new Error(
        "Credential restore lifecycle tersedia tanpa marker aktif",
      );
    return { authorized: false, record: null };
  }
  const allowedPhases =
    action === "stop"
      ? ["stopping"]
      : action === "start"
        ? ["starting", "recovery_start"]
        : [];
  if (!allowedPhases.includes(record.phase))
    throw new Error(
      `Lifecycle ${action} ditolak selama restore phase ${record.phase}`,
    );
  if (
    operationId !== record.operationId ||
    !restoreTokenMatches(token, record.tokenDigest)
  )
    throw new Error(
      `Lifecycle ${action} tidak memiliki credential restore yang valid`,
    );
  if (process.ppid !== record.coordinatorPid)
    throw new Error(
      `Lifecycle ${action} bukan child langsung restore coordinator`,
    );
  const coordinator =
    (record.coordinatorStartToken.startsWith("self:") &&
      process.ppid === record.coordinatorPid) ||
    (await processIdentityMatches(
      record.coordinatorPid,
      ["scripts/restore.mjs"],
      record.coordinatorStartToken,
    )) ||
    (await processIdentityMatches(
      record.coordinatorPid,
      [join(workspaceRoot, "scripts/restore.mjs")],
      record.coordinatorStartToken,
    ));
  if (!coordinator)
    throw new Error("Restore coordinator ownership tidak valid");
  return { authorized: true, record };
}

export async function verifyWorkspaceLockOwner(
  name,
  pid,
  expectedPatterns,
  expectedOwnerNonce = null,
) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) ||
    !Number.isSafeInteger(pid) ||
    pid <= 1
  )
    return false;
  const lockPath = join(workspaceRoot, ".runtime", "locks", `${name}.lock`);
  const info = await lstat(lockPath).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  const ownerPath = join(lockPath, "owner.json");
  const ownerInfo = await lstat(ownerPath).catch(() => null);
  if (!ownerInfo?.isFile() || ownerInfo.isSymbolicLink()) return false;
  const owner = await readFile(ownerPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (owner?.pid !== pid || owner?.workspaceRoot !== workspaceRoot)
    return false;
  if (
    typeof expectedOwnerNonce === "string" &&
    expectedOwnerNonce.length >= 24
  ) {
    return process.ppid === pid && owner.nonce === expectedOwnerNonce;
  }
  const commandLine = await processCommandLine(pid);
  if (
    !commandLine ||
    !expectedPatterns.some((pattern) =>
      pattern.every((fragment) => commandLine.includes(fragment)),
    )
  )
    return false;
  const currentStartToken = await processStartToken(pid);
  return Boolean(
    owner.startToken &&
    currentStartToken &&
    owner.startToken === currentStartToken,
  );
}

export async function acquireWorkspaceLock(name, options = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name))
    throw new Error("Nama lock workspace tidak valid");
  const locksDirectory = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "locks"),
    "lock directory",
  );
  const lockPath = assertWorkspaceManagedPath(
    join(locksDirectory, `${name}.lock`),
    "lock path",
  );
  const ownerPath = join(lockPath, "owner.json");
  const nonce = randomBytes(18).toString("base64url");
  const validOwnerFragments = options.validOwnerFragments ?? [];
  const currentFragments = options.currentFragments ?? [];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = {
        pid: process.pid,
        nonce,
        purpose: options.purpose ?? name,
        workspaceRoot,
        createdAt: new Date().toISOString(),
        startToken: await processStartToken(process.pid),
        currentFragments,
      };
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      let released = false;
      return {
        path: lockPath,
        ownerToken: nonce,
        async release() {
          if (released) return;
          released = true;
          const existing = await readFile(ownerPath, "utf8")
            .then(JSON.parse)
            .catch(() => null);
          if (existing?.pid === process.pid && existing?.nonce === nonce)
            await rm(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await rm(lockPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    }

    const info = await lstat(lockPath).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Lock ${name} bukan directory workspace yang aman`);
    const owner = await readFile(ownerPath, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (!owner && Date.now() - info.mtimeMs < 10_000)
      throw new Error(`Lock ${name} sedang diinisialisasi proses lain`);
    const pid = Number(owner?.pid);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    const commandLine = alive ? await processCommandLine(pid) : null;
    const commandMatches = Boolean(
      commandLine &&
      validOwnerFragments.some((pattern) =>
        pattern.every((fragment) => commandLine.includes(fragment)),
      ),
    );
    const currentStartToken = alive ? await processStartToken(pid) : null;
    const startMatches = Boolean(
      owner?.startToken &&
      currentStartToken &&
      owner.startToken === currentStartToken,
    );
    if (
      alive &&
      owner?.workspaceRoot === workspaceRoot &&
      commandMatches &&
      startMatches
    ) {
      throw new Error(
        `Lock ${name} sedang dimiliki PID ${pid} (${owner.purpose ?? "workspace operation"})`,
      );
    }
    if (
      alive &&
      owner?.workspaceRoot === workspaceRoot &&
      commandMatches &&
      (!owner?.startToken || !currentStartToken)
    ) {
      throw new Error(
        `Lock ${name} memiliki owner aktif PID ${pid}, tetapi start token tidak dapat diverifikasi; fail-closed`,
      );
    }
    if (alive && !commandLine)
      throw new Error(
        `Lock ${name} memiliki PID aktif ${pid}, tetapi ownership tidak dapat diverifikasi dengan aman`,
      );
    const quarantine = assertWorkspaceManagedPath(
      join(locksDirectory, `.${name}.stale-${process.pid}-${nonce}-${attempt}`),
      "stale lock quarantine",
    );
    try {
      await rename(lockPath, quarantine);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  }
  throw new Error(`Gagal memperoleh lock workspace ${name}`);
}

export function run(command, args = [], options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
      shell: false,
      detached: options.detached ?? false,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout)
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    if (child.stderr)
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 || options.allowFailure)
        resolvePromise({
          code: code ?? 1,
          signal,
          stdout,
          stderr,
          pid: child.pid,
        });
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} gagal (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
    });
    if (options.unref) child.unref();
  });
}

export async function commandVersion(command, args = ["--version"]) {
  if (!command) return null;
  const result = await run(command, args, {
    stdio: "pipe",
    allowFailure: true,
  });
  return result.code === 0
    ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0]
    : null;
}

function parseSemver(value) {
  const match = String(value ?? "").match(
    /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/,
  );
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        text: `${match[1]}.${match[2]}.${match[3]}`,
      }
    : null;
}

function versionAtLeast(version, minimum) {
  if (!version) return false;
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

export async function detectRuntime() {
  const bun = await findExecutable("bun");
  const node = await findExecutable("node");
  const bunVersion = bun ? await commandVersion(bun) : null;
  const nodeVersion = node ? await commandVersion(node) : null;
  const bunParsed = parseSemver(bunVersion);
  const bunCompatible = Boolean(
    bun && versionAtLeast(bunParsed, minimumBunVersion),
  );
  const selected = bunCompatible
    ? { kind: "bun", command: bun, version: bunVersion }
    : node
      ? { kind: "node", command: node, version: nodeVersion }
      : null;
  return {
    selected,
    bun: bunVersion,
    bunCommand: bun,
    bunVersion: bunParsed,
    bunCompatible,
    node: nodeVersion,
    nodeCommand: node,
  };
}

export function parseCloudflaredVersion(value) {
  const match = String(value ?? "").match(
    /(?:^|\s)(\d{4})\.(\d{1,2})\.(\d+)(?:\s|$|[-+])/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export async function cloudflaredVersionInfo(binary) {
  if (!binary) return { raw: null, version: null, compatible: false };
  const result = await run(binary, ["--version"], {
    env: selectEnvironment(process.env, ["PATH", "HOME"]),
    stdio: "pipe",
    allowFailure: true,
  });
  const raw =
    result.code === 0
      ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0]
      : null;
  const version = parseCloudflaredVersion(raw);
  const compatible = Boolean(
    version &&
    (version.major > 2025 ||
      (version.major === 2025 &&
        (version.minor > 4 || (version.minor === 4 && version.patch >= 0)))),
  );
  return { raw, version, compatible };
}

export async function cleanupWorkspacePm2(pm2, environment) {
  const tracked = new Set();
  const capture = await run(pm2, ["jlist"], {
    env: environment,
    stdio: "pipe",
    allowFailure: true,
  });
  if (capture.code === 0) {
    try {
      for (const item of JSON.parse(capture.stdout)) {
        const pid = Number(item?.pid);
        if (Number.isSafeInteger(pid) && pid > 1) tracked.add(pid);
      }
    } catch {
      /* pm2 kill below remains the authoritative cleanup */
    }
  }
  const pm2Home = assertWorkspaceManagedPath(environment.PM2_HOME, "PM2_HOME");
  for (const pid of await workspacePm2ProcessIds(pm2Home)) tracked.add(pid);
  const daemonPidPath = join(pm2Home, "pm2.pid");
  const daemonPid = await readFile(daemonPidPath, "utf8")
    .then((value) => Number(value.trim()))
    .catch(() => null);
  if (Number.isSafeInteger(daemonPid) && daemonPid > 1) tracked.add(daemonPid);

  const deleted = await run(pm2, ["delete", "all"], {
    env: environment,
    stdio: "pipe",
    allowFailure: true,
  });
  const killed = await run(pm2, ["kill"], {
    env: environment,
    stdio: "pipe",
    allowFailure: true,
  });
  for (let attempt = 0; attempt < 100 && tracked.size > 0; attempt += 1) {
    for (const pid of tracked) {
      try {
        process.kill(pid, 0);
      } catch {
        tracked.delete(pid);
      }
    }
    if (tracked.size > 0)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (tracked.size > 0)
    throw new Error(
      `Cleanup PM2 workspace belum tuntas; PID masih aktif: ${[...tracked].join(", ")}`,
    );
  if (killed.code !== 0 && deleted.code !== 0) {
    const detail =
      killed.stderr || deleted.stderr || killed.stdout || deleted.stdout;
    throw new Error(
      `Cleanup PM2 workspace gagal${detail ? `: ${detail.trim()}` : ""}`,
    );
  }
}

export async function workspacePm2ProcessIds(pm2HomeValue) {
  const pm2Home = assertWorkspaceManagedPath(pm2HomeValue, "PM2_HOME");
  const homeInfo = await lstat(pm2Home).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!homeInfo) return [];
  if (
    !homeInfo.isDirectory() ||
    homeInfo.isSymbolicLink() ||
    (typeof process.getuid === "function" && homeInfo.uid !== process.getuid())
  ) {
    throw new Error("PM2_HOME workspace bukan directory aman milik user aktif");
  }
  const candidates = [join(pm2Home, "pm2.pid")];
  const pidsDirectory = join(pm2Home, "pids");
  const pidsInfo = await lstat(pidsDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (pidsInfo) {
    if (!pidsInfo.isDirectory() || pidsInfo.isSymbolicLink())
      throw new Error("PM2 PID directory tidak aman");
    for (const name of await readdir(pidsDirectory))
      if (name.endsWith(".pid")) candidates.push(join(pidsDirectory, name));
  }
  const result = new Set();
  for (const path of candidates) {
    const info = await lstat(path).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 128 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new Error("PM2 PID file tidak aman");
    const pid = await readFile(path, "utf8").then((value) =>
      Number(value.trim()),
    );
    if (Number.isSafeInteger(pid) && pid > 1) result.add(pid);
  }
  return [...result];
}

export async function liveWorkspacePm2ProcessIds(pm2Home) {
  const live = [];
  for (const pid of await workspacePm2ProcessIds(pm2Home)) {
    try {
      process.kill(pid, 0);
      live.push(pid);
    } catch (error) {
      if (error?.code === "EPERM") live.push(pid);
    }
  }
  return live;
}

export function printCheck(ok, label, detail = "") {
  process.stdout.write(
    `${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}\n`,
  );
}

export function requireExplicitNpmRun() {
  const npmCommand = process.env.npm_command;
  if (npmCommand === "install" || npmCommand === "ci") {
    process.stdout.write(
      "Lifecycle dependency install terdeteksi; deployment dilewati. Jalankan `npm run install` secara eksplisit.\n",
    );
    return false;
  }
  return true;
}

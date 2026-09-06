import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireWorkspaceLock,
  assertSessionAffineDatabaseUrl,
  assertWorkspaceManagedPath,
  assertRestoreLifecycleAuthorization,
  cloudflaredVersionInfo,
  configuredLocalPostgresStartOptions,
  detectRuntime,
  ensurePrivateDirectory,
  ensureWorkspaceDirectories,
  findExecutable,
  inheritedEnvironment,
  localPostgresStartOptions,
  minimumBunVersion,
  printCheck,
  processMatches,
  readWorkspaceEnv,
  requireExplicitNpmRun,
  run,
  syncTunnelToken,
  updateEnvFile,
  writePrivateWorkspaceFile,
  workspaceRoot,
} from "./lib/common.mjs";
import { processStates } from "./lib/process-state.mjs";

if (!requireExplicitNpmRun()) process.exit(0);
process.umask(0o077);

const installScript = join(workspaceRoot, "scripts/install.mjs");
const startScript = join(workspaceRoot, "scripts/start.mjs");
const stopScript = join(workspaceRoot, "scripts/stop.mjs");
const restoreScript = join(workspaceRoot, "scripts/restore.mjs");
const checkOnly = process.argv.includes("--check-only");
const artifactPaths = Object.freeze([
  "node_modules",
  "packages/shared/dist",
  "apps/gateway-api/dist",
  "apps/baileys-service/dist",
  "apps/dashboard/.next",
]);
const excludedRootEntries = new Set([
  ".git",
  ".runtime",
  ".env",
  "data",
  "node_modules",
]);
const excludedNestedEntries = new Set([
  "node_modules",
  "dist",
  ".next",
  "coverage",
]);

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64");
}

function usableDatabaseUrl(value) {
  return (
    typeof value === "string" &&
    /^postgres(?:ql)?:\/\//.test(value) &&
    !value.includes("user:password")
  );
}

async function pathInfo(path) {
  return lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertSafePathParents(path, { includeTarget = false } = {}) {
  const resolved = assertWorkspaceManagedPath(path, "artifact path");
  const parts = relative(workspaceRoot, resolved).split(sep).filter(Boolean);
  let current = workspaceRoot;
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = join(current, parts[index]);
    const info = await pathInfo(current);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `Parent artifact bukan directory regular workspace: ${relative(workspaceRoot, current)}`,
      );
    }
  }
  return resolved;
}

async function ensureEnv({ persist = true } = {}) {
  const envPath = join(workspaceRoot, ".env");
  const info = await pathInfo(envPath);
  if (info?.isSymbolicLink() || (info && !info.isFile()))
    throw new Error(".env wajib regular file non-symlink");
  if (!info) {
    if (persist)
      await copyFile(
        join(workspaceRoot, ".env.example"),
        envPath,
        constants.COPYFILE_EXCL,
      );
  } else if (
    !persist &&
    ((info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()))
  ) {
    throw new Error(".env check-only wajib owner-only milik user aktif");
  }
  if (persist) await chmod(envPath, 0o600);

  const current = await readWorkspaceEnv({ optional: true });
  const updates = {};
  const candidates = [
    current.DATABASE_URL,
    current.POSTGRES_URL,
    current.POSTGRESQL_URL,
    current.OPENCLAW_DATABASE_URL,
  ];
  let databaseUrl = candidates.find(usableDatabaseUrl);
  if (!databaseUrl && current.PGHOST && current.PGUSER) {
    const authentication = `${encodeURIComponent(current.PGUSER)}${current.PGPASSWORD ? `:${encodeURIComponent(current.PGPASSWORD)}` : ""}`;
    databaseUrl = `postgresql://${authentication}@${current.PGHOST}:${current.PGPORT || "5432"}/${current.PGDATABASE || "openclaw_gateway"}`;
  }
  if (databaseUrl && !usableDatabaseUrl(current.DATABASE_URL))
    updates.DATABASE_URL = databaseUrl;
  for (const key of [
    "JWT_SECRET",
    "INTERNAL_API_KEY",
    "SESSION_ENCRYPTION_KEY",
    "WHATSAPP_SESSION_ENCRYPTION_KEY",
    "BACKUP_ENCRYPTION_KEY",
  ]) {
    if (!current[key])
      updates[key] = secret(
        key === "JWT_SECRET" || key === "INTERNAL_API_KEY" ? 48 : 32,
      );
  }
  if (!current.OPENCLAW_API_KEY) updates.OPENCLAW_API_KEY = secret(48);
  if (!current.BOOTSTRAP_ADMIN_EMAIL)
    updates.BOOTSTRAP_ADMIN_EMAIL = "ramdanifahmy2023@gmail.com";
  if (!current.BOOTSTRAP_ADMIN_PASSWORD)
    updates.BOOTSTRAP_ADMIN_PASSWORD = secret(48);
  if (persist && Object.keys(updates).length) await updateEnvFile(updates);
  return persist ? readWorkspaceEnv() : { ...current, ...updates };
}

async function setupLocalPostgres() {
  const binaries = Object.fromEntries(
    await Promise.all(
      ["initdb", "pg_ctl", "createdb"].map(async (name) => [
        name,
        await findExecutable(name),
      ]),
    ),
  );
  if (!binaries.initdb || !binaries.pg_ctl || !binaries.createdb) return null;

  const dataDir = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "postgres"),
    "PostgreSQL data directory",
  );
  await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "postgres-socket"),
    "PostgreSQL socket directory",
  );
  const credentialsPath = join(
    workspaceRoot,
    ".runtime",
    "postgres-credentials.json",
  );
  const passwordFile = join(
    workspaceRoot,
    ".runtime",
    `pg-password-${process.pid}`,
  );
  const username = userInfo().username;
  const newPassword = secret(24).replace(/[+/=]/g, "a");
  const versionInfo = await pathInfo(join(dataDir, "PG_VERSION"));
  if (versionInfo?.isSymbolicLink() || (versionInfo && !versionInfo.isFile()))
    throw new Error("PG_VERSION lokal bukan regular file yang aman");
  const initialized = Boolean(versionInfo);

  if (!initialized) {
    const entries = await readdir(dataDir);
    if (entries.length > 0)
      throw new Error(
        "PostgreSQL data directory belum terinisialisasi tetapi tidak kosong; intervensi manual diperlukan",
      );
    await writeFile(passwordFile, `${newPassword}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await run(
        binaries.initdb,
        [
          "-D",
          dataDir,
          "--username",
          username,
          "--pwfile",
          passwordFile,
          "--auth-host=scram-sha-256",
          "--auth-local=scram-sha-256",
          "--encoding=UTF8",
          "--no-locale",
        ],
        { env: inheritedEnvironment() },
      );
      await writeFile(
        credentialsPath,
        `${JSON.stringify({ username, password: newPassword }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
    } finally {
      await rm(passwordFile, { force: true });
    }
  }

  const credentialsInfo = await pathInfo(credentialsPath);
  if (!credentialsInfo?.isFile() || credentialsInfo.isSymbolicLink()) {
    throw new Error(
      "Credential PostgreSQL lokal hilang/tidak aman; pulihkan file workspace atau gunakan DATABASE_URL managed",
    );
  }
  await chmod(credentialsPath, 0o600);
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  if (
    typeof credentials.username !== "string" ||
    !credentials.username ||
    typeof credentials.password !== "string" ||
    !credentials.password
  ) {
    throw new Error("Credential PostgreSQL lokal tidak valid");
  }
  const hbaPath = join(dataDir, "pg_hba.conf");
  const hbaInfo = await pathInfo(hbaPath);
  if (!hbaInfo?.isFile() || hbaInfo.isSymbolicLink())
    throw new Error("pg_hba.conf lokal bukan regular file yang aman");
  const hba = await readFile(hbaPath, "utf8");
  const hardenedHba = hba
    .replace(
      /^(\s*local\s+\S+\s+\S+\s+)trust(\s*(?:#.*)?)$/gm,
      "$1scram-sha-256$2",
    )
    .replace(
      /^(\s*host(?:ssl|nossl)?\s+\S+\s+\S+\s+\S+\s+)trust(\s*(?:#.*)?)$/gm,
      "$1scram-sha-256$2",
    );
  if (hardenedHba !== hba)
    await writePrivateWorkspaceFile(
      hbaPath,
      hardenedHba,
      "PostgreSQL pg_hba.conf",
    );

  const optionsPath = join(workspaceRoot, ".runtime", "postgres-start-options");
  await writePrivateWorkspaceFile(
    optionsPath,
    `${localPostgresStartOptions()}\n`,
    "PostgreSQL start options",
  );
  const startOptions = await configuredLocalPostgresStartOptions();
  const postgresEnvironment = inheritedEnvironment();
  const status = await run(binaries.pg_ctl, ["-D", dataDir, "status"], {
    env: postgresEnvironment,
    stdio: "pipe",
    allowFailure: true,
  });
  const logPath = join(workspaceRoot, "data/logs/postgres.log");
  if (status.code !== 0) {
    await run(
      binaries.pg_ctl,
      ["-D", dataDir, "-l", logPath, "-o", startOptions, "start", "-w"],
      { env: postgresEnvironment },
    );
  } else {
    const activeOptions = await readFile(
      join(dataDir, "postmaster.opts"),
      "utf8",
    ).catch(() => "");
    const privateSocket = join(workspaceRoot, ".runtime", "postgres-socket");
    const hardened =
      activeOptions.includes("127.0.0.1") &&
      activeOptions.includes("55432") &&
      activeOptions.includes(privateSocket) &&
      activeOptions.includes("unix_socket_permissions=0700");
    if (!hardened || hardenedHba !== hba) {
      await run(
        binaries.pg_ctl,
        [
          "-D",
          dataDir,
          "-l",
          logPath,
          "-o",
          startOptions,
          "restart",
          "-m",
          "fast",
          "-w",
        ],
        { env: postgresEnvironment },
      );
    }
  }
  await chmod(optionsPath, 0o600);
  const childEnv = {
    ...postgresEnvironment,
    PGPASSWORD: String(credentials.password),
  };
  await run(
    binaries.createdb,
    [
      "-h",
      "127.0.0.1",
      "-p",
      "55432",
      "-U",
      String(credentials.username),
      "openclaw_gateway",
    ],
    {
      env: childEnv,
      stdio: "pipe",
      allowFailure: true,
    },
  );
  const url = `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@127.0.0.1:55432/openclaw_gateway`;
  await updateEnvFile({ DATABASE_URL: url, DATABASE_SSL: "false" });
  return url;
}

async function setupLocalRedis(env) {
  if (env.REDIS_URL) return env.REDIS_URL;
  const redisServer = await findExecutable("redis-server");
  if (!redisServer) return null;
  const redisDir = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "redis"),
    "Redis data directory",
  );
  const credentialsPath = join(
    workspaceRoot,
    ".runtime",
    "redis-credentials.json",
  );
  const credentialsInfo = await pathInfo(credentialsPath);
  if (
    credentialsInfo?.isSymbolicLink() ||
    (credentialsInfo && !credentialsInfo.isFile())
  )
    throw new Error("Credential Redis lokal tidak aman");
  let password;
  if (credentialsInfo) {
    password = JSON.parse(await readFile(credentialsPath, "utf8")).password;
    if (typeof password !== "string" || !password)
      throw new Error("Credential Redis lokal tidak valid");
    await chmod(credentialsPath, 0o600);
  } else {
    password = secret(32).replace(/[+/=]/g, "x");
    await writeFile(
      credentialsPath,
      `${JSON.stringify({ password }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  const config = [
    "bind 127.0.0.1",
    "protected-mode yes",
    "port 56379",
    "daemonize no",
    "supervised no",
    `dir ${JSON.stringify(redisDir)}`,
    "appendonly yes",
    "appendfsync everysec",
    `requirepass ${password}`,
    'logfile ""',
    "",
  ].join("\n");
  await writePrivateWorkspaceFile(
    join(workspaceRoot, ".runtime", "redis.conf"),
    config,
    "Redis config",
  );
  const url = `redis://:${encodeURIComponent(password)}@127.0.0.1:56379/0`;
  await updateEnvFile({ REDIS_URL: url });
  return url;
}

async function prepareTunnel(env) {
  const tokenPath = await syncTunnelToken(env);
  if (!tokenPath) return { configured: false, binary: null, version: null };
  const local = join(workspaceRoot, ".runtime/bin/cloudflared");
  const localInfo = await pathInfo(local);
  const binary =
    (localInfo?.isFile() && !localInfo.isSymbolicLink()
      ? await findExecutable(local)
      : null) || (await findExecutable("cloudflared"));
  return {
    configured: true,
    binary,
    version: await cloudflaredVersionInfo(binary),
  };
}

async function createStage() {
  const stagingParent = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "staging"),
    "staging directory",
  );
  const stage = assertWorkspaceManagedPath(
    join(
      stagingParent,
      `install-${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`,
    ),
    "install staging path",
  );
  await mkdir(stage, { mode: 0o700 });

  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (excludedRootEntries.has(entry.name) || entry.name.endsWith(".zip"))
      continue;
    const source = join(workspaceRoot, entry.name);
    const target = join(stage, entry.name);
    const topInfo = await lstat(source);
    if (topInfo.isSymbolicLink())
      throw new Error(`Source staging tidak boleh symlink: ${entry.name}`);
    await cp(source, target, {
      recursive: topInfo.isDirectory(),
      dereference: false,
      errorOnExist: true,
      force: false,
      filter: async (candidate) => {
        const info = await lstat(candidate);
        if (info.isSymbolicLink())
          throw new Error(
            `Source staging tidak boleh symlink: ${relative(workspaceRoot, candidate)}`,
          );
        const nested = relative(workspaceRoot, candidate)
          .split(sep)
          .filter(Boolean);
        return (
          nested.length <= 1 ||
          !nested.slice(1).some((part) => excludedNestedEntries.has(part))
        );
      },
    });
  }
  await chmod(stage, 0o700);
  return stage;
}

async function buildStage(stage, npm) {
  const lockExists = Boolean(await pathInfo(join(stage, "package-lock.json")));
  process.stdout.write(
    `Dependency dan build dijalankan di staging privat ${relative(workspaceRoot, stage)}.\n`,
  );
  const dependencyEnvironment = {
    ...inheritedEnvironment(),
    OCGW_DEPENDENCY_INSTALL: "1",
  };
  await run(
    npm,
    [lockExists ? "ci" : "install", "--include=dev", "--no-audit", "--no-fund"],
    {
      cwd: stage,
      env: dependencyEnvironment,
    },
  );
  await run(npm, ["run", "build"], { cwd: stage, env: dependencyEnvironment });
  for (const artifact of artifactPaths) {
    const path = join(stage, artifact);
    const info = await pathInfo(path);
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error(
        `Build staging tidak menghasilkan directory regular: ${artifact}`,
      );
  }
}

async function testDatabaseWithStage(stage, env) {
  const sharedUrl = pathToFileURL(
    join(stage, "packages/shared/dist/index.js"),
  ).href;
  const source = [
    `const shared = await import(${JSON.stringify(sharedUrl)});`,
    `const env = shared.loadEnvironment({ fresh: true, root: ${JSON.stringify(stage)} });`,
    "const db = shared.createDatabasePool(env);",
    "try { await db.query('SELECT 1 AS connected'); } finally { await db.end(); }",
  ].join("\n");
  await run(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: stage,
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  printCheck(true, "Database", "connection diuji dari build staging");
}

async function safetyBackup() {
  const prerequisites = [
    join(workspaceRoot, "node_modules"),
    join(workspaceRoot, "packages/shared/dist"),
  ];
  if (
    !(await Promise.all(prerequisites.map(pathInfo))).every(
      (info) => info?.isDirectory() && !info.isSymbolicLink(),
    )
  ) {
    process.stderr.write(
      "PERINGATAN: safety backup dilewati karena instalasi aktif belum lengkap.\n",
    );
    return false;
  }
  const result = await run(
    process.execPath,
    ["scripts/backup.mjs", "--safety"],
    { stdio: "pipe", allowFailure: true },
  );
  if (result.code !== 0) {
    process.stderr.write(
      `PERINGATAN: safety backup gagal; migrasi akan tetap berjalan sesuai permintaan installer.${result.stderr ? ` ${result.stderr.trim()}` : ""}\n`,
    );
    return false;
  }
  process.stdout.write(result.stdout || "Safety backup database berhasil.\n");
  return true;
}

async function wasRunningBeforeInstall() {
  const state = await processStates();
  if (state.services.some((service) => service.status === "online"))
    return true;
  const runnerPid = await readFile(
    join(workspaceRoot, ".runtime/pids/runner.pid"),
    "utf8",
  )
    .then((value) => Number(value.trim()))
    .catch(() => null);
  return await processMatches(runnerPid, [
    join(workspaceRoot, "scripts/runner-daemon.mjs"),
  ]);
}

async function activateArtifacts(stage, onCreated) {
  const releases = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime", "releases"),
    "release rollback directory",
  );
  const rollbackRoot = assertWorkspaceManagedPath(
    join(
      releases,
      `activation-${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`,
    ),
    "activation rollback path",
  );
  await mkdir(rollbackRoot, { mode: 0o700 });
  const activation = { activated: [], rollbackRoot };
  onCreated(activation);

  for (const artifact of artifactPaths) {
    const stagedPath = await assertSafePathParents(join(stage, artifact), {
      includeTarget: true,
    });
    const stagedInfo = await lstat(stagedPath);
    if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink())
      throw new Error(`Artifact staging tidak aman: ${artifact}`);

    const activePath = await assertSafePathParents(
      join(workspaceRoot, artifact),
    );
    const activeInfo = await pathInfo(activePath);
    if (
      activeInfo?.isSymbolicLink() ||
      (activeInfo && !activeInfo.isDirectory())
    )
      throw new Error(`Artifact aktif tidak aman: ${artifact}`);

    const previousPath = join(rollbackRoot, "previous", artifact);
    await assertSafePathParents(previousPath);
    await mkdir(dirname(previousPath), { recursive: true, mode: 0o700 });
    if (activeInfo) await rename(activePath, previousPath);
    const entry = {
      activePath,
      previousPath,
      hadPrevious: Boolean(activeInfo),
    };
    activation.activated.push(entry);
    try {
      await rename(stagedPath, activePath);
    } catch (error) {
      try {
        if (activeInfo) await rename(previousPath, activePath);
        activation.activated.pop();
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Aktivasi dan pemulihan langsung gagal untuk ${artifact}`,
        );
      }
      throw error;
    }
  }
  return activation;
}

async function rollbackArtifacts(activation) {
  if (!activation) return;
  for (const item of [...activation.activated].reverse()) {
    const activeInfo = await pathInfo(item.activePath);
    if (
      activeInfo?.isSymbolicLink() ||
      (activeInfo && !activeInfo.isDirectory())
    ) {
      throw new Error(
        `Rollback menolak artifact aktif yang berubah menjadi path tidak aman: ${relative(workspaceRoot, item.activePath)}`,
      );
    }
    if (activeInfo) await rm(item.activePath, { recursive: true, force: true });
    if (item.hadPrevious) await rename(item.previousPath, item.activePath);
  }
  await rm(activation.rollbackRoot, { recursive: true, force: true });
}

async function discardRollback(activation) {
  if (activation)
    await rm(activation.rollbackRoot, { recursive: true, force: true });
}

async function localHealthCheck(env) {
  const targets = [
    [
      "Gateway API",
      `http://127.0.0.1:${env.GATEWAY_PORT || 3100}/health/ready`,
    ],
    [
      "Baileys",
      `http://127.0.0.1:${env.BAILEYS_HEALTH_PORT || 3101}/health/live`,
    ],
    ["Dashboard", `http://127.0.0.1:${env.DASHBOARD_PORT || 3200}/login`],
  ];
  for (const [label, url] of targets) {
    let lastError = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2_000),
          redirect: "manual",
        });
        if (response.status === 200) {
          lastError = "";
          break;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(500);
    }
    if (lastError)
      throw new Error(`${label} gagal health check lokal: ${lastError}`);
    printCheck(true, label, "healthy setelah aktivasi");
  }
}

async function stopServices() {
  await run(process.execPath, ["scripts/stop.mjs", "--keep-database"], {
    env: {
      ...process.env,
      OCGW_LIFECYCLE_OWNER_PID: String(process.pid),
      OCGW_LIFECYCLE_OWNER_TOKEN: lifecycleLock?.ownerToken ?? "",
    },
  });
}

async function startServices() {
  await run(process.execPath, ["scripts/start.mjs"], {
    env: {
      ...process.env,
      OCGW_LIFECYCLE_OWNER_PID: String(process.pid),
      OCGW_LIFECYCLE_OWNER_TOKEN: lifecycleLock?.ownerToken ?? "",
    },
  });
}

async function main() {
  process.stdout.write("\nOpenClaw WhatsApp Gateway Workspace Installer\n\n");
  await ensureWorkspaceDirectories();
  await assertRestoreLifecycleAuthorization("install");
  const installLock = await acquireWorkspaceLock("install", {
    purpose: checkOnly ? "install check" : "install and atomic activation",
    currentFragments: [installScript],
    validOwnerFragments: [[installScript], ["scripts/install.mjs"]],
  });

  let stage = null;
  let activation = null;
  let oldServicesWereRunning = false;
  let servicesStopped = false;
  let databaseMayHaveChanged = false;
  let lifecycleLock = null;

  try {
    const runtime = await detectRuntime();
    if (!runtime.selected)
      throw new Error("Bun atau Node.js tidak ditemukan di workspace");
    const nodeMajor = Number((runtime.node ?? "").match(/v?(\d+)/)?.[1] ?? 0);
    if (nodeMajor < 22)
      throw new Error(
        `Node.js 22+ diperlukan untuk npm dan Next.js; ditemukan ${runtime.node ?? "unknown"}`,
      );
    printCheck(
      true,
      "Runtime",
      runtime.selected.kind === "node" && runtime.bun && !runtime.bunCompatible
        ? `node ${runtime.selected.version}; Bun ${runtime.bun} diabaikan (minimum ${minimumBunVersion.text})`
        : `${runtime.selected.kind} ${runtime.selected.version}`,
    );
    await access(workspaceRoot, constants.W_OK);
    printCheck(true, "Workspace", "writable, tanpa akses root");

    let env = await ensureEnv({ persist: !checkOnly });
    if (!usableDatabaseUrl(env.DATABASE_URL)) {
      if (checkOnly) {
        printCheck(false, "Database", "DATABASE_URL belum tersedia");
        process.exitCode = 1;
        return;
      }
      const localUrl = await setupLocalPostgres();
      if (!localUrl)
        throw new Error(
          "PostgreSQL tidak ditemukan. Isi DATABASE_URL managed/service pada .env; installer tidak memasang package sistem.",
        );
      env = await readWorkspaceEnv();
      printCheck(
        true,
        "Database",
        "workspace-local PostgreSQL terdeteksi dan dikonfigurasi",
      );
    } else {
      assertSessionAffineDatabaseUrl(env.DATABASE_URL, env.DATABASE_POOL_MODE);
      printCheck(
        true,
        "Database",
        "connection ditemukan dari environment/.env",
      );
    }
    assertSessionAffineDatabaseUrl(env.DATABASE_URL, env.DATABASE_POOL_MODE);

    if (checkOnly) {
      const tunnel = await prepareTunnel(env);
      printCheck(
        true,
        "Redis",
        env.REDIS_URL ? "configured" : "PostgreSQL queue fallback",
      );
      printCheck(
        !tunnel.configured ||
          Boolean(tunnel.binary && tunnel.version?.compatible),
        "Cloudflare Tunnel",
        tunnel.configured
          ? !tunnel.binary
            ? "token ada, binary belum tersedia"
            : tunnel.version.compatible
              ? `configured, cloudflared ${tunnel.version.version.text}`
              : `cloudflared ${tunnel.version.version?.text ?? "unknown"} tidak kompatibel; wajib >=2025.4.0`
          : "optional, belum dikonfigurasi",
      );
      if (tunnel.configured && (!tunnel.binary || !tunnel.version?.compatible))
        process.exitCode = 1;
      return;
    }

    const npm = await findExecutable("npm");
    if (!npm) throw new Error("npm tidak ditemukan; Node.js 22+ diperlukan");

    stage = await createStage();
    await buildStage(stage, npm);
    await testDatabaseWithStage(stage, env);
    await safetyBackup();

    await setupLocalRedis(env);
    env = await readWorkspaceEnv();
    const tunnel = await prepareTunnel(env);
    if (tunnel.configured && !tunnel.binary) {
      process.stderr.write(
        "PERINGATAN: token Cloudflare tersedia tetapi binary cloudflared tidak ditemukan; tunnel tidak akan dimulai.\n",
      );
    } else if (tunnel.configured && !tunnel.version.compatible) {
      process.stderr.write(
        `PERINGATAN: cloudflared ${tunnel.version.version?.text ?? "unknown"} <2025.4.0/tidak dikenali; tunnel tidak akan dimulai dengan --token-file.\n`,
      );
    }

    lifecycleLock = await acquireWorkspaceLock("lifecycle", {
      purpose: "install artifact activation",
      currentFragments: [installScript],
      validOwnerFragments: [
        [installScript],
        ["scripts/install.mjs"],
        [startScript],
        ["scripts/start.mjs"],
        [stopScript],
        ["scripts/stop.mjs"],
        [restoreScript],
        ["scripts/restore.mjs"],
      ],
    });
    oldServicesWereRunning = await wasRunningBeforeInstall();
    servicesStopped = oldServicesWereRunning;
    await stopServices();
    activation = await activateArtifacts(stage, (created) => {
      activation = created;
    });

    process.stdout.write(
      "Menerapkan migrasi maju. Perubahan database TIDAK termasuk rollback artifact filesystem.\n",
    );
    databaseMayHaveChanged = true;
    await run(process.execPath, ["scripts/migrate.mjs"]);
    await run(process.execPath, ["scripts/seed.mjs"]);
    await run(process.execPath, ["scripts/bootstrap-admin.mjs"]);
    const inertBootstrapPassword = secret(48);
    await updateEnvFile({ BOOTSTRAP_ADMIN_PASSWORD: inertBootstrapPassword });
    process.env.BOOTSTRAP_ADMIN_PASSWORD = inertBootstrapPassword;
    await startServices();
    servicesStopped = false;
    await localHealthCheck(env);

    await discardRollback(activation);
    activation = null;
    await rm(stage, { recursive: true, force: true });
    stage = null;

    const doctor = await run(process.execPath, ["scripts/doctor.mjs"], {
      allowFailure: true,
    });
    if (doctor.code !== 0)
      process.stderr.write(
        "PERINGATAN: doctor melaporkan dependency eksternal/config opsional belum sehat; aktivasi lokal tetap dipertahankan.\n",
      );
    process.stdout.write(
      "\nInstalasi workspace-local selesai. Login pertama wajib mengganti password bootstrap.\n",
    );
  } catch (error) {
    if (activation) {
      process.stderr.write(
        "Aktivasi gagal; menghentikan release baru dan memulihkan artifact lama.\n",
      );
      let stopError = null;
      try {
        await stopServices();
      } catch (caught) {
        stopError = caught;
      }
      if (stopError) {
        process.stderr.write(
          "BAHAYA: release baru tidak dapat dihentikan; artifact tidak di-rollback agar proses hidup tidak memakai tree yang sedang dipindahkan. Artifact lama tetap ditahan di .runtime/releases.\n",
        );
        if (databaseMayHaveChanged) {
          process.stderr.write(
            "PENTING: migrasi/seed/bootstrap database TIDAK di-rollback otomatis.\n",
          );
        }
        throw new AggregateError(
          [error, stopError],
          "Aktivasi gagal dan release baru tidak dapat dihentikan dengan aman",
        );
      }
      servicesStopped = true;
      await rollbackArtifacts(activation);
      activation = null;
      if (oldServicesWereRunning) {
        await startServices();
        servicesStopped = false;
      }
    } else if (servicesStopped && oldServicesWereRunning) {
      await startServices();
      servicesStopped = false;
    }
    if (databaseMayHaveChanged) {
      process.stderr.write(
        "PENTING: artifact lama dipulihkan, tetapi migrasi/seed/bootstrap database TIDAK di-rollback otomatis. Gunakan safety backup sesuai runbook bila perlu.\n",
      );
    }
    throw error;
  } finally {
    if (stage)
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await lifecycleLock?.release().catch(() => undefined);
    await installLock.release();
  }
}

await main();

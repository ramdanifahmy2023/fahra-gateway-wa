import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  acquireWorkspaceLock,
  assertSessionAffineDatabaseUrl,
  assertRestoreLifecycleAuthorization,
  cleanupWorkspacePm2,
  configuredLocalPostgresStartOptions,
  enforceWorkspaceLogLimits,
  ensureWorkspaceDirectories,
  findExecutable,
  inheritedEnvironment,
  ensurePrivateDirectory,
  liveWorkspacePm2ProcessIds,
  managedConfigurationKeys,
  parseEnv,
  processMatches,
  readRunnerInstance,
  removeRunnerInstanceIfDead,
  run,
  runnerInstanceActive,
  syncTunnelToken,
  updateEnvFile,
  verifyWorkspaceLockOwner,
  writePrivateWorkspaceFile,
  workspaceRoot,
} from "./lib/common.mjs";

const startScript = join(workspaceRoot, "scripts/start.mjs");
const stopScript = join(workspaceRoot, "scripts/stop.mjs");
const runnerScript = join(workspaceRoot, "scripts/runner-daemon.mjs");
const runnerPidPath = join(workspaceRoot, ".runtime/pids/runner.pid");
const runnerModePath = join(workspaceRoot, ".runtime/runner-mode");
const installScript = join(workspaceRoot, "scripts/install.mjs");
const restoreScript = join(workspaceRoot, "scripts/restore.mjs");
const prestartGuardScript = join(workspaceRoot, "scripts/prestart-guard.mjs");

function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (leaderError) {
      return leaderError?.code === "EPERM";
    }
  }
}

async function waitForProcessGroup(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await delay(100);
  }
  return !processGroupAlive(pid);
}

async function cleanupRecordedFallbackGroups() {
  const directory = join(workspaceRoot, ".runtime/pids");
  const fragments = {
    "ocgw-redis": join(workspaceRoot, ".runtime/redis.conf"),
    "ocgw-gateway-api": join(workspaceRoot, "apps/gateway-api/dist/server.js"),
    "ocgw-openclaw-bridge": join(
      workspaceRoot,
      "apps/gateway-api/dist/bridge-worker.js",
    ),
    "ocgw-maintenance": join(
      workspaceRoot,
      "apps/gateway-api/dist/maintenance-worker.js",
    ),
    "ocgw-baileys": join(workspaceRoot, "apps/baileys-service/dist/index.js"),
    "ocgw-dashboard": "apps/dashboard/.next/standalone",
    "ocgw-cloudflared": join(workspaceRoot, ".runtime/cloudflare-token"),
  };
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".pid") || name === "runner.pid") continue;
    const service = name.slice(0, -4);
    const path = join(directory, name);
    const pid = await readFile(path, "utf8")
      .then((value) => Number(value.trim()))
      .catch(() => null);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      await rm(path, { force: true });
      continue;
    }
    if (!processGroupAlive(pid)) {
      await rm(path, { force: true });
      continue;
    }
    let leaderAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      leaderAlive = false;
    }
    const fragment = fragments[service];
    if (!fragment || (leaderAlive && !(await processMatches(pid, [fragment]))))
      throw new Error(
        `Partial fallback group ${service}:${pid} tidak dapat diverifikasi; cleanup fail-closed`,
      );
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    if (!(await waitForProcessGroup(pid, 5_000))) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    if (!(await waitForProcessGroup(pid, 5_000)))
      throw new Error(
        `Partial fallback group ${service}:${pid} gagal dihentikan`,
      );
    await rm(path, { force: true });
  }
}

async function effectiveWorkspaceEnvironment() {
  const envPath = join(workspaceRoot, ".env");
  const info = await lstat(envPath);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(".env wajib regular file non-symlink");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(".env bukan milik user aktif");
  await chmod(envPath, 0o600);
  const source = parseEnv(await readFile(envPath, "utf8"));
  if (process.env.OCGW_SANITIZED_SERVICE_ENV === "1") return source;
  const updates = {};
  for (const key of managedConfigurationKeys) {
    if (
      Object.prototype.hasOwnProperty.call(process.env, key) &&
      process.env[key] !== undefined &&
      String(process.env[key]) !== source[key]
    ) {
      updates[key] = String(process.env[key]);
    }
  }
  if (Object.keys(updates).length) await updateEnvFile(updates);
  return Object.keys(updates).length
    ? parseEnv(await readFile(envPath, "utf8"))
    : source;
}

async function fallbackRunnerPid() {
  const recordedPid = await readFile(runnerPidPath, "utf8")
    .then((value) => Number(value.trim()))
    .catch(() => null);
  const instance = await readRunnerInstance({ optional: true });
  if (
    Number.isSafeInteger(recordedPid) &&
    recordedPid > 1 &&
    instance &&
    instance.pid !== recordedPid
  )
    throw new Error(
      "PID file dan heartbeat fallback runner tidak cocok; start fail-closed",
    );
  const pid =
    Number.isSafeInteger(recordedPid) && recordedPid > 1
      ? recordedPid
      : instance?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    await rm(runnerPidPath, { force: true });
    return null;
  }
  if (
    (await processMatches(pid, [runnerScript])) ||
    (await runnerInstanceActive(pid, { observe: true }))
  )
    return pid;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive)
    throw new Error(
      `PID ${pid} hidup tetapi bukan fallback runner workspace; start dibatalkan`,
    );
  await rm(runnerPidPath, { force: true });
  await removeRunnerInstanceIfDead(pid);
  return null;
}

async function updateTunnelGate(env) {
  const marker = join(workspaceRoot, ".runtime", "tunnel-enabled");
  if (!env.CLOUDFLARE_TUNNEL_TOKEN) {
    await rm(marker, { force: true });
    return;
  }
  const shared = await import(
    pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
  );
  const appEnv = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
  const db = shared.createDatabasePool(appEnv);
  try {
    const result = await db.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE force_password_change=false)::int AS ready FROM admin_users WHERE is_active=true`,
    );
    const ready =
      Number(result.rows[0]?.total) === 1 &&
      Number(result.rows[0]?.ready) === 1;
    if (!ready) {
      await rm(marker, { force: true });
      return;
    }
    await writePrivateWorkspaceFile(
      marker,
      "password-change-complete\n",
      "tunnel enable marker",
    );
  } finally {
    await db.end();
  }
}

async function startLocalPostgres() {
  const dataDirectory = join(workspaceRoot, ".runtime/postgres");
  const local = await readFile(join(dataDirectory, "PG_VERSION"), "utf8")
    .then(() => true)
    .catch(() => false);
  if (!local) return;
  const pgCtl = await findExecutable("pg_ctl");
  if (!pgCtl)
    throw new Error(
      "pg_ctl tidak ditemukan untuk PostgreSQL workspace-local yang sudah dikonfigurasi",
    );
  const postgresEnvironment = inheritedEnvironment();
  const status = await run(pgCtl, ["-D", dataDirectory, "status"], {
    env: postgresEnvironment,
    stdio: "pipe",
    allowFailure: true,
  });
  const options = await configuredLocalPostgresStartOptions();
  const log = await open(
    join(workspaceRoot, "data/logs/postgres.log"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  await log.chmod(0o600);
  await log.close();
  if (status.code === 0) {
    const activeOptions = await readFile(
      join(dataDirectory, "postmaster.opts"),
      "utf8",
    ).catch(() => "");
    const required = [
      "127.0.0.1",
      "55432",
      join(workspaceRoot, ".runtime/postgres-socket"),
      "unix_socket_permissions=0700",
    ];
    if (required.every((fragment) => activeOptions.includes(fragment))) return;
    await run(
      pgCtl,
      [
        "-D",
        dataDirectory,
        "-l",
        join(workspaceRoot, "data/logs/postgres.log"),
        "-o",
        options,
        "restart",
        "-m",
        "fast",
        "-w",
      ],
      { env: postgresEnvironment },
    );
    return;
  }
  await run(
    pgCtl,
    [
      "-D",
      dataDirectory,
      "-l",
      join(workspaceRoot, "data/logs/postgres.log"),
      "-o",
      options,
      "start",
      "-w",
    ],
    { env: postgresEnvironment },
  );
}

async function cleanupPm2(pm2, pm2Env) {
  await cleanupWorkspacePm2(pm2, pm2Env);
}

async function pm2Healthy(pm2, pm2Env) {
  const required = new Set([
    "ocgw-gateway-api",
    "ocgw-openclaw-bridge",
    "ocgw-maintenance",
    "ocgw-baileys",
    "ocgw-dashboard",
  ]);
  let consecutive = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await run(pm2, ["jlist"], {
      env: pm2Env,
      stdio: "pipe",
      allowFailure: true,
    });
    if (result.code === 0) {
      try {
        const online = new Set(
          JSON.parse(result.stdout)
            .filter((item) => item.pm2_env?.status === "online")
            .map((item) => item.name),
        );
        if ([...required].every((name) => online.has(name))) {
          consecutive += 1;
          if (consecutive >= 8) return true;
        } else consecutive = 0;
      } catch {
        consecutive = 0;
      }
    } else consecutive = 0;
    await delay(250);
  }
  return false;
}

async function startFallbackRunner(baseEnv) {
  const existing = await fallbackRunnerPid();
  if (existing) return existing;
  const instanceToken = randomBytes(48).toString("base64url");
  const log = await open(
    join(workspaceRoot, "data/logs/runner.log"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  await log.chmod(0o600);
  const child = spawn(process.execPath, [runnerScript], {
    cwd: workspaceRoot,
    env: {
      ...baseEnv,
      OCGW_RUNNER: "fallback",
      OCGW_RUNNER_INSTANCE_TOKEN: instanceToken,
    },
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    shell: false,
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    await log.close();
  }
  child.unref();
  let verified = false;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(250);
      const pid = await readFile(runnerPidPath, "utf8")
        .then((value) => Number(value.trim()))
        .catch(() => null);
      if (
        pid === child.pid &&
        ((await processMatches(pid, [runnerScript])) ||
          (await runnerInstanceActive(pid, { expectedToken: instanceToken })))
      ) {
        verified = true;
        return pid;
      }
      try {
        process.kill(child.pid, 0);
      } catch {
        break;
      }
    }
    throw new Error(
      "Fallback runner gagal memperoleh lock/PID ownership workspace",
    );
  } finally {
    if (!verified) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      for (
        let attempt = 0;
        attempt < 600 && child.exitCode === null && child.signalCode === null;
        attempt += 1
      )
        await delay(100);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        for (
          let attempt = 0;
          attempt < 50 && child.exitCode === null && child.signalCode === null;
          attempt += 1
        )
          await delay(100);
      }
    }
    if (!verified) await cleanupRecordedFallbackGroups();
    const stored = await readFile(runnerPidPath, "utf8")
      .then((value) => Number(value.trim()))
      .catch(() => null);
    if (!verified && stored === child.pid)
      await rm(runnerPidPath, { force: true });
  }
}

async function stopNewFallbackRunner(pid) {
  if (
    !(await processMatches(pid, [runnerScript])) &&
    !(await runnerInstanceActive(pid, { observe: true }))
  )
    return;
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await delay(250);
    if (!(await processMatches(pid, [runnerScript]))) return;
  }
  if (await processMatches(pid, [runnerScript])) process.kill(pid, "SIGKILL");
  await cleanupRecordedFallbackGroups();
  if (await processMatches(pid, [runnerScript]))
    throw new Error(
      `Fallback runner baru PID ${pid} gagal dihentikan setelah runner-mode write gagal`,
    );
}

await ensureWorkspaceDirectories();
await enforceWorkspaceLogLimits();
await assertRestoreLifecycleAuthorization("start");
const delegatedOwner = Number(process.env.OCGW_LIFECYCLE_OWNER_PID);
const delegatedOwnerToken = process.env.OCGW_LIFECYCLE_OWNER_TOKEN;
let lifecycleLock = null;
if (Number.isSafeInteger(delegatedOwner) && delegatedOwner > 1) {
  const valid =
    process.ppid === delegatedOwner &&
    (await verifyWorkspaceLockOwner(
      "lifecycle",
      delegatedOwner,
      [
        [installScript],
        ["scripts/install.mjs"],
        [restoreScript],
        ["scripts/restore.mjs"],
      ],
      delegatedOwnerToken,
    ));
  if (!valid) throw new Error("Delegasi lifecycle lock installer tidak valid");
} else {
  lifecycleLock = await acquireWorkspaceLock("lifecycle", {
    purpose: "start services",
    currentFragments: [startScript],
    validOwnerFragments: [
      [startScript],
      ["scripts/start.mjs"],
      [stopScript],
      ["scripts/stop.mjs"],
      [installScript],
      ["scripts/install.mjs"],
      [restoreScript],
      ["scripts/restore.mjs"],
    ],
  });
}
try {
  const env = await effectiveWorkspaceEnvironment();
  assertSessionAffineDatabaseUrl(env.DATABASE_URL, env.DATABASE_POOL_MODE);
  await syncTunnelToken(env);
  await startLocalPostgres();
  await run(process.execPath, [prestartGuardScript], { stdio: "inherit" });
  await updateTunnelGate(env);

  const baseEnv = {
    ...inheritedEnvironment(),
    OCGW_SANITIZED_SERVICE_ENV: "1",
  };
  const pm2Home = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime/pm2"),
    "PM2_HOME",
  );
  const pm2Env = { ...baseEnv, PM2_HOME: pm2Home };
  const localPm2 = join(workspaceRoot, "node_modules/.bin/pm2");
  const availablePm2 =
    (await findExecutable(localPm2)) || (await findExecutable("pm2"));
  const pm2LiveBefore = await liveWorkspacePm2ProcessIds(pm2Home);
  const forceFallback =
    (process.env.OCGW_RUNNER ?? env.OCGW_RUNNER) === "fallback";
  const existingRunner = await fallbackRunnerPid();
  if (existingRunner) {
    if (availablePm2) await cleanupPm2(availablePm2, pm2Env);
    else if (pm2LiveBefore.length)
      throw new Error(
        `Fallback runner dan PM2 workspace aktif, tetapi binary PM2 tidak tersedia untuk cleanup: ${pm2LiveBefore.join(", ")}`,
      );
    const pm2LiveAfter = await liveWorkspacePm2ProcessIds(pm2Home);
    if (pm2LiveAfter.length)
      throw new Error(
        `Dual process manager ditolak; PM2 PID masih aktif: ${pm2LiveAfter.join(", ")}`,
      );
    await writePrivateWorkspaceFile(
      runnerModePath,
      "fallback\n",
      "runner mode",
    );
    process.stdout.write(
      `Fallback runner workspace sudah aktif (PID ${existingRunner}).\n`,
    );
  } else {
    await cleanupRecordedFallbackGroups();
    if (forceFallback) {
      if (availablePm2) await cleanupPm2(availablePm2, pm2Env);
      else if (pm2LiveBefore.length)
        throw new Error(
          "Tidak dapat beralih dari PM2 ke fallback: process aktif dan binary PM2 tidak tersedia",
        );
      const pm2LiveAfter = await liveWorkspacePm2ProcessIds(pm2Home);
      if (pm2LiveAfter.length)
        throw new Error(
          `Tidak dapat memulai fallback; PM2 PID masih aktif: ${pm2LiveAfter.join(", ")}`,
        );
    }
    const pm2 = forceFallback ? null : availablePm2;
    if (pm2) {
      const result = await run(
        pm2,
        [
          "start",
          join(workspaceRoot, "deployment/pm2/ecosystem.config.cjs"),
          "--update-env",
        ],
        { env: pm2Env, stdio: "pipe", allowFailure: true },
      );
      if (result.code === 0 && (await pm2Healthy(pm2, pm2Env))) {
        await run(pm2, ["save", "--force"], {
          env: pm2Env,
          stdio: "pipe",
          allowFailure: true,
        });
        try {
          await writePrivateWorkspaceFile(
            runnerModePath,
            "pm2\n",
            "runner mode",
          );
        } catch (error) {
          await cleanupPm2(pm2, pm2Env);
          throw error;
        }
        process.stdout.write("Services dimulai dengan PM2 workspace-local.\n");
      } else {
        process.stderr.write(
          `PM2 gagal/partial; membersihkan seluruh proses PM2 workspace sebelum fallback.${result.stderr ? ` ${result.stderr.trim()}` : ""}\n`,
        );
        await cleanupPm2(pm2, pm2Env);
        const pid = await startFallbackRunner(baseEnv);
        try {
          await writePrivateWorkspaceFile(
            runnerModePath,
            "fallback\n",
            "runner mode",
          );
        } catch (error) {
          await stopNewFallbackRunner(pid);
          throw error;
        }
        process.stdout.write(
          `Services dimulai dengan fallback runner workspace (PID ${pid}).\n`,
        );
      }
    } else {
      if (pm2LiveBefore.length)
        throw new Error(
          `PM2 workspace aktif tetapi binary PM2 tidak tersedia: ${pm2LiveBefore.join(", ")}`,
        );
      const pid = await startFallbackRunner(baseEnv);
      try {
        await writePrivateWorkspaceFile(
          runnerModePath,
          "fallback\n",
          "runner mode",
        );
      } catch (error) {
        await stopNewFallbackRunner(pid);
        throw error;
      }
      process.stdout.write(
        `Services dimulai dengan fallback runner workspace (PID ${pid}).\n`,
      );
    }
  }
} finally {
  await lifecycleLock?.release();
}

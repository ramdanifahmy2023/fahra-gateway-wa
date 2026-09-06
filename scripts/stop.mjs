import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireWorkspaceLock,
  assertRestoreLifecycleAuthorization,
  cleanupWorkspacePm2,
  ensurePrivateDirectory,
  ensureWorkspaceDirectories,
  findExecutable,
  inheritedEnvironment,
  liveWorkspacePm2ProcessIds,
  processMatches,
  readRunnerInstance,
  removeRunnerInstanceIfDead,
  run,
  runnerInstanceActive,
  verifyWorkspaceLockOwner,
  workspaceRoot,
} from "./lib/common.mjs";

const startScript = join(workspaceRoot, "scripts/start.mjs");
const stopScript = join(workspaceRoot, "scripts/stop.mjs");
const runnerScript = join(workspaceRoot, "scripts/runner-daemon.mjs");
const installScript = join(workspaceRoot, "scripts/install.mjs");
const restoreScript = join(workspaceRoot, "scripts/restore.mjs");

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

async function verifyFallbackGroupsStopped() {
  const directory = join(workspaceRoot, ".runtime/pids");
  const active = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".pid") || name === "runner.pid") continue;
    const path = join(directory, name);
    const pid = await readFile(path, "utf8")
      .then((value) => Number(value.trim()))
      .catch(() => null);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      await rm(path, { force: true });
      continue;
    }
    if (processGroupAlive(pid)) active.push(`${name}:${pid}`);
    else await rm(path, { force: true });
  }
  if (active.length)
    throw new Error(
      `Fallback process group belum berhenti; PID state dipertahankan: ${active.join(", ")}`,
    );
}

async function stopFallbackRunner() {
  const path = join(workspaceRoot, ".runtime/pids/runner.pid");
  const recordedPid = await readFile(path, "utf8")
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
      "PID file dan heartbeat fallback runner tidak cocok; stop fail-closed",
    );
  const pid =
    Number.isSafeInteger(recordedPid) && recordedPid > 1
      ? recordedPid
      : instance?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    await rm(path, { force: true });
    return false;
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    await rm(path, { force: true });
    await removeRunnerInstanceIfDead(pid);
    return false;
  }
  if (
    !(await processMatches(pid, [runnerScript])) &&
    !(await runnerInstanceActive(pid, { observe: true }))
  )
    throw new Error(
      `PID ${pid} bukan fallback runner workspace aktif; tidak mengirim signal`,
    );
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await delay(250);
    try {
      process.kill(pid, 0);
    } catch {
      await rm(path, { force: true });
      return true;
    }
  }
  throw new Error(`Fallback runner PID ${pid} tidak berhenti dalam 60 detik`);
}

await ensureWorkspaceDirectories();
await assertRestoreLifecycleAuthorization("stop");
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
    purpose: "stop services",
    currentFragments: [stopScript],
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
  const pm2Home = await ensurePrivateDirectory(
    join(workspaceRoot, ".runtime/pm2"),
    "PM2_HOME",
  );
  const pm2 =
    (await findExecutable(join(workspaceRoot, "node_modules/.bin/pm2"))) ||
    (await findExecutable("pm2"));
  const pm2LiveBefore = await liveWorkspacePm2ProcessIds(pm2Home);
  if (pm2) {
    const env = { ...inheritedEnvironment(), PM2_HOME: pm2Home };
    await cleanupWorkspacePm2(pm2, env);
  } else if (pm2LiveBefore.length) {
    throw new Error(
      `Process PM2 workspace aktif tetapi binary PM2 tidak ditemukan: ${pm2LiveBefore.join(", ")}`,
    );
  }
  const pm2LiveAfter = await liveWorkspacePm2ProcessIds(pm2Home);
  if (pm2LiveAfter.length)
    throw new Error(
      `Process PM2 workspace belum berhenti: ${pm2LiveAfter.join(", ")}`,
    );
  await stopFallbackRunner();
  await verifyFallbackGroupsStopped();

  if (!process.argv.includes("--keep-database")) {
    const dataDirectory = join(workspaceRoot, ".runtime/postgres");
    const local = await readFile(join(dataDirectory, "PG_VERSION"), "utf8")
      .then(() => true)
      .catch(() => false);
    if (local) {
      const pgCtl = await findExecutable("pg_ctl");
      if (!pgCtl)
        throw new Error(
          "pg_ctl tidak ditemukan; PostgreSQL workspace-local belum dihentikan",
        );
      const result = await run(
        pgCtl,
        ["-D", dataDirectory, "stop", "-m", "fast", "-w"],
        { env: inheritedEnvironment(), stdio: "pipe", allowFailure: true },
      );
      if (
        result.code !== 0 &&
        !/no server running/i.test(`${result.stdout}\n${result.stderr}`)
      )
        throw new Error(
          `PostgreSQL workspace-local gagal dihentikan: ${result.stderr || result.stdout}`,
        );
    }
  }
  process.stdout.write("Services workspace dihentikan.\n");
} finally {
  await lifecycleLock?.release();
}

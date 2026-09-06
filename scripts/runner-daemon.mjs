import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { serviceSpecs } from "./lib/services.mjs";
import {
  acquireWorkspaceLock,
  enforceWorkspaceLogLimits,
  ensureWorkspaceDirectories,
  processMatches,
  removeRunnerInstanceIfOwned,
  writeRunnerInstance,
  workspaceRoot,
  writePrivateWorkspaceFile,
} from "./lib/common.mjs";

const pidDirectory = join(workspaceRoot, ".runtime/pids");
const runnerScript = join(workspaceRoot, "scripts/runner-daemon.mjs");
const children = new Map();
const restartTimers = new Set();
const launchAdmissions = new Set();
const launchingNames = new Set();
let stopping = false;
let runnerLock;
let logMaintenanceTimer;
let runnerHeartbeatTimer;
let runnerHeartbeatPromise = Promise.resolve();
let runnerHeartbeatWriting = false;
const runnerInstanceToken = process.env.OCGW_RUNNER_INSTANCE_TOKEN ?? "";

async function atomicWrite(path, value) {
  await writePrivateWorkspaceFile(path, value, "fallback runner PID");
}

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

function signalProcessGroup(pid, signal, child) {
  if (Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "EINVAL") throw error;
    }
  }
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill(signal);
}

async function waitForProcessGroup(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupAlive(pid);
}

async function terminateProcessGroup(pid, child, graceMilliseconds = 5000) {
  signalProcessGroup(pid, "SIGTERM", child);
  if (await waitForProcessGroup(pid, graceMilliseconds)) return;
  signalProcessGroup(pid, "SIGKILL", child);
  await waitForProcessGroup(pid, 5000);
}

async function appendLifecycleLog(name, message) {
  const handle = await open(
    join(workspaceRoot, "data/logs", `${name}.log`),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.write(`${new Date().toISOString()} ${message}\n`);
  } finally {
    await handle.close();
  }
}

async function removePidIfOwned(name, pid) {
  const path = join(pidDirectory, `${name}.pid`);
  const stored = await readFile(path, "utf8")
    .then((value) => Number(value.trim()))
    .catch(() => null);
  if (stored === pid) await rm(path, { force: true });
}

function scheduleRestart(spec, attempts) {
  if (stopping || !spec.restart) return;
  const timeout = setTimeout(
    () => {
      restartTimers.delete(timeout);
      if (!stopping)
        void launch(spec, attempts).catch((error) => {
          void appendLifecycleLog(
            spec.name,
            `restart failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!error?.ocgwRestartScheduled) scheduleRestart(spec, attempts + 1);
        });
    },
    Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)),
  );
  restartTimers.add(timeout);
}

function launch(spec, attempts = 0) {
  if (stopping) return Promise.resolve();
  if (children.has(spec.name) || launchingNames.has(spec.name))
    return Promise.reject(
      new Error(`Service ${spec.name} sudah mempunyai child/admission aktif`),
    );
  launchingNames.add(spec.name);
  const admission = launchAdmitted(spec, attempts).finally(() => {
    launchingNames.delete(spec.name);
    launchAdmissions.delete(admission);
  });
  launchAdmissions.add(admission);
  return admission;
}

async function launchAdmitted(spec, attempts = 0) {
  const logPath = join(workspaceRoot, "data/logs", `${spec.name}.log`);
  const log = await open(
    logPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await log.chmod(0o600);
  } catch (error) {
    await log.close().catch(() => undefined);
    throw error;
  }
  if (stopping) {
    await log.close();
    return;
  }
  const child = spawn(spec.command, spec.args, {
    cwd: workspaceRoot,
    env: spec.env,
    stdio: ["ignore", log.fd, log.fd],
    shell: false,
    detached: true,
  });
  let publishPid;
  const pidPublished = new Promise((resolve) => {
    publishPid = resolve;
  });
  const state = {
    child,
    spec,
    attempts,
    startedAt: Date.now(),
    finished: false,
    finishPromise: null,
    finish: null,
    groupClean: null,
    pidPublished,
  };
  children.set(spec.name, state);

  const finish = (kind, code, signal, error) => {
    if (state.finishPromise) return state.finishPromise;
    state.finished = true;
    state.finishPromise = (async () => {
      let groupClean = true;
      try {
        await terminateProcessGroup(child.pid, child);
        groupClean = !processGroupAlive(child.pid);
        if (!groupClean)
          throw new Error(`process group ${child.pid} tetap aktif`);
      } catch (cleanupError) {
        groupClean = false;
        await appendLifecycleLog(
          spec.name,
          `process-group cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        ).catch(() => undefined);
      }
      state.groupClean = groupClean;
      await state.pidPublished;
      if (groupClean)
        await removePidIfOwned(spec.name, child.pid).catch(() => undefined);
      await appendLifecycleLog(
        spec.name,
        `${kind} code=${code ?? "none"} signal=${signal ?? "none"}${error ? ` error=${error.message}` : ""}`,
      ).catch(() => undefined);
      const stable = Date.now() - state.startedAt >= 30_000;
      if (groupClean) {
        if (children.get(spec.name) === state) children.delete(spec.name);
        scheduleRestart(spec, stable ? 1 : attempts + 1);
      }
    })();
    return state.finishPromise;
  };
  state.finish = finish;

  child.once("error", (error) => {
    error.ocgwRestartScheduled = true;
    void finish("spawn-error", null, null, error);
  });
  child.once(
    "close",
    (code, signal) => void finish("closed", code, signal, null),
  );
  let logClosed = false;
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await log.close();
    logClosed = true;
    await atomicWrite(join(pidDirectory, `${spec.name}.pid`), `${child.pid}\n`);
  } catch (error) {
    error.ocgwRestartScheduled = true;
    if (child.exitCode === null && child.signalCode === null)
      signalProcessGroup(child.pid, "SIGTERM", child);
    throw error;
  } finally {
    publishPid();
    if (!logClosed) await log.close().catch(() => undefined);
  }
}

async function reclaimOrphan(spec) {
  const path = join(pidDirectory, `${spec.name}.pid`);
  const pid = await readFile(path, "utf8")
    .then((value) => Number(value.trim()))
    .catch(() => null);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    await rm(path, { force: true });
    return;
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  const groupAlive = processGroupAlive(pid);
  if (!alive && !groupAlive) {
    await rm(path, { force: true });
    return;
  }
  if (!alive && groupAlive) {
    await appendLifecycleLog(
      spec.name,
      `reclaiming orphan process group with exited leader=${pid}`,
    );
    await terminateProcessGroup(pid, null, 10_000);
    if (processGroupAlive(pid))
      throw new Error(
        `Process group orphan ${pid} untuk ${spec.name} tidak dapat dihentikan`,
      );
    await rm(path, { force: true });
    return;
  }
  const workspaceArgument = spec.args.find(
    (argument) =>
      typeof argument === "string" && argument.startsWith(workspaceRoot),
  );
  if (!workspaceArgument || !(await processMatches(pid, [workspaceArgument]))) {
    throw new Error(
      `PID stale ${pid} untuk ${spec.name} hidup tetapi ownership tidak cocok; runner fail-closed`,
    );
  }
  await appendLifecycleLog(
    spec.name,
    `reclaiming orphan process group leader=${pid}`,
  );
  await terminateProcessGroup(pid, null, 10_000);
  if (processGroupAlive(pid))
    throw new Error(
      `Process group orphan ${pid} untuk ${spec.name} tidak dapat dihentikan`,
    );
  await rm(path, { force: true });
}

async function reclaimUnconfiguredOrphans(configuredNames) {
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
  for (const fileName of await readdir(pidDirectory).catch(() => [])) {
    if (!fileName.endsWith(".pid") || fileName === "runner.pid") continue;
    const name = fileName.slice(0, -4);
    if (configuredNames.has(name)) continue;
    const path = join(pidDirectory, fileName);
    const pid = await readFile(path, "utf8")
      .then((value) => Number(value.trim()))
      .catch(() => null);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      await rm(path, { force: true });
      continue;
    }
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    const groupAlive = processGroupAlive(pid);
    if (!alive && !groupAlive) {
      await rm(path, { force: true });
      continue;
    }
    if (!alive && groupAlive) {
      await terminateProcessGroup(pid, null, 10_000);
      if (processGroupAlive(pid))
        throw new Error(
          `Process group unconfigured ${pid} (${name}) tidak dapat dihentikan`,
        );
      await rm(path, { force: true });
      continue;
    }
    const fragment = fragments[name];
    if (!fragment || !(await processMatches(pid, [fragment])))
      throw new Error(
        `PID unconfigured ${pid} (${name}) tidak dapat diverifikasi; runner fail-closed`,
      );
    await terminateProcessGroup(pid, null, 10_000);
    if (processGroupAlive(pid))
      throw new Error(
        `Process group unconfigured ${pid} (${name}) tidak dapat dihentikan`,
      );
    await rm(path, { force: true });
  }
}

async function stop(reason, exitCode) {
  if (stopping) return;
  stopping = true;
  if (logMaintenanceTimer) clearInterval(logMaintenanceTimer);
  if (runnerHeartbeatTimer) clearInterval(runnerHeartbeatTimer);
  await runnerHeartbeatPromise.catch(() => undefined);
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
  await Promise.allSettled([...launchAdmissions]);
  const active = [...children.values()];
  for (const state of active)
    signalProcessGroup(state.child.pid, "SIGTERM", state.child);
  await Promise.all(
    active.map((state) => waitForProcessGroup(state.child.pid, 25_000)),
  );
  const remaining = active.filter((state) =>
    processGroupAlive(state.child.pid),
  );
  for (const state of remaining)
    signalProcessGroup(state.child.pid, "SIGKILL", state.child);
  await Promise.all(
    remaining.map((state) => waitForProcessGroup(state.child.pid, 5_000)),
  );
  await Promise.allSettled(
    active.map((state) =>
      state.finish(
        "runner-stop",
        state.child.exitCode,
        state.child.signalCode,
        null,
      ),
    ),
  );
  const groupFailure = active.some((state) =>
    processGroupAlive(state.child.pid),
  );
  for (const state of active) {
    if (!processGroupAlive(state.child.pid)) {
      await removePidIfOwned(state.spec.name, state.child.pid).catch(
        () => undefined,
      );
      if (children.get(state.spec.name) === state)
        children.delete(state.spec.name);
    }
  }
  await rm(join(pidDirectory, "runner.pid"), { force: true });
  if (runnerInstanceToken)
    await removeRunnerInstanceIfOwned(process.pid, runnerInstanceToken).catch(
      () => undefined,
    );
  await runnerLock?.release().catch(() => undefined);
  process.stderr.write(
    reason === "SIGTERM" ? "" : `Fallback runner berhenti: ${reason}\n`,
  );
  process.exit(groupFailure ? 1 : exitCode);
}

async function main() {
  if (Buffer.byteLength(runnerInstanceToken, "utf8") < 32)
    throw new Error("OCGW_RUNNER_INSTANCE_TOKEN wajib random minimal 32 byte");
  await ensureWorkspaceDirectories();
  await enforceWorkspaceLogLimits();
  logMaintenanceTimer = setInterval(
    () => {
      void enforceWorkspaceLogLimits().catch((error) => {
        process.stderr.write(
          `Gagal membatasi file log workspace: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    },
    5 * 60 * 1000,
  );
  logMaintenanceTimer.unref();
  await mkdir(pidDirectory, { recursive: true, mode: 0o700 });
  runnerLock = await acquireWorkspaceLock("runner", {
    purpose: "fallback runner",
    currentFragments: [runnerScript],
    validOwnerFragments: [[runnerScript], ["scripts/runner-daemon.mjs"]],
  });
  await atomicWrite(join(pidDirectory, "runner.pid"), `${process.pid}\n`);
  await writeRunnerInstance(process.pid, runnerInstanceToken);
  runnerHeartbeatTimer = setInterval(() => {
    if (stopping || runnerHeartbeatWriting) return;
    runnerHeartbeatWriting = true;
    runnerHeartbeatPromise = writeRunnerInstance(
      process.pid,
      runnerInstanceToken,
    )
      .catch((error) => {
        void stop(
          `fallback runner heartbeat gagal: ${error instanceof Error ? error.message : String(error)}`,
          1,
        );
      })
      .finally(() => {
        runnerHeartbeatWriting = false;
      });
  }, 1000);
  runnerHeartbeatTimer.unref();
  const specs = await serviceSpecs();
  await reclaimUnconfiguredOrphans(new Set(specs.map((spec) => spec.name)));
  for (const spec of specs) await reclaimOrphan(spec);
  for (const spec of specs) {
    try {
      await launch(spec);
    } catch (error) {
      await appendLifecycleLog(
        spec.name,
        `initial spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
      if (!error?.ocgwRestartScheduled) scheduleRestart(spec, 1);
    }
  }
  await new Promise(() => {});
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void stop(signal, 0));
process.once(
  "uncaughtException",
  (error) => void stop(error.stack ?? error.message, 1),
);
process.once(
  "unhandledRejection",
  (error) =>
    void stop(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      1,
    ),
);
await main().catch(async (error) => {
  if (runnerHeartbeatTimer) clearInterval(runnerHeartbeatTimer);
  await runnerHeartbeatPromise.catch(() => undefined);
  await rm(join(pidDirectory, "runner.pid"), { force: true }).catch(
    () => undefined,
  );
  if (runnerInstanceToken)
    await removeRunnerInstanceIfOwned(process.pid, runnerInstanceToken).catch(
      () => undefined,
    );
  await runnerLock?.release().catch(() => undefined);
  process.stderr.write(
    `Fallback runner gagal dimulai: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

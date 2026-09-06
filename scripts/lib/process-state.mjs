import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  findExecutable,
  inheritedEnvironment,
  liveWorkspacePm2ProcessIds,
  processMatches,
  readRunnerInstance,
  run,
  runnerInstanceActive,
  workspaceRoot,
} from "./common.mjs";

function expectedFragments(name) {
  const mapping = {
    "ocgw-redis": [join(workspaceRoot, ".runtime/redis.conf")],
    "ocgw-gateway-api": [
      join(workspaceRoot, "apps/gateway-api/dist/server.js"),
    ],
    "ocgw-openclaw-bridge": [
      join(workspaceRoot, "apps/gateway-api/dist/bridge-worker.js"),
    ],
    "ocgw-maintenance": [
      join(workspaceRoot, "apps/gateway-api/dist/maintenance-worker.js"),
    ],
    "ocgw-baileys": [join(workspaceRoot, "apps/baileys-service/dist/index.js")],
    "ocgw-dashboard": ["apps/dashboard/.next/standalone"],
    "ocgw-cloudflared": [
      "cloudflared",
      "--token-file",
      join(workspaceRoot, ".runtime/cloudflare-token"),
    ],
  };
  return mapping[name] ?? [];
}

export async function processStates() {
  const recordedMode = await readFile(
    join(workspaceRoot, ".runtime/runner-mode"),
    "utf8",
  )
    .then((value) => value.trim())
    .catch(() => "unknown");
  const services = [];
  const directory = join(workspaceRoot, ".runtime/pids");
  const recordedRunnerPid = await readFile(
    join(directory, "runner.pid"),
    "utf8",
  )
    .then((value) => Number(value.trim()))
    .catch(() => null);
  const runnerInstance = await readRunnerInstance({ optional: true });
  const runnerPid =
    Number.isSafeInteger(recordedRunnerPid) && recordedRunnerPid > 1
      ? recordedRunnerPid
      : runnerInstance?.pid;
  const fallbackRunner =
    (await processMatches(runnerPid, [
      join(workspaceRoot, "scripts/runner-daemon.mjs"),
    ])) ||
    (Boolean(runnerInstance) &&
      runnerInstance.pid === runnerPid &&
      (await runnerInstanceActive(runnerPid)));
  const pm2Home = join(workspaceRoot, ".runtime/pm2");
  const pm2Pids = await liveWorkspacePm2ProcessIds(pm2Home);
  if (pm2Pids.length) {
    const pm2 =
      (await findExecutable(join(workspaceRoot, "node_modules/.bin/pm2"))) ||
      (await findExecutable("pm2"));
    if (pm2) {
      const env = { ...inheritedEnvironment(), PM2_HOME: pm2Home };
      const result = await run(pm2, ["jlist"], {
        env,
        stdio: "pipe",
        allowFailure: true,
      });
      if (result.code === 0)
        try {
          for (const item of JSON.parse(result.stdout)) {
            const fragments = expectedFragments(item.name);
            const metadata = JSON.stringify([
              item.pm2_env?.pm_cwd,
              item.pm2_env?.pm_exec_path,
              item.pm2_env?.args,
              item.pm2_env?.node_args,
            ]);
            const metadataOwned =
              item.pm2_env?.pm_cwd === workspaceRoot &&
              fragments.every((fragment) => metadata.includes(fragment));
            const owned =
              fragments.length > 0 &&
              ((await processMatches(Number(item.pid), fragments)) ||
                metadataOwned);
            services.push({
              name: item.name,
              pid: item.pid,
              status: owned ? (item.pm2_env?.status ?? "unknown") : "stale",
              restarts: item.pm2_env?.restart_time ?? 0,
              manager: "pm2",
            });
          }
        } catch {
          /* fallback PID scan below still reports workspace runner state */
        }
    } else {
      services.push({
        name: "ocgw-pm2-unmanaged",
        pid: pm2Pids[0],
        status: "stale",
        restarts: null,
        manager: "pm2",
      });
    }
  }
  for (const fileName of await readdir(directory).catch(() => [])) {
    if (!fileName.endsWith(".pid") || fileName === "runner.pid") continue;
    const name = fileName.slice(0, -4);
    const pid = Number(
      (await readFile(join(directory, fileName), "utf8")).trim(),
    );
    const fragments = expectedFragments(name);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    const owned =
      fragments.length > 0 &&
      ((await processMatches(pid, fragments)) || (fallbackRunner && alive));
    services.push({
      name,
      pid,
      status: owned ? "online" : alive ? "stale" : "stopped",
      restarts: null,
      manager: "fallback",
    });
  }
  const pm2Active = services.some(
    (service) => service.manager === "pm2" && service.status === "online",
  );
  const fallbackActive =
    fallbackRunner ||
    services.some(
      (service) =>
        service.manager === "fallback" && service.status === "online",
    );
  const mode =
    pm2Active && fallbackActive
      ? "conflict"
      : pm2Active
        ? "pm2"
        : fallbackActive
          ? "fallback"
          : pm2Pids.length
            ? "pm2-stale"
            : recordedMode;
  return { mode, services };
}

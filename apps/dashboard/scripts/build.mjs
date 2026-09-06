import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");
const shim = join(dashboardRoot, "scripts", "memory-usage-shim.cjs");

let needsMemoryShim = false;
try {
  process.memoryUsage.rss();
} catch {
  needsMemoryShim = true;
}

function nodeOptionPath(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const inheritedOptions = process.env.NODE_OPTIONS?.trim() ?? "";
const shimOption = `--require ${nodeOptionPath(shim)}`;
const childEnvironment = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  ...(needsMemoryShim
    ? { NODE_OPTIONS: [inheritedOptions, shimOption].filter(Boolean).join(" ") }
    : {}),
};
const argumentsList = [nextCli, "build", "--webpack"];

const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, argumentsList, {
    cwd: dashboardRoot,
    env: childEnvironment,
    stdio: "inherit",
    shell: false,
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) resolvePromise(0);
    else
      reject(new Error(`Next.js build gagal (${code ?? signal ?? "unknown"})`));
  });
});

process.exitCode = exitCode;

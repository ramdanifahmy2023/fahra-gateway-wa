import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const candidates = [
  path.join(workspace, ".next", "standalone", "apps", "dashboard", "server.js"),
  path.join(workspace, ".next", "standalone", "server.js"),
];
const server = await firstFile(candidates);
if (!server) {
  console.error(
    "Build standalone belum tersedia. Jalankan npm run build terlebih dahulu.",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [server], {
  cwd: path.dirname(server),
  env: {
    ...process.env,
    HOSTNAME: process.env.DASHBOARD_HOST ?? "127.0.0.1",
    PORT: process.env.DASHBOARD_PORT ?? process.env.PORT ?? "3200",
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 0 : (code ?? 1));
});

async function firstFile(paths) {
  for (const candidate of paths) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Candidate layout lain akan diperiksa.
    }
  }
  return null;
}

import { findExecutable, run, workspaceRoot } from "./lib/common.mjs";

const npm = await findExecutable("npm");
if (!npm)
  throw new Error(
    "npm tidak ditemukan; Node.js 22+ diperlukan untuk build Next.js",
  );
for (const workspace of [
  "@ocgw/shared",
  "@ocgw/gateway-api",
  "@ocgw/baileys-service",
  "@ocgw/dashboard",
]) {
  process.stdout.write(`Build ${workspace}\n`);
  await run(npm, ["run", "build", `--workspace=${workspace}`], {
    cwd: workspaceRoot,
  });
}

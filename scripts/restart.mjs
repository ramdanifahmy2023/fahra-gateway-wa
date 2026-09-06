import { run } from "./lib/common.mjs";
await run(process.execPath, ["scripts/stop.mjs"]);
await run(process.execPath, ["scripts/start.mjs"]);

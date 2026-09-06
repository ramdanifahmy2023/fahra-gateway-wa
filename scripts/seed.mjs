import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceRoot } from "./lib/common.mjs";

const shared = await import(
  pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
);
const env = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
const db = shared.createDatabasePool(env);
try {
  const sql = await readFile(join(workspaceRoot, "database/seed.sql"), "utf8");
  await db.query(sql);
  process.stdout.write("Seed idempotent diterapkan.\n");
} finally {
  await db.end();
}

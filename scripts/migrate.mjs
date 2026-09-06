import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertSessionAffineDatabaseUrl,
  readWorkspaceEnv,
  workspaceRoot,
} from "./lib/common.mjs";

const shared = await import(
  pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
);
const env = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
const rawEnvironment = await readWorkspaceEnv();
assertSessionAffineDatabaseUrl(
  env.DATABASE_URL,
  rawEnvironment.DATABASE_POOL_MODE,
);
const logger = shared.createLogger(env, "migration-runner");
const pool = shared.createDatabasePool(env);
try {
  const applied = await shared.runMigrations(
    pool,
    join(workspaceRoot, "database/migrations"),
    logger,
  );
  process.stdout.write(
    applied.length
      ? `Migration diterapkan: ${applied.join(", ")}\n`
      : "Database sudah mutakhir.\n",
  );
} finally {
  await pool.end();
}

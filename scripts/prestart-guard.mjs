import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv, workspaceRoot } from "./lib/common.mjs";

const baselinePath = join(workspaceRoot, "data/state/boot-baseline.json");
const envText = await readFile(join(workspaceRoot, ".env"), "utf8");
const rawEnv = parseEnv(envText);
const shared = await import(pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href);
const env = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
const db = shared.createDatabasePool(env);

function databaseFingerprint(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ""),
  };
}

async function readBaseline() {
  return JSON.parse(await readFile(baselinePath, "utf8").catch(() => "null"));
}

async function writeBaseline(value) {
  await mkdir(dirname(baselinePath), { recursive: true, mode: 0o700 });
  await writeFile(baselinePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function count(table) {
  const result = await db.query(`select count(*)::int as count from ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

try {
  const database = databaseFingerprint(env.DATABASE_URL);
  const counts = {
    whatsapp_messages: await count("whatsapp_messages"),
    whatsapp_groups: await count("whatsapp_groups"),
    whatsapp_auth_state: await count("whatsapp_auth_state"),
  };
  const baseline = await readBaseline();
  if (!baseline) {
    await writeBaseline({
      database,
      minimum: { whatsapp_auth_state: Math.min(counts.whatsapp_auth_state, 1000) },
      lastHealthy: counts,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ ok: true, initialized: true, database, counts }));
    process.exit(0);
  }
  const expected = baseline.database;
  for (const key of ["protocol", "host", "port", "database"]) {
    if (String(database[key]) !== String(expected?.[key])) {
      throw new Error(`DB target berubah: ${key}=${database[key]} expected=${expected?.[key]}`);
    }
  }
  const last = baseline.lastHealthy || {};
  if ((last.whatsapp_messages ?? 0) > 0 && counts.whatsapp_messages === 0) {
    throw new Error("DB suspicious-empty: whatsapp_messages turun ke 0; start diblokir supaya data tidak tertimpa");
  }
  if ((last.whatsapp_groups ?? 0) > 0 && counts.whatsapp_groups === 0) {
    throw new Error("DB suspicious-empty: whatsapp_groups turun ke 0; start diblokir supaya data tidak tertimpa");
  }
  const minAuth = Number(baseline.minimum?.whatsapp_auth_state ?? 0);
  if (minAuth > 0 && counts.whatsapp_auth_state < minAuth) {
    throw new Error(`Auth suspicious-drop: whatsapp_auth_state=${counts.whatsapp_auth_state} minimum=${minAuth}`);
  }
  const next = {
    ...baseline,
    lastHealthy: {
      whatsapp_messages: Math.max(Number(last.whatsapp_messages ?? 0), counts.whatsapp_messages),
      whatsapp_groups: Math.max(Number(last.whatsapp_groups ?? 0), counts.whatsapp_groups),
      whatsapp_auth_state: Math.max(Number(last.whatsapp_auth_state ?? 0), counts.whatsapp_auth_state),
    },
    updatedAt: new Date().toISOString(),
  };
  await writeBaseline(next);
  console.log(JSON.stringify({ ok: true, database, counts }));
} finally {
  await db.end();
}

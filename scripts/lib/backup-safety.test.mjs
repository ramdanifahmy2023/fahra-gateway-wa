import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertNotSuspiciousEmptyBackup } from "./backup-safety.mjs";

const healthyBaseline = {
  lastHealthy: {
    whatsapp_messages: 111,
    whatsapp_groups: 4,
    whatsapp_auth_state: 46_424,
  },
};

function clientFor(current, onQuery = () => undefined) {
  return {
    async query(sql) {
      onQuery(sql);
      return { rows: [current] };
    },
  };
}

const readHealthyBaseline = async () => structuredClone(healthyBaseline);

test("healthy database counts pass the suspicious-empty guard", async () => {
  const result = await assertNotSuspiciousEmptyBackup({
    client: clientFor({ messages: 111, groups: 4, auth: 46_424 }),
    baselinePath: "/unused/boot-baseline.json",
    readBaseline: readHealthyBaseline,
  });
  assert.equal(result.skipped, false);
});

test("normal backup blocks an empty messages table against a healthy baseline", async () => {
  await assert.rejects(
    assertNotSuspiciousEmptyBackup({
      client: clientFor({ messages: 0, groups: 4, auth: 46_424 }),
      baselinePath: "/unused/boot-baseline.json",
      readBaseline: readHealthyBaseline,
    }),
    /whatsapp_messages=0/,
  );
});

test("normal backup blocks an empty groups table against a healthy baseline", async () => {
  await assert.rejects(
    assertNotSuspiciousEmptyBackup({
      client: clientFor({ messages: 111, groups: 0, auth: 46_424 }),
      baselinePath: "/unused/boot-baseline.json",
      readBaseline: readHealthyBaseline,
    }),
    /whatsapp_groups=0/,
  );
});

test("normal backup blocks a drastic auth-state drop", async () => {
  await assert.rejects(
    assertNotSuspiciousEmptyBackup({
      client: clientFor({ messages: 111, groups: 4, auth: 999 }),
      baselinePath: "/unused/boot-baseline.json",
      readBaseline: readHealthyBaseline,
    }),
    /auth_state turun drastis/,
  );
});

test("safety backup bypasses the guard before querying database or baseline", async () => {
  let queried = false;
  let baselineRead = false;
  const result = await assertNotSuspiciousEmptyBackup({
    client: clientFor(
      { messages: 0, groups: 0, auth: 0 },
      () => {
        queried = true;
      },
    ),
    baselinePath: "/unused/boot-baseline.json",
    safety: true,
    readBaseline: async () => {
      baselineRead = true;
      return healthyBaseline;
    },
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(queried, false);
  assert.equal(baselineRead, false);
});

test("backup runtime calls the guard inside the locked snapshot before dumping tables", async () => {
  const source = await readFile(new URL("../backup.mjs", import.meta.url), "utf8");
  const begin = source.indexOf(
    'await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")',
  );
  const lock = source.indexOf("LOCK TABLE", begin);
  const guard = source.indexOf("await assertNotSuspiciousEmptyBackup({", lock);
  const dump = source.indexOf("tables.push(await dumpTable", guard);

  assert.ok(begin >= 0, "repeatable-read transaction marker missing");
  assert.ok(lock > begin, "table lock must follow repeatable-read begin");
  assert.ok(guard > lock, "backup guard must run after table lock");
  assert.ok(dump > guard, "table dump must run after backup guard");
});

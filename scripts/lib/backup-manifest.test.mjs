import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BACKUP_TABLE_NAMES,
  EXCLUDED_TABLE_POLICY,
  assertMigrationCompatibility,
  createBackupManifestDescriptor,
  isWorkspaceDataMarker,
  validateBackupManifestDescriptor,
} from "./backup-manifest.mjs";

const checksumA = "a".repeat(64);
const checksumB = "b".repeat(64);

test("manifest contains the durable graph in dependency order", () => {
  assert.ok(
    BACKUP_TABLE_NAMES.indexOf("queue_jobs") <
      BACKUP_TABLE_NAMES.indexOf("whatsapp_messages"),
  );
  for (const required of [
    "admin_refresh_tokens",
    "whatsapp_group_participants",
    "queue_job_attempts",
    "message_delivery_events",
    "integration_outbox",
    "openclaw_responses",
    "contact_memory",
    "crm_config_state",
    "crm_tags",
    "crm_contact_tags",
    "crm_internal_notes",
    "operational_logs",
  ])
    assert.ok(BACKUP_TABLE_NAMES.includes(required), `${required} missing`);
  assert.equal(new Set(BACKUP_TABLE_NAMES).size, BACKUP_TABLE_NAMES.length);
});

test("manifest policy covers every application table declared by schema.sql", async () => {
  const schema = await readFile(
    new URL("../../database/schema.sql", import.meta.url),
    "utf8",
  );
  const declared = [
    ...schema.matchAll(
      /\bCREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
    ),
  ].map((match) => match[1]);
  const covered = [
    ...BACKUP_TABLE_NAMES,
    ...EXCLUDED_TABLE_POLICY.map((entry) => entry.name),
    // Migration history is carried as checksummed artifact metadata rather
    // than imported as an ordinary durable table.
    "schema_migrations",
  ];
  assert.deepEqual([...new Set(covered)].sort(), [...new Set(declared)].sort());
});

test("runtime is reset while target backup history is explicitly preserved", () => {
  assert.equal(
    EXCLUDED_TABLE_POLICY.find((entry) => entry.name === "runtime_instances")
      ?.restorePolicy,
    "truncate",
  );
  assert.equal(
    EXCLUDED_TABLE_POLICY.find((entry) => entry.name === "backup_records")
      ?.restorePolicy,
    "preserve",
  );
});

test("descriptor validation rejects reordered or altered table policy", () => {
  const descriptor = createBackupManifestDescriptor();
  assert.deepEqual(validateBackupManifestDescriptor(descriptor), descriptor);
  const changed = structuredClone(descriptor);
  changed.tables.reverse();
  assert.throws(
    () => validateBackupManifestDescriptor(changed),
    /Manifest tabel backup/,
  );
});

test("migration compatibility requires an exact filename/checksum set", () => {
  const source = [{ filename: "0001_core.sql", checksum: checksumA }];
  assert.deepEqual(assertMigrationCompatibility(source, source), {
    sourceCount: 1,
    targetCount: 1,
    targetIsSuperset: false,
  });
  assert.throws(
    () =>
      assertMigrationCompatibility(source, [
        ...source,
        { filename: "0002_more.sql", checksum: checksumB },
      ]),
    /wajib sama/,
  );
});

test("migration compatibility rejects missing and rewritten history", () => {
  const source = [{ filename: "0001_core.sql", checksum: checksumA }];
  assert.throws(
    () =>
      assertMigrationCompatibility(source, [
        { filename: "0002_more.sql", checksum: checksumB },
      ]),
    /belum memiliki/,
  );
  assert.throws(
    () =>
      assertMigrationCompatibility(source, [
        { filename: "0001_core.sql", checksum: checksumB },
      ]),
    /Checksum migration/,
  );
});

test("only the shipped root .gitkeep is treated as an ephemeral data marker", () => {
  assert.equal(isWorkspaceDataMarker(".gitkeep"), true);
  assert.equal(isWorkspaceDataMarker("inbox/.gitkeep"), false);
  assert.equal(isWorkspaceDataMarker("status.json"), false);
  assert.equal(isWorkspaceDataMarker("asset.gitkeep"), false);
});

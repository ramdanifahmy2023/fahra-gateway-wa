import assert from "node:assert/strict";
import test from "node:test";
import {
  assertKeyConfirmation,
  backupLimitsFromEnvironment,
  boundedBackupPageRows,
  createKeyConfirmation,
  decodeBackup,
  encodeBinaryValue,
  encodeBackup,
  reviveValue,
  strictBase64Decode,
} from "./backup-format.mjs";

const key = Buffer.alloc(32, 7).toString("base64");

function payload() {
  return {
    format: "OCGWB1",
    createdAt: "2026-08-09T00:00:00.000Z",
    tables: [],
    marker: "round-trip",
  };
}

test("OCGWB1 round-trip authenticates and restores the clear payload", async () => {
  const encoded = await encodeBackup(payload(), key, {
    maxArtifactBytes: 1024 * 1024,
    maxClearBytes: 1024 * 1024,
  });
  const decoded = await decodeBackup(encoded, key, {
    maxArtifactBytes: 1024 * 1024,
    maxClearBytes: 1024 * 1024,
  });
  assert.equal(decoded.marker, "round-trip");
});

test("OCGWB1 rejects a tampered ciphertext before restore", async () => {
  const encoded = await encodeBackup(payload(), key);
  const envelope = JSON.parse(encoded.toString("utf8"));
  envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
  await assert.rejects(
    () => decodeBackup(Buffer.from(JSON.stringify(envelope)), key),
    /Checksum ciphertext/,
  );
});

test("OCGWB1 rejects the wrong encryption key through GCM authentication", async () => {
  const encoded = await encodeBackup(payload(), key);
  const wrongKey = Buffer.alloc(32, 8).toString("base64");
  await assert.rejects(
    () => decodeBackup(encoded, wrongKey),
    /Autentikasi backup gagal/,
  );
});

test("format limits fail clearly instead of allowing an unbounded clear payload", async () => {
  await assert.rejects(
    () =>
      encodeBackup({ ...payload(), marker: "x".repeat(10_000) }, key, {
        maxClearBytes: 1_000,
      }),
    /BACKUP_MAX_CLEAR_BYTES/,
  );
});

test("base64 parser accepts only canonical padded data", () => {
  assert.deepEqual(strictBase64Decode("YQ=="), Buffer.from("a"));
  assert.throws(() => strictBase64Decode("YQ"), /base64 canonical/);
  assert.throws(() => strictBase64Decode("YQ==="), /base64 canonical/);
  assert.throws(() => strictBase64Decode("YR=="), /base64 canonical/);
  assert.throws(() => strictBase64Decode("YWF="), /base64 canonical/);
});

test("BYTEA row survives canonical JSON serialization and revival", () => {
  const source = Buffer.from([0, 1, 2, 127, 128, 255]);
  const portableRow = {
    scope: "default",
    value_encrypted: encodeBinaryValue(
      source,
      "whatsapp_auth_state.value_encrypted",
    ),
  };
  const parsedRow = JSON.parse(JSON.stringify(portableRow));
  assert.deepEqual(reviveValue(parsedRow.value_encrypted), source);
  assert.throws(
    () => reviveValue({ $ocgw: "buffer", base64: "not-base64" }),
    /base64 canonical/,
  );
});

test("key confirmations bind both durable encryption-key domains", () => {
  const sourceKey = Buffer.alloc(32, 11).toString("base64");
  const otherKey = Buffer.alloc(32, 12).toString("base64");
  for (const purpose of ["whatsapp-session", "application-secrets"]) {
    const confirmation = createKeyConfirmation(sourceKey, purpose);
    assert.equal(assertKeyConfirmation(confirmation, sourceKey, purpose), true);
    assert.throws(
      () => assertKeyConfirmation(confirmation, otherKey, purpose),
      /target tidak cocok/,
    );
  }
});

test("page size and aggregate memory configuration are explicitly bounded", () => {
  const limits = backupLimitsFromEnvironment({
    BACKUP_PAGE_ROWS: "500",
    BACKUP_MAX_ROW_BYTES: String(2 * 1024 * 1024),
  });
  assert.equal(boundedBackupPageRows(limits), 4);
  assert.equal(boundedBackupPageRows(limits, 1024), 500);
  assert.throws(
    () =>
      backupLimitsFromEnvironment({
        BACKUP_MAX_ARTIFACT_BYTES: String(256 * 1024 * 1024),
        BACKUP_MAX_CLEAR_BYTES: String(256 * 1024 * 1024),
      }),
    /BACKUP_MAX_WORKING_BYTES/,
  );
});

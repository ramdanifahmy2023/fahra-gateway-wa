import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, parseEncryptionKey } from "../src/config.js";

void test("session encryption key accepts exactly 32 bytes in canonical encodings", () => {
  const raw = Buffer.alloc(32, 7);
  assert.deepEqual(parseEncryptionKey(raw.toString("hex")), raw);
  assert.deepEqual(parseEncryptionKey(`base64:${raw.toString("base64")}`), raw);
  assert.throws(() => parseEncryptionKey("short-password"));
});

void test("remote PostgreSQL requires TLS", () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const base = {
    DATABASE_URL: "postgresql://u:p@example.com/db",
    INTERNAL_API_KEY: "x".repeat(32),
    WHATSAPP_SESSION_ENCRYPTION_KEY: key,
  };
  assert.throws(() => loadConfig(base), /remote PostgreSQL/);
  assert.equal(loadConfig({ ...base, DATABASE_SSL_MODE: "verify-full" }).databaseSslMode, "verify-full");
  assert.equal(
    loadConfig({ ...base, DATABASE_URL: "postgresql://u:p@127.0.0.1/db" }).databaseSslMode,
    "disable",
  );
});

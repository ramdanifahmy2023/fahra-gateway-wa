import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { decryptEnvelope, encryptEnvelope } from "../src/crypto-envelope.js";

void test("AES-256-GCM envelope round-trips and binds the record AAD", () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('{"private":"signal-key-material"}');
  const encrypted = encryptEnvelope(plaintext, key, "scope\0record\0v1");

  assert.notDeepEqual(encrypted, plaintext);
  assert.deepEqual(
    decryptEnvelope(encrypted, key, "scope\0record\0v1"),
    plaintext,
  );
  assert.throws(() =>
    decryptEnvelope(encrypted, key, "scope\0another-record\0v1"),
  );
});

void test("AES-256-GCM envelope rejects ciphertext tampering", () => {
  const key = randomBytes(32);
  const encrypted = encryptEnvelope(Buffer.from("auth-state"), key, "aad");
  const lastIndex = encrypted.length - 1;
  encrypted[lastIndex] = (encrypted[lastIndex] ?? 0) ^ 1;
  assert.throws(() => decryptEnvelope(encrypted, key, "aad"));
});

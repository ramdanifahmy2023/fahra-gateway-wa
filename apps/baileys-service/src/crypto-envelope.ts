import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("OCWA", "ascii");
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + IV_LENGTH + TAG_LENGTH;

export function encryptEnvelope(
  plaintext: Buffer,
  key: Buffer,
  aad: string,
): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, ciphertext]);
}

export function decryptEnvelope(
  envelope: Buffer,
  key: Buffer,
  aad: string,
): Buffer {
  assertKey(key);
  if (
    envelope.length < HEADER_LENGTH ||
    !envelope.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("Encrypted WhatsApp auth record has an invalid envelope");
  }
  if (envelope[MAGIC.length] !== VERSION) {
    throw new Error(
      "Encrypted WhatsApp auth record uses an unsupported version",
    );
  }

  const ivStart = MAGIC.length + 1;
  const tagStart = ivStart + IV_LENGTH;
  const ciphertextStart = tagStart + TAG_LENGTH;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    envelope.subarray(ivStart, tagStart),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
  return Buffer.concat([
    decipher.update(envelope.subarray(ciphertextStart)),
    decipher.final(),
  ]);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("AES-256-GCM key must be exactly 32 bytes");
  }
}

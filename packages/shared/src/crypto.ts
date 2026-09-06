import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type EncryptedValue = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

export function parseEncryptionKey(value: string): Buffer {
  const normalized = value.trim();
  let key: Buffer;
  if (/^[a-f\d]{64}$/i.test(normalized)) key = Buffer.from(normalized, "hex");
  else {
    try {
      key = Buffer.from(normalized, "base64");
    } catch {
      key = Buffer.alloc(0);
    }
  }
  if (key.length !== 32)
    throw new Error(
      "Encryption key harus tepat 32 byte (base64 atau 64 karakter hex)",
    );
  return key;
}

export function encryptValue(
  value: unknown,
  keyInput: string,
  aad: string,
): string {
  const key = parseEncryptionKey(keyInput);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const envelope: EncryptedValue = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function decryptValue<T>(
  value: string,
  keyInput: string,
  aad: string,
): T {
  const envelope = JSON.parse(value) as EncryptedValue;
  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm")
    throw new Error("Encrypted value version tidak didukung");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    parseEncryptionKey(keyInput),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(cleartext) as T;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

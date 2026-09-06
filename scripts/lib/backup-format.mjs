import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const format = "OCGWB1";
const mebibyte = 1024 * 1024;

export const DEFAULT_BACKUP_LIMITS = Object.freeze({
  // The format is intentionally bounded in-memory until a streaming v2
  // container exists. These defaults keep the conservative peak estimate
  // below 512 MiB instead of merely capping the final artifact.
  maxArtifactBytes: 64 * mebibyte,
  maxClearBytes: 48 * mebibyte,
  maxFileBytes: 25 * mebibyte,
  maxTotalFileBytes: 28 * mebibyte,
  maxFiles: 5_000,
  maxRowBytes: 2 * mebibyte,
  maxTableRows: 250_000,
  maxTotalRows: 500_000,
  pageRows: 500,
  maxWorkingBytes: 512 * mebibyte,
});

const limitEnvironmentKeys = Object.freeze({
  maxArtifactBytes: "BACKUP_MAX_ARTIFACT_BYTES",
  maxClearBytes: "BACKUP_MAX_CLEAR_BYTES",
  maxFileBytes: "BACKUP_MAX_FILE_BYTES",
  maxTotalFileBytes: "BACKUP_MAX_TOTAL_FILE_BYTES",
  maxFiles: "BACKUP_MAX_FILES",
  maxRowBytes: "BACKUP_MAX_ROW_BYTES",
  maxTableRows: "BACKUP_MAX_TABLE_ROWS",
  maxTotalRows: "BACKUP_MAX_TOTAL_ROWS",
  pageRows: "BACKUP_PAGE_ROWS",
  maxWorkingBytes: "BACKUP_MAX_WORKING_BYTES",
});

export function backupLimitsFromEnvironment(environment = process.env) {
  const limits = {};
  for (const [property, environmentKey] of Object.entries(
    limitEnvironmentKeys,
  )) {
    const raw = environment[environmentKey];
    const fallback = DEFAULT_BACKUP_LIMITS[property];
    if (raw === undefined || String(raw).trim() === "") {
      limits[property] = fallback;
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${environmentKey} wajib berupa integer positif`);
    }
    limits[property] = parsed;
  }
  if (limits.maxFileBytes > limits.maxTotalFileBytes) {
    throw new Error(
      "BACKUP_MAX_FILE_BYTES tidak boleh melebihi BACKUP_MAX_TOTAL_FILE_BYTES",
    );
  }
  if (limits.maxTotalFileBytes > Math.floor((limits.maxClearBytes * 3) / 4)) {
    throw new Error(
      "BACKUP_MAX_TOTAL_FILE_BYTES terlalu besar untuk BACKUP_MAX_CLEAR_BYTES setelah ekspansi base64",
    );
  }
  if (limits.maxRowBytes > limits.maxClearBytes) {
    throw new Error(
      "BACKUP_MAX_ROW_BYTES tidak boleh melebihi BACKUP_MAX_CLEAR_BYTES",
    );
  }
  if (limits.maxTableRows > limits.maxTotalRows) {
    throw new Error(
      "BACKUP_MAX_TABLE_ROWS tidak boleh melebihi BACKUP_MAX_TOTAL_ROWS",
    );
  }
  if (limits.maxFiles > 1_000_000 || limits.maxTotalRows > 10_000_000) {
    throw new Error(
      "BACKUP_MAX_FILES/BACKUP_MAX_TOTAL_ROWS melewati hard safety cap format in-memory",
    );
  }
  if (limits.pageRows > limits.maxTableRows) {
    throw new Error(
      "BACKUP_PAGE_ROWS tidak boleh melebihi BACKUP_MAX_TABLE_ROWS",
    );
  }
  assertConfiguredWorkingSet(limits);
  return Object.freeze(limits);
}

export function boundedBackupPageRows(
  limits,
  observedMaxRowBytes = limits.maxRowBytes,
) {
  const rowBytes = Math.max(
    1,
    Math.min(limits.maxRowBytes, observedMaxRowBytes),
  );
  const pageBudget = Math.max(
    rowBytes * 16,
    limits.maxWorkingBytes - limits.maxClearBytes * 8,
  );
  const memoryBound = Math.max(1, Math.floor(pageBudget / (rowBytes * 16)));
  return Math.max(1, Math.min(limits.pageRows, memoryBound));
}

function assertConfiguredWorkingSet(limits) {
  const encodePeak = limits.maxClearBytes * 8;
  const decodePeak = limits.maxArtifactBytes * 4 + limits.maxClearBytes * 5;
  const dumpPagePeak = encodePeak + limits.maxRowBytes * 16;
  if (
    !Number.isSafeInteger(encodePeak) ||
    !Number.isSafeInteger(decodePeak) ||
    Math.max(encodePeak, decodePeak, dumpPagePeak) > limits.maxWorkingBytes
  ) {
    throw new Error(
      "Konfigurasi BACKUP_MAX_* melebihi BACKUP_MAX_WORKING_BYTES; turunkan cap artifact/clear atau naikkan budget memori secara eksplisit",
    );
  }
}

function assertActualWorkingSet(artifactBytes, clearBytes, limits, phase) {
  const estimate =
    phase === "encode" ? clearBytes * 8 : artifactBytes * 4 + clearBytes * 5;
  if (!Number.isSafeInteger(estimate) || estimate > limits.maxWorkingBytes) {
    throw new Error(
      `Estimasi working set ${phase} ${String(estimate)} byte melewati BACKUP_MAX_WORKING_BYTES=${limits.maxWorkingBytes}`,
    );
  }
}

function keyFrom(value) {
  const normalized = String(value ?? "").trim();
  const key = /^[a-f\d]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : strictBase64Decode(normalized, "BACKUP_ENCRYPTION_KEY");
  if (key.length !== 32)
    throw new Error("BACKUP_ENCRYPTION_KEY harus tepat 32 byte");
  return key;
}

export async function encodeBackup(payload, keyInput, options = {}) {
  const limits = { ...DEFAULT_BACKUP_LIMITS, ...options };
  const serialized = JSON.stringify(payload);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  assertActualWorkingSet(0, serializedBytes, limits, "encode");
  const clear = Buffer.from(serialized, "utf8");
  if (clear.length > limits.maxClearBytes) {
    throw new Error(
      `Payload backup ${clear.length} byte melewati BACKUP_MAX_CLEAR_BYTES=${limits.maxClearBytes}`,
    );
  }
  const compressed = await gzipAsync(clear, { level: 9 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyInput), iv);
  cipher.setAAD(Buffer.from(format));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const envelope = {
    format,
    createdAt: payload.createdAt,
    algorithm: "aes-256-gcm",
    compression: "gzip",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    payloadSha256: digest(clear),
    compressedSha256: digest(compressed),
    ciphertextSha256: digest(ciphertext),
    clearBytes: clear.length,
    compressedBytes: compressed.length,
    ciphertextBytes: ciphertext.length,
    ciphertext: ciphertext.toString("base64"),
  };
  const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (encoded.length > limits.maxArtifactBytes) {
    throw new Error(
      `Artifact backup ${encoded.length} byte melewati BACKUP_MAX_ARTIFACT_BYTES=${limits.maxArtifactBytes}`,
    );
  }
  return encoded;
}

export async function decodeBackup(buffer, keyInput, options = {}) {
  const limits = { ...DEFAULT_BACKUP_LIMITS, ...options };
  if (!Buffer.isBuffer(buffer))
    throw new Error("Artifact backup wajib berupa Buffer");
  if (buffer.length > limits.maxArtifactBytes) {
    throw new Error(
      `Artifact backup ${buffer.length} byte melewati BACKUP_MAX_ARTIFACT_BYTES=${limits.maxArtifactBytes}`,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("Format backup bukan JSON envelope yang valid");
  }
  validateEnvelope(envelope, limits);
  assertActualWorkingSet(buffer.length, envelope.clearBytes, limits, "decode");
  const ciphertext = strictBase64Decode(envelope.ciphertext, "ciphertext");
  if (ciphertext.length !== envelope.ciphertextBytes)
    throw new Error("Ukuran ciphertext backup tidak cocok");
  assertDigest(ciphertext, envelope.ciphertextSha256, "ciphertext");

  const iv = strictBase64Decode(envelope.iv, "iv");
  const tag = strictBase64Decode(envelope.tag, "authentication tag");
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Nonce/tag backup tidak valid");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyInput), iv);
  decipher.setAAD(Buffer.from(format));
  decipher.setAuthTag(tag);
  let compressed;
  try {
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      "Autentikasi backup gagal: key salah atau file telah diubah",
    );
  }
  if (compressed.length !== envelope.compressedBytes)
    throw new Error("Ukuran compressed payload tidak cocok");
  assertDigest(compressed, envelope.compressedSha256, "compressed payload");

  let clear;
  try {
    clear = await gunzipAsync(compressed, {
      maxOutputLength: limits.maxClearBytes,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Dekompresi backup gagal atau melewati BACKUP_MAX_CLEAR_BYTES: ${detail}`,
    );
  }
  if (
    clear.length !== envelope.clearBytes ||
    clear.length > limits.maxClearBytes
  ) {
    throw new Error(
      "Ukuran clear payload backup tidak cocok atau melewati batas",
    );
  }
  assertDigest(clear, envelope.payloadSha256, "clear payload");

  let payload;
  try {
    payload = JSON.parse(clear.toString("utf8"));
  } catch {
    throw new Error("Payload backup bukan JSON yang valid");
  }
  if (
    !isRecord(payload) ||
    payload.format !== format ||
    !Array.isArray(payload.tables)
  ) {
    throw new Error("Manifest backup tidak valid");
  }
  return payload;
}

function validateEnvelope(value, limits) {
  if (!isRecord(value) || value.format !== format) {
    throw new Error(
      `Format backup tidak didukung: ${isRecord(value) ? (value.format ?? "unknown") : "unknown"}`,
    );
  }
  if (value.algorithm !== "aes-256-gcm" || value.compression !== "gzip") {
    throw new Error("Algoritma atau kompresi backup tidak didukung");
  }
  for (const property of [
    "payloadSha256",
    "compressedSha256",
    "ciphertextSha256",
  ]) {
    if (
      typeof value[property] !== "string" ||
      !/^[0-9a-f]{64}$/.test(value[property])
    ) {
      throw new Error(`Checksum envelope tidak valid: ${property}`);
    }
  }
  for (const property of ["clearBytes", "compressedBytes", "ciphertextBytes"]) {
    if (!Number.isSafeInteger(value[property]) || value[property] < 0) {
      throw new Error(`Ukuran envelope tidak valid: ${property}`);
    }
  }
  if (
    value.clearBytes > limits.maxClearBytes ||
    value.ciphertextBytes > limits.maxArtifactBytes
  ) {
    throw new Error(
      "Ukuran yang dideklarasikan envelope melewati batas konfigurasi",
    );
  }
  if (
    typeof value.ciphertext !== "string" ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string"
  ) {
    throw new Error("Field binary envelope tidak valid");
  }
}

export function strictBase64Decode(value, label = "base64") {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new Error(`${label} bukan base64 canonical`);
  }
  // ponytail: large backup ciphertext can overflow V8 regexp stack; chunk scan keeps
  // validation bounded. Upgrade path: streaming envelope decode.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const firstPadding = value.indexOf("=");
  const bodyEnd = firstPadding === -1 ? value.length : firstPadding;
  for (let index = 0; index < bodyEnd; index += 1) {
    if (!alphabet.includes(value[index]))
      throw new Error(`${label} bukan base64 canonical`);
  }
  if (firstPadding !== -1 && !/^={1,2}$/.test(value.slice(firstPadding)))
    throw new Error(`${label} bukan base64 canonical`);
  if (value.endsWith("==") && base64Sextet(value.at(-3)) % 16 !== 0)
    throw new Error(`${label} bukan base64 canonical`);
  if (
    value.endsWith("=") &&
    !value.endsWith("==") &&
    base64Sextet(value.at(-2)) % 4 !== 0
  )
    throw new Error(`${label} bukan base64 canonical`);
  const decoded = Buffer.from(value, "base64");
  return decoded;
}

function base64Sextet(character) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return alphabet.indexOf(character);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value, expected, label) {
  const actual = Buffer.from(digest(value), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    expectedBuffer.length !== actual.length ||
    !timingSafeEqual(actual, expectedBuffer)
  ) {
    throw new Error(`Checksum ${label} backup tidak cocok`);
  }
}

export function reviveValue(value) {
  if (value && typeof value === "object" && value.$ocgw === "buffer") {
    if (Object.keys(value).length !== 2 || typeof value.base64 !== "string") {
      throw new Error("Representasi Buffer backup tidak valid");
    }
    return strictBase64Decode(value.base64, "Buffer row");
  }
  if (Array.isArray(value)) return value.map(reviveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, reviveValue(item)]),
    );
  }
  return value;
}

export function encodeBinaryValue(value, label = "BYTEA") {
  if (!Buffer.isBuffer(value)) throw new Error(`${label} source bukan Buffer`);
  return { $ocgw: "buffer", base64: value.toString("base64") };
}

function encryptionKey(value, label) {
  const normalized = String(value ?? "").trim();
  let key;
  if (normalized.startsWith("hex:")) {
    const body = normalized.slice(4);
    if (!/^[a-f\d]{64}$/i.test(body))
      throw new Error(`${label} hex wajib 64 karakter`);
    key = Buffer.from(body, "hex");
  } else if (normalized.startsWith("base64:")) {
    key = strictBase64Decode(normalized.slice(7), label);
  } else if (/^[a-f\d]{64}$/i.test(normalized)) {
    key = Buffer.from(normalized, "hex");
  } else {
    key = strictBase64Decode(normalized, label);
  }
  if (key.length !== 32) throw new Error(`${label} harus tepat 32 byte`);
  return key;
}

const keyPurposeLabels = Object.freeze({
  "whatsapp-session": "WHATSAPP_SESSION_ENCRYPTION_KEY",
  "application-secrets": "SESSION_ENCRYPTION_KEY",
});

function keyPurposeLabel(purpose) {
  const label = keyPurposeLabels[purpose];
  if (!label)
    throw new Error(`Purpose konfirmasi kunci tidak didukung: ${purpose}`);
  return label;
}

function keyConfirmationContext(purpose) {
  return `OCGWB1:key-confirmation:${purpose}:v1`;
}

export function createKeyConfirmation(keyInput, purpose) {
  const label = keyPurposeLabel(purpose);
  const salt = randomBytes(16);
  return {
    version: 1,
    algorithm: "hmac-sha256",
    purpose,
    salt: salt.toString("base64"),
    verifier: createHmac("sha256", encryptionKey(keyInput, label))
      .update(keyConfirmationContext(purpose))
      .update(salt)
      .digest("hex"),
  };
}

export function assertKeyConfirmation(value, keyInput, purpose) {
  const label = keyPurposeLabel(purpose);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.algorithm !== "hmac-sha256" ||
    value.purpose !== purpose ||
    typeof value.salt !== "string" ||
    typeof value.verifier !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.verifier)
  ) {
    throw new Error(`Konfirmasi ${label} tidak valid`);
  }
  const salt = strictBase64Decode(value.salt, `Salt konfirmasi ${label}`);
  if (salt.length !== 16)
    throw new Error(`Salt konfirmasi ${label} tidak valid`);
  const actual = createHmac("sha256", encryptionKey(keyInput, label))
    .update(keyConfirmationContext(purpose))
    .update(salt)
    .digest();
  const expected = Buffer.from(value.verifier, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(
      `${label} target tidak cocok dengan artifact; restore dibatalkan sebelum downtime`,
    );
  }
  return true;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

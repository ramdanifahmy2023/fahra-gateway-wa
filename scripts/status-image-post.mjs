#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, chmod } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { readWorkspaceEnv, workspaceRoot } from "./lib/common.mjs";
import {
  acquireStatusPostClaim,
  readStatusPostClaim,
  updateStatusPostClaim,
  validateStatusPostKey,
} from "./lib/status-post-idempotency.mjs";

process.umask(0o077);
const rawArgs = process.argv.slice(2);
const keyIndex = rawArgs.indexOf("--idempotency-key");
const idempotencyKey = keyIndex >= 0 ? validateStatusPostKey(rawArgs[keyIndex + 1]) : null;
if (keyIndex >= 0) rawArgs.splice(keyIndex, 2);
const [sourceArg, caption = ""] = rawArgs;
const preflightOnly = sourceArg === "--preflight";
if (!sourceArg) {
  throw new Error(
    "Usage: node scripts/status-image-post.mjs --preflight | <qc-passed-image> [caption] --idempotency-key <date:slot>",
  );
}
if (!preflightOnly && !idempotencyKey) throw new Error("--idempotency-key is required for Status posting");
if (caption.length > 700) throw new Error("Caption exceeds 700 characters");

const env = await readWorkspaceEnv();
const key = env.INTERNAL_API_KEY;
if (!key) throw new Error("INTERNAL_API_KEY is unavailable");
const port = env.BAILEYS_HEALTH_PORT || "3101";
const origin = `http://127.0.0.1:${port}`;
const headers = { "x-internal-api-key": key, "content-type": "application/json" };
const claimDirectory = resolve(workspaceRoot, env.DATA_DIR || "data", "status-post-claims");

if (idempotencyKey) {
  const existingClaim = await readStatusPostClaim(claimDirectory, idempotencyKey);
  if (existingClaim) {
    process.stdout.write(
      JSON.stringify({ status: "duplicate_prevented", priorState: existingClaim.state || "unknown" }) + "\n",
    );
    process.exit(0);
  }
}

const readyResponse = await fetch(`${origin}/internal/status/ready`, {
  method: "GET",
  headers: { "x-internal-api-key": key },
  signal: AbortSignal.timeout(10_000),
});
const ready = await readyResponse.json().catch(() => null);
if (!readyResponse.ok || ready?.data?.status !== "ready" || ready.data.audienceCount < 1) {
  throw new Error(`Status preflight failed explicitly (HTTP ${readyResponse.status})`);
}
if (preflightOnly) {
  process.stdout.write(JSON.stringify({ status: "ready", audienceCount: ready.data.audienceCount }) + "\n");
  process.exit(0);
}

const source = resolve(sourceArg);
const extension = extname(source).toLowerCase();
const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) throw new Error("Unsupported image extension");
const sourceBytes = await readFile(source);
const uploadDir = resolve(workspaceRoot, env.DATA_DIR || "data", "uploads");
await mkdir(uploadDir, { recursive: true, mode: 0o700 });
const storedName = `${randomUUID()}${extension}`;
const destination = join(uploadDir, storedName);
await copyFile(source, destination);
await chmod(destination, 0o600);

try {
  const claim = await acquireStatusPostClaim(claimDirectory, idempotencyKey, {
    sourceDigest: createHash("sha256").update(sourceBytes).digest("hex"),
    captionDigest: createHash("sha256").update(caption).digest("hex"),
  });
  if (!claim.acquired) {
    process.stdout.write(
      JSON.stringify({ status: "duplicate_prevented", priorState: claim.claim?.state || "unknown" }) + "\n",
    );
    process.exitCode = 0;
  } else {
    const response = await fetch(`${origin}/internal/status/image`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: basename(destination), mimeType, caption }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json().catch(() => null);
    const data = payload?.data;
    if (!response.ok || data?.status !== "accepted" || data?.remoteJid !== "status@broadcast" || !data?.waMessageId || data?.audienceCount < 1) {
      throw new Error(`Status post was not accepted explicitly (HTTP ${response.status})`);
    }
    await updateStatusPostClaim(claimDirectory, idempotencyKey, {
      state: "accepted",
      acceptedAt: new Date().toISOString(),
      audienceCount: data.audienceCount,
    });
    process.stdout.write(JSON.stringify({ status: "accepted", audienceCount: data.audienceCount }) + "\n");
  }
} catch (error) {
  await updateStatusPostClaim(claimDirectory, idempotencyKey, {
    state: "failed_or_ambiguous",
    failedAt: new Date().toISOString(),
    errorClass: error?.name || "Error",
  }).catch(() => undefined);
  throw error;
} finally {
  await rm(destination, { force: true });
}

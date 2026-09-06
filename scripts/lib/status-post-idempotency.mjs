import { open, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function validateStatusPostKey(value) {
  if (!KEY_PATTERN.test(value || "")) {
    throw new Error("Invalid status idempotency key");
  }
  return value;
}

export function statusPostClaimPath(directory, key) {
  return join(directory, `${validateStatusPostKey(key)}.json`);
}

export async function readStatusPostClaim(directory, key) {
  try {
    return JSON.parse(await readFile(statusPostClaimPath(directory, key), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function acquireStatusPostClaim(directory, key, evidence = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = statusPostClaimPath(directory, key);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    const claim = {
      schemaVersion: 1,
      key,
      state: "attempted",
      attemptedAt: new Date().toISOString(),
      ...evidence,
    };
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
    await handle.sync();
    return { acquired: true, claim, path };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { acquired: false, claim: await readStatusPostClaim(directory, key), path };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function updateStatusPostClaim(directory, key, patch) {
  const path = statusPostClaimPath(directory, key);
  const current = await readStatusPostClaim(directory, key);
  if (!current) throw new Error("Status post claim is missing");
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return next;
}

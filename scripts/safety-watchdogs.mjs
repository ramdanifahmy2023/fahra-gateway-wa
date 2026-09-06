#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const root = process.env.WATCHDOG_ROOT || process.cwd();
const runtime = path.join(root, ".runtime");
const backupDir = path.join(root, "data", "backups");
const publicLoginUrl = process.env.WATCHDOG_PUBLIC_LOGIN_URL || "https://fahragateway.chatkulaku.my.id/login";
const maxBackupAgeMs = Number(process.env.WATCHDOG_BACKUP_MAX_AGE_MS || 26 * 60 * 60 * 1000);
const output = { version: 1, at: new Date().toISOString(), checks: [], mutations: [] };

async function check(name, fn) {
  try { output.checks.push({ name, ...(await fn()), ok: true }); }
  catch (error) { output.checks.push({ name, ok: false, error: String(error?.message || error) }); }
}
async function run(file, args, options) {
  try { return await exec(file, args, options); }
  catch (error) {
    if (error?.code !== 75) throw error;
    return exec(file, args, options);
  }
}
async function createSafetyBackup(cause) {
  const { stdout } = await run("npm", ["run", "backup", "--silent", "--", "--safety"], { cwd: root, timeout: 120000, maxBuffer: 512 * 1024 });
  output.mutations.push({ type: "safety_backup", cause, evidence: stdout.trim().slice(-500) });
  return { repaired: true };
}
async function files() {
  const names = (await fs.readdir(backupDir)).filter((n) => n.endsWith(".ocgwb"));
  const rows = await Promise.all(names.map(async (name) => {
    const file = path.join(backupDir, name); const stat = await fs.stat(file);
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  }));
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

await check("backup_integrity", async () => {
  const rows = await files();
  if (!rows.length) return createSafetyBackup("no_backup");
  const latest = rows[0];
  if (latest.size < 4096) return createSafetyBackup("backup_too_small");
  const artifact = await fs.readFile(path.join(backupDir, latest.name));
  const digest = createHash("sha256").update(artifact).digest("hex");
  let envelope;
  try { envelope = JSON.parse(artifact.toString("utf8")); } catch { return createSafetyBackup("backup_invalid_json"); }
  if (envelope?.format !== "OCGWB1" || !/^[a-f0-9]{64}$/i.test(envelope?.ciphertextSha256 || "")) return createSafetyBackup("backup_invalid_envelope");
  const ciphertext = Buffer.from(envelope.ciphertext || "", "base64");
  const ciphertextDigest = createHash("sha256").update(ciphertext).digest("hex");
  if (ciphertextDigest !== envelope.ciphertextSha256) return createSafetyBackup("backup_checksum_mismatch");
  const ageMs = Date.now() - latest.mtimeMs;
  if (ageMs > maxBackupAgeMs) {
    await createSafetyBackup("backup_stale");
    return { latest: latest.name, bytes: latest.size, ageMs, sha256: digest, repaired: true, count: rows.length };
  }
  return { latest: latest.name, bytes: latest.size, ageMs, sha256: digest, repaired: false, count: rows.length };
});

await check("gateway_doctor", async () => {
  const { stdout } = await run("npm", ["run", "doctor", "--silent"], { cwd: root, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (!stdout.includes("✓")) throw new Error("Doctor returned no PASS evidence");
  return { evidence: "doctor_pass" };
});

await check("public_health", async () => {
  const { stdout } = await run("curl", ["-fsS", "-L", "-o", "/dev/null", "-w", "%{http_code}", publicLoginUrl], { timeout: 30000 });
  if (stdout.trim() !== "200") throw new Error(`Public login HTTP ${stdout.trim()}`);
  return { http: 200 };
});

await check("queue_observation", async () => {
  const { stdout } = await run("npm", ["run", "status", "--silent"], { cwd: root, timeout: 60000, maxBuffer: 512 * 1024 });
  return { evidence: stdout.includes("Queue") ? "status_queue_visible" : "status_pass" };
});

await fs.mkdir(runtime, { recursive: true });
await fs.appendFile(path.join(runtime, "safety-watchdogs.jsonl"), JSON.stringify(output) + "\n");
if (output.checks.some((c) => !c.ok)) process.exitCode = 1;

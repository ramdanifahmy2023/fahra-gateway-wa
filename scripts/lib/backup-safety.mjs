import { readFile } from "node:fs/promises";

async function readBaselineFile(path) {
  const content = await readFile(path, "utf8").catch(() => "null");
  return JSON.parse(content);
}

export async function assertNotSuspiciousEmptyBackup({
  client,
  baselinePath,
  safety = false,
  readBaseline = readBaselineFile,
}) {
  if (safety) return { skipped: true };
  if (!client || typeof client.query !== "function")
    throw new Error("Backup safety guard membutuhkan database client");
  if (typeof baselinePath !== "string" || baselinePath.length === 0)
    throw new Error("Backup safety guard membutuhkan baseline path");

  const counts = await client.query(`
    select
      (select count(*)::int from whatsapp_messages) as messages,
      (select count(*)::int from whatsapp_groups) as groups,
      (select count(*)::int from whatsapp_auth_state) as auth
  `);
  const current = counts.rows[0] ?? {};
  const baseline = await readBaseline(baselinePath);
  const last = baseline?.lastHealthy ?? {};

  if (
    Number(last.whatsapp_messages ?? 0) > 0 &&
    Number(current.messages ?? 0) === 0
  ) {
    throw new Error(
      "Backup diblokir: DB suspicious-empty whatsapp_messages=0 sementara baseline punya data",
    );
  }
  if (
    Number(last.whatsapp_groups ?? 0) > 0 &&
    Number(current.groups ?? 0) === 0
  ) {
    throw new Error(
      "Backup diblokir: DB suspicious-empty whatsapp_groups=0 sementara baseline punya data",
    );
  }
  if (
    Number(last.whatsapp_auth_state ?? 0) > 1000 &&
    Number(current.auth ?? 0) < 1000
  ) {
    throw new Error(
      "Backup diblokir: whatsapp_auth_state turun drastis; cegah overwrite session sehat",
    );
  }

  return { skipped: false, current, lastHealthy: last };
}

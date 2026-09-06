export const WEEKLY_BACKUP_RETAIN = 7;
export const WEEKLY_BACKUP_SCHEDULING_STATUSES = [
  "queued",
  "running",
  "completed",
] as const;

export function weeklyBackupDedupeKey(
  scheduledWeek: string,
  backupId: string,
): string {
  return `backup-weekly:${scheduledWeek}:${backupId}`;
}

export function localBackupWindow(
  timeZone: string,
  now = new Date(),
): { scheduledDate: string; scheduledWeek: string; eligible: boolean } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  if (!values.year || !values.month || !values.day || !Number.isInteger(hour))
    throw new Error("Local backup date tidak dapat dihitung");
  const scheduledDate = `${values.year}-${values.month}-${values.day}`;
  return {
    scheduledDate,
    scheduledWeek: weeklyBackupKey(scheduledDate),
    eligible: hour >= 2,
  };
}

export function weeklyRetentionIds<T extends { id: string }>(
  newestFirst: readonly T[],
): Set<string> {
  return new Set(newestFirst.slice(WEEKLY_BACKUP_RETAIN).map((record) => record.id));
}

function weeklyBackupKey(localDate: string): string {
  const [yearText, monthText, dayText] = localDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
    throw new Error("Local backup date tidak valid");
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

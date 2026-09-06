import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value: unknown): string {
  if (!value) return "Tidak tersedia";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

export function formatNumber(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("id-ID").format(number)
    : "0";
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  const source = value as Record<string, unknown>;
  const normalized = { ...source };
  for (const [key, entry] of Object.entries(source)) {
    if (!key.includes("_")) continue;
    const camelKey = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (!(camelKey in normalized)) normalized[camelKey] = entry;
  }
  return normalized;
}

export function unwrapData(value: unknown): unknown {
  const record = asRecord(value);
  return "data" in record ? record.data : value;
}

export function unwrapRecord(value: unknown): Record<string, unknown> {
  return asRecord(unwrapData(value));
}

export function unwrapCollection(value: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapData(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(asRecord);
  const record = asRecord(unwrapped);
  const list = record.items ?? record.results ?? record.rows;
  return Array.isArray(list) ? list.map(asRecord) : [];
}

export function responseMeta(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value).meta);
}

export function getRecordId(record: Record<string, unknown>): string {
  return String(record.id ?? record.uuid ?? record.key ?? record.jid ?? "");
}

export function getString(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = getValue(record, key);
    if (value !== undefined && value !== null) return String(value);
  }
  return "";
}

export function getBoolean(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean {
  for (const key of keys) {
    const snakeKey = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    if (key in record) return Boolean(record[key]);
    if (snakeKey in record) return Boolean(record[snakeKey]);
  }
  return false;
}

export function getValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  if (key in record) return record[key];
  const snakeKey = key.replace(
    /[A-Z]/g,
    (letter) => `_${letter.toLowerCase()}`,
  );
  return record[snakeKey];
}

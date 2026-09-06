const IDENTIFIER_PART = /^[a-z_][a-z0-9_]*$/i;

export function quoteIdentifier(identifier: string): string {
  const parts = identifier.split(".");
  if (
    parts.length < 1 ||
    parts.length > 2 ||
    parts.some((part) => !IDENTIFIER_PART.test(part))
  ) {
    throw new Error(`Invalid PostgreSQL identifier: ${identifier}`);
  }

  return parts.map((part) => `"${part}"`).join(".");
}

export function splitIdentifier(identifier: string): {
  schema: string;
  table: string;
} {
  const parts = identifier.split(".");
  if (parts.length === 1 && parts[0] && IDENTIFIER_PART.test(parts[0])) {
    return { schema: "public", table: parts[0] };
  }
  if (
    parts.length === 2 &&
    parts[0] &&
    parts[1] &&
    IDENTIFIER_PART.test(parts[0]) &&
    IDENTIFIER_PART.test(parts[1])
  ) {
    return { schema: parts[0], table: parts[1] };
  }

  throw new Error(`Invalid PostgreSQL identifier: ${identifier}`);
}

export function exponentialBackoff(
  attempt: number,
  baseMs: number,
  maximumMs: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(
    maximumMs,
    baseMs * 2 ** Math.min(safeAttempt - 1, 20),
  );
  const jitterFactor = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(
    maximumMs,
    Math.max(baseMs, Math.floor(exponential * jitterFactor)),
  );
}

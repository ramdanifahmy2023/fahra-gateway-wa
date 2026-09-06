import { Redis } from "ioredis";
import type { Logger } from "pino";

export type RedisState = {
  client: Redis | null;
  configured: boolean;
  available: boolean;
  error?: string;
};

export async function connectOptionalRedis(
  url: string | undefined,
  logger?: Logger,
): Promise<RedisState> {
  if (!url) return { client: null, configured: false, available: false };
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: () => null,
  });
  client.on("error", (error) =>
    logger?.warn({ err: error }, "redis connection error"),
  );
  try {
    await client.connect();
    await client.ping();
    return { client, configured: true, available: true };
  } catch (error) {
    await client.quit().catch(() => undefined);
    const message =
      error instanceof Error ? error.message : "unknown redis error";
    logger?.warn(
      { error: message },
      "Redis tidak tersedia; memakai queue PostgreSQL",
    );
    return { client: null, configured: true, available: false, error: message };
  }
}

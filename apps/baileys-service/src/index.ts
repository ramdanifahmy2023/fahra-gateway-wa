import { chmod, mkdir } from "node:fs/promises";

import { loadConfig } from "./config.js";
import {
  createEncryptedAuthState,
  PostgresEncryptedAuthStore,
} from "./encrypted-auth-state.js";
import { HealthServer } from "./health-server.js";
import { createLogger } from "./logger.js";
import { OpenClawClient } from "./openclaw-client.js";
import { OpenClawOutboxWorker } from "./outbox-worker.js";
import { DurableQueueWorker } from "./queue-worker.js";
import {
  createPool,
  type SingletonLease,
  WhatsAppRepository,
} from "./repository.js";
import { WhatsAppSocketManager } from "./socket-manager.js";
import { StatusStore } from "./status-store.js";

process.umask(0o077);

async function main(): Promise<void> {
  const config = loadConfig();
  await Promise.all(
    [config.whatsappDir, config.uploadsDir, config.logsDir].map(
      async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      },
    ),
  );
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const repository = new WhatsAppRepository(pool, config);
  const statusStore = new StatusStore(config.whatsappDir);
  await statusStore.initialize();

  logger.info(
    {
      runtime:
        typeof globalThis.Bun === "undefined"
          ? `node-${process.version}`
          : "bun",
      dataDir: config.dataDir,
      healthHost: config.healthHost,
      healthPort: config.healthPort,
    },
    "Starting workspace-local Baileys service",
  );

  let singletonLease: SingletonLease | undefined;
  let socketManager: WhatsAppSocketManager | undefined;
  let queueWorker: DurableQueueWorker | undefined;
  let outboxWorker: OpenClawOutboxWorker | undefined;
  let healthServer: HealthServer | undefined;
  try {
    await repository.ping();
    await repository.assertContract();
    singletonLease = await repository.acquireSingletonLease((error) => {
      logger.fatal({ err: error }, "PostgreSQL singleton lease was lost");
      process.kill(process.pid, "SIGTERM");
    });

    const authStore = new PostgresEncryptedAuthStore(
      pool,
      config.authTable,
      config.sessionScope,
      config.sessionEncryptionKey,
    );
    const authState = await createEncryptedAuthState(authStore);
    socketManager = new WhatsAppSocketManager(
      config,
      authState,
      repository,
      statusStore,
      logger,
    );
    queueWorker = new DurableQueueWorker(
      config,
      repository,
      socketManager,
      logger,
    );
    const openClawClient = new OpenClawClient(
      config.gatewayInternalUrl,
      config.internalApiKey,
      logger,
    );
    outboxWorker = new OpenClawOutboxWorker(
      config,
      repository,
      openClawClient,
      logger,
    );
    healthServer = new HealthServer(
      config,
      repository,
      socketManager,
      statusStore,
      logger,
    );

    await healthServer.start();
    await socketManager.start();
    await queueWorker.start();
    await outboxWorker.start();
  } catch (error) {
    await Promise.allSettled([
      healthServer?.stop(),
      queueWorker?.stop(),
      outboxWorker?.stop(),
    ]);
    await socketManager?.stop().catch(() => undefined);
    await singletonLease?.release().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }

  if (
    !singletonLease ||
    !socketManager ||
    !queueWorker ||
    !outboxWorker ||
    !healthServer
  ) {
    await pool.end();
    throw new Error(
      "Baileys service initialization did not produce all runtime components",
    );
  }

  const heartbeat = setInterval(() => {
    void statusStore
      .patch({ lastHeartbeatAt: new Date().toISOString() })
      .catch((error: unknown) => {
        logger.error({ err: error }, "Unable to write Baileys heartbeat");
      });
    void repository.touchConnection().catch((error: unknown) => {
      logger.warn(
        { err: error },
        "Unable to persist Baileys database heartbeat",
      );
    });
    void socketManager.recoverInboundSpool().catch((error: unknown) => {
      logger.error(
        { err: error },
        "Unable to scan encrypted inbound recovery spool",
      );
    });
  }, 15_000);
  heartbeat.unref();

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    logger.info({ reason }, "Stopping workspace-local Baileys service");
    const forcedExit = setTimeout(() => {
      logger.fatal("Graceful shutdown deadline exceeded");
      process.exit(1);
    }, 20_000);
    forcedExit.unref();
    // Stop new queue claims and let the in-flight send persist its outcome
    // before closing Baileys. This narrows the unavoidable network-ack crash
    // window and leaves deterministic message IDs as the replay fence.
    await Promise.allSettled([
      healthServer.stop(),
      queueWorker.stop(),
      outboxWorker.stop(),
    ]);
    await socketManager.stop().catch((error: unknown) => {
      logger.error({ err: error }, "Unable to stop WhatsApp socket cleanly");
    });
    await singletonLease.release().catch((error: unknown) => {
      logger.error(
        { err: error },
        "Unable to release PostgreSQL singleton lease cleanly",
      );
    });
    await pool.end();
    clearTimeout(forcedExit);
    logger.info("Baileys service stopped");
    logger.flush();
    process.exitCode = exitCode;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    logger.fatal({ err: error }, "Unhandled rejection");
    void shutdown("unhandledRejection", 1);
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Baileys service startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});

declare global {
  // Bun is intentionally optional. The installer chooses it when available.
  var Bun: unknown;
}

import type { Logger } from "pino";

import { exponentialBackoff } from "./backoff.js";
import type { ServiceConfig } from "./config.js";
import { PermanentJobError, errorMessage } from "./errors.js";
import type { OpenClawClient } from "./openclaw-client.js";
import type { ClaimedOutboxEvent, WhatsAppRepository } from "./repository.js";

export class OpenClawOutboxWorker {
  private readonly abortController = new AbortController();
  private running: Promise<void> | undefined;

  public constructor(
    private readonly config: ServiceConfig,
    private readonly repository: WhatsAppRepository,
    private readonly client: OpenClawClient,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    const recovered = await this.repository.recoverOutbox(true);
    if (recovered > 0) {
      this.logger.warn({ recovered }, "Recovered stale OpenClaw outbox events");
    }
    this.running = this.loop();
  }

  public async stop(): Promise<void> {
    this.abortController.abort();
    await this.running;
  }

  private async loop(): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      let event: ClaimedOutboxEvent | null = null;
      try {
        event = await this.repository.claimOutbox();
        if (!event) {
          await delay(this.config.pollIntervalMs, signal);
          continue;
        }
        const responseStatus = await this.client.forward(event.payload);
        await this.repository.completeOutbox(event, responseStatus);
      } catch (error) {
        if (signal.aborted) return;
        if (!event) {
          this.logger.error({ err: error }, "OpenClaw outbox polling failed");
          await delay(Math.max(2_000, this.config.pollIntervalMs), signal);
          continue;
        }
        const dead =
          error instanceof PermanentJobError ||
          event.attempts >= event.maxAttempts;
        const backoffMs = dead
          ? 0
          : exponentialBackoff(
              event.attempts,
              this.config.retryBaseMs,
              this.config.retryMaxMs,
            );
        await this.repository
          .failOutbox(event, errorMessage(error), dead, backoffMs)
          .catch((persistenceError: unknown) => {
            this.logger.error(
              { err: persistenceError, eventId: event?.id },
              "Unable to persist OpenClaw outbox retry",
            );
          });
        this.logger[dead ? "error" : "warn"](
          { err: error, eventId: event.id, attempt: event.attempts, backoffMs },
          dead
            ? "OpenClaw event moved to dead state"
            : "OpenClaw event scheduled for retry",
        );
      }
    }
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

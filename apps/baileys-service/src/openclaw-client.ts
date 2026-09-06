import type { Logger } from "pino";

import { PermanentJobError, RetryableJobError } from "./errors.js";

export interface OpenClawInboundEvent {
  readonly eventId: string;
  readonly waMessageId: string;
  readonly remoteJid: string;
  readonly participantJid?: string;
  readonly isGroup: boolean;
  readonly text: string;
  readonly messageType?: "text" | "image" | "document";
  readonly media?: Record<string, unknown>;
  readonly quotedMessageId?: string;
  readonly replyToParticipant?: string;
  readonly timestamp: string;
  readonly payload?: Record<string, unknown>;
}

export class OpenClawClient {
  public constructor(
    private readonly baseUrl: URL,
    private readonly internalApiKey: string,
    private readonly logger: Logger,
  ) {}

  public async forward(event: OpenClawInboundEvent): Promise<number> {
    const url = new URL("/internal/openclaw/event", this.baseUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-api-key": this.internalApiKey,
          "idempotency-key": event.eventId,
          "x-request-id": event.eventId,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch (error) {
      throw new RetryableJobError("OpenClaw bridge is unreachable", {
        cause: error,
      });
    }

    await response.body?.cancel().catch(() => undefined);
    if (response.ok || response.status === 409) {
      this.logger.info(
        { eventId: event.eventId, statusCode: response.status },
        "Inbound event forwarded",
      );
      return response.status;
    }
    if ([408, 425, 429].includes(response.status) || response.status >= 500) {
      throw new RetryableJobError(
        `OpenClaw bridge returned HTTP ${response.status}`,
      );
    }
    throw new PermanentJobError(
      `OpenClaw bridge rejected event with HTTP ${response.status}`,
    );
  }
}

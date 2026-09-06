import { hostname } from "node:os";

import type { Logger } from "pino";

import { exponentialBackoff } from "./backoff.js";
import type { ServiceConfig } from "./config.js";
import { PermanentJobError, errorMessage } from "./errors.js";
import type { ClaimedJob, WhatsAppRepository } from "./repository.js";
import type {
  OutboundPayload,
  WhatsAppSocketManager,
} from "./socket-manager.js";

export class DurableQueueWorker {
  private readonly abortController = new AbortController();
  private readonly workerId = `${hostname()}:${process.pid}:baileys`;
  private running: Promise<void> | undefined;

  public constructor(
    private readonly config: ServiceConfig,
    private readonly repository: WhatsAppRepository,
    private readonly socketManager: WhatsAppSocketManager,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    const recovered = await this.repository.recoverStaleJobs(false);
    if (recovered > 0) {
      this.logger.warn(
        { recovered },
        "Recovered WhatsApp jobs with expired worker leases",
      );
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
      let job: ClaimedJob | null = null;
      try {
        job = await this.repository.claimJob(
          this.workerId,
          this.config.staleLeaseSeconds,
          this.socketManager.isConnected(),
        );
        if (!job) {
          await delay(this.config.pollIntervalMs, signal);
          continue;
        }
        await this.withLeaseHeartbeat(job, (claimed) => this.process(claimed));
        await this.repository.completeJob(job, this.workerId);
        this.logger.info(
          { jobId: job.id, queue: job.queueName, type: job.jobType },
          "Durable queue job completed",
        );
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (!job) {
          this.logger.error({ err: error }, "Durable queue polling failed");
          await delay(Math.max(this.config.pollIntervalMs, 2_000), signal);
          continue;
        }
        const permanent = error instanceof PermanentJobError;
        const dead = permanent || job.attempts >= job.maxAttempts;
        const backoffMs = dead
          ? 0
          : exponentialBackoff(
              job.attempts,
              this.config.retryBaseMs,
              this.config.retryMaxMs,
            );
        const safeError = errorMessage(error);
        await this.repository
          .failJob(job, this.workerId, safeError, dead, backoffMs)
          .catch((persistenceError: unknown) => {
            this.logger.error(
              { err: persistenceError, jobId: job?.id },
              "Unable to persist queue retry state",
            );
          });
        if (job.queueName === "whatsapp-outbound") {
          const messageId = safeMessageId(job.payload);
          await this.repository
            .markOutboundAttempt(
              messageId,
              job.id,
              job.attempts,
              dead ? "dead_letter" : "retrying",
              safeError,
            )
            .catch((persistenceError: unknown) => {
              this.logger.error(
                { err: persistenceError, jobId: job?.id },
                "Unable to update outbound delivery status",
              );
            });
        }
        this.logger[dead ? "error" : "warn"](
          {
            jobId: job.id,
            queue: job.queueName,
            type: job.jobType,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
            backoffMs,
            err: error,
          },
          dead
            ? "Durable queue job moved to dead letter state"
            : "Durable queue job scheduled for retry",
        );
        await this.repository
          .operationalLog(
            dead ? "error" : "warn",
            dead ? "queue.job_dead" : "queue.job_retry",
            dead
              ? "WhatsApp queue job moved to dead letter state"
              : "WhatsApp queue job scheduled for retry",
            {
              jobId: job.id,
              queue: job.queueName,
              type: job.jobType,
              attempt: job.attempts,
              backoffMs,
            },
          )
          .catch(() => undefined);
      }
    }
  }

  private async withLeaseHeartbeat<T>(
    job: ClaimedJob,
    operation: (job: ClaimedJob) => Promise<T>,
  ): Promise<T> {
    const interval = setInterval(() => {
      void this.repository
        .extendJobLease(job, this.workerId, this.config.staleLeaseSeconds)
        .then((kept) => {
          if (!kept) this.logger.warn({ jobId: job.id }, "Queue lease heartbeat lost ownership");
        })
        .catch((error: unknown) => {
          this.logger.warn({ err: error, jobId: job.id }, "Queue lease heartbeat failed");
        });
    }, Math.max(1_000, Math.floor((this.config.staleLeaseSeconds * 1_000) / 2)));
    try {
      return await operation(job);
    } finally {
      clearInterval(interval);
    }
  }

  private async process(job: ClaimedJob): Promise<void> {
    if (job.queueName === "whatsapp-control") {
      await this.processControl(job.jobType);
      return;
    }
    if (job.queueName !== "whatsapp-outbound") {
      throw new PermanentJobError(`Unsupported queue: ${job.queueName}`);
    }

    const payload = outboundPayload(job.payload);
    if (await this.repository.outboundAlreadySent(payload.messageId, job.id)) {
      this.logger.info(
        { jobId: job.id, messageId: payload.messageId },
        "Recovered already-sent outbound job",
      );
      return;
    }
    await this.repository.markOutboundAttempt(
      payload.messageId,
      job.id,
      job.attempts,
      "processing",
      null,
    );
    switch (job.jobType) {
      case "send-text":
      case "whatsapp.send.text":
        await this.socketManager.sendText(job.id, job.attempts, payload);
        return;
      case "send-image":
      case "whatsapp.send.image":
        await this.socketManager.sendImage(job.id, job.attempts, payload);
        return;
      case "send-document":
      case "whatsapp.send.document":
        await this.socketManager.sendDocument(job.id, job.attempts, payload);
        return;
      case "send-video":
      case "whatsapp.send.video":
        await this.socketManager.sendVideo(job.id, job.attempts, payload);
        return;
      case "send-audio":
      case "whatsapp.send.audio":
        await this.socketManager.sendAudio(job.id, job.attempts, payload);
        return;
      case "message-reaction":
        await this.socketManager.reactToMessage(job.id, job.attempts, payload);
        return;
      case "message-mark-read":
        await this.socketManager.markMessageRead(payload);
        return;
      case "message-typing":
        await this.socketManager.sendTyping(payload);
        return;
      default:
        throw new PermanentJobError(
          `Unsupported WhatsApp outbound job type: ${job.jobType}`,
        );
    }
  }

  private async processControl(jobType: string): Promise<void> {
    switch (jobType) {
      case "connect":
        await this.socketManager.connectNow();
        return;
      case "disconnect":
        await this.socketManager.disconnect();
        return;
      case "restart":
        await this.socketManager.restart();
        return;
      case "logout":
        await this.socketManager.logout();
        return;
      case "sync-groups":
        await this.socketManager.syncGroups();
        return;
      default:
        throw new PermanentJobError(
          `Unsupported WhatsApp control job type: ${jobType}`,
        );
    }
  }
}

function outboundPayload(payload: Record<string, unknown>): OutboundPayload {
  const record = recordPayload(payload);
  const remoteJid = requiredString(record, "remoteJid");
  const messageId = requiredString(record, "messageId");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      messageId,
    )
  ) {
    throw new PermanentJobError("Queue payload field messageId must be a UUID");
  }
  const text = optionalString(record, "text");
  const filePath = optionalString(record, "filePath");
  const base64 = optionalString(record, "base64");
  const mimeType = optionalString(record, "mimeType");
  const fileName = optionalString(record, "fileName");
  const caption = optionalString(record, "caption");
  const replyTo = optionalString(record, "replyTo");
  const replyToParticipant = optionalString(record, "replyToParticipant");
  const targetMessageId = optionalString(record, "targetMessageId");
  const targetWaMessageId = optionalString(record, "targetWaMessageId");
  const targetParticipantJid = optionalString(record, "targetParticipantJid");
  const emoji = optionalNullableString(record, "emoji");
  const durationSeconds = optionalNumber(record, "durationSeconds");
  const voiceNote = optionalBoolean(record, "voiceNote");
  return {
    remoteJid,
    messageId,
    ...(text ? { text } : {}),
    ...(filePath ? { filePath } : {}),
    ...(base64 ? { base64 } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(replyToParticipant ? { replyToParticipant } : {}),
    ...(targetMessageId ? { targetMessageId } : {}),
    ...(targetWaMessageId ? { targetWaMessageId } : {}),
    ...(targetParticipantJid ? { targetParticipantJid } : {}),
    ...(emoji !== undefined ? { emoji } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(voiceNote !== undefined ? { voiceNote } : {}),
  };
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermanentJobError("Queue payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = optionalString(record, field);
  if (!value) {
    throw new PermanentJobError(`Queue payload field ${field} is required`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PermanentJobError(
      `Queue payload field ${field} must be a string`,
    );
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new PermanentJobError(`Queue payload field ${field} must be boolean`);
  }
  return value;
}

function optionalNullableString(
  record: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new PermanentJobError(
      `Queue payload field ${field} must be a string or null`,
    );
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new PermanentJobError(`Queue payload field ${field} must be number`);
  }
  return value;
}

function safeMessageId(payload: unknown): string | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>).messageId;
  return typeof value === "string" ? value : undefined;
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

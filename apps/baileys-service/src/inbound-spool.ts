import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { decryptEnvelope, encryptEnvelope } from "./crypto-envelope.js";
import type { ParsedInboundMessage } from "./message-parser.js";

const FILE_SUFFIX = ".ocwi";
const AAD_PREFIX = "openclaw-wa-inbound-spool";

interface SerializedInboundMessage extends Omit<
  ParsedInboundMessage,
  "timestamp"
> {
  readonly timestamp: string;
}

/**
 * Workspace-local encrypted write-ahead spool. An inbound event is fsync'd
 * here before PostgreSQL is touched, then removed only after the database
 * transaction (message plus outbox event) commits.
 */
export class EncryptedInboundSpool {
  private readonly directory: string;

  public constructor(
    whatsappDirectory: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.directory = path.join(whatsappDirectory, "inbox");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.recoverTemporaryFiles();
  }

  public async put(message: ParsedInboundMessage): Promise<string> {
    const id = spoolId(message);
    const target = this.filePath(id);
    const temporary = path.join(
      this.directory,
      `.${id}.${process.pid}.${randomUUID()}.tmp`,
    );
    const serialized: SerializedInboundMessage = {
      ...message,
      timestamp: message.timestamp.toISOString(),
    };
    const encrypted = encryptEnvelope(
      Buffer.from(JSON.stringify(serialized), "utf8"),
      this.encryptionKey,
      this.aad(id),
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encrypted);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      await this.syncDirectory();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return id;
  }

  public async list(): Promise<readonly string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isFile() && /^[a-f0-9]{64}\.ocwi$/.test(entry.name),
      )
      .map((entry) => entry.name.slice(0, -FILE_SUFFIX.length))
      .sort();
  }

  public async read(id: string): Promise<ParsedInboundMessage> {
    assertSpoolId(id);
    const envelope = await readFile(this.filePath(id));
    const plaintext = decryptEnvelope(
      envelope,
      this.encryptionKey,
      this.aad(id),
    );
    return parseSerializedInbound(
      JSON.parse(plaintext.toString("utf8")) as unknown,
    );
  }

  public async remove(id: string): Promise<void> {
    assertSpoolId(id);
    await rm(this.filePath(id), { force: true });
    await this.syncDirectory();
  }

  private filePath(id: string): string {
    assertSpoolId(id);
    return path.join(this.directory, `${id}${FILE_SUFFIX}`);
  }

  private aad(id: string): string {
    return `${AAD_PREFIX}\u0000${id}\u0000v1`;
  }

  private async recoverTemporaryFiles(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    let recovered = false;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^\.([a-f0-9]{64})\.[0-9]+\.[0-9a-f-]{36}\.tmp$/.exec(
        entry.name,
      );
      const id = match?.[1];
      if (!id) continue;
      const temporary = path.join(this.directory, entry.name);
      try {
        const envelope = await readFile(temporary);
        const plaintext = decryptEnvelope(
          envelope,
          this.encryptionKey,
          this.aad(id),
        );
        parseSerializedInbound(
          JSON.parse(plaintext.toString("utf8")) as unknown,
        );
        await rename(temporary, this.filePath(id));
        recovered = true;
      } catch {
        // A partial temp file is deliberately retained for operator forensics.
        // It is never treated as a valid durable event without GCM validation.
      }
    }
    if (recovered) await this.syncDirectory();
  }

  private async syncDirectory(): Promise<void> {
    const directoryHandle = await open(this.directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

function spoolId(
  message: Pick<ParsedInboundMessage, "remoteJid" | "waMessageId">,
): string {
  return createHash("sha256")
    .update(message.remoteJid)
    .update("\u0000")
    .update(message.waMessageId)
    .digest("hex");
}

function assertSpoolId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error("Invalid inbound spool identifier");
  }
}

function parseSerializedInbound(value: unknown): ParsedInboundMessage {
  if (!isRecord(value)) {
    throw new Error("Encrypted inbound spool record is not an object");
  }
  const waMessageId = requiredString(value, "waMessageId");
  const remoteJid = requiredString(value, "remoteJid");
  const timestampRaw = requiredString(value, "timestamp");
  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Encrypted inbound spool timestamp is invalid");
  }
  const messageType = value.messageType;
  if (!["text", "image", "document", "unknown"].includes(String(messageType))) {
    throw new Error("Encrypted inbound spool message type is invalid");
  }
  const mentionedJids = stringArray(value.mentionedJids, "mentionedJids");
  const participantJid = nullableString(value, "participantJid");
  const quotedMessageId = nullableString(value, "quotedMessageId");
  const pushName = nullableString(value, "pushName");
  if (
    typeof value.isGroup !== "boolean" ||
    typeof value.agentMentioned !== "boolean" ||
    typeof value.shouldForward !== "boolean"
  ) {
    throw new Error("Encrypted inbound spool routing flags are invalid");
  }
  const media = value.media;
  if (media !== null && !isRecord(media)) {
    throw new Error("Encrypted inbound spool media metadata is invalid");
  }
  return {
    waMessageId,
    remoteJid,
    participantJid,
    isGroup: value.isGroup,
    text: requiredStringAllowEmpty(value, "text"),
    mentionedJids,
    agentMentioned: value.agentMentioned,
    shouldForward: value.shouldForward,
    quotedMessageId,
    timestamp,
    messageType: messageType as ParsedInboundMessage["messageType"],
    media,
    pushName,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredStringAllowEmpty(record, field);
  if (value === "")
    throw new Error(`Encrypted inbound spool ${field} is empty`);
  return value;
}

function requiredStringAllowEmpty(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string")
    throw new Error(`Encrypted inbound spool ${field} is invalid`);
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error(`Encrypted inbound spool ${field} is invalid`);
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Encrypted inbound spool ${field} is invalid`);
  }
  return value as string[];
}

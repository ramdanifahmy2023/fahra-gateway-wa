import {
  areJidsSameUser,
  isJidGroup,
  type WAMessage,
  type proto,
} from "@whiskeysockets/baileys";

export interface ParsedInboundMessage {
  readonly waMessageId: string;
  readonly remoteJid: string;
  readonly participantJid: string | null;
  readonly isGroup: boolean;
  readonly text: string;
  readonly mentionedJids: readonly string[];
  readonly agentMentioned: boolean;
  readonly shouldForward: boolean;
  readonly quotedMessageId: string | null;
  readonly timestamp: Date;
  readonly messageType: "text" | "image" | "document" | "unknown";
  readonly media: Record<string, unknown> | null;
  readonly pushName: string | null;
}

export function parseInboundMessage(
  message: WAMessage,
  ownJid: string | readonly string[] | undefined,
): ParsedInboundMessage | null {
  if (message.key.fromMe || !message.key.id || !message.message) {
    return null;
  }
  // Inspect the primary address before PN/LID canonicalization. System feeds
  // can carry an alternate PN and must never be reclassified as a direct chat.
  if (isSystemAddress(message.key.remoteJid)) {
    return null;
  }
  const remoteJid = preferredRoutingJid(
    message.key.remoteJid,
    message.key.remoteJidAlt,
  );
  if (!remoteJid) {
    return null;
  }
  if (isSystemAddress(remoteJid)) {
    return null;
  }

  const content = unwrapContent(message.message);
  if (!content) {
    return null;
  }
  const extracted = extractContent(content);
  if (!extracted) {
    return null;
  }

  const group = Boolean(isJidGroup(remoteJid));
  const mentionedJids =
    extracted.contextInfo?.mentionedJid?.filter((jid): jid is string =>
      Boolean(jid),
    ) ?? [];
  const ownJids = typeof ownJid === "string" ? [ownJid] : (ownJid ?? []);
  const agentMentioned =
    group &&
    mentionedJids.some((mentioned) =>
      ownJids.some((own) => areJidsSameUser(mentioned, own)),
    );
  const captionlessMedia =
    group &&
    (extracted.type === "image" || extracted.type === "document") &&
    extracted.text.trim() === "";

  return {
    waMessageId: message.key.id,
    remoteJid,
    participantJid: preferredParticipantJid(
      message.key.participant,
      message.key.participantAlt,
    ),
    isGroup: group,
    text: extracted.text,
    mentionedJids,
    agentMentioned,
    // Direct captionless media still reaches HRD; the bridge converts it into a
    // short media prompt. Group captionless media stays audit-only unless needed later.
    shouldForward: (!group || agentMentioned) && !captionlessMedia,
    quotedMessageId: extracted.contextInfo?.stanzaId ?? null,
    timestamp: messageTimestamp(message.messageTimestamp),
    messageType: extracted.type,
    media: extracted.media,
    pushName: message.pushName ?? null,
  };
}

function isSystemAddress(jid: string | null | undefined): boolean {
  return Boolean(
    jid && (jid.endsWith("@broadcast") || jid.endsWith("@newsletter")),
  );
}

/**
 * Baileys v7 can address a direct chat by its LID and provide the phone-number
 * JID as an alternate. Prefer the stable PN identity when it is available so
 * database dedupe/routing stays compatible across PN/LID addressing modes.
 * Group JIDs must never be replaced by a participant alternate.
 */
function preferredRoutingJid(
  primary: string | null | undefined,
  alternate: string | undefined,
): string | null {
  if (primary?.endsWith("@g.us")) {
    return primary;
  }
  if (primary?.endsWith("@s.whatsapp.net")) {
    return primary;
  }
  if (alternate?.endsWith("@s.whatsapp.net")) {
    return alternate;
  }
  return primary ?? alternate ?? null;
}

function preferredParticipantJid(
  primary: string | null | undefined,
  alternate: string | undefined,
): string | null {
  if (primary?.endsWith("@s.whatsapp.net")) {
    return primary;
  }
  if (alternate?.endsWith("@s.whatsapp.net")) {
    return alternate;
  }
  return primary ?? alternate ?? null;
}

function unwrapContent(message: proto.IMessage): proto.IMessage | null {
  if (message.ephemeralMessage?.message) {
    return unwrapContent(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapContent(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapContent(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapContent(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapContent(message.documentWithCaptionMessage.message);
  }
  return message;
}

interface ExtractedContent {
  readonly text: string;
  readonly type: ParsedInboundMessage["messageType"];
  readonly contextInfo?: proto.IContextInfo | null | undefined;
  readonly media: Record<string, unknown> | null;
}

function extractContent(content: proto.IMessage): ExtractedContent | null {
  if (content.conversation !== null && content.conversation !== undefined) {
    return { text: content.conversation, type: "text", media: null };
  }
  if (content.extendedTextMessage) {
    return {
      text: content.extendedTextMessage.text ?? "",
      type: "text",
      contextInfo: content.extendedTextMessage.contextInfo,
      media: null,
    };
  }
  if (content.imageMessage) {
    return {
      text: content.imageMessage.caption ?? "",
      type: "image",
      contextInfo: content.imageMessage.contextInfo,
      media: compactObject({
        mimetype: content.imageMessage.mimetype,
        fileLength: longToNumber(content.imageMessage.fileLength),
        width: content.imageMessage.width,
        height: content.imageMessage.height,
      }),
    };
  }
  if (content.documentMessage) {
    return {
      text: content.documentMessage.caption ?? "",
      type: "document",
      contextInfo: content.documentMessage.contextInfo,
      media: compactObject({
        mimetype: content.documentMessage.mimetype,
        fileName: content.documentMessage.fileName,
        fileLength: longToNumber(content.documentMessage.fileLength),
      }),
    };
  }
  if (content.buttonsResponseMessage) {
    return {
      text:
        content.buttonsResponseMessage.selectedDisplayText ??
        content.buttonsResponseMessage.selectedButtonId ??
        "",
      type: "text",
      contextInfo: content.buttonsResponseMessage.contextInfo,
      media: null,
    };
  }
  if (content.listResponseMessage) {
    return {
      text:
        content.listResponseMessage.title ??
        content.listResponseMessage.singleSelectReply?.selectedRowId ??
        "",
      type: "text",
      contextInfo: content.listResponseMessage.contextInfo,
      media: null,
    };
  }
  return null;
}

function messageTimestamp(timestamp: WAMessage["messageTimestamp"]): Date {
  const seconds = longToNumber(timestamp);
  if (!seconds || !Number.isFinite(seconds)) {
    return new Date();
  }
  return new Date(seconds * 1_000);
}

function longToNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const converter = (value as { toNumber?: unknown }).toNumber;
    if (typeof converter === "function") {
      return Number(converter.call(value));
    }
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return undefined;
}

function compactObject(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

import { describe, expect, it } from "vitest";
import {
  aggregateReceiptTotals,
  assertContactOutboundAllowed,
  normalizeJid,
  normalizeReactionEmoji,
  outboundQueueType,
  parseOutboundMessage,
  parseTypingDuration,
  requireIdempotencyKey,
  safeQueueFailureReason,
  validateOutboundMediaType,
} from "../src/modules/messages.js";
describe("WhatsApp JID normalization", () => {
  it("keeps valid group, PN, and LID JIDs", () => {
    expect(normalizeJid("120363000000@g.us")).toBe("120363000000@g.us");
    expect(normalizeJid("628123456789@s.whatsapp.net")).toBe(
      "628123456789@s.whatsapp.net",
    );
    expect(normalizeJid("123456789@lid")).toBe("123456789@lid");
  });
  it("converts E.164-like numbers", () =>
    expect(normalizeJid("+62 812-3456-789")).toBe(
      "628123456789@s.whatsapp.net",
    ));
  it("rejects invalid or unknown JIDs", () => {
    expect(() => normalizeJid("abc")).toThrow();
    expect(() => normalizeJid("123@newsletter")).toThrow();
    expect(() => normalizeJid("name628123456789")).toThrow();
  });
});

describe("Inbox Phase 2 action validation", () => {
  it("treats blank reactions as removal", () => {
    expect(normalizeReactionEmoji(" 👍 ")).toBe("👍");
    expect(normalizeReactionEmoji("   ")).toBeNull();
    expect(normalizeReactionEmoji(null)).toBeNull();
    expect(() => normalizeReactionEmoji("x".repeat(33))).toThrow();
    expect(() => normalizeReactionEmoji("bukan emoji")).toThrow();
    expect(() => normalizeReactionEmoji("👍halo")).toThrow();
    expect(normalizeReactionEmoji("🇮🇩")).toBe("🇮🇩");
    expect(normalizeReactionEmoji("1️⃣")).toBe("1️⃣");
  });

  it("bounds typing duration to 1-15 seconds", () => {
    expect(parseTypingDuration({ durationSeconds: "15" })).toBe(15);
    expect(() => parseTypingDuration({ durationSeconds: 0 })).toThrow();
    expect(() => parseTypingDuration({ durationSeconds: 16 })).toThrow();
  });
});

describe("Inbox Phase 2 safe observability", () => {
  it("aggregates receipt rows and folds dead_letter into dead", () => {
    expect(
      aggregateReceiptTotals([
        { status: "sent", count: 2 },
        { status: "read", count: "3" },
        { status: "dead_letter", count: 1 },
        { status: "unknown", count: 99 },
      ]),
    ).toMatchObject({ sent: 2, read: 3, dead: 1, failed: 0 });
  });

  it("maps raw worker errors to bounded safe reasons", () => {
    expect(safeQueueFailureReason("The operation was aborted.")).toMatch(
      /batas waktu/i,
    );
    expect(safeQueueFailureReason("/private/customer/path missing")).toMatch(
      /Media/i,
    );
    expect(safeQueueFailureReason("secret raw error")).not.toContain("secret");
  });
});
describe("Outbound idempotency", () => {
  it("requires a stable valid header", () => {
    expect(
      requireIdempotencyKey({
        headers: { "idempotency-key": "openclaw:event-123" },
      } as never),
    ).toBe("openclaw:event-123");
    expect(() => requireIdempotencyKey({ headers: {} } as never)).toThrow();
    expect(() =>
      requireIdempotencyKey({
        headers: { "idempotency-key": "short" },
      } as never),
    ).toThrow();
  });
});

describe("CRM do-not-contact outbound gate", () => {
  it("blocks DNC contacts and allows unknown/non-DNC contacts", async () => {
    const blocked = {
      query: async () => ({ rows: [{ do_not_contact: true }] }),
    };
    const allowed = {
      query: async () => ({ rows: [{ do_not_contact: false }] }),
    };
    const unknown = { query: async () => ({ rows: [] }) };
    await expect(assertContactOutboundAllowed(blocked, "6281@s.whatsapp.net")).rejects.toMatchObject({
      code: "CONTACT_DO_NOT_CONTACT",
    });
    await expect(assertContactOutboundAllowed(allowed, "6281@s.whatsapp.net")).resolves.toBeUndefined();
    await expect(assertContactOutboundAllowed(unknown, "6281@s.whatsapp.net")).resolves.toBeUndefined();
  });
});

describe("Outbound media schema", () => {
  const uploadId = "123e4567-e89b-42d3-a456-426614174000";

  it("accepts video and audio/voice-note payloads", () => {
    expect(
      parseOutboundMessage({
        to: "628123456789",
        type: "video",
        uploadId,
        caption: "Demo",
      }).type,
    ).toBe("video");
    expect(
      parseOutboundMessage({
        to: "628123456789",
        type: "audio",
        uploadId,
        voiceNote: true,
      }),
    ).toMatchObject({ type: "audio", voiceNote: true });
  });

  it("rejects voiceNote on non-audio and caption on audio", () => {
    expect(() =>
      parseOutboundMessage({
        to: "628123456789",
        type: "video",
        uploadId,
        voiceNote: true,
      }),
    ).toThrow();
    expect(() =>
      parseOutboundMessage({
        to: "628123456789",
        type: "audio",
        uploadId,
        caption: "unsupported",
      }),
    ).toThrow();
  });

  it("maps every supported type to a deterministic queue job", () => {
    expect(outboundQueueType("video")).toBe("send-video");
    expect(outboundQueueType("audio")).toBe("send-audio");
  });

  it("rejects mismatched media and requires OGG for voice notes", () => {
    const video = parseOutboundMessage({
      to: "628123456789",
      type: "video",
      uploadId,
    });
    expect(() => validateOutboundMediaType(video, "video/mp4")).not.toThrow();
    expect(() => validateOutboundMediaType(video, "image/png")).toThrow(
      /MP4/,
    );

    const voice = parseOutboundMessage({
      to: "628123456789",
      type: "audio",
      uploadId,
      voiceNote: true,
    });
    expect(() => validateOutboundMediaType(voice, "audio/ogg")).not.toThrow();
    expect(() => validateOutboundMediaType(voice, "audio/mpeg")).toThrow(
      /OGG Opus/,
    );
  });
});

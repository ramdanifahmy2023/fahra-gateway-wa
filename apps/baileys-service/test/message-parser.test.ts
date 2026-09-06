import assert from "node:assert/strict";
import test from "node:test";

import type { WAMessage } from "@whiskeysockets/baileys";

import { parseInboundMessage } from "../src/message-parser.js";

function message(remoteJid: string, mentionedJid?: string): WAMessage {
  return {
    key: {
      id: "ABC123",
      fromMe: false,
      remoteJid,
      ...(remoteJid.endsWith("@g.us")
        ? { participant: "628111111111@s.whatsapp.net" }
        : {}),
    },
    messageTimestamp: 1_700_000_000,
    pushName: "Pengirim",
    message: {
      extendedTextMessage: {
        text: mentionedJid ? "@agent tolong proses" : "tolong proses",
        contextInfo: mentionedJid ? { mentionedJid: [mentionedJid] } : {},
      },
    },
  };
}

void test("group inbound is accepted only for an exact agent mention", () => {
  const ownJid = "628123456789@s.whatsapp.net";
  const noMention = parseInboundMessage(message("120363000000@g.us"), ownJid);
  assert.equal(noMention?.shouldForward, false);
  assert.equal(noMention?.agentMentioned, false);
  const wrongMention = parseInboundMessage(
    message("120363000000@g.us", "628999999999@s.whatsapp.net"),
    ownJid,
  );
  assert.equal(wrongMention?.shouldForward, false);
  assert.equal(wrongMention?.agentMentioned, false);
  const parsed = parseInboundMessage(
    message("120363000000@g.us", "628123456789:4@s.whatsapp.net"),
    ownJid,
  );
  assert.equal(parsed?.isGroup, true);
  assert.equal(parsed?.text, "@agent tolong proses");
  assert.equal(parsed?.agentMentioned, true);
  assert.equal(parsed?.shouldForward, true);
});

void test("direct messages remain routable without mention metadata", () => {
  const parsed = parseInboundMessage(
    message("628111111111@s.whatsapp.net"),
    "628123456789@s.whatsapp.net",
  );
  assert.equal(parsed?.isGroup, false);
  assert.equal(parsed?.waMessageId, "ABC123");
  assert.equal(parsed?.shouldForward, true);
});

void test("history/fromMe messages cannot enter the inbound route", () => {
  const candidate = message("628111111111@s.whatsapp.net");
  candidate.key.fromMe = true;
  assert.equal(
    parseInboundMessage(candidate, "628123456789@s.whatsapp.net"),
    null,
  );
});

void test("Baileys LID addressing prefers PN alternates without changing group routing", () => {
  const direct = message("100000000000000@lid");
  direct.key.remoteJidAlt = "628111111111@s.whatsapp.net";
  const parsedDirect = parseInboundMessage(
    direct,
    "628123456789@s.whatsapp.net",
  );
  assert.equal(parsedDirect?.remoteJid, "628111111111@s.whatsapp.net");

  const group = message("120363000000@g.us", "628123456789@s.whatsapp.net");
  group.key.remoteJidAlt = "628111111111@s.whatsapp.net";
  group.key.participant = "100000000000001@lid";
  group.key.participantAlt = "628222222222@s.whatsapp.net";
  const parsedGroup = parseInboundMessage(group, "628123456789@s.whatsapp.net");
  assert.equal(parsedGroup?.remoteJid, "120363000000@g.us");
  assert.equal(parsedGroup?.participantJid, "628222222222@s.whatsapp.net");
});

void test("system feeds cannot be converted into a DM through a PN alternate", () => {
  const status = message("status@broadcast");
  status.key.remoteJidAlt = "628111111111@s.whatsapp.net";
  assert.equal(
    parseInboundMessage(status, "628123456789@s.whatsapp.net"),
    null,
  );

  const broadcast = message("12345@broadcast");
  broadcast.key.remoteJidAlt = "628111111111@s.whatsapp.net";
  assert.equal(
    parseInboundMessage(broadcast, "628123456789@s.whatsapp.net"),
    null,
  );
});

void test("captioned media is forwarded with metadata; direct captionless media is forwarded", () => {
  const captioned = message("628111111111@s.whatsapp.net");
  captioned.message = {
    imageMessage: {
      caption: "bukti pembayaran",
      mimetype: "image/jpeg",
      width: 800,
      height: 600,
    },
  };
  const parsedCaptioned = parseInboundMessage(
    captioned,
    "628123456789@s.whatsapp.net",
  );
  assert.equal(parsedCaptioned?.messageType, "image");
  assert.equal(parsedCaptioned?.shouldForward, true);
  assert.deepEqual(parsedCaptioned?.media, {
    mimetype: "image/jpeg",
    width: 800,
    height: 600,
  });

  const captionless = message("628111111111@s.whatsapp.net");
  captionless.message = {
    documentMessage: {
      fileName: "resume.pdf",
      mimetype: "application/pdf",
    },
  };
  const parsedCaptionless = parseInboundMessage(
    captionless,
    "628123456789@s.whatsapp.net",
  );
  assert.equal(parsedCaptionless?.messageType, "document");
  assert.equal(parsedCaptionless?.text, "");
  assert.equal(parsedCaptionless?.shouldForward, true);
  assert.deepEqual(parsedCaptionless?.media, {
    mimetype: "application/pdf",
    fileName: "resume.pdf",
  });
});

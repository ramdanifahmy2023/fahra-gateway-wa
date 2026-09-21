import assert from "node:assert/strict";
import test from "node:test";

import {
  audioMessageContent,
  outboundSendOptions,
  shouldCheckpointAuthOnDisconnect,
  shouldSyncHistoryMessage,
  videoMessageContent,
} from "../src/socket-manager.js";
import { DisconnectReason, proto } from "@whiskeysockets/baileys";

void test("quoted reply options preserve direct and group message identity", () => {
  const direct = outboundSendOptions(
    "628111111111@s.whatsapp.net",
    "job-1",
    "INBOUND-1",
  );
  assert.deepEqual(direct.quoted?.key, {
    remoteJid: "628111111111@s.whatsapp.net",
    id: "INBOUND-1",
    fromMe: false,
  });
  assert.deepEqual(direct.quoted?.message, { conversation: "" });

  const group = outboundSendOptions(
    "120363000000@g.us",
    "job-2",
    "INBOUND-2",
    "628222222222@s.whatsapp.net",
  );
  assert.equal(group.quoted?.key.participant, "628222222222@s.whatsapp.net");
  assert.equal(outboundSendOptions("628111111111@s.whatsapp.net", "job-3").quoted, undefined);
});

void test("video and audio builders enforce safe MIME and voice-note rules", () => {
  const bytes = Buffer.from("OggS----OpusHead----", "ascii");
  assert.deepEqual(videoMessageContent({ bytes, mimeType: "video/mp4", caption: "demo" }), {
    video: bytes,
    mimetype: "video/mp4",
    caption: "demo",
  });
  assert.deepEqual(audioMessageContent({ bytes, mimeType: "audio/ogg" }, true), {
    audio: bytes,
    mimetype: "audio/ogg; codecs=opus",
    ptt: true,
  });
  assert.deepEqual(audioMessageContent({ bytes, mimeType: "audio/mpeg" }, false), {
    audio: bytes,
    mimetype: "audio/mpeg",
    ptt: false,
  });
  assert.throws(
    () => audioMessageContent({ bytes, mimeType: "audio/mpeg" }, true),
    /OGG Opus/,
  );
});

void test("pairing restart checkpoints auth and keeps required LID history sync", () => {
  assert.equal(
    shouldCheckpointAuthOnDisconnect(DisconnectReason.restartRequired),
    true,
  );
  assert.equal(
    shouldCheckpointAuthOnDisconnect(DisconnectReason.loggedOut),
    false,
  );
  assert.equal(
    shouldSyncHistoryMessage({
      syncType: proto.Message.HistorySyncType.FULL,
    }),
    false,
  );
  assert.equal(
    shouldSyncHistoryMessage({
      syncType: proto.Message.HistorySyncType.RECENT,
    }),
    true,
  );
});

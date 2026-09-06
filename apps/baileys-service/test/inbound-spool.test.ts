import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EncryptedInboundSpool } from "../src/inbound-spool.js";
import type { ParsedInboundMessage } from "../src/message-parser.js";

void test("inbound spool encrypts, recovers, and removes a durable event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ocgw-spool-"));
  try {
    const spool = new EncryptedInboundSpool(directory, Buffer.alloc(32, 7));
    const message: ParsedInboundMessage = {
      waMessageId: "ABC123",
      remoteJid: "628111111111@s.whatsapp.net",
      participantJid: null,
      isGroup: false,
      text: "pesan rahasia",
      mentionedJids: [],
      agentMentioned: false,
      shouldForward: true,
      quotedMessageId: null,
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      messageType: "text",
      media: null,
      pushName: "Pengirim",
    };
    await spool.initialize();
    const id = await spool.put(message);
    const raw = await readFile(path.join(directory, "inbox", `${id}.ocwi`));
    assert.equal(raw.includes(Buffer.from(message.text)), false);
    assert.deepEqual(await spool.list(), [id]);
    assert.deepEqual(await spool.read(id), message);
    await spool.remove(id);
    assert.deepEqual(await spool.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("inbound spool recovers a fully fsynced pre-rename temp envelope", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ocgw-spool-temp-"));
  try {
    const key = Buffer.alloc(32, 9);
    const spool = new EncryptedInboundSpool(directory, key);
    const message: ParsedInboundMessage = {
      waMessageId: "TEMP123",
      remoteJid: "628333333333@s.whatsapp.net",
      participantJid: null,
      isGroup: false,
      text: "recover me",
      mentionedJids: [],
      agentMentioned: false,
      shouldForward: true,
      quotedMessageId: null,
      timestamp: new Date("2026-08-09T01:00:00.000Z"),
      messageType: "text",
      media: null,
      pushName: null,
    };
    await spool.initialize();
    const id = await spool.put(message);
    const inbox = path.join(directory, "inbox");
    const temporary = path.join(
      inbox,
      `.${id}.${process.pid}.123e4567-e89b-42d3-a456-426614174000.tmp`,
    );
    await rename(path.join(inbox, `${id}.ocwi`), temporary);

    const recovered = new EncryptedInboundSpool(directory, key);
    await recovered.initialize();
    assert.deepEqual(await recovered.list(), [id]);
    assert.deepEqual(await recovered.read(id), message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

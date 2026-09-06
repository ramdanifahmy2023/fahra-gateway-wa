import { createHash } from "node:crypto";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  STORIES_JID,
  areJidsSameUser,
  jidNormalizedUser,
  type BaileysEventMap,
  type GroupMetadata,
  type WAMessageKey,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import { exponentialBackoff } from "./backoff.js";
import type { ServiceConfig } from "./config.js";
import type {
  EncryptedBaileysAuthEpoch,
  EncryptedBaileysAuthState,
} from "./encrypted-auth-state.js";
import {
  PermanentJobError,
  RetryableJobError,
  errorMessage,
} from "./errors.js";
import { EncryptedInboundSpool } from "./inbound-spool.js";
import {
  MediaLoader,
  type LoadedMedia,
  type MediaReference,
} from "./media-loader.js";
import {
  parseInboundMessage,
  type ParsedInboundMessage,
} from "./message-parser.js";
import { EphemeralQrStore } from "./qr-store.js";
import type { GroupSnapshot, WhatsAppRepository } from "./repository.js";
import type { StatusStore } from "./status-store.js";

export interface OutboundPayload {
  readonly messageId: string;
  readonly remoteJid: string;
  readonly text?: string;
  readonly filePath?: string;
  readonly base64?: string;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly caption?: string;
  readonly replyTo?: string;
  readonly replyToParticipant?: string;
  readonly voiceNote?: boolean;
  readonly targetMessageId?: string;
  readonly targetWaMessageId?: string;
  readonly targetParticipantJid?: string;
  readonly emoji?: string | null;
  readonly durationSeconds?: number;
}

export interface OutboundResult {
  readonly databaseMessageId: string;
  readonly waMessageId: string;
  readonly remoteJid: string;
}

export interface TextStatusResult {
  readonly waMessageId: string;
  readonly remoteJid: typeof STORIES_JID;
  readonly audienceCount: number;
}

export class WhatsAppSocketManager {
  private socket: WASocket | undefined;
  private authEpoch: EncryptedBaileysAuthEpoch | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectPromise: Promise<void> | undefined;
  private closeTransition: Promise<void> | undefined;
  private desiredConnected = true;
  private stopped = false;
  private connected = false;
  private readonly pendingHandlers = new Set<Promise<void>>();
  private inboundDrainPromise: Promise<number> | undefined;
  private readonly mediaLoader: MediaLoader;
  private readonly qrStore: EphemeralQrStore;
  private readonly inboundSpool: EncryptedInboundSpool;

  public constructor(
    private readonly config: ServiceConfig,
    private readonly auth: EncryptedBaileysAuthState,
    private readonly repository: WhatsAppRepository,
    private readonly statusStore: StatusStore,
    private readonly logger: Logger,
  ) {
    this.mediaLoader = new MediaLoader(config.uploadsDir, config.maxMediaBytes);
    this.qrStore = new EphemeralQrStore(
      config.whatsappDir,
      config.qrTtlMs,
      statusStore,
    );
    this.inboundSpool = new EncryptedInboundSpool(
      config.whatsappDir,
      config.sessionEncryptionKey,
    );
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public accountJid(): string | undefined {
    return this.socket?.user?.id;
  }

  public async statusReadiness(): Promise<{
    readonly connected: true;
    readonly audienceCount: number;
  }> {
    this.requireConnectedSocket();
    const audience = await this.statusAudience();
    return { connected: true, audienceCount: audience.length };
  }

  public async postTextStatus(
    text: string,
    backgroundColor = "#25D366",
    font = 1,
  ): Promise<TextStatusResult> {
    const socket = this.requireConnectedSocket();
    const audience = await this.statusAudience();
    const sent = await socket.sendMessage(
      STORIES_JID,
      { text },
      {
        statusJidList: audience,
        broadcast: true,
        backgroundColor,
        font,
      },
    );
    const waMessageId = sent?.key.id;
    if (!waMessageId || sent.key.remoteJid !== STORIES_JID || !sent.key.fromMe) {
      throw new Error("Baileys did not return a valid status message identity");
    }
    this.logger.info(
      { waMessageId, audienceCount: audience.length },
      "WhatsApp text status accepted by Baileys",
    );
    return {
      waMessageId,
      remoteJid: STORIES_JID,
      audienceCount: audience.length,
    };
  }

  public async postImageStatus(
    reference: MediaReference,
  ): Promise<TextStatusResult> {
    const socket = this.requireConnectedSocket();
    const audience = await this.statusAudience();
    const media = await this.mediaLoader.load(reference);
    if (media.mimeType && !["image/jpeg", "image/png", "image/webp"].includes(media.mimeType)) {
      throw new PermanentJobError("Status image mimeType is not supported");
    }
    const sent = await socket.sendMessage(
      STORIES_JID,
      {
        image: media.bytes,
        ...(media.caption ? { caption: media.caption } : {}),
        ...(media.mimeType ? { mimetype: media.mimeType } : {}),
      },
      { statusJidList: audience, broadcast: true },
    );
    const waMessageId = sent?.key.id;
    if (!waMessageId || sent.key.remoteJid !== STORIES_JID || !sent.key.fromMe) {
      throw new Error("Baileys did not return a valid image status identity");
    }
    this.logger.info(
      { waMessageId, audienceCount: audience.length },
      "WhatsApp image status accepted by Baileys",
    );
    return {
      waMessageId,
      remoteJid: STORIES_JID,
      audienceCount: audience.length,
    };
  }

  public async postVideoStatus(
    reference: MediaReference,
  ): Promise<TextStatusResult> {
    const socket = this.requireConnectedSocket();
    const audience = await this.statusAudience();
    const media = await this.mediaLoader.load(reference);
    if (media.mimeType !== "video/mp4") {
      throw new PermanentJobError("Status video mimeType is not supported");
    }
    const sent = await socket.sendMessage(
      STORIES_JID,
      {
        video: media.bytes,
        mimetype: media.mimeType,
        ...(media.caption ? { caption: media.caption } : {}),
      },
      { statusJidList: audience, broadcast: true },
    );
    const waMessageId = sent?.key.id;
    if (!waMessageId || sent.key.remoteJid !== STORIES_JID || !sent.key.fromMe) {
      throw new Error("Baileys did not return a valid video status identity");
    }
    this.logger.info(
      { waMessageId, audienceCount: audience.length },
      "WhatsApp video status accepted by Baileys",
    );
    return {
      waMessageId,
      remoteJid: STORIES_JID,
      audienceCount: audience.length,
    };
  }

  private async statusAudience(): Promise<string[]> {
    const ownJid = this.accountJid();
    const audience = (await this.repository.listStatusAudienceJids()).filter(
      (jid) => !ownJid || !areJidsSameUser(jid, ownJid),
    );
    if (audience.length === 0) {
      throw new PermanentJobError(
        "WhatsApp status audience is empty; refusing recipient-less send",
      );
    }
    return audience;
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.desiredConnected = true;
    await this.inboundSpool.initialize();
    await this.recoverInboundSpool();
    await this.connectNow();
  }

  public async connectNow(): Promise<void> {
    await this.closeTransition;
    if (this.stopped) {
      throw new PermanentJobError("Baileys service is stopping");
    }
    this.desiredConnected = true;
    if (this.connected || this.socket || this.connectPromise) {
      return this.connectPromise;
    }
    this.clearReconnectTimer();
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  public async disconnect(): Promise<void> {
    const pendingConnection = this.connectPromise;
    const active = this.socket;
    const activeAuthEpoch = this.authEpoch;
    this.desiredConnected = false;
    this.connected = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.socket = undefined;
    this.authEpoch = undefined;
    this.auth.invalidate(activeAuthEpoch);
    void active?.end(new Error("Workspace operator requested disconnect"));
    await pendingConnection?.catch(() => undefined);
    await this.awaitPendingHandlers();
    await this.safeQrClear();
    await this.safeStatusPatch({
      state: "disconnected",
      connected: false,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: null,
    });
    await this.safeConnectionUpdate("disconnected", { reconnectAttempt: 0 });
    await this.safeConnectionEvent("close", "operator_disconnect", 0);
    await this.safeOperationalLog(
      "info",
      "whatsapp.disconnected",
      "WhatsApp disconnected by operator",
    );
  }

  public async restart(): Promise<void> {
    const pendingConnection = this.connectPromise;
    const active = this.socket;
    const activeAuthEpoch = this.authEpoch;
    this.desiredConnected = false;
    this.connected = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.socket = undefined;
    this.authEpoch = undefined;
    this.auth.invalidate(activeAuthEpoch);
    void active?.end(new Error("Workspace operator requested restart"));
    await pendingConnection?.catch(() => undefined);
    await this.awaitPendingHandlers();
    this.desiredConnected = true;
    await this.connectNow();
  }

  public async logout(): Promise<void> {
    const pendingConnection = this.connectPromise;
    this.desiredConnected = false;
    this.clearReconnectTimer();
    const active = this.socket;
    const activeAuthEpoch = this.authEpoch;
    this.socket = undefined;
    this.authEpoch = undefined;
    this.connected = false;
    this.generation += 1;
    this.auth.invalidate(activeAuthEpoch);
    if (active) {
      await active.logout().catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          "WhatsApp logout request failed; clearing local encrypted session",
        );
      });
      void active.end(new Error("Workspace operator requested logout"));
    }
    await pendingConnection?.catch(() => undefined);
    await this.awaitPendingHandlers();
    await this.auth.clear();
    await this.safeQrClear();
    await this.safeStatusPatch({
      state: "logged_out",
      connected: false,
      accountJid: null,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: null,
    });
    await this.safeConnectionUpdate("logged_out", { reconnectAttempt: 0 });
    await this.safeConnectionEvent("logged_out", "operator_logout", 0);
    await this.safeOperationalLog(
      "info",
      "whatsapp.logged_out",
      "WhatsApp encrypted session cleared by operator",
    );
    this.desiredConnected = true;
    this.scheduleReconnect(1_000);
  }

  public async syncGroups(): Promise<number> {
    const socket = this.requireConnectedSocket();
    const ownJid = socket.user?.id;
    if (!ownJid) {
      throw new RetryableJobError("WhatsApp account identity is not available");
    }
    let groups: Record<string, GroupMetadata>;
    try {
      groups = await socket.groupFetchAllParticipating();
    } catch (error) {
      throw new RetryableJobError("Unable to synchronize WhatsApp groups", {
        cause: error,
      });
    }
    const ownJids = ownIdentityJids(socket);
    const snapshots: GroupSnapshot[] = Object.values(groups).map((group) => ({
      jid: group.id,
      name: group.subject || group.id,
      ownerJid: group.owner ?? null,
      participantCount: group.participants.length,
      agentIsParticipant: group.participants.some((participant) =>
        ownJids.some((candidate) => areJidsSameUser(participant.id, candidate)),
      ),
      metadata: compactObject({
        description: group.desc,
        creation: group.creation,
        announce: group.announce,
        restrict: group.restrict,
        ephemeralDuration: group.ephemeralDuration,
      }),
    }));
    await this.repository.upsertGroups(snapshots);
    await this.safeOperationalLog(
      "info",
      "whatsapp.groups_synced",
      "WhatsApp groups synchronized",
      {
        count: snapshots.length,
      },
    );
    return snapshots.length;
  }

  public async sendText(
    jobId: string,
    attempts: number,
    payload: OutboundPayload,
  ): Promise<OutboundResult> {
    if (
      typeof payload.text !== "string" ||
      payload.text.trim() === "" ||
      payload.text.length > 65_536
    ) {
      throw new PermanentJobError(
        "Text message must contain 1 to 65536 characters",
      );
    }
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const socket = this.requireConnectedSocket();
    const sent = await this.sendWithSocket(
      socket,
      remoteJid,
      { text: payload.text },
      outboundSendOptions(remoteJid, jobId, payload.replyTo, payload.replyToParticipant),
    );
    const waMessageId = requireSentMessageId(sent);
    const databaseMessageId = await this.repository.markOutboundSent(
      payload.messageId,
      jobId,
      attempts,
      remoteJid,
      waMessageId,
      "text",
      payload.text,
      {},
      sent.message,
    );
    await this.safeStatusPatch({ lastOutboundAt: new Date().toISOString() });
    return { databaseMessageId, waMessageId, remoteJid };
  }

  public async sendImage(
    jobId: string,
    attempts: number,
    payload: OutboundPayload,
  ): Promise<OutboundResult> {
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const media = await this.mediaLoader.load(mediaReference(payload));
    if (media.mimeType && !media.mimeType.toLowerCase().startsWith("image/")) {
      throw new PermanentJobError("Image message requires an image mimeType");
    }
    const socket = this.requireConnectedSocket();
    const content = {
      image: media.bytes,
      ...(media.caption ? { caption: media.caption } : {}),
      ...(media.mimeType ? { mimetype: media.mimeType } : {}),
    };
    const sent = await this.sendWithSocket(
      socket,
      remoteJid,
      content,
      outboundSendOptions(remoteJid, jobId, payload.replyTo, payload.replyToParticipant),
    );
    const waMessageId = requireSentMessageId(sent);
    const databaseMessageId = await this.repository.markOutboundSent(
      payload.messageId,
      jobId,
      attempts,
      remoteJid,
      waMessageId,
      "image",
      media.caption ?? null,
      compactObject({ mimeType: media.mimeType, fileName: media.fileName }),
      sent.message,
    );
    await this.safeStatusPatch({ lastOutboundAt: new Date().toISOString() });
    return { databaseMessageId, waMessageId, remoteJid };
  }

  public async sendDocument(
    jobId: string,
    attempts: number,
    payload: OutboundPayload,
  ): Promise<OutboundResult> {
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const media = await this.mediaLoader.load(mediaReference(payload));
    if (!media.fileName) {
      throw new PermanentJobError("Document message requires fileName");
    }
    const socket = this.requireConnectedSocket();
    const content = {
      document: media.bytes,
      fileName: media.fileName,
      mimetype: media.mimeType ?? "application/octet-stream",
      ...(media.caption ? { caption: media.caption } : {}),
    };
    const sent = await this.sendWithSocket(
      socket,
      remoteJid,
      content,
      outboundSendOptions(remoteJid, jobId, payload.replyTo, payload.replyToParticipant),
    );
    const waMessageId = requireSentMessageId(sent);
    const databaseMessageId = await this.repository.markOutboundSent(
      payload.messageId,
      jobId,
      attempts,
      remoteJid,
      waMessageId,
      "document",
      media.caption ?? null,
      {
        mimeType: media.mimeType ?? "application/octet-stream",
        fileName: media.fileName,
      },
      sent.message,
    );
    await this.safeStatusPatch({ lastOutboundAt: new Date().toISOString() });
    return { databaseMessageId, waMessageId, remoteJid };
  }

  public async sendVideo(
    jobId: string,
    attempts: number,
    payload: OutboundPayload,
  ): Promise<OutboundResult> {
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const media = await this.mediaLoader.load(mediaReference(payload));
    const content = videoMessageContent(media);
    const socket = this.requireConnectedSocket();
    const sent = await this.sendWithSocket(
      socket,
      remoteJid,
      content,
      outboundSendOptions(remoteJid, jobId, payload.replyTo, payload.replyToParticipant),
    );
    const waMessageId = requireSentMessageId(sent);
    const databaseMessageId = await this.repository.markOutboundSent(
      payload.messageId,
      jobId,
      attempts,
      remoteJid,
      waMessageId,
      "video",
      media.caption ?? null,
      compactObject({ mimeType: media.mimeType, fileName: media.fileName }),
      sent.message,
    );
    await this.safeStatusPatch({ lastOutboundAt: new Date().toISOString() });
    return { databaseMessageId, waMessageId, remoteJid };
  }

  public async sendAudio(
    jobId: string,
    attempts: number,
    payload: OutboundPayload,
  ): Promise<OutboundResult> {
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const media = await this.mediaLoader.load(mediaReference(payload));
    const content = audioMessageContent(media, payload.voiceNote === true);
    const socket = this.requireConnectedSocket();
    const sent = await this.sendWithSocket(
      socket,
      remoteJid,
      content,
      outboundSendOptions(remoteJid, jobId, payload.replyTo, payload.replyToParticipant),
    );
    const waMessageId = requireSentMessageId(sent);
    const databaseMessageId = await this.repository.markOutboundSent(
      payload.messageId,
      jobId,
      attempts,
      remoteJid,
      waMessageId,
      "audio",
      null,
      compactObject({
        mimeType: media.mimeType,
        fileName: media.fileName,
        voiceNote: payload.voiceNote === true,
      }),
      sent.message,
    );
    await this.safeStatusPatch({ lastOutboundAt: new Date().toISOString() });
    return { databaseMessageId, waMessageId, remoteJid };
  }

  public async reactToMessage(
    jobId: string,
    attempts: number,
    payload: OutboundPayload,
  ): Promise<OutboundResult> {
    if (!payload.targetWaMessageId) {
      throw new PermanentJobError("Reaction targetWaMessageId is required");
    }
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const socket = this.requireConnectedSocket();
    const sent = await this.sendWithSocket(
      socket,
      remoteJid,
      {
        react: {
          key: inboundTargetKey(remoteJid, payload.targetWaMessageId, payload.targetParticipantJid),
          text: payload.emoji ?? "",
        },
      },
      { messageId: deterministicMessageId(jobId) },
    );
    const waMessageId = requireSentMessageId(sent);
    const databaseMessageId = await this.repository.markOutboundSent(
      payload.messageId,
      jobId,
      attempts,
      remoteJid,
      waMessageId,
      "reaction",
      payload.emoji ?? null,
      compactObject({ targetMessageId: payload.targetMessageId }),
      sent.message,
    );
    await this.safeStatusPatch({ lastOutboundAt: new Date().toISOString() });
    return { databaseMessageId, waMessageId, remoteJid };
  }

  public async markMessageRead(payload: OutboundPayload): Promise<void> {
    if (!payload.targetWaMessageId) {
      throw new PermanentJobError("Read targetWaMessageId is required");
    }
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    await this.requireConnectedSocket().readMessages([
      inboundTargetKey(remoteJid, payload.targetWaMessageId, payload.targetParticipantJid),
    ]);
  }

  public async sendTyping(payload: OutboundPayload): Promise<void> {
    const seconds: unknown = payload.durationSeconds;
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 15
    ) {
      throw new PermanentJobError("Typing durationSeconds must be 1 to 15");
    }
    const remoteJid = normalizeOutboundJid(payload.remoteJid);
    const socket = this.requireConnectedSocket();
    try {
      await socket.sendPresenceUpdate("composing", remoteJid);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    } finally {
      await socket.sendPresenceUpdate("paused", remoteJid);
    }
  }

  public async stop(): Promise<void> {
    const pendingConnection = this.connectPromise;
    const active = this.socket;
    const activeAuthEpoch = this.authEpoch;
    this.stopped = true;
    this.desiredConnected = false;
    this.connected = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.socket = undefined;
    this.authEpoch = undefined;
    this.auth.invalidate(activeAuthEpoch);
    void active?.end(new Error("Baileys service shutdown"));
    await pendingConnection?.catch(() => undefined);
    await this.awaitPendingHandlers();
    await this.inboundDrainPromise?.catch(() => undefined);
    await this.safeQrClear();
    await this.safeStatusPatch({
      state: "stopped",
      connected: false,
      lastHeartbeatAt: new Date().toISOString(),
    });
    await this.safeConnectionUpdate("disconnected", { reconnectAttempt: 0 });
    await this.safeConnectionEvent("close", "service_shutdown", 0);
  }

  private async openSocket(): Promise<void> {
    const generation = ++this.generation;
    await this.statusStore.patch({
      state: this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      connected: false,
      reconnectAttempt: this.reconnectAttempt,
      lastError: null,
    });
    if (!this.connectionIntentIsCurrent(generation)) return;
    await this.safeConnectionUpdate(
      this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      {
        reconnectAttempt: this.reconnectAttempt,
      },
    );
    if (!this.connectionIntentIsCurrent(generation)) return;
    await this.safeConnectionEvent("connecting", null, this.reconnectAttempt);
    if (!this.connectionIntentIsCurrent(generation)) return;
    const authEpoch = this.auth.createSocketState();
    const socket = makeWASocket({
      auth: authEpoch.state,
      browser: Browsers.ubuntu("OpenClaw WhatsApp Gateway"),
      logger: this.logger.child(
        { component: "baileys-protocol" },
        { level: "warn" },
      ),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async (key) => {
        if (!key.remoteJid || !key.id) {
          return undefined;
        }
        return this.repository.getStoredMessage(
          key.remoteJid,
          key.id,
          directAlternateJid(key.remoteJid, key.remoteJidAlt),
        );
      },
    });
    if (!this.connectionIntentIsCurrent(generation)) {
      this.auth.invalidate(authEpoch);
      void socket.end(new Error("Superseded WhatsApp connection attempt"));
      return;
    }
    this.socket = socket;
    this.authEpoch = authEpoch;
    this.installEventHandlers(socket, generation, authEpoch);
    this.logger.info({ generation }, "WhatsApp socket initialized");
  }

  private installEventHandlers(
    socket: WASocket,
    generation: number,
    authEpoch: EncryptedBaileysAuthEpoch,
  ): void {
    socket.ev.on("creds.update", () => {
      this.trackHandler(
        "Encrypted WhatsApp credential persistence failed",
        this.onCredentialsUpdate(socket, generation, authEpoch),
      );
    });
    socket.ev.on("connection.update", (update) => {
      const task = this.onConnectionUpdate(
        socket,
        generation,
        authEpoch,
        update,
      );
      if (update.connection === "close") {
        const closing = task
          .catch(() => undefined)
          .finally(() => {
            if (this.closeTransition === closing)
              this.closeTransition = undefined;
          });
        this.closeTransition = closing;
      }
      this.trackHandler("Connection lifecycle handler failed", task);
    });
    socket.ev.on("messages.upsert", (upsert) => {
      this.trackHandler(
        "Inbound message handler failed",
        this.onMessagesUpsert(socket, generation, upsert),
      );
    });
    socket.ev.on("messages.update", (updates) => {
      this.trackHandler(
        "Delivery update handler failed",
        this.onMessageUpdates(generation, updates),
      );
    });
    socket.ev.on("message-receipt.update", (updates) => {
      this.trackHandler(
        "Receipt update handler failed",
        this.onReceiptUpdates(generation, updates),
      );
    });
  }

  private async onCredentialsUpdate(
    socket: WASocket,
    generation: number,
    authEpoch: EncryptedBaileysAuthEpoch,
  ): Promise<void> {
    if (!this.connectionIntentIsCurrent(generation) || this.socket !== socket)
      return;
    try {
      await this.auth.saveCreds(authEpoch);
    } catch (error) {
      void socket.end(new Error("Encrypted credential persistence failed"));
      throw error;
    }
  }

  private async onConnectionUpdate(
    socket: WASocket,
    generation: number,
    authEpoch: EncryptedBaileysAuthEpoch,
    update: BaileysEventMap["connection.update"],
  ): Promise<void> {
    if (generation !== this.generation || this.stopped) {
      return;
    }
    if (update.qr) {
      await this.qrStore.publish(update.qr);
      if (!this.lifecycleGenerationIsCurrent(generation)) return;
      this.logger.info(
        { expiresInMs: this.config.qrTtlMs },
        "WhatsApp QR is available in workspace storage",
      );
      await this.safeOperationalLog(
        "info",
        "whatsapp.qr_available",
        "WhatsApp pairing QR is available",
        {
          expiresInMs: this.config.qrTtlMs,
        },
      );
      await this.safeConnectionUpdate("qr_pending", {
        reconnectAttempt: this.reconnectAttempt,
      });
      await this.safeConnectionEvent("qr", null, this.reconnectAttempt, {
        expiresInMs: this.config.qrTtlMs,
      });
      if (!this.lifecycleGenerationIsCurrent(generation)) return;
    }
    if (update.connection === "open") {
      this.connected = true;
      this.reconnectAttempt = 0;
      await this.safeQrClear();
      await this.safeStatusPatch({
        state: "connected",
        connected: true,
        accountJid: socket.user?.id ?? null,
        reconnectAttempt: 0,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
      });
      await this.safeConnectionUpdate("connected", {
        jid: socket.user?.phoneNumber ?? socket.user?.id ?? null,
        displayName: socket.user?.name ?? null,
        reconnectAttempt: 0,
        incrementGeneration: true,
      });
      await this.safeConnectionEvent("open", null, 0);
      this.logger.info(
        { accountJid: socket.user?.id },
        "WhatsApp connection opened",
      );
      await this.safeOperationalLog(
        "info",
        "whatsapp.connected",
        "WhatsApp connection opened",
      );
      return;
    }
    if (update.connection !== "close") {
      return;
    }

    this.connected = false;
    if (this.socket === socket) {
      this.socket = undefined;
    }
    if (this.authEpoch === authEpoch) {
      this.authEpoch = undefined;
    }
    this.auth.invalidate(authEpoch);
    const code = disconnectStatusCode(update.lastDisconnect?.error);
    const reason = disconnectReasonName(code);
    const freshSessionRequired =
      code === DisconnectReason.loggedOut ||
      code === DisconnectReason.badSession ||
      code === DisconnectReason.multideviceMismatch;
    const authenticationBlocked = code === DisconnectReason.forbidden;
    const connectionReplaced = code === DisconnectReason.connectionReplaced;
    const terminal = authenticationBlocked || connectionReplaced;
    if (terminal) this.desiredConnected = false;
    await this.safeQrClear();
    if (!this.lifecycleGenerationIsCurrent(generation)) return;
    await this.safeStatusPatch({
      state:
        terminal ||
        (freshSessionRequired && code !== DisconnectReason.loggedOut)
          ? "error"
          : code === DisconnectReason.loggedOut
            ? "logged_out"
            : "disconnected",
      connected: false,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: reason,
    });
    if (!this.lifecycleGenerationIsCurrent(generation)) return;
    const databaseStatus =
      authenticationBlocked ||
      (freshSessionRequired && code !== DisconnectReason.loggedOut)
        ? "auth_failed"
        : code === DisconnectReason.loggedOut
          ? "logged_out"
          : "disconnected";
    await this.safeConnectionUpdate(databaseStatus, {
      error: reason,
      reconnectAttempt: this.reconnectAttempt,
    });
    await this.safeConnectionEvent(
      terminal || (freshSessionRequired && code !== DisconnectReason.loggedOut)
        ? "error"
        : code === DisconnectReason.loggedOut
          ? "logged_out"
          : "close",
      reason,
      this.reconnectAttempt,
      {
        disconnectCode: code ?? null,
      },
    );
    this.logger.warn(
      { disconnectCode: code, reason },
      "WhatsApp connection closed",
    );
    await this.safeOperationalLog(
      "warn",
      "whatsapp.connection_closed",
      "WhatsApp connection closed",
      {
        disconnectCode: code,
        reason,
      },
    );

    if (
      !this.lifecycleGenerationIsCurrent(generation) ||
      terminal ||
      !this.desiredConnected
    )
      return;
    if (freshSessionRequired) {
      await this.auth.clear().catch(async (error: unknown) => {
        this.logger.error(
          { err: error },
          "Unable to clear invalid encrypted WhatsApp session before reconnect",
        );
        await this.safeOperationalLog(
          "error",
          "whatsapp.session_clear_failed",
          "Unable to clear invalid encrypted WhatsApp session before reconnect",
        );
      });
      if (
        this.lifecycleGenerationIsCurrent(generation) &&
        this.desiredConnected
      ) {
        this.scheduleReconnect(1_000);
      }
      return;
    }
    if (this.lifecycleGenerationIsCurrent(generation) && this.desiredConnected)
      this.scheduleReconnect();
  }

  private async onMessagesUpsert(
    socket: WASocket,
    generation: number,
    upsert: BaileysEventMap["messages.upsert"],
  ): Promise<void> {
    if (
      generation !== this.generation ||
      !["notify", "append"].includes(upsert.type)
    ) {
      return;
    }
    const messages: ParsedInboundMessage[] = [];
    for (const raw of upsert.messages) {
      const parsed = parseInboundMessage(raw, ownIdentityJids(socket));
      if (parsed) messages.push(parsed);
    }

    // Baileys delivers an upsert batch as one event. Make every accepted item
    // durable before the first PostgreSQL await so one stalled insert cannot
    // leave later messages acknowledged only in memory.
    const spooled: Array<{ message: ParsedInboundMessage; spoolId: string }> =
      [];
    for (const message of messages) {
      try {
        spooled.push({
          message,
          spoolId: await this.inboundSpool.put(message),
        });
      } catch (error) {
        this.connected = false;
        void socket.end(
          new Error("Encrypted inbound spool persistence failed"),
        );
        await this.safeOperationalLog(
          "error",
          "whatsapp.inbound_spool_failed",
          "Inbound message could not be persisted to the encrypted workspace spool",
          { waMessageId: message.waMessageId, remoteJid: message.remoteJid },
        );
        throw new Error(
          "Inbound spool write failed; WhatsApp socket closed for replay safety",
          { cause: error },
        );
      }
    }

    for (const entry of spooled) {
      await this.persistSpooledInbound(entry.message, entry.spoolId).catch(
        (error: unknown) => {
          this.logger.error(
            {
              err: error,
              waMessageId: entry.message.waMessageId,
              remoteJid: entry.message.remoteJid,
            },
            "Inbound WhatsApp message remains in encrypted recovery spool",
          );
        },
      );
    }
  }

  private async persistSpooledInbound(
    message: ParsedInboundMessage,
    spoolId: string,
  ): Promise<void> {
    const result = await this.repository.persistInbound(message);
    await this.inboundSpool.remove(spoolId);
    if (result.inserted) {
      await this.safeStatusPatch({ lastInboundAt: new Date().toISOString() });
      this.logger.info(
        {
          eventId: result.eventId,
          waMessageId: message.waMessageId,
          remoteJid: message.remoteJid,
          isGroup: message.isGroup,
          messageType: message.messageType,
          forwarded: result.forwarded,
        },
        result.forwarded
          ? "Inbound WhatsApp message persisted for OpenClaw forwarding"
          : "Inbound WhatsApp group message persisted as ignored",
      );
    } else {
      this.logger.debug(
        { waMessageId: message.waMessageId, remoteJid: message.remoteJid },
        "Duplicate inbound ignored",
      );
    }
  }

  public async recoverInboundSpool(): Promise<number> {
    if (!this.inboundDrainPromise) {
      this.inboundDrainPromise = this.drainInboundSpool().finally(() => {
        this.inboundDrainPromise = undefined;
      });
    }
    return this.inboundDrainPromise;
  }

  private async drainInboundSpool(): Promise<number> {
    const entries = await this.inboundSpool.list();
    let recovered = 0;
    for (const id of entries) {
      try {
        const message = await this.inboundSpool.read(id);
        await this.repository.persistInbound(message);
        await this.inboundSpool.remove(id);
        recovered += 1;
      } catch (error) {
        this.logger.error(
          { err: error, spoolId: id },
          "Unable to recover encrypted inbound spool record",
        );
      }
    }
    if (recovered > 0) {
      this.logger.info(
        { recovered },
        "Recovered inbound WhatsApp messages from encrypted spool",
      );
    }
    return recovered;
  }

  private async onMessageUpdates(
    generation: number,
    updates: BaileysEventMap["messages.update"],
  ): Promise<void> {
    if (generation !== this.generation || this.stopped) return;
    for (const item of updates) {
      if (
        !item.key.remoteJid ||
        !item.key.id ||
        item.update.status === undefined ||
        item.update.status === null
      ) {
        continue;
      }
      const status = deliveryStatus(Number(item.update.status));
      if (status) {
        await this.repository.updateDelivery(
          item.key.remoteJid,
          item.key.id,
          status,
          directAlternateJid(item.key.remoteJid, item.key.remoteJidAlt),
        );
      }
    }
  }

  private async onReceiptUpdates(
    generation: number,
    updates: BaileysEventMap["message-receipt.update"],
  ): Promise<void> {
    if (generation !== this.generation || this.stopped) return;
    for (const item of updates) {
      if (!item.key.remoteJid || !item.key.id) {
        continue;
      }
      const status =
        item.receipt.readTimestamp || item.receipt.playedTimestamp
          ? "read"
          : "delivered";
      await this.repository.updateDelivery(
        item.key.remoteJid,
        item.key.id,
        status,
        directAlternateJid(item.key.remoteJid, item.key.remoteJidAlt),
      );
    }
  }

  private async sendWithSocket(
    socket: WASocket,
    remoteJid: string,
    content: Parameters<WASocket["sendMessage"]>[1],
    options: Parameters<WASocket["sendMessage"]>[2],
  ): Promise<WAMessage> {
    try {
      const sent = await socket.sendMessage(remoteJid, content, options);
      if (!sent) {
        throw new Error("Baileys returned no sent message");
      }
      return sent;
    } catch (error) {
      if (options?.quoted) {
        this.logger.warn(
          { err: error, remoteJid },
          "WhatsApp quoted send failed; retrying as plain message",
        );
        const sent = await socket.sendMessage(remoteJid, content,
          options.messageId ? { messageId: options.messageId } : undefined,
        );
        if (!sent) {
          throw new Error("Baileys returned no sent message");
        }
        return sent;
      }
      if (error instanceof PermanentJobError) {
        throw error;
      }
      throw new RetryableJobError("WhatsApp send failed", { cause: error });
    }
  }

  private requireConnectedSocket(): WASocket {
    if (!this.connected || !this.socket) {
      throw new RetryableJobError(
        "WhatsApp is disconnected; durable job will be retried",
      );
    }
    return this.socket;
  }

  private scheduleReconnect(explicitDelay?: number): void {
    if (this.stopped || !this.desiredConnected || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs =
      explicitDelay ??
      exponentialBackoff(
        this.reconnectAttempt,
        1_000,
        this.config.reconnectMaxMs,
      );
    this.trackHandler(
      "Reconnect telemetry handler failed",
      this.persistReconnectTelemetry(delayMs),
    );
    this.logger.info(
      { attempt: this.reconnectAttempt, delayMs },
      "WhatsApp reconnect scheduled",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectNow().catch((error: unknown) => {
        this.logger.error(
          { err: error },
          "WhatsApp reconnect initialization failed",
        );
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private connectionIntentIsCurrent(generation: number): boolean {
    return (
      generation === this.generation && !this.stopped && this.desiredConnected
    );
  }

  private lifecycleGenerationIsCurrent(generation: number): boolean {
    return generation === this.generation && !this.stopped;
  }

  private async persistReconnectTelemetry(delayMs: number): Promise<void> {
    const attempt = this.reconnectAttempt;
    await Promise.all([
      this.safeStatusPatch({
        state: "reconnecting",
        connected: false,
        reconnectAttempt: attempt,
      }),
      this.safeConnectionUpdate("reconnecting", { reconnectAttempt: attempt }),
      this.safeConnectionEvent("reconnect_scheduled", null, attempt, {
        delayMs,
      }),
      this.safeOperationalLog(
        "info",
        "whatsapp.reconnect_scheduled",
        "WhatsApp reconnect scheduled",
        {
          attempt,
          delayMs,
        },
      ),
    ]);
  }

  private trackHandler(failureMessage: string, task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => {
        this.logger.error({ err: error }, failureMessage);
      })
      .finally(() => {
        this.pendingHandlers.delete(tracked);
      });
    this.pendingHandlers.add(tracked);
  }

  private async awaitPendingHandlers(): Promise<void> {
    while (this.pendingHandlers.size > 0) {
      await Promise.allSettled([...this.pendingHandlers]);
    }
  }

  private async safeStatusPatch(
    patch: Parameters<StatusStore["patch"]>[0],
  ): Promise<void> {
    await this.statusStore.patch(patch).catch((error: unknown) => {
      this.logger.warn(
        { err: error },
        "Unable to persist workspace WhatsApp status telemetry",
      );
    });
  }

  private async safeQrClear(): Promise<void> {
    await this.qrStore.clear().catch((error: unknown) => {
      this.logger.warn(
        { err: error },
        "Unable to clear workspace WhatsApp QR telemetry",
      );
    });
  }

  private async safeOperationalLog(
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.repository
      .operationalLog(level, event, message, context)
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, event },
          "Unable to persist operational log",
        );
      });
  }

  private async safeConnectionUpdate(
    ...arguments_: Parameters<WhatsAppRepository["updateConnection"]>
  ): Promise<void> {
    await this.repository
      .updateConnection(...arguments_)
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, state: arguments_[0] },
          "Unable to persist WhatsApp connection state",
        );
      });
  }

  private async safeConnectionEvent(
    ...arguments_: Parameters<WhatsAppRepository["recordConnectionEvent"]>
  ): Promise<void> {
    await this.repository
      .recordConnectionEvent(...arguments_)
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, event: arguments_[0] },
          "Unable to persist WhatsApp connection event",
        );
      });
  }
}

function normalizeOutboundJid(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PermanentJobError("remoteJid is required");
  }
  const trimmed = value.trim();
  if (/^\+?[0-9]{6,20}$/.test(trimmed)) {
    return `${trimmed.replace(/\D/g, "")}@s.whatsapp.net`;
  }
  if (/^[0-9-]+@g\.us$/.test(trimmed)) {
    return trimmed;
  }
  if (
    /^[0-9]+(?::[0-9]+)?@s\.whatsapp\.net$/.test(trimmed) ||
    /^[0-9]+@lid$/.test(trimmed)
  ) {
    return jidNormalizedUser(trimmed);
  }
  throw new PermanentJobError(
    "remoteJid must be a phone number, user JID, LID, or group JID",
  );
}

function mediaReference(payload: OutboundPayload): MediaReference {
  return {
    ...(payload.filePath ? { filePath: payload.filePath } : {}),
    ...(payload.base64 ? { base64: payload.base64 } : {}),
    ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    ...(payload.fileName ? { fileName: payload.fileName } : {}),
    ...(payload.caption ? { caption: payload.caption } : {}),
  };
}

export function videoMessageContent(media: LoadedMedia): {
  video: Buffer;
  mimetype: "video/mp4";
  caption?: string;
} {
  if (media.mimeType !== "video/mp4") {
    throw new PermanentJobError("Video message requires video/mp4");
  }
  return {
    video: media.bytes,
    mimetype: "video/mp4",
    ...(media.caption ? { caption: media.caption } : {}),
  };
}

export function audioMessageContent(
  media: LoadedMedia,
  voiceNote: boolean,
): {
  audio: Buffer;
  mimetype: "audio/mpeg" | "audio/ogg; codecs=opus";
  ptt: boolean;
} {
  if (media.caption) {
    throw new PermanentJobError("Audio message does not support caption");
  }
  if (media.mimeType === "audio/mpeg") {
    if (voiceNote) {
      throw new PermanentJobError("Voice note requires OGG Opus audio");
    }
    return { audio: media.bytes, mimetype: "audio/mpeg", ptt: false };
  }
  if (
    media.mimeType === "audio/ogg" &&
    media.bytes.subarray(0, 128).includes(Buffer.from("OpusHead", "ascii"))
  ) {
    return {
      audio: media.bytes,
      mimetype: "audio/ogg; codecs=opus",
      ptt: voiceNote,
    };
  }
  throw new PermanentJobError("Audio message requires MP3 or OGG Opus");
}

export function outboundSendOptions(
  remoteJid: string,
  jobId: string,
  replyTo?: string,
  replyToParticipant?: string,
): { messageId: string; quoted?: WAMessage } {
  return {
    messageId: deterministicMessageId(jobId),
    ...(replyTo
      ? {
          quoted: {
            key: {
              remoteJid,
              id: replyTo,
              fromMe: false,
              ...(replyToParticipant ? { participant: replyToParticipant } : {}),
            },
            message: { conversation: "" },
          },
        }
      : {}),
  };
}

function inboundTargetKey(
  remoteJid: string,
  id: string,
  participant?: string,
): WAMessageKey {
  return {
    remoteJid,
    id,
    fromMe: false,
    ...(participant ? { participant } : {}),
  };
}

function deterministicMessageId(jobId: string): string {
  // Match Baileys' V2 ID shape (3EB0 + 18 uppercase hex characters) while
  // deriving it from the durable job id for crash-safe replay dedupe.
  return `3EB0${createHash("sha256").update(jobId).digest("hex").slice(0, 18).toUpperCase()}`;
}

function requireSentMessageId(message: WAMessage): string {
  if (!message.key.id) {
    throw new RetryableJobError("WhatsApp did not return a message identifier");
  }
  return message.key.id;
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as {
    output?: { statusCode?: unknown };
    data?: { statusCode?: unknown };
    statusCode?: unknown;
  };
  const code =
    candidate.output?.statusCode ??
    candidate.data?.statusCode ??
    candidate.statusCode;
  return typeof code === "number" ? code : undefined;
}

function disconnectReasonName(code: number | undefined): string {
  if (code === undefined) {
    return "unknown";
  }
  const name = (DisconnectReason as unknown as Record<number, unknown>)[code];
  return typeof name === "string" ? name : `code_${code}`;
}

function deliveryStatus(
  status: number,
): "sent" | "delivered" | "read" | "failed" | null {
  if (status === 0) return "failed";
  if (status === 2) return "sent";
  if (status === 3) return "delivered";
  if (status === 4 || status === 5) return "read";
  return null;
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

function ownIdentityJids(socket: WASocket): string[] {
  const candidates = [
    socket.user?.id,
    socket.user?.lid,
    socket.user?.phoneNumber,
  ];
  return [...new Set(candidates.filter((jid): jid is string => Boolean(jid)))];
}

function directAlternateJid(
  primary: string,
  alternate: string | undefined,
): string | undefined {
  if (primary.endsWith("@g.us") || !alternate) return undefined;
  const primaryIsDirect =
    primary.endsWith("@s.whatsapp.net") || primary.endsWith("@lid");
  const alternateIsDirect =
    alternate.endsWith("@s.whatsapp.net") || alternate.endsWith("@lid");
  return primaryIsDirect && alternateIsDirect ? alternate : undefined;
}

export function safeErrorForStatus(error: unknown): string {
  return errorMessage(error);
}

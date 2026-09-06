import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type WhatsAppLifecycleState =
  | "initializing"
  | "connecting"
  | "qr"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "logged_out"
  | "error"
  | "stopped";

export interface ServiceStatus {
  readonly service: "baileys-service";
  readonly state: WhatsAppLifecycleState;
  readonly connected: boolean;
  readonly accountJid: string | null;
  readonly reconnectAttempt: number;
  readonly qrAvailable: boolean;
  readonly qrExpiresAt: string | null;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly lastConnectedAt: string | null;
  readonly lastDisconnectedAt: string | null;
  readonly lastInboundAt: string | null;
  readonly lastOutboundAt: string | null;
  readonly lastError: string | null;
}

export class StatusStore {
  private current: ServiceStatus;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly statusPath: string;

  public constructor(private readonly whatsappDir: string) {
    const now = new Date().toISOString();
    this.statusPath = path.join(whatsappDir, "status.json");
    this.current = {
      service: "baileys-service",
      state: "initializing",
      connected: false,
      accountJid: null,
      reconnectAttempt: 0,
      qrAvailable: false,
      qrExpiresAt: null,
      startedAt: now,
      lastHeartbeatAt: now,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null,
    };
  }

  public snapshot(): ServiceStatus {
    return { ...this.current };
  }

  public async initialize(): Promise<void> {
    await mkdir(this.whatsappDir, { recursive: true, mode: 0o700 });
    await this.patch({});
  }

  public async patch(
    patch: Partial<Omit<ServiceStatus, "service" | "startedAt">>,
  ): Promise<void> {
    this.current = { ...this.current, ...patch };
    const snapshot = JSON.stringify(this.current, null, 2) + "\n";
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const temporaryPath = `${this.statusPath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, snapshot, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, this.statusPath);
      });
    await this.writeChain;
  }

  public async removeQrMetadata(): Promise<void> {
    await rm(path.join(this.whatsappDir, "qr.png"), { force: true });
    await rm(path.join(this.whatsappDir, "qr.json"), { force: true });
    await this.patch({ qrAvailable: false, qrExpiresAt: null });
  }
}

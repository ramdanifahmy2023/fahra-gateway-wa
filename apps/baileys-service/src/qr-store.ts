import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import QRCode from "qrcode";

import type { StatusStore } from "./status-store.js";

export class EphemeralQrStore {
  private expiryTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private operationChain: Promise<void> = Promise.resolve();
  private readonly qrPath: string;
  private readonly qrJsonPath: string;

  public constructor(
    private readonly whatsappDir: string,
    private readonly ttlMs: number,
    private readonly statusStore: StatusStore,
  ) {
    this.qrPath = path.join(whatsappDir, "qr.png");
    this.qrJsonPath = path.join(whatsappDir, "qr.json");
  }

  public async publish(qr: string): Promise<void> {
    this.operationChain = this.operationChain
      .catch(() => undefined)
      .then(() => this.publishNow(qr));
    return this.operationChain;
  }

  public async clear(): Promise<void> {
    this.operationChain = this.operationChain
      .catch(() => undefined)
      .then(() => this.clearNow());
    return this.operationChain;
  }

  private async publishNow(qr: string): Promise<void> {
    const currentGeneration = ++this.generation;
    await mkdir(this.whatsappDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.qrPath}.${process.pid}.tmp`;
    const temporaryJsonPath = `${this.qrJsonPath}.${process.pid}.tmp`;
    try {
      await QRCode.toFile(temporaryPath, qr, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 384,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.qrPath);

      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
      await writeFile(
        temporaryJsonPath,
        JSON.stringify({ qr, createdAt, expiresAt }) + "\n",
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      await rename(temporaryJsonPath, this.qrJsonPath);
      await this.statusStore.patch({
        state: "qr",
        connected: false,
        qrAvailable: true,
        qrExpiresAt: expiresAt,
      });

      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
      }
      this.expiryTimer = setTimeout(() => {
        if (currentGeneration === this.generation) {
          // Expiry is telemetry cleanup and must never become an unhandled
          // rejection that tears down an otherwise healthy transport.
          void this.clear().catch(() => undefined);
        }
      }, this.ttlMs);
      this.expiryTimer.unref();
    } catch (error) {
      await Promise.allSettled([
        rm(this.qrPath, { force: true }),
        rm(this.qrJsonPath, { force: true }),
        this.statusStore.patch({ qrAvailable: false, qrExpiresAt: null }),
      ]);
      throw error;
    } finally {
      await Promise.allSettled([
        rm(temporaryPath, { force: true }),
        rm(temporaryJsonPath, { force: true }),
      ]);
    }
  }

  private async clearNow(): Promise<void> {
    this.generation += 1;
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    await rm(this.qrPath, { force: true });
    await rm(this.qrJsonPath, { force: true });
    await this.statusStore.patch({ qrAvailable: false, qrExpiresAt: null });
  }
}

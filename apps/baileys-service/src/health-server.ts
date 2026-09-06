import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { Logger } from "pino";

import type { ServiceConfig } from "./config.js";
import type { WhatsAppRepository } from "./repository.js";
import type { WhatsAppSocketManager } from "./socket-manager.js";
import type { StatusStore } from "./status-store.js";

export class HealthServer {
  private server: Server | undefined;

  public constructor(
    private readonly config: ServiceConfig,
    private readonly repository: WhatsAppRepository,
    private readonly socketManager: WhatsAppSocketManager,
    private readonly statusStore: StatusStore,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logger.error({ err: error }, "Health request failed");
        sendJson(response, 500, { status: "error" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(
        this.config.healthPort,
        this.config.healthHost,
        () => {
          this.server?.off("error", reject);
          resolve();
        },
      );
    });
    this.logger.info(
      { host: this.config.healthHost, port: this.config.healthPort },
      "Baileys health server listening on workspace loopback",
    );
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }

  private async handle(
    request: IncomingMessage,
    response: Parameters<typeof sendJson>[0],
  ): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (["/health/live", "/health/ready", "/status"].includes(pathname) && request.method !== "GET") {
      sendJson(response, 405, { status: "method_not_allowed" }, { allow: "GET" });
      return;
    }
    if (pathname === "/health/live") {
      sendJson(response, 200, {
        status: "ok",
        service: "baileys-service",
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (pathname === "/health/ready") {
      let database = true;
      try {
        await Promise.race([
          this.repository.ping(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("Database health timeout")),
              3_000,
            ),
          ),
        ]);
      } catch {
        database = false;
      }
      sendJson(response, database ? 200 : 503, {
        status: database ? "ready" : "not_ready",
        checks: {
          database,
          whatsappConnected: this.socketManager.isConnected(),
        },
        whatsapp: this.statusStore.snapshot(),
      });
      return;
    }
    if (pathname === "/status") {
      if (!validInternalKey(request.headers["x-internal-api-key"], this.config.internalApiKey)) {
        sendJson(response, 401, { status: "unauthorized" });
        return;
      }
      sendJson(response, 200, { data: this.statusStore.snapshot() });
      return;
    }
    if (pathname === "/internal/status/ready" && request.method === "GET") {
      if (!validInternalKey(request.headers["x-internal-api-key"], this.config.internalApiKey)) {
        sendJson(response, 401, { status: "unauthorized" });
        return;
      }
      const result = await this.socketManager.statusReadiness();
      sendJson(response, 200, { data: { ...result, status: "ready" } });
      return;
    }
    if (pathname === "/internal/status/text" && request.method === "POST") {
      if (!validInternalKey(request.headers["x-internal-api-key"], this.config.internalApiKey)) {
        sendJson(response, 401, { status: "unauthorized" });
        return;
      }
      const input = parseTextStatusRequest(await readJsonBody(request));
      const result = await this.socketManager.postTextStatus(
        input.text,
        input.backgroundColor,
        input.font,
      );
      sendJson(response, 202, { data: { ...result, status: "accepted" } });
      return;
    }
    if (pathname === "/internal/status/image" && request.method === "POST") {
      if (!validInternalKey(request.headers["x-internal-api-key"], this.config.internalApiKey)) {
        sendJson(response, 401, { status: "unauthorized" });
        return;
      }
      const input = parseImageStatusRequest(await readJsonBody(request));
      const result = await this.socketManager.postImageStatus(input);
      sendJson(response, 202, { data: { ...result, status: "accepted" } });
      return;
    }
    if (pathname === "/internal/status/video" && request.method === "POST") {
      if (!validInternalKey(request.headers["x-internal-api-key"], this.config.internalApiKey)) {
        sendJson(response, 401, { status: "unauthorized" });
        return;
      }
      const input = parseVideoStatusRequest(await readJsonBody(request));
      const result = await this.socketManager.postVideoStatus(input);
      sendJson(response, 202, { data: { ...result, status: "accepted" } });
      return;
    }
    sendJson(response, 404, { status: "not_found" });
  }
}

export interface TextStatusRequest {
  readonly text: string;
  readonly backgroundColor: string;
  readonly font: number;
}

export function parseTextStatusRequest(value: unknown): TextStatusRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Status request must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length < 1 || text.length > 700) {
    throw new Error("Status text must contain 1-700 characters");
  }
  const backgroundColor =
    typeof input.backgroundColor === "string"
      ? input.backgroundColor.trim().toUpperCase()
      : "#25D366";
  if (!/^#[0-9A-F]{6}$/.test(backgroundColor)) {
    throw new Error("backgroundColor must use #RRGGBB format");
  }
  const font = input.font === undefined ? 1 : input.font;
  if (!Number.isInteger(font) || Number(font) < 0 || Number(font) > 5) {
    throw new Error("font must be an integer between 0 and 5");
  }
  return { text, backgroundColor, font: Number(font) };
}

export function parseImageStatusRequest(value: unknown): {
  readonly filePath: string;
  readonly mimeType: string;
  readonly caption?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Image status request must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const filePath = typeof input.filePath === "string" ? input.filePath.trim() : "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:jpe?g|png|webp)$/i.test(filePath)) {
    throw new Error("filePath must be a gateway-generated image name");
  }
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    throw new Error("mimeType must be image/jpeg, image/png, or image/webp");
  }
  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  if (caption.length > 700) throw new Error("Image status caption cannot exceed 700 characters");
  return { filePath, mimeType, ...(caption ? { caption } : {}) };
}

export function parseVideoStatusRequest(value: unknown): {
  readonly filePath: string;
  readonly mimeType: "video/mp4";
  readonly caption?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Video status request must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const filePath = typeof input.filePath === "string" ? input.filePath.trim() : "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.mp4$/i.test(filePath)) {
    throw new Error("filePath must be a gateway-generated MP4 name");
  }
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : "";
  if (mimeType !== "video/mp4") throw new Error("mimeType must be video/mp4");
  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  if (caption.length > 700) throw new Error("Video status caption cannot exceed 700 characters");
  return { filePath, mimeType: "video/mp4", ...(caption ? { caption } : {}) };
}

function validInternalKey(
  presented: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof presented !== "string") return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8_192) throw new Error("Request body exceeds 8 KiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("Request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

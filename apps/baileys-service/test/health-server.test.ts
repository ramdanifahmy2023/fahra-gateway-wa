import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ServiceConfig } from "../src/config.js";
import { HealthServer } from "../src/health-server.js";
import type { WhatsAppRepository } from "../src/repository.js";
import type { WhatsAppSocketManager } from "../src/socket-manager.js";
import { StatusStore } from "../src/status-store.js";

const internalApiKey = "0123456789abcdef0123456789abcdef";

async function withHealthServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baileys-health-"));
  const port = await freePort();
  const config: ServiceConfig = {
    databaseUrl: "postgresql://user:pass@127.0.0.1:5432/db",
    databaseSslMode: "disable",
    databasePoolMax: 1,
    internalApiKey,
    gatewayInternalUrl: new URL("http://127.0.0.1:3100"),
    sessionEncryptionKey: Buffer.alloc(32),
    sessionScope: "test",
    dataDir: dir,
    whatsappDir: dir,
    uploadsDir: dir,
    logsDir: dir,
    healthHost: "127.0.0.1",
    healthPort: port,
    logLevel: "silent",
    pollIntervalMs: 1_000,
    staleLeaseSeconds: 60,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    reconnectMaxMs: 1_000,
    qrTtlMs: 60_000,
    maxMediaBytes: 1_000,
    authTable: "auth",
    messagesTable: "messages",
    queueTable: "queue",
    groupsTable: "groups",
    outboxTable: "outbox",
    connectionTable: "connection",
    connectionEventsTable: "connection_events",
  };
  const repository = { ping: async () => undefined } as unknown as WhatsAppRepository;
  const socketManager = { isConnected: () => true } as unknown as WhatsAppSocketManager;
  const statusStore = new StatusStore(dir);
  const logger = { info: () => undefined, error: () => undefined } as never;
  const server = new HealthServer(config, repository, socketManager, statusStore, logger);
  try {
    await server.start();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

void test("live and ready stay public GET-only loopback health endpoints", async () => {
  await withHealthServer(async (baseUrl) => {
    const live = await requestJson(baseUrl, "GET", "/health/live");
    assert.equal(live.statusCode, 200);
    assert.equal(live.body.status, "ok");

    const ready = await requestJson(baseUrl, "GET", "/health/ready");
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.status, "ready");

    for (const pathname of ["/health/live", "/health/ready", "/status"]) {
      const response = await requestJson(baseUrl, "POST", pathname);
      assert.equal(response.statusCode, 405);
      assert.equal(response.headers.allow, "GET");
      assert.equal(response.body.status, "method_not_allowed");
    }
  });
});

void test("status requires internal key while internal status mutation key behavior stays intact", async () => {
  await withHealthServer(async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, "GET", "/status")).statusCode, 401);
    assert.equal(
      (await requestJson(baseUrl, "GET", "/status", { "x-internal-api-key": "wrong" })).statusCode,
      401,
    );

    const status = await requestJson(baseUrl, "GET", "/status", {
      "x-internal-api-key": internalApiKey,
    });
    assert.equal(status.statusCode, 200);
    assert.equal((status.body.data as Record<string, unknown>).service, "baileys-service");

    const textWithoutKey = await requestJson(baseUrl, "POST", "/internal/status/text", {
      "content-type": "application/json",
    }, JSON.stringify({ text: "test" }));
    assert.equal(textWithoutKey.statusCode, 401);
  });
});

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.equal(typeof address, "object");
  assert(address);
  return (address as AddressInfo).port;
}

async function requestJson(
  baseUrl: string,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
  const url = new URL(pathname, baseUrl);
  return await new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (body) request.end(body);
    else request.end();
  });
}

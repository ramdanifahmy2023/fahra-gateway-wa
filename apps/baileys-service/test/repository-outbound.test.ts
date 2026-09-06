import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import type { ServiceConfig } from "../src/config.js";
import { WhatsAppRepository } from "../src/repository.js";

const messageId = "8cdddb96-3312-4ae3-8f33-d217a269d7a7";

void test("outbound replay fence commits before best-effort delivery telemetry", async () => {
  const statements: string[] = [];
  const telemetryStatements: string[] = [];
  let released = false;
  const client = {
    query: async (
      sql: string,
    ): Promise<{ rows: unknown[]; rowCount: number }> => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 1 };
    },
    release: (): void => {
      released = true;
    },
  };
  const repository = new WhatsAppRepository(
    {
      connect: async () => client,
      query: async (sql: string): Promise<never> => {
        telemetryStatements.push(sql.replace(/\s+/g, " ").trim());
        throw new Error("telemetry unavailable");
      },
    } as unknown as Pool,
    tableConfig(),
  );

  const result = await repository.markOutboundSent(
    messageId,
    "e09d5250-b987-49ad-8ec0-307b6e2637dc",
    1,
    "628111111111@s.whatsapp.net",
    "WA123",
    "text",
    "halo",
    {},
    { conversation: "halo" },
  );

  assert.equal(result, messageId);
  assert.equal(statements[0], "BEGIN");
  assert.match(statements[1] ?? "", /^INSERT INTO "whatsapp_messages"/);
  assert.equal(statements[2], "COMMIT");
  assert.match(
    telemetryStatements[0] ?? "",
    /^INSERT INTO message_delivery_events/,
  );
  assert.equal(released, true);
});

void test("ambiguous COMMIT confirms the sent fence before allowing a retry", async () => {
  const statements: string[] = [];
  const poolStatements: string[] = [];
  const client = {
    query: async (
      sql: string,
    ): Promise<{ rows: unknown[]; rowCount: number }> => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (normalized === "COMMIT")
        throw new Error("connection lost after commit");
      return { rows: [], rowCount: 1 };
    },
    release: (): void => undefined,
  };
  const repository = new WhatsAppRepository(
    {
      connect: async () => client,
      query: async (
        sql: string,
      ): Promise<{ rows: Array<{ id: string }>; rowCount: number }> => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        poolStatements.push(normalized);
        if (normalized.startsWith("SELECT id FROM"))
          return { rows: [{ id: messageId }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool,
    tableConfig(),
  );

  const result = await repository.markOutboundSent(
    messageId,
    "e09d5250-b987-49ad-8ec0-307b6e2637dc",
    1,
    "628111111111@s.whatsapp.net",
    "WA123",
    "text",
    "halo",
    {},
    { conversation: "halo" },
  );

  assert.equal(result, messageId);
  assert.deepEqual(statements.slice(-2), ["COMMIT", "ROLLBACK"]);
  assert.match(poolStatements[0] ?? "", /^SELECT id FROM "whatsapp_messages"/);
  assert.match(poolStatements[1] ?? "", /^INSERT INTO message_delivery_events/);
});

void test("reaction outbound rows use the same replay fence", async () => {
  const statements: string[] = [];
  const repository = new WhatsAppRepository(
    {
      connect: async () => ({
        query: async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
          statements.push(sql.replace(/\s+/g, " ").trim());
          return { rows: [], rowCount: 1 };
        },
        release: (): void => undefined,
      }),
      query: async (): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows: [], rowCount: 1 }),
    } as unknown as Pool,
    tableConfig(),
  );

  await repository.markOutboundSent(
    messageId,
    "e09d5250-b987-49ad-8ec0-307b6e2637dc",
    1,
    "628111111111@s.whatsapp.net",
    "WA123",
    "reaction",
    "👍",
    { targetMessageId: messageId },
    { reactionMessage: { text: "👍" } },
  );

  assert.match(statements[1] ?? "", /^INSERT INTO "whatsapp_messages"/);
  assert.equal(statements[2], "COMMIT");
});

function tableConfig(): ServiceConfig {
  return {
    messagesTable: "whatsapp_messages",
    queueTable: "queue_jobs",
    groupsTable: "whatsapp_groups",
    outboxTable: "integration_outbox",
    connectionTable: "whatsapp_connection",
    connectionEventsTable: "whatsapp_connection_events",
  } as ServiceConfig;
}

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isAllowedProxyRoute } from "./gateway";

describe("dashboard gateway proxy allowlist", () => {
  it("allows exact contact-memory mode POST endpoints only", () => {
    expect(isAllowedProxyRoute("POST", "contact-memory/6281@s.whatsapp.net/manual-mode")).toBe(true);
    expect(isAllowedProxyRoute("POST", "contact-memory/6281@s.whatsapp.net/ai-mode")).toBe(true);
    expect(isAllowedProxyRoute("GET", "contact-memory/6281@s.whatsapp.net/manual-mode")).toBe(false);
    expect(isAllowedProxyRoute("POST", "contact-memory/6281@s.whatsapp.net/manual-mode/extra")).toBe(false);
  });

  it("allows exact inbox phase 2 dashboard routes only", () => {
    expect(isAllowedProxyRoute("POST", "messages/abc/reaction")).toBe(true);
    expect(isAllowedProxyRoute("POST", "messages/abc/mark-read")).toBe(true);
    expect(isAllowedProxyRoute("POST", "messages/abc/typing")).toBe(true);
    expect(isAllowedProxyRoute("GET", "messages/analytics/receipts")).toBe(true);
    expect(isAllowedProxyRoute("GET", "messages/queue/failed")).toBe(true);
    expect(isAllowedProxyRoute("GET", "messages/abc/reaction")).toBe(false);
    expect(isAllowedProxyRoute("POST", "messages/abc/typing/extra")).toBe(false);
    expect(isAllowedProxyRoute("GET", "messages/queue/failed/raw-payloads")).toBe(false);
  });

  it("allows bounded CRM Phase 3A routes and denies method/path drift", () => {
    expect(isAllowedProxyRoute("GET", "crm/config")).toBe(true);
    expect(isAllowedProxyRoute("PUT", "crm/config")).toBe(true);
    expect(isAllowedProxyRoute("GET", "crm/contacts")).toBe(true);
    expect(isAllowedProxyRoute("PUT", "crm/contacts/6281@s.whatsapp.net")).toBe(true);
    expect(isAllowedProxyRoute("POST", "crm/contacts/6281@s.whatsapp.net/notes")).toBe(true);
    expect(isAllowedProxyRoute("DELETE", "crm/notes/550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isAllowedProxyRoute("PATCH", "crm/config")).toBe(false);
    expect(isAllowedProxyRoute("POST", "crm/contacts/free-form/send")).toBe(false);
    expect(isAllowedProxyRoute("GET", "crm/config/secrets")).toBe(false);
  });
});

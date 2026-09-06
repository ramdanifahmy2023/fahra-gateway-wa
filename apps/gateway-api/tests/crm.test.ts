import { describe, expect, it } from "vitest";
import {
  defaultCrmConfig,
  parseCrmContactUpdate,
  parseCrmConfigUpdate,
  resolveCrmConfig,
} from "../src/modules/crm.js";

describe("CRM Lite config helpers", () => {
  it("uses conservative defaults", () => {
    expect(resolveCrmConfig([])).toEqual(defaultCrmConfig);
    expect(defaultCrmConfig).toMatchObject({
      "crm.enabled": false,
      "crm.ai.enabled": false,
      "crm.ai.mode": "off",
      "crm.allow_auto_reply": false,
    });
  });

  it("rejects AI-on config in Phase 3A", () => {
    expect(() =>
      parseCrmConfigUpdate({ expectedRevision: 1, "crm.ai.enabled": true }),
    ).toThrow();
    expect(() =>
      parseCrmConfigUpdate({ expectedRevision: 1, "crm.allow_auto_reply": true }),
    ).toThrow();
  });

  it("strictly validates config allowlist", () => {
    expect(() =>
      parseCrmConfigUpdate({ expectedRevision: 1, "crm.unknown": false }),
    ).toThrow();
    expect(() =>
      parseCrmConfigUpdate({ expectedRevision: 0, "crm.enabled": true }),
    ).toThrow();
    expect(() => parseCrmConfigUpdate({ expectedRevision: 1 })).toThrow();
  });

  it("accepts only canonical contact enums and requires a DNC reason", () => {
    expect(
      parseCrmContactUpdate({
        expectedRevision: 1,
        crmStatus: "waiting_human",
        consentStatus: "granted",
        consentSource: "Form persetujuan",
        aiModeOverride: "suggest_only",
        doNotContact: true,
        doNotContactReason: "Permintaan kontak",
      }),
    ).toMatchObject({ crmStatus: "waiting_human", consentStatus: "granted" });
    expect(() =>
      parseCrmContactUpdate({ expectedRevision: 1, doNotContact: true }),
    ).toThrow();
    expect(() =>
      parseCrmContactUpdate({ expectedRevision: 1, crmStatus: "won" }),
    ).toThrow();
  });

  it("resolves DB settings with schema guard and fallback", () => {
    expect(
      resolveCrmConfig([
        { key: "crm.enabled", value: true },
        { key: "crm.default_sla_hours", value: 72 },
        { key: "crm.ai.enabled", value: true },
        { key: "crm.ai.mode", value: "auto" },
        { key: "crm.allow_auto_reply", value: true },
      ]),
    ).toEqual({
      "crm.enabled": true,
      "crm.ai.enabled": false,
      "crm.ai.mode": "off",
      "crm.default_sla_hours": 72,
      "crm.default_status": "open",
      "crm.default_priority": "normal",
      "crm.default_ai_override": "inherit",
      "crm.notes_required_on_close": false,
      "crm.human_override_required": true,
      "crm.allow_auto_reply": false,
    });
  });
});

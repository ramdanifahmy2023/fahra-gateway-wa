import { describe, expect, it } from "vitest";
import {
  getBoolean,
  getRecordId,
  getString,
  responseMeta,
  unwrapCollection,
  unwrapRecord,
} from "@/lib/utils";

describe("normalisasi response API", () => {
  it("membaca collection dari envelope data.items", () => {
    expect(unwrapCollection({ data: { items: [{ id: "one" }] } })).toEqual([
      { id: "one" },
    ]);
  });

  it("tidak membuat data contoh untuk payload kosong", () => {
    expect(unwrapCollection(null)).toEqual([]);
    expect(unwrapRecord(undefined)).toEqual({});
  });

  it("membaca identifier dan boolean eksplisit", () => {
    expect(getRecordId({ uuid: "resource-id" })).toBe("resource-id");
    expect(getBoolean({ enabled: false }, "enabled")).toBe(false);
  });

  it("menormalisasi nama field PostgreSQL snake_case", () => {
    const record = unwrapRecord({
      data: { remote_jid: "group@g.us", created_at: "2026-08-09" },
    });
    expect(getString(record, "remoteJid")).toBe("group@g.us");
    expect(record.createdAt).toBe("2026-08-09");
  });

  it("membaca meta dari root response tanpa ikut membuka data", () => {
    expect(responseMeta({ data: [{ id: "one" }], meta: { total: 51 } })).toEqual({ total: 51 });
  });
});

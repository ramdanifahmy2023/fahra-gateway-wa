import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/client-api";
import { conflictNotice, displayName } from "@/components/features/crm-center";

describe("CRM presenter", () => {
  it("memakai candidate_name saat display_name kosong", () => {
    expect(displayName({ candidate_name: "Nama kandidat" })).toBe("Nama kandidat");
  });

  it("membedakan revision conflict dari 409 lain", () => {
    expect(conflictNotice(new ApiError("CRM nonaktif", 409, { error: { code: "CRM_DISABLED" } }), "gagal")).toEqual({
      tone: "danger",
      text: "CRM nonaktif",
    });
    expect(conflictNotice(new ApiError("berubah", 409, { error: { code: "REVISION_CONFLICT" } }), "gagal").tone).toBe("warning");
  });
});

import { describe, expect, it } from "vitest";
import { ApiError, apiErrorCode } from "@/lib/client-api";

describe("ApiError", () => {
  it("membaca kode error API bersarang", () => {
    expect(apiErrorCode(new ApiError("konflik", 409, { error: { code: "REVISION_CONFLICT" } }))).toBe("REVISION_CONFLICT");
  });
});

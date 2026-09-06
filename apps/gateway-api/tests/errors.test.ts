import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, errorPayload } from "../src/errors.js";
describe("API errors", () => {
  it("keeps explicit public errors", () =>
    expect(errorPayload(new ApiError(409, "CONFLICT", "Bentrok"))).toEqual({
      statusCode: 409,
      payload: {
        error: { code: "CONFLICT", message: "Bentrok", details: null },
      },
    }));
  it("does not leak unknown exception details", () =>
    expect(errorPayload(new Error("database password leaked")).payload).toEqual(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Terjadi kesalahan internal",
        },
      },
    ));
  it("maps Zod issues to 422", () => {
    const parsed = z.object({ id: z.uuid() }).safeParse({ id: "x" });
    if (parsed.success) throw new Error("expected failure");
    expect(errorPayload(parsed.error).statusCode).toBe(422);
  });
});

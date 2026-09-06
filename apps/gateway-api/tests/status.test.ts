import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import { parseAcceptedStatusResponse } from "../src/modules/status.js";

describe("WhatsApp Status response contract", () => {
  it("accepts only a complete Baileys status identity", () => {
    const result = parseAcceptedStatusResponse({
      data: {
        status: "accepted",
        remoteJid: "status@broadcast",
        waMessageId: "STATUS-1",
        audienceCount: 7,
      },
    });
    expect(result.audienceCount).toBe(7);
  });

  it("fails closed for incomplete or recipient-less responses", () => {
    for (const payload of [
      null,
      {},
      { data: { status: "accepted", remoteJid: "status@broadcast", waMessageId: "", audienceCount: 7 } },
      { data: { status: "accepted", remoteJid: "status@broadcast", waMessageId: "STATUS-1", audienceCount: 0 } },
    ]) {
      expect(() => parseAcceptedStatusResponse(payload)).toThrow(ApiError);
    }
  });
});

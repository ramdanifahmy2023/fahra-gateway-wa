import { describe, expect, it, vi } from "vitest";
import { retryDelayMs } from "./queue.js";
describe("retry delay", () => {
  it("uses capped exponential backoff with jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(4)).toBe(8000);
    expect(retryDelayMs(20, 300_000)).toBe(300_000);
    vi.restoreAllMocks();
  });
});

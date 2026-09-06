import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  decryptValue,
  encryptValue,
  parseEncryptionKey,
} from "./crypto.js";

const key = Buffer.alloc(32, 7).toString("base64");
describe("encrypted values", () => {
  it("round-trips with AAD", () => {
    const encrypted = encryptValue({ secret: "value" }, key, "record:1");
    expect(decryptValue(encrypted, key, "record:1")).toEqual({
      secret: "value",
    });
  });
  it("rejects tampering and wrong AAD", () => {
    const encrypted = encryptValue("value", key, "record:1");
    expect(() => decryptValue(encrypted, key, "record:2")).toThrow();
  });
  it("requires a 32-byte key", () =>
    expect(() =>
      parseEncryptionKey(Buffer.alloc(31).toString("base64")),
    ).toThrow());
  it("compares secrets without length branching", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("short", "a much longer value")).toBe(false);
  });
});

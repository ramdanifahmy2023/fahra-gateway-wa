import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/modules/catalog.js";

describe("AI provider network policy", () => {
  it("memblok alamat private, metadata, dokumentasi, multicast, dan IPv4-mapped", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "192.0.2.1",
      "198.51.100.2",
      "203.0.113.3",
      "224.0.0.1",
      "::1",
      "::7f00:1",
      "fd00::1",
      "fe80::1",
      "2001:db8::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
    ])
      expect(isPrivateAddress(address)).toBe(true);
  });
  it("mengizinkan alamat Internet publik", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
  it("memblok alamat yang bukan literal IP", () =>
    expect(isPrivateAddress("not-an-ip")).toBe(true));
});

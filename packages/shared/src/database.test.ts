import { describe, expect, it } from "vitest";
import { requiresDatabaseSsl } from "./database.js";

describe("database TLS policy", () => {
  it("allows loopback PostgreSQL without TLS", () => {
    expect(requiresDatabaseSsl("postgresql://u:p@127.0.0.1/db")).toBe(false);
    expect(requiresDatabaseSsl("postgresql://u:p@localhost/db")).toBe(false);
  });

  it("requires TLS for remote PostgreSQL hosts", () => {
    expect(requiresDatabaseSsl("postgresql://u:p@example.com/db")).toBe(true);
  });
});

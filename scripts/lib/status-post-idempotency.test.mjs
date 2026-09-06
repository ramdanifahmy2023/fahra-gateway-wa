import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireStatusPostClaim,
  readStatusPostClaim,
  updateStatusPostClaim,
  validateStatusPostKey,
} from "./status-post-idempotency.mjs";

test("status post key is path-safe and bounded", () => {
  assert.equal(validateStatusPostKey("2026-08-23:evening"), "2026-08-23:evening");
  assert.throws(() => validateStatusPostKey("../escape"), /Invalid status idempotency key/);
  assert.throws(() => validateStatusPostKey("a".repeat(101)), /Invalid status idempotency key/);
});

test("only one concurrent claim can be acquired", async () => {
  const root = await mkdtemp(join(tmpdir(), "status-claim-"));
  try {
    const results = await Promise.all([
      acquireStatusPostClaim(root, "2026-08-23:evening", { sourceDigest: "one" }),
      acquireStatusPostClaim(root, "2026-08-23:evening", { sourceDigest: "two" }),
    ]);
    assert.equal(results.filter((result) => result.acquired).length, 1);
    assert.equal(results.filter((result) => !result.acquired).length, 1);
    const claim = await readStatusPostClaim(root, "2026-08-23:evening");
    assert.equal(claim.state, "attempted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted state is durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "status-claim-"));
  try {
    await acquireStatusPostClaim(root, "2026-08-24:evening");
    await updateStatusPostClaim(root, "2026-08-24:evening", {
      state: "accepted",
      audienceCount: 8,
    });
    const claim = await readStatusPostClaim(root, "2026-08-24:evening");
    assert.equal(claim.state, "accepted");
    assert.equal(claim.audienceCount, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

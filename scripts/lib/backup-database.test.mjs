import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSessionAffineDatabaseUrl,
  databaseSessionAffinity,
} from "./common.mjs";

test("ordinary direct PostgreSQL URLs pass the best-effort affinity guard", () => {
  const result = databaseSessionAffinity(
    "postgresql://app:secret@db.internal:5432/gateway",
  );
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, false);
});

test("obvious managed transaction-pool endpoints fail without confirmation", () => {
  const result = databaseSessionAffinity(
    "postgresql://app:secret@tenant.pooler.example:6543/gateway",
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("; "), /pooler|6543/);
  assert.throws(
    () =>
      assertSessionAffineDatabaseUrl(
        "postgresql://app:secret@tenant.pooler.example:6543/gateway",
      ),
    /direct\/session-affine/,
  );
});

test("explicit session mode only overrides heuristic false positives", () => {
  assert.equal(
    databaseSessionAffinity(
      "postgresql://app:secret@session-pooler.example:6543/gateway",
      "session",
    ).ok,
    true,
  );
  assert.equal(
    databaseSessionAffinity(
      "postgresql://app:secret@db.example/gateway?pool_mode=transaction",
      "session",
    ).ok,
    false,
  );
  assert.equal(
    databaseSessionAffinity(
      "postgresql://app:secret@db.example/gateway",
      "transaction",
    ).ok,
    false,
  );
  assert.equal(
    databaseSessionAffinity(
      "postgresql://app:secret@db.example/gateway?pool_mode=adaptive",
    ).ok,
    false,
  );
});

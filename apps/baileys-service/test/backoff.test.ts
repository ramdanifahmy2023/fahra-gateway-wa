import assert from "node:assert/strict";
import test from "node:test";

import { exponentialBackoff } from "../src/backoff.js";

void test("exponential backoff grows, jitters, and respects the cap", () => {
  assert.equal(
    exponentialBackoff(1, 1_000, 60_000, () => 0.5),
    1_000,
  );
  assert.equal(
    exponentialBackoff(2, 1_000, 60_000, () => 0.5),
    2_000,
  );
  assert.equal(
    exponentialBackoff(20, 1_000, 60_000, () => 0.5),
    60_000,
  );
  assert.equal(
    exponentialBackoff(20, 1_000, 60_000, () => 1),
    60_000,
  );
  assert.equal(
    exponentialBackoff(2, 1_000, 60_000, () => 0),
    1_600,
  );
  assert.equal(
    exponentialBackoff(2, 1_000, 60_000, () => 1),
    2_400,
  );
});

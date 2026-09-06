import assert from "node:assert/strict";
import test from "node:test";

import {
  createEncryptedAuthState,
  type PostgresEncryptedAuthStore,
} from "../src/encrypted-auth-state.js";

void test("stale socket auth epochs cannot repopulate Signal keys after invalidation", async () => {
  const keyWrites: unknown[][] = [];
  let clears = 0;
  const fakeStore = {
    read: async (): Promise<undefined> => undefined,
    write: async (): Promise<void> => undefined,
    writeMany: async (writes: readonly unknown[]): Promise<void> => {
      keyWrites.push([...writes]);
    },
    clear: async (): Promise<void> => {
      clears += 1;
    },
  } as unknown as PostgresEncryptedAuthStore;
  const auth = await createEncryptedAuthState(fakeStore);

  const first = auth.createSocketState();
  await first.state.keys.set({
    "lid-mapping": { first: "6281@s.whatsapp.net" },
  });
  assert.equal(keyWrites.length, 1);

  auth.invalidate(first);
  await first.state.keys.set({
    "lid-mapping": { stale: "6282@s.whatsapp.net" },
  });
  assert.equal(keyWrites.length, 1);

  const second = auth.createSocketState();
  await second.state.keys.set({
    "lid-mapping": { second: "6283@s.whatsapp.net" },
  });
  assert.equal(keyWrites.length, 2);
  await auth.clear();
  await second.state.keys.set({
    "lid-mapping": { staleAfterClear: "6284@s.whatsapp.net" },
  });
  assert.equal(keyWrites.length, 2);
  assert.equal(clears, 1);
});

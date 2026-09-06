import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaLoader } from "../src/media-loader.js";

void test("media loader accepts workspace uploads and rejects path escape/symlink escape", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "ocgw-media-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const uploads = path.join(root, "uploads");
  await mkdir(uploads);
  const stored = "2f5d1e19-9b8a-4a1f-88ff-0f2b991e31dc.txt";
  const escaped = "8367a187-5ea6-4a5c-b4fd-5d9a248c16b0.txt";
  await writeFile(path.join(uploads, stored), "allowed");
  await writeFile(path.join(root, "outside.txt"), "outside");
  await symlink(path.join(root, "outside.txt"), path.join(uploads, escaped));

  const loader = new MediaLoader(uploads, 1_024);
  assert.equal((await loader.load({ filePath: stored })).bytes.toString(), "allowed");
  await assert.rejects(() => loader.load({ filePath: "../outside.txt" }));
  await assert.rejects(() => loader.load({ filePath: "allowed.txt" }));
  await assert.rejects(() => loader.load({ filePath: escaped }));
});

void test("media loader requires canonical bounded base64", async () => {
  const loader = new MediaLoader("/unused", 10);
  assert.equal(
    (
      await loader.load({ base64: Buffer.from("image").toString("base64") })
    ).bytes.toString(),
    "image",
  );
  await assert.rejects(() => loader.load({ base64: "not base64" }));
});

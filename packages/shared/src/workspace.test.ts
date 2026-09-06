import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspacePath } from "./workspace.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspacePath", () => {
  it("menerima subdirectory relatif", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocgw-workspace-"));
    temporary.push(root);
    await mkdir(join(root, "data"));
    expect(workspacePath("./data", root)).toBe(join(root, "data"));
  });
  it("menolak absolute path dan traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocgw-workspace-"));
    temporary.push(root);
    expect(() => workspacePath("/tmp/outside", root)).toThrow();
    expect(() => workspacePath("../outside", root)).toThrow();
  });
  it("menolak komponen symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocgw-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "ocgw-outside-"));
    temporary.push(root, outside);
    await symlink(outside, join(root, "data"));
    expect(() => workspacePath("./data/uploads", root)).toThrow(/Symlink/);
  });
});

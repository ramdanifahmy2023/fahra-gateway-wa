import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const staticSource = path.join(workspace, ".next", "static");
const candidates = [
  path.join(workspace, ".next", "standalone", "apps", "dashboard", ".next"),
  path.join(workspace, ".next", "standalone", ".next"),
];

const target = await firstDirectory(candidates);
if (!target)
  throw new Error("Bundle standalone Next.js tidak ditemukan setelah build.");

await mkdir(path.join(target, "static"), { recursive: true });
await cp(staticSource, path.join(target, "static"), {
  recursive: true,
  force: true,
});

async function firstDirectory(paths) {
  for (const candidate of paths) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Candidate layout lain akan diperiksa.
    }
  }
  return null;
}

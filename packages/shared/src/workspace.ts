import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function findWorkspaceRoot(start = process.cwd()): string {
  let current = resolve(start);
  for (;;) {
    const packagePath = join(current, "package.json");
    const envExample = join(current, ".env.example");
    if (existsSync(packagePath) && existsSync(envExample)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `OpenClaw Gateway workspace root tidak ditemukan dari ${start}`,
      );
    }
    current = parent;
  }
}

export const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export function workspacePath(
  value: string,
  root = findWorkspaceRoot(),
): string {
  if (isAbsolute(value))
    throw new Error("Path state wajib relatif terhadap workspace");
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, value);
  const lexical = relative(absoluteRoot, candidate);
  if (
    !lexical ||
    lexical === ".." ||
    lexical.startsWith(`..${sep}`) ||
    isAbsolute(lexical)
  )
    throw new Error("Path state wajib berada di subdirectory workspace");
  let cursor = absoluteRoot;
  for (const component of lexical.split(sep)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink())
      throw new Error(`Symlink tidak diizinkan pada path state: ${cursor}`);
  }
  const realRoot = realpathSync(absoluteRoot);
  if (existsSync(candidate)) {
    const realCandidate = realpathSync(candidate);
    const realRelative = relative(realRoot, realCandidate);
    if (
      !realRelative ||
      realRelative === ".." ||
      realRelative.startsWith(`..${sep}`) ||
      isAbsolute(realRelative)
    )
      throw new Error("Real path state keluar dari workspace");
  }
  return candidate;
}

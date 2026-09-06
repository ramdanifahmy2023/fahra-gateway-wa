import { rm } from "node:fs/promises";

const target = process.argv[2];
if (!["dist", "dist/.test"].includes(target)) {
  throw new Error("clean.mjs only permits dist or dist/.test");
}

await rm(new URL(`./${target}/`, import.meta.url), {
  recursive: true,
  force: true,
});

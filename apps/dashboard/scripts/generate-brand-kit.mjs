import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "public", "brand");
await mkdir(out, { recursive: true });

const colors = {
  bg: "#0C111B",
  panel: "#101724",
  ink: "#F2F6FA",
  muted: "#94A3B8",
  green: "#20C768",
  cyan: "#38BDF8",
  warning: "#F59E0B",
  black: "#05070B",
  white: "#FFFFFF",
};

function mark({ fg = colors.green, wave = colors.cyan, bg = "none" } = {}) {
  const bgRect = bg === "none" ? "" : `<rect width="64" height="64" rx="14" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="OpenClaw WhatsApp Gateway mark">${bgRect}<path fill="${fg}" d="M14 16h28a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8H29L18 54v-8h-4a8 8 0 0 1-8-8V24a8 8 0 0 1 8-8Zm2 8v14h7v-7h6v7h7v-7h6v-7H16Z"/><path fill="${wave}" d="M43 22h5v5h-5zm5 5h5v5h-5zm-5 5h5v5h-5z"/><path fill="${colors.warning}" d="M29 10h6v6h-6z"/></svg>`;
}

function lockup(mode = "dark", stacked = false) {
  const dark = mode === "dark";
  const ink = dark ? colors.ink : colors.bg;
  const muted = dark ? colors.muted : "#475569";
  const icon = Buffer.from(mark({ fg: dark ? colors.green : "#128C4A", wave: dark ? colors.cyan : "#0477A5", bg: dark ? colors.panel : colors.white })).toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${stacked ? 360 : 520} ${stacked ? 220 : 96}" role="img" aria-label="OpenClaw WhatsApp Gateway lockup"><rect width="100%" height="100%" rx="18" fill="${dark ? colors.bg : colors.white}"/><image href="data:image/svg+xml;base64,${icon}" x="24" y="${stacked ? 18 : 16}" width="64" height="64"/><text x="${stacked ? 24 : 108}" y="${stacked ? 112 : 42}" fill="${ink}" font-family="Inter, ui-sans-serif, system-ui" font-weight="800" font-size="24">OPENCLAW</text><text x="${stacked ? 24 : 108}" y="${stacked ? 146 : 68}" fill="${muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15">WHATSAPP GATEWAY</text><text x="${stacked ? 24 : 332}" y="${stacked ? 178 : 68}" fill="${colors.green}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">BAILEYS · LOCAL-FIRST</text></svg>`;
}

const files = {
  "ocgw-mark-dark.svg": mark({ fg: colors.green, wave: colors.cyan }),
  "ocgw-mark-light.svg": mark({ fg: "#128C4A", wave: "#0477A5" }),
  "ocgw-mark-mono-black.svg": mark({ fg: colors.black, wave: colors.black }),
  "ocgw-mark-mono-white.svg": mark({ fg: colors.white, wave: colors.white }),
  "ocgw-app-icon.svg": mark({ fg: colors.green, wave: colors.cyan, bg: colors.bg }),
  "ocgw-lockup-horizontal-dark.svg": lockup("dark", false),
  "ocgw-lockup-horizontal-light.svg": lockup("light", false),
  "ocgw-lockup-stacked-dark.svg": lockup("dark", true),
  "ocgw-lockup-stacked-light.svg": lockup("light", true),
  "BACA-DULU.txt": `OPENCLAW WHATSAPP GATEWAY: BRAND KIT\n\nMotto: Local by default. Reliable by design.\nDescriptor: Local-first Baileys gateway for secure WhatsApp automation.\n\nUse official SVG/PNG exports. Do not redraw from screenshots.\n\nColors:\nBG ${colors.bg}\nPanel ${colors.panel}\nInk ${colors.ink}\nMuted ${colors.muted}\nGateway Green ${colors.green}\nSignal Cyan ${colors.cyan}\nWarning ${colors.warning}\n\nDo not rotate, stretch, recolor outside tokens, add glow/gradients, crop into a circle, or place on noisy low-contrast backgrounds.\n\nClear space: at least 1/8 mark height. Minimum mark size: 16px.\n`,
};

for (const [name, content] of Object.entries(files)) await writeFile(join(out, name), content);

const pngs = [16, 32, 64, 128, 256, 512];
for (const size of pngs) {
  const target = join(out, `ocgw-mark-${size}.png`);
  const r = spawnSync("sips", ["-s", "format", "png", "-z", String(size), String(size), join(out, "ocgw-app-icon.svg"), "--out", target], { stdio: "ignore" });
  if (r.status !== 0) await writeFile(target, await readFile(join(out, "ocgw-app-icon.svg")));
}

const lockupPngs = [
  ["ocgw-lockup-horizontal-dark.svg", "ocgw-lockup-horizontal-dark", 520, 96],
  ["ocgw-lockup-horizontal-light.svg", "ocgw-lockup-horizontal-light", 520, 96],
  ["ocgw-lockup-stacked-dark.svg", "ocgw-lockup-stacked-dark", 360, 220],
  ["ocgw-lockup-stacked-light.svg", "ocgw-lockup-stacked-light", 360, 220],
];
for (const [source, name, width, height] of lockupPngs) {
  for (const scale of [1, 2, 3]) {
    const target = join(out, `${name}@${scale}x.png`);
    const r = spawnSync("sips", ["-s", "format", "png", "-z", String(height * scale), String(width * scale), join(out, source), "--out", target], { stdio: "ignore" });
    if (r.status !== 0) await writeFile(target, await readFile(join(out, source)));
  }
}

await writeFile(join(out, "ocgw-logo-clear-space.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#0C111B"/><rect x="16" y="16" width="64" height="64" fill="none" stroke="#38BDF8" stroke-dasharray="4 4"/><image href="ocgw-app-icon.svg" x="24" y="24" width="48" height="48"/><text x="48" y="90" text-anchor="middle" fill="#94A3B8" font-family="ui-monospace, monospace" font-size="6">clear space 1/8 mark</text></svg>`);

await rm(join(out, "ocgw-brand-kit.tar.gz"), { force: true });
await rm(join(out, "ocgw-brand-kit.zip"), { force: true });
const list = Object.keys(files).concat(pngs.map((s) => `ocgw-mark-${s}.png`), lockupPngs.flatMap(([, name]) => [1, 2, 3].map((scale) => `${name}@${scale}x.png`)), ["ocgw-logo-clear-space.svg"]);
const tar = spawnSync("tar", ["-czf", join(out, "ocgw-brand-kit.tar.gz"), ...list], { cwd: out, stdio: "inherit" });
if (tar.status !== 0) throw new Error("tar failed");
const zip = spawnSync("zip", ["-q", "ocgw-brand-kit.zip", ...list], { cwd: out, stdio: "inherit" });
if (zip.status !== 0) throw new Error("zip failed");
const tarHash = createHash("sha256").update(await readFile(join(out, "ocgw-brand-kit.tar.gz"))).digest("hex");
const zipHash = createHash("sha256").update(await readFile(join(out, "ocgw-brand-kit.zip"))).digest("hex");
await writeFile(join(out, "SHA256SUMS.txt"), `${tarHash}  ocgw-brand-kit.tar.gz\n${zipHash}  ocgw-brand-kit.zip\n`);
console.log(`generated ${list.length + 2} assets`);

// Dev aid: run `paw chat …` under a pty, feed its output through a headless xterm, and print the SCREEN
// (what the operator sees, cursor moves applied) at the given moments. Read-only unless you pass --type.
//   node scripts/lean/screen-chat.ts --at 100,400,1500 [--type 'text' --type-at ms] [--cwd dir] -- chat @skills
import { spawn as ptySpawn } from "@lydell/node-pty";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pnpmDir = join(repo, "node_modules/.pnpm");
const xtermDir = readdirSync(pnpmDir).find((d) => d.startsWith("@xterm+headless@"));
if (!xtermDir) throw new Error("no @xterm/headless under node_modules/.pnpm");
type Line = { translateToString(trim: boolean): string };
type Term = { write(d: string, cb?: () => void): void; buffer: { active: { length: number; cursorX: number; cursorY: number; baseY: number; getLine(i: number): Line | undefined } } };
const { Terminal } = createRequire(import.meta.url)(join(pnpmDir, xtermDir, "node_modules/@xterm/headless")) as { Terminal: new (o: object) => Term };

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = argv.slice(0, sep);
const flag = (f: string) => (opts.indexOf(f) >= 0 ? opts[opts.indexOf(f) + 1] : undefined);
const at = (flag("--at") ?? "100,500,2000").split(",").map(Number);
const cols = Number(flag("--cols") ?? 100);
const rows = Number(flag("--rows") ?? 30);
const term = new Terminal({ cols, rows, allowProposedApi: true });
const p = ptySpawn(join(process.env.HOME!, ".bun/bin/bun"), [join(repo, "bin/paw.ts"), ...argv.slice(sep + 1)], { name: "xterm-256color", cols, rows, cwd: flag("--cwd") ?? process.cwd(), env: process.env as Record<string, string> });
p.onData((d) => term.write(d));
const t0 = Date.now();
const typeText = flag("--type");
if (typeText !== undefined) setTimeout(() => p.write(typeText.replace(/\\r/g, "\r")), Number(flag("--type-at") ?? 30));
const dump = (label: string) => {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)!.translateToString(true));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  console.log(`──── ${label} (cursor ${b.cursorY + b.baseY},${b.cursorX}) ────\n${lines.slice(-rows).join("\n")}`);
};
for (const ms of at) setTimeout(() => term.write("", () => dump(`+${ms}ms`)), ms);
setTimeout(() => {
  p.write("\x15");
  setTimeout(() => p.write("\x04"), 100);
}, Math.max(...at) + 50);
const code = await new Promise<number>((r) => p.onExit(({ exitCode }) => r(exitCode)));
await new Promise((r) => term.write("", () => r(undefined)));
dump(`exit ${code} after ${Date.now() - t0}ms`);
process.exit(0);

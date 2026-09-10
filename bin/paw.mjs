#!/usr/bin/env node
/**
 * Package bin for `pnpm paw` / `npx` / a PATH symlink. Runs the TS composition root through tsx
 * so a clone does not need a `dist/` build. Daemons still resolve through daemonRoot() (release
 * snapshot or PAW_RELEASE=dev), never through this file.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(root, "bin", "paw.ts");
if (!existsSync(tsx)) {
  console.error(`paw: tsx is missing at ${tsx} — run \`pnpm install\` in the paw checkout first.`);
  process.exit(1);
}
const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

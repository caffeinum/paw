#!/usr/bin/env node
/**
 * Package bin for `pnpm paw` / `npx` / a PATH symlink, so a clone needs no `dist/` build. Daemons
 * still resolve through daemonRoot() (release snapshot or PAW_RELEASE=dev), never through this file.
 *
 * Node >= 22.18 strips TypeScript itself, so the common case IMPORTS bin/paw.ts in this very process
 * — no tsx, no second process. Two cases still need tsx: an older node, and a checkout that lives
 * under node_modules (`npx github:…` installs there), where node refuses to strip types by design.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "bin", "paw.ts");
const [maj, min] = process.versions.node.split(".").map(Number);
const native = maj > 23 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18);
const underNodeModules = root.split(sep).includes("node_modules");

if (native && !underNodeModules) {
  await import(pathToFileURL(entry).href);
} else {
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsx)) {
    console.error(`paw: node ${process.versions.node} can't run TypeScript here and tsx is missing at ${tsx} — use node >= 22.18, or run \`pnpm install\` in the paw checkout.`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

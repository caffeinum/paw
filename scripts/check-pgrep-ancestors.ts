/**
 * check:pgrep — paw's daemon detection sees its caller's OWN ANCESTORS (2026-11-07). macOS pgrep excludes them by
 * default, so a paw command run inside an agent (a descendant of its space's manager) could not see that manager:
 * `paw restart --full --space <own space>` printed "no manager running", adopted it, and bounced nothing.
 *
 * A fake manager (a node process carrying the real `cotald.ts supervise --space <s> --server` signature) spawns a
 * child that runs managerProcs / scanDaemons for <s>: both must report the parent. Hermetic: no mesh, no daemons.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const space = `pgrepprobe${process.pid}`;
const lifecycle = join(import.meta.dirname, "..", "src", "lifecycle.ts");
const child = `
  const { managerProcs, scanDaemons } = await import(${JSON.stringify(lifecycle)});
  console.log(JSON.stringify({ parent: process.ppid, procs: managerProcs(${JSON.stringify(space)}), scan: [...scanDaemons(${JSON.stringify(space)}).manager.keys()] }));
`;
// the fake manager: argv carries the signature; it runs the child and relays its stdout
// one line: `pgrep -l` prints a command line only up to its first newline (real daemon argv has none)
const parent = `const r = require("node:child_process").spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { encoding: "utf8" }); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);`;
const r = spawnSync(process.execPath, ["-e", parent, "cotald.ts", "supervise", "--space", space, "--server", "nats://127.0.0.1:1"], { encoding: "utf8" });
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const line = r.stdout.trim().split("\n").pop() ?? "";
let got: { parent: number; procs: number[]; scan: number[] } | undefined;
try {
  got = JSON.parse(line);
} catch {
  ok("the probe ran", false, `${r.stdout}\n${r.stderr}`);
}
if (got) {
  ok("managerProcs sees the caller's own ancestor manager", got.procs.includes(got.parent), JSON.stringify(got));
  ok("scanDaemons sees it too", got.scan.includes(got.parent), JSON.stringify(got));
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

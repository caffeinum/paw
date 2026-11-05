/**
 * Real-daemon check of the keeper's multi-space sleep sweep (no claude): two isolated spaces, each with a REAL
 * mesh + manager and an opted-in registered agent, plus a third opted-in space with NO manager. The keeper's
 * `sweepOtherSpaces` must reach both running managers on their own handles, skip the third without starting
 * anything, and `paw sleep --sweep --dry-run` must report per-agent verdicts read-only.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/e2e-sleep-spaces.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePersonaFile, setFolderName, setPersonaKeys } from "../src/addressing.ts";
import { ensure, managerProcs, stop } from "../src/lifecycle.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { pawServer } from "../src/server.ts";
import { spacesWithOptIns, sweepOtherSpaces } from "../src/sleep.ts";

const home = process.env.PAW_HOME?.trim();
const base = process.env.PAW_SPACE?.trim();
if (!home || home === join(homedir(), ".paw") || !base || base === "paw") throw new Error("run isolated: PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev");
process.env.PAW_RUNTIME ??= "pty";
const [a, b, c] = [`${base}-a`, `${base}-b`, `${base}-c`];
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const folders: string[] = [];
const optIn = (space: string, name: string) => {
  const folder = mkdtempSync(join(tmpdir(), `pawsleep-e2e-${name}-`));
  folders.push(folder);
  setFolderName(space, folder, name);
  ensurePersonaFile(space, name);
  setPersonaKeys(space, name, { cwd: folder, hibernate: "60m" });
};

try {
  for (const s of [a, b]) {
    const t0 = Date.now();
    await ensure({ needMesh: true, needManager: true, space: s });
    console.log(`manager up for ${s} in ${Date.now() - t0}ms`);
  }
  optIn(a, "sa");
  optIn(b, "sb");
  optIn(c, "sc");
  ok("all three spaces are found as having opted-in agents", [a, b, c].every((s) => spacesWithOptIns().includes(s)), spacesWithOptIns().join());

  const lines: string[] = [];
  const res = await sweepOtherSpaces("paw", { log: (l) => lines.push(l) });
  console.log(JSON.stringify(res));
  ok(`${a} swept on its real manager`, res.some((r) => r.space === a && Array.isArray(r.slept) && !r.error), JSON.stringify(res.find((r) => r.space === a)));
  ok(`${b} swept on its real manager`, res.some((r) => r.space === b && Array.isArray(r.slept) && !r.error), JSON.stringify(res.find((r) => r.space === b)));
  ok(`${c} (no manager here) skipped`, res.find((r) => r.space === c)?.skipped === "no manager of this machine runs it");
  ok(`no manager was started for ${c}`, managerProcs(c).length === 0);
  ok("nothing was logged as failed", !lines.some((l) => /failed/.test(l)), lines.join(" | "));

  const cli = (space: string) => {
    try {
      return { out: execFileSync(process.execPath, [join(import.meta.dirname, "..", "bin", "paw.mjs"), "sleep", "--sweep", "--dry-run", "--space", space], { encoding: "utf8", env: process.env }), code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
    }
  };
  const ra = cli(a);
  console.log(ra.out.trim());
  ok(`paw sleep --sweep --dry-run --space ${a} prints the verdict`, ra.code === 0 && /sa: awake — not live/.test(ra.out) && /dry run — nothing touched/.test(ra.out));
  const rc = cli(c);
  ok(`paw sleep --sweep --dry-run --space ${c} refuses (no manager) and starts none`, rc.code !== 0 && /no manager of this machine runs space/.test(rc.out) && managerProcs(c).length === 0, rc.out.trim());
} finally {
  for (const s of [a, b]) {
    await stop({ space: s }).catch((e) => console.error(`teardown stop ${s}:`, (e as Error).message));
    await purgeTestSpace(s, pawServer(s)).catch((e) => {
      console.error(`teardown purge ${s}:`, (e as Error).message);
      process.exitCode = 1;
    });
  }
  for (const f of folders) rmSync(f, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : process.exitCode ?? 0);

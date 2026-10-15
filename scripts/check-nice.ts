/**
 * `paw nice`: arg parse (show / set one / --apply, values 0-20, fail loud) and the process-tree pid set.
 * Pure — no ps, no renice. Run: pnpm check:nice
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-nice-home-"));
const { parseNiceArgs, treePids } = await import("../src/commands/nice.ts");

let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`nice: ${m}`);
  n++;
  console.log(`  ok  ${m}`);
};
const throws = (argv: string[]) => {
  try {
    parseNiceArgs(argv);
    return false;
  } catch {
    return true;
  }
};

ok(parseNiceArgs([]).name === undefined && !parseNiceArgs([]).apply, "no args = show");
ok(parseNiceArgs(["--apply"]).apply, "--apply");
const one = parseNiceArgs(["evals", "15"]);
ok(one.name === "evals" && one.value === 15, "<name> <n> sets one agent");
ok(parseNiceArgs(["evals", "0"]).value === 0, "0 = normal priority");
ok(throws(["evals"]) && throws(["evals", "21"]) && throws(["evals", "-5"]) && throws(["evals", "low"]) && throws(["--fast"]) && throws(["evals", "5", "--apply"]), "missing value, out of range, negative, non-number, unknown flag, set+apply all fail loud");
const procs = { roots: [1], ageMs: 0, items: [{ pid: 2, kind: "task" as const, label: "x", ageMs: 0, ports: [], pids: [2, 3] }, { pid: 4, kind: "mcp" as const, label: "m", ageMs: 0, ports: [], pids: [4, 2] }] };
ok(treePids(procs).sort().join() === "1,2,3,4", "tree pids: roots + every subtree, deduped");

console.log(`✓ check:nice — ${n} assertions`);

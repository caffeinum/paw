/**
 * `paw tidy`: which agents get asked about which processes (background tasks + orphans the running agent
 * detached; never MCP/hooks; age + size floors; abandoned orphans excluded) and the arg parse. Pure — no
 * ps, no mesh. Run: pnpm check:tidy
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-tidy-home-"));
const { tidyAsks, parseTidyArgs } = await import("../src/commands/tidy.ts");

let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`tidy: ${m}`);
  n++;
  console.log(`  ok  ${m}`);
};

const H = 3_600_000;
const item = (pid: number, kind: "task" | "bg" | "mcp" | "hook", ageMs: number, mem: number, ports: number[] = []) => ({ pid, kind, label: `p${pid}`, ageMs, mem, ports, pids: [pid] });
const fleet = {
  agents: {
    evals: { roots: [1], ageMs: 10 * H, items: [item(10, "task", 2 * H, 1200, [3000]), item(11, "mcp", 10 * H, 50), item(12, "hook", 2 * H, 30), item(13, "task", 60_000, 900)] },
    kit: { roots: [2], ageMs: 20 * H, items: [item(20, "bg", 15 * H, 1)] },
    quiet: { roots: [3], ageMs: 5 * H, items: [] },
  },
  orphans: [
    { agent: "quiet", ...item(30, "bg", 3 * H, 100) }, // younger than its agent → detached on purpose → ask
    { agent: "evals", ...item(31, "bg", 70 * H, 15, [47811]) }, // older than its agent → abandoned → never asked
    { agent: "gone", ...item(32, "bg", 5 * H, 500) }, // agent not live → abandoned
  ],
};
const now = 1_000 * H;
const asks = tidyAsks(fleet as never, now, { olderMs: H, minMb: 20 });
const by = Object.fromEntries(asks.map((a) => [a.agent, a.items.map((i) => i.pid)]));
ok(JSON.stringify(by.evals) === "[10]", "evals: old big task asked; mcp, hook and the 1-minute task skipped");
ok(!by.kit, "kit: a 1 MB shell is under the size floor");
ok(JSON.stringify(by.quiet) === "[30]", "an orphan the running agent detached is its to answer for");
ok(!by.gone && !Object.values(by).flat().includes(31), "abandoned orphans are never asked (nobody to ask)");
ok(asks.find((a) => a.agent === "evals")!.text.includes(":3000") && asks[0].text.includes("pid 10"), "the DM names pid and port");
ok(tidyAsks(fleet as never, now, { olderMs: H, minMb: 20, names: ["quiet"] }).map((a) => a.agent).join() === "quiet", "names filter");

const a = parseTidyArgs(["--older", "30m", "--min-mb", "5", "-n", "evals"]);
ok(a.olderMs === 30 * 60_000 && a.minMb === 5 && a.dryRun && a.names[0] === "evals", "args parse");
let threw = 0;
for (const bad of [["--older", "soon"], ["--min-mb", "x"], ["--kill"]])
  try {
    parseTidyArgs(bad);
  } catch {
    threw++;
  }
ok(threw === 3, "bad duration, bad number, unknown flag all fail loud");

console.log(`✓ check:tidy — ${n} assertions`);

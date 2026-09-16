/**
 * `paw optimize [--since 24h] [--dry-run] [<name>…]` — give memory back by restarting agents that have
 * not been ACTIVE (transcript written) for longer than the cutoff. A claude process grows the longer it
 * runs (measured 2026-09-16: 133h agents at ~640MB came back at ~350MB), and every agent resumes its
 * pinned session, so restarting one nobody is using costs context nothing.
 *
 * The procedure is the careful one done by hand that day, including what went wrong in it:
 *  - never touch an agent that is doing something: live + idle, no turn in flight, no queued/unread DM,
 *    and nothing written to its transcript for the whole `--since` window;
 *  - never touch a session two processes already hold (a leftover `<name>_2` duplicate) — reported, the
 *    operator decides;
 *  - one agent at a time, re-checked right before its restart (the fleet changes while this runs), paced
 *    by machine load, verified afterwards: the agent is back under ITS OWN name and alone on its session.
 *    (That day's first run came back as eight `<name>_2` agents; spawn now hard-pins the name.)
 * Memory is the process tree's macOS phys_footprint (claude + its MCP servers), before and after; where
 * `footprint` isn't available no number is printed rather than a guessed one.
 */
import { execFileSync } from "node:child_process";
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { psRowAlive, restartAgent, type PsRow } from "../addressing.js";
import { withManagerControl } from "../control.js";
import { ensure, resolveSpace } from "../lifecycle.js";
import { liveSessionProcs, type LiveSessionProc } from "../named.js";
import { awaitSpawnHeadroom } from "../pacing.js";
import { collectStatus, type AgentStatus } from "../status.js";

export interface OptimizeArgs {
  space?: string;
  sinceMs: number;
  dryRun: boolean;
  names: string[];
}

/** `<n><m|h|d>` → ms. Anything else throws — a cutoff paw guessed at would restart the wrong agents. */
export function parseWindow(v: string | undefined, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(v ?? "");
  if (!m) throw new Error(`paw: ${flag} needs a duration like 30m, 24h or 2d (got ${v === undefined ? "nothing" : `"${v}"`})`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

export function parseOptimizeArgs(argv: string[]): OptimizeArgs {
  const out: OptimizeArgs = { sinceMs: parseWindow("24h", "--since"), dryRun: false, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") out.sinceMs = parseWindow(argv[++i], "--since");
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — optimize [--since 24h] [--dry-run] [<name>…]`);
    else out.names.push(a);
  }
  return out;
}

export type Verdict = { act: "restart"; idleMs: number; pid: number } | { act: "skip"; reason: string } | { act: "recent" };

/** Pure: should this agent be restarted now? `procs` = live processes holding its pinned session. */
export function optimizeVerdict(row: AgentStatus, procs: LiveSessionProc[], now: number, opts: { sinceMs: number }): Verdict {
  if (row.unregistered) return { act: "skip", reason: "unregistered — paw can't bring it back" };
  if (row.harness && row.harness !== "claude") return { act: "skip", reason: `${row.harness} agent` };
  if (!row.live) return { act: "skip", reason: "not running" };
  if (row.activeMs === undefined) return { act: "skip", reason: "last activity unknown" };
  const idleMs = now - row.activeMs;
  if (idleMs < opts.sinceMs) return { act: "recent" };
  if (row.runtime === "fg") return { act: "skip", reason: "foreground `paw claude` — lives in your terminal" };
  if (!row.pin || !row.durable) return { act: "skip", reason: "no resumable session — a restart would lose its context" };
  if (procs.length === 0) return { act: "skip", reason: "no process found on its session" };
  if (procs.length > 1) return { act: "skip", reason: `${procs.length} processes on one session (pids ${procs.map((p) => p.pid).join(", ")}) — a duplicate; resolve it first` };
  const proc = procs[0];
  if (row.mesh !== "idle" || row.busy) return { act: "skip", reason: row.busy ? "mid-turn" : row.mesh };
  if (row.inbox.kind === "lag" && (row.inbox.queued > 0 || row.inbox.unread > 0)) return { act: "skip", reason: "DMs waiting" };
  if (row.inbox.kind !== "lag" && row.inbox.kind !== "none") return { act: "skip", reason: "inbox state unknown" };
  return { act: "restart", idleMs, pid: proc.pid };
}

/** phys_footprint (MB) of `pid` and its descendants, or undefined when it can't be measured. */
export function treeFootprintMb(pid: number): number | undefined {
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    const kids = new Map<number, number[]>();
    for (const line of ps.trim().split("\n")) {
      const [c, p] = line.trim().split(/\s+/).map(Number);
      kids.set(p, [...(kids.get(p) ?? []), c]);
    }
    const tree: number[] = [];
    const walk = (p: number) => { tree.push(p); for (const k of kids.get(p) ?? []) walk(k); };
    walk(pid);
    let total = 0;
    for (const p of tree) {
      const out = execFileSync("footprint", ["-p", String(p)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
      if (m) total += Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as const)[m[2] as "KB" | "MB" | "GB"];
    }
    return Math.round(total);
  } catch {
    return undefined;
  }
}

const hours = (ms: number) => `${Math.round(ms / 3_600_000)}h`;
const mb = (v: number | undefined) => (v === undefined ? "?" : `${v}MB`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function optimize(argv: string[]): Promise<void> {
  const args = parseOptimizeArgs(argv);
  const space = args.space ?? resolveSpace();
  const { server } = await ensure({ needMesh: true, needManager: true, space });
  const opts = { sinceMs: args.sinceMs };

  await withManagerControl(space, server, async (ctl) => {
    const pick = (rows: AgentStatus[]) => (args.names.length ? rows.filter((r) => args.names.includes(r.name)) : rows);
    const first = pick((await collectStatus(space, ctl)).rows);
    for (const n of args.names) if (!first.some((r) => r.name === n)) throw new Error(`paw: no registered agent "${n}"`);

    const verdictOf = (row: AgentStatus) => optimizeVerdict(row, row.pin ? liveSessionProcs(row.pin) : [], Date.now(), opts);
    const plan = first.map((row) => ({ row, v: verdictOf(row) }));
    const todo = plan.filter((p) => p.v.act === "restart");
    const skipped = plan.filter((p) => p.v.act === "skip" && (args.names.length || p.row.live));
    console.log(`paw optimize — inactive for over ${hours(args.sinceMs)}: ${todo.length} to restart, ${skipped.length} skipped`);
    for (const { row, v } of todo) if (v.act === "restart") console.log(`  • ${row.name}  last active ${hours(v.idleMs)} ago  ${mb(treeFootprintMb(v.pid))}`);
    for (const { row, v } of skipped) if (v.act === "skip") console.log(`  – ${row.name}: ${v.reason}`);
    if (args.dryRun || !todo.length) return;

    const results: Array<{ name: string; before?: number; after?: number; error?: string }> = [];
    for (const { row } of todo) {
      // The fleet moves while this runs: re-read this agent right before touching it.
      const fresh = (await collectStatus(space, ctl)).rows.find((r) => r.name === row.name);
      const v = fresh ? verdictOf(fresh) : ({ act: "skip", reason: "gone" } as Verdict);
      if (v.act !== "restart") {
        console.log(`  – ${row.name}: now ${v.act === "skip" ? v.reason : "active again"}, left alone`);
        continue;
      }
      const before = treeFootprintMb(v.pid);
      const headroom = await awaitSpawnHeadroom({ onWait: (load, thr) => console.log(`    load ${load.toFixed(0)} > ${thr}, waiting before ${row.name}…`) });
      if (headroom === "gave-up") console.log(`    still loaded — restarting ${row.name} anyway`);
      try {
        await restartAgent(ctl, { space, name: row.name, cwd: fresh!.folder });
        const ps = await ctl.ps();
        const rows = ps.ok ? ((ps.data as PsRow[]) ?? []) : [];
        const self = rows.find((r) => r.name === row.name);
        const strays = rows.filter((r) => new RegExp(`^${row.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[_-]\\d+$`).test(r.name)).map((r) => r.name);
        const holders = liveSessionProcs(fresh!.pin!);
        if (!self || !psRowAlive(self)) throw new Error(`not back on the mesh under "${row.name}"`);
        if (strays.length) throw new Error(`a duplicate came up (${strays.join(", ")})`);
        if (holders.length !== 1) throw new Error(`${holders.length} processes now hold its session`);
        await sleep(5000); // let the new process settle before measuring it
        const after = treeFootprintMb(holders[0].pid);
        results.push({ name: row.name, before, after });
        console.log(`  ✓ ${row.name}  ${mb(before)} → ${mb(after)}`);
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0];
        results.push({ name: row.name, before, error: msg });
        console.log(`  ✗ ${row.name}: ${msg} — stopping here; check \`paw status\` before running again`);
        break;
      }
    }
    const ok = results.filter((r) => !r.error);
    const measured = ok.filter((r) => r.before !== undefined && r.after !== undefined);
    const freed = measured.reduce((s, r) => s + (r.before! - r.after!), 0);
    console.log(`✓ restarted ${ok.length}${measured.length ? `, ${freed >= 0 ? "freed" : "grew"} ${Math.abs(freed)}MB` : ""}${results.length > ok.length ? `, 1 failed` : ""}`);
  });
}

const optimizeCommand: Command = {
  kind: "command",
  name: "optimize",
  group: "Lifecycle",
  summary: "restart long-running idle agents to give memory back (each resumes its session)",
  usage: "optimize [--since 24h] [--dry-run] [<name>…]",
  run: (a) => optimize([...a.raw]),
};

registry.register(optimizeCommand);

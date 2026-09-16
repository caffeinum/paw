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
 * An agent whose folder was deleted (a merged, cleaned-up worktree) can never be restarted there, so it
 * is STOPPED instead — same idle checks — and its transcript is left for `paw adopt --resume` elsewhere.
 * Memory is the process tree's macOS phys_footprint (claude + its MCP servers), before and after; where
 * `footprint` isn't available no number is printed rather than a guessed one.
 */
import { existsSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { psRowAlive, restartAgent, stopAgent, type PsRow } from "../addressing.js";
import { withManagerControl } from "../control.js";
import { fmtMb, machineLine, pawMb, renderTable, serverPorts, snapshotFleet, sortRows, topRows, verdictText, type Fleet } from "../fleet.js";
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

export type Verdict = { act: "restart" | "stop"; idleMs: number; pid: number } | { act: "skip"; reason: string } | { act: "recent" };

/** Pure: should this agent be restarted now? `procs` = live processes holding its pinned session. */
export function optimizeVerdict(row: AgentStatus, procs: Pick<LiveSessionProc, "pid">[], now: number, opts: { sinceMs: number; ports?: number[] }): Verdict {
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
  // A dev server it started in the background would be orphaned by a restart, not stopped.
  if (opts.ports?.length) return { act: "skip", reason: `has a live server on ${opts.ports.map((p) => `:${p}`).join(" ")}` };
  // Its folder was deleted (a merged/cleaned worktree): it can never be restarted there, so a restart
  // is impossible and leaving it running only holds memory. Stop it; the transcript stays resumable.
  if (!existsSync(row.folder)) return { act: "stop", idleMs, pid: proc.pid };
  return { act: "restart", idleMs, pid: proc.pid };
}

const hours = (ms: number) => (ms >= 48 * 3_600_000 ? `${Math.round(ms / 86_400_000)}d` : `${Math.round(ms / 3_600_000)}h`);
const mb = fmtMb;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The agent's tree footprint right now (after a restart the process — and its pid — is new). */
const memOf = async (space: string, name: string) => (await snapshotFleet(space, { sampleMs: 0 })).agents[name]?.mem;

async function optimize(argv: string[]): Promise<void> {
  const args = parseOptimizeArgs(argv);
  const space = args.space ?? resolveSpace();
  const { server } = await ensure({ needMesh: true, needManager: true, space });

  await withManagerControl(space, server, async (ctl) => {
    const pick = (rows: AgentStatus[]) => (args.names.length ? rows.filter((r) => args.names.includes(r.name)) : rows);
    const [status, fleet] = await Promise.all([collectStatus(space, ctl, { git: false }), snapshotFleet(space)]);
    const first = pick(status.rows);
    for (const n of args.names) if (!first.some((r) => r.name === n)) throw new Error(`paw: no registered agent "${n}"`);

    const verdictOf = (row: AgentStatus, f: Fleet) =>
      optimizeVerdict(row, row.pin ? liveSessionProcs(row.pin) : [], Date.now(), { sinceMs: args.sinceMs, ports: serverPorts(f.agents[row.name]) });
    const plan = new Map(first.map((row) => [row.name, verdictOf(row, fleet)]));
    const todo = first.filter((r) => ["restart", "stop"].includes(plan.get(r.name)!.act));
    const shown = first.filter((r) => plan.get(r.name)!.act !== "recent" && (args.names.length || r.live));
    const stops = todo.filter((r) => plan.get(r.name)!.act === "stop").length;
    const now = Date.now();
    console.log(machineLine(fleet.machine, pawMb(fleet)));
    console.log(`paw optimize — inactive for over ${hours(args.sinceMs)}: ${todo.length - stops} to restart, ${stops} to stop (folder gone), ${shown.length - todo.length} skipped\n`);
    const rows = topRows(first, fleet, now, (row) => verdictText(plan.get(row.name)!)).filter((r) => shown.some((s) => s.name === r.name));
    console.log(renderTable(sortRows(rows, "mem"), { width: process.stdout.columns ?? 160, now, noteHeader: "VERDICT" }));
    if (args.dryRun || !todo.length) return;

    const results: Array<{ name: string; before?: number; after?: number; error?: string }> = [];
    const stopped: Array<{ name: string; freed?: number }> = [];
    for (const row of todo) {
      // The fleet moves while this runs: re-read this agent (and what it's running) right before touching it.
      const [freshStatus, freshFleet] = await Promise.all([collectStatus(space, ctl, { git: false }), snapshotFleet(space, { sampleMs: 0 })]);
      const fresh = freshStatus.rows.find((r) => r.name === row.name);
      const v = fresh ? verdictOf(fresh, freshFleet) : ({ act: "skip", reason: "gone" } as Verdict);
      if (v.act !== "restart" && v.act !== "stop") {
        console.log(`  – ${row.name}: now ${v.act === "skip" ? v.reason : "active again"}, left alone`);
        continue;
      }
      const before = freshFleet.agents[row.name]?.mem;
      if (v.act === "stop") {
        if (!(await stopAgent(ctl, row.name))) {
          console.log(`  ✗ ${row.name}: the manager didn't stop it — stopping here; check \`paw status\``);
          break;
        }
        stopped.push({ name: row.name, freed: before });
        console.log(`  ■ ${row.name} stopped, ${mb(before)} freed — resume it elsewhere: paw adopt <folder> --resume ${fresh!.pin}`);
        continue;
      }
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
        await sleep(30_000); // a resumed claude peaks while it loads its transcript; 5s measured that spike (+169MB), not the steady state
        const after = await memOf(space, row.name);
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
    const freed = measured.reduce((s, r) => s + (r.before! - r.after!), 0) + stopped.reduce((s, r) => s + (r.freed ?? 0), 0);
    console.log(`✓ restarted ${ok.length}, stopped ${stopped.length}${measured.length || stopped.length ? `, ${freed >= 0 ? "freed" : "grew"} ${mb(Math.abs(freed))}` : ""}${results.length > ok.length ? `, 1 failed` : ""}`);
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

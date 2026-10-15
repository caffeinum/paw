/**
 * `paw tidy [--older 1h] [--min-mb 20] [--dry-run] [--space s] [<name>…]` — ask every live agent that
 * holds background processes (dev servers, test runs, detached jobs) whether it still uses them, and to
 * stop the ones it doesn't. Only the agent knows: cotal's `idle` means "the turn ended", not "nothing
 * pending" (cotal feedback 431c9f15), so a subagent's dev server looks exactly like a forgotten one from
 * the outside. paw never kills an agent's process itself — it lists them in a DM and the agent answers.
 * Orphans whose agent is gone are printed as `kill` hints for the operator, same as `paw top`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { sendAsYou } from "../dm.ts";
import { fmtMb, orphanAbandoned, snapshotFleet, type Fleet, type Item } from "../fleet.ts";
import { resolveSpace } from "../lifecycle.ts";
import { pawServer } from "../server.ts";
import { ago } from "../status.ts";

export interface TidyArgs {
  space?: string;
  olderMs: number;
  minMb: number;
  dryRun: boolean;
  names: string[];
}

const USAGE = "tidy [--older 1h] [--min-mb 20] [--dry-run] [<name>…]";

export function parseDuration(s: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(s);
  if (!m) throw new Error(`paw: bad duration "${s}" — use e.g. 30m, 2h, 1d`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

export function parseTidyArgs(argv: string[]): TidyArgs {
  const out: TidyArgs = { olderMs: 3_600_000, minMb: 20, dryRun: false, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--older") out.olderMs = parseDuration(argv[++i] ?? "");
    else if (a === "--min-mb") {
      out.minMb = Number(argv[++i]);
      if (!Number.isFinite(out.minMb)) throw new Error(`paw: --min-mb needs a number — ${USAGE}`);
    } else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${USAGE}`);
    else out.names.push(a);
  }
  return out;
}

export interface Ask {
  agent: string;
  items: Item[];
  text: string;
}

const describe = (it: Item, now: number) =>
  `${it.label}${it.ports.map((p) => ` :${p}`).join("")} (pid ${it.pid}${it.mem === undefined ? "" : `, ${fmtMb(it.mem)}`}, ${ago(now - it.ageMs, now)} old)`;

/** Which live agents to ask about which processes. Background tasks and orphans the running agent
 *  detached count; MCP servers, hooks and tracepaper don't (they belong to the harness). Small or young
 *  ones are skipped — a 1 MB shell or a server started a minute ago isn't worth a turn. */
export function tidyAsks(fleet: Fleet, now: number, opts: { olderMs: number; minMb: number; names?: string[] }): Ask[] {
  const worth = (it: Item) => it.ageMs >= opts.olderMs && (it.mem === undefined || it.mem >= opts.minMb);
  const held = new Map<string, Item[]>();
  for (const [agent, procs] of Object.entries(fleet.agents))
    for (const it of procs.items) if ((it.kind === "task" || it.kind === "bg") && worth(it)) held.set(agent, [...(held.get(agent) ?? []), it]);
  for (const o of fleet.orphans)
    if (!orphanAbandoned(o, fleet) && worth(o)) held.set(o.agent, [...(held.get(o.agent) ?? []), o]);
  return [...held]
    .filter(([agent]) => !opts.names?.length || opts.names.includes(agent))
    .map(([agent, items]) => ({
      agent,
      items,
      text:
        `housekeeping: you have background processes running — ${items.map((it) => describe(it, now)).join("; ")}. ` +
        "are you still using them? stop the ones you don't need. reply in one line: what you killed, what you keep and why.",
    }));
}

export const SWEEP_EVERY_MS = 6 * 3_600_000;
const SWEEP_FLOORS = { olderMs: 2 * 3_600_000, minMb: 100 };

interface SweepState {
  lastRunMs: number;
  /** agent → pids already asked about (pids are reused eventually; the age floor makes a false skip harmless) */
  asked: Record<string, number[]>;
}

function statePath(space: string): string {
  return join(process.env.PAW_HOME ?? join(homedir(), ".paw"), "spaces", space, "tidy.json");
}

function readState(space: string): SweepState {
  let raw: string;
  try {
    raw = readFileSync(statePath(space), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lastRunMs: 0, asked: {} };
    throw e;
  }
  return JSON.parse(raw) as SweepState;
}

/** Pure: drop items already asked about; prune remembered pids to the ones still alive in the fleet. */
export function freshAsks(asks: Ask[], state: SweepState, livePids: Set<number>): { asks: Ask[]; asked: Record<string, number[]> } {
  const asked: Record<string, number[]> = {};
  for (const [a, pids] of Object.entries(state.asked)) {
    const alive = pids.filter((p) => livePids.has(p));
    if (alive.length) asked[a] = alive;
  }
  const out: Ask[] = [];
  for (const a of asks) {
    const known = new Set(asked[a.agent] ?? []);
    if (a.items.some((it) => !known.has(it.pid))) out.push(a); // anything new → ask about the whole current list
    asked[a.agent] = [...new Set([...known, ...a.items.map((it) => it.pid)])];
  }
  return { asks: out, asked };
}

/** The keeper tick's sweep: at most once per SWEEP_EVERY_MS, DM agents about NEW background processes. */
export async function tidySweep(space: string, now = Date.now()): Promise<string[]> {
  const state = readState(space);
  if (now - state.lastRunMs < SWEEP_EVERY_MS) return [];
  const fleet = await snapshotFleet(space);
  const live = new Set([...Object.values(fleet.agents).flatMap((a) => a.items), ...fleet.orphans].map((it) => it.pid));
  const { asks, asked } = freshAsks(tidyAsks(fleet, now, SWEEP_FLOORS), state, live);
  const server = pawServer();
  for (const a of asks) await sendAsYou({ space, server, target: a.agent, text: a.text });
  mkdirSync(dirname(statePath(space)), { recursive: true });
  writeFileSync(statePath(space), JSON.stringify({ lastRunMs: now, asked } satisfies SweepState));
  return asks.map((a) => a.agent);
}

async function tidy(argv: string[]): Promise<void> {
  const args = parseTidyArgs(argv);
  const space = args.space ?? resolveSpace();
  const fleet = await snapshotFleet(space);
  const now = Date.now();
  for (const n of args.names) if (!fleet.agents[n]) throw new Error(`paw: no running agent "${n}" in space ${space}`);
  const asks = tidyAsks(fleet, now, args);
  const abandoned = fleet.orphans.filter((o) => orphanAbandoned(o, fleet) && (!args.names.length || args.names.includes(o.agent)));

  if (!asks.length) console.log(`nothing to ask — no live agent holds background work older than ${ago(now - args.olderMs, now)} and ≥${args.minMb} MB`);
  const server = pawServer();
  for (const a of asks) {
    const list = a.items.map((it) => describe(it, now)).join(", ");
    if (args.dryRun) {
      console.log(`would ask ${a.agent}: ${list}`);
      continue;
    }
    await sendAsYou({ space, server, target: a.agent, text: a.text });
    console.log(`asked ${a.agent}: ${list}`);
  }
  if (abandoned.length) console.log(`orphans left by earlier runs (nobody to ask): kill ${abandoned.map((o) => o.pid).join(" ")}`);
  if (asks.length && !args.dryRun) console.log("replies land in `paw inbox`");
}

const tidyCommand: Command = {
  kind: "command",
  name: "tidy",
  group: "Lifecycle",
  summary: "ask agents holding background processes whether they still use them",
  usage: USAGE,
  run: (a) => tidy([...a.raw]),
};

registry.register(tidyCommand);

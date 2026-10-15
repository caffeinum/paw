/**
 * `paw tidy [--older 1h] [--min-mb 20] [--dry-run] [--space s] [<name>…]` — ask every live agent that
 * holds background processes (dev servers, test runs, detached jobs) whether it still uses them, and to
 * stop the ones it doesn't. Only the agent knows: cotal's `idle` means "the turn ended", not "nothing
 * pending" (cotal feedback 431c9f15), so a subagent's dev server looks exactly like a forgotten one from
 * the outside. paw never kills an agent's process itself — it lists them in a DM and the agent answers.
 * Orphans whose agent is gone are printed as `kill` hints for the operator, same as `paw top`.
 */
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

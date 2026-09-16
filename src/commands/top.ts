/**
 * `paw top [--sort mem|cpu|active|name] [-v] [--all] [--json] [<name>…]` — every paw agent with the
 * memory and CPU its whole process tree is using, when it was last active, and what is running inside
 * it: a Bash call it is stuck in, background tasks and the servers they hold, its MCP servers. Plus
 * processes an agent left behind (orphans) and a hint per row for cleaning up. It never acts — every
 * hint is a command that exists, for the operator to run. The same table is `paw optimize --dry-run`.
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { withManagerControl } from "../control.js";
import { resolveSpace } from "../lifecycle.js";
import { ago, collectStatus } from "../status.js";
import { writeJson } from "../stdout.js";
import {
  color,
  fmtMb,
  hintFor,
  machineLine,
  orphanAbandoned,
  pawMb,
  renderTable,
  serverPorts,
  snapshotFleet,
  sortRows,
  topRows,
  type Item,
} from "../fleet.js";
import { optimizeVerdict } from "./optimize.js";

const DAY = 86_400_000;

export interface TopArgs {
  space?: string;
  sort: string;
  verbose: boolean;
  all: boolean;
  json: boolean;
  names: string[];
}

export function parseTopArgs(argv: string[]): TopArgs {
  const out: TopArgs = { sort: "mem", verbose: false, all: false, json: false, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sort") out.sort = argv[++i] ?? "";
    else if (a === "-v" || a === "--verbose") out.verbose = true;
    else if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — top [--sort mem|cpu|active|name] [-v] [--all] [--json] [<name>…]`);
    else out.names.push(a);
  }
  sortRows([], out.sort); // fail loud on a bad --sort before any work
  return out;
}

const line = (it: Item, now: number) =>
  `${String(it.pid).padStart(6)}  ${`${it.label}${it.ports.map((p) => ` :${p}`).join("")}`.slice(0, 30).padEnd(30)}${fmtMb(it.mem).padStart(6)}  ${ago(now - it.ageMs, now).padEnd(4)}`;

async function top(argv: string[]): Promise<void> {
  const args = parseTopArgs(argv);
  const space = args.space ?? resolveSpace();
  // Read-only: it never boots daemons (a dead manager fails loud below), which also skips ensure's own ps round-trip.
  const [status, fleet] = await Promise.all([
    withManagerControl(space, DEFAULT_SERVER, (ctl) => collectStatus(space, ctl, { git: false })),
    snapshotFleet(space, { all: args.all }),
  ]);
  const now = Date.now();
  const names = new Set(status.rows.map((r) => r.name));
  const hints = new Map<string, { text: string; cmd?: string }>();
  const width = process.stdout.columns ?? 160;
  let rows = topRows(
    status.rows,
    fleet,
    now,
    (row, procs) => {
      const verdict = optimizeVerdict(row, (procs?.roots ?? []).map((pid) => ({ pid, mesh: true })), now, { sinceMs: DAY, ports: serverPorts(procs) });
      const h = hintFor(row, procs, verdict, now, names);
      if (!h) return undefined;
      hints.set(row.name, h);
      return h.cmd ? `${h.cmd}  ${color.dim(`(${h.text})`)}` : color.dim(h.text);
    },
  );
  for (const n of args.names) if (!rows.some((r) => r.name === n)) throw new Error(`paw: no running agent "${n}" in space ${space}`);
  if (args.names.length) rows = rows.filter((r) => args.names.includes(r.name));
  rows = sortRows(rows, args.sort);

  if (args.json) {
    writeJson({ space, now, machine: fleet.machine, measured: fleet.measured, agents: rows.map((r) => ({ ...status.rows.find((s) => s.name === r.name), state: r.state, mem: r.mem, cpu: r.cpu, hint: hints.get(r.name), procs: fleet.agents[r.name] })), orphans: fleet.orphans, other: fleet.other, errors: status.errors });
    return;
  }

  const sumMem = (xs: Array<number | undefined>) => (fleet.measured ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : undefined);
  const agentProcs = Object.values(fleet.agents);
  const pawTotal = pawMb(fleet);
  console.log(machineLine(fleet.machine, pawTotal));
  if (!fleet.measured) console.log(color.yellow("footprint unavailable — memory shown as ?"));
  console.log("");
  console.log(renderTable(rows, { width, now, noteHeader: "HINT", verbose: args.verbose }));

  if (fleet.orphans.length) {
    console.log(`\n${color.bold("ORPHANS")} ${color.dim("— reparented to launchd, still carrying an agent's name")}`);
    for (const o of fleet.orphans) {
      const tail = orphanAbandoned(o, fleet) ? `kill ${o.pid}` : color.dim(`detached by the running ${o.agent} — its work, not cleanup`);
      console.log(`${line(o, now)}  ${o.agent.padEnd(16)}  ${tail}`);
    }
  }
  if (args.all && fleet.other.length) {
    console.log(`\n${color.dim("NOT PAW — claude processes outside the mesh")}`);
    for (const o of fleet.other) console.log(color.dim(line(o, now)));
  }

  const items = agentProcs.flatMap((a) => a.items);
  const of = (k: Item["kind"][]) => items.filter((i) => k.includes(i.kind));
  const cls = (label: string, xs: Item[]) => (xs.length ? `${label} ×${xs.length} ${fmtMb(sumMem(xs.map((x) => x.mem)))}` : undefined);
  const claudeMb = fleet.measured ? (pawTotal ?? 0) - (sumMem([...items, ...fleet.orphans].map((x) => x.mem)) ?? 0) : undefined;
  console.log(
    "\n" +
      color.dim(
        [`claude ×${agentProcs.length} ${fmtMb(claudeMb)}`, cls("mcp", of(["mcp"])), cls("tracepaper", of(["tp"])), cls("bg", of(["task", "bg"])), cls("orphans", fleet.orphans)]
          .filter(Boolean)
          .join(" · "),
      ),
  );

  const abandoned = fleet.orphans.filter((o) => orphanAbandoned(o, fleet));
  const kills = abandoned.map((o) => o.pid);
  const stops = [...hints].filter(([, h]) => h.cmd?.startsWith("paw stop")).map(([n]) => n);
  const optimize = [...hints].filter(([, h]) => h.cmd?.startsWith("paw optimize")).map(([n]) => n);
  const nowMb = sumMem([...abandoned.map((o) => o.mem), ...stops.map((n) => fleet.agents[n]?.mem)]);
  const cmds = [
    kills.length ? `kill ${kills.join(" ")}` : "",
    ...stops.map((n) => hints.get(n)!.cmd!),
    optimize.length ? `paw optimize --since 24h ${color.dim(`(${optimize.length} idle >24h, holding ${fmtMb(sumMem(optimize.map((n) => fleet.agents[n]?.mem)))})`)}` : "",
  ].filter(Boolean);
  if (cmds.length) console.log(`reclaimable now ≈ ${fmtMb(nowMb)}: ${cmds.join(" · ")}`);
  for (const e of status.errors) console.error(color.dim(e));
}

const topCommand: Command = {
  kind: "command",
  name: "top",
  group: "Lifecycle",
  summary: "every agent's memory, cpu, last activity and subprocesses, with a hint to clean up",
  usage: "top [--sort mem|cpu|active|name] [-v] [--all] [--json] [<name>…]",
  run: (a) => top([...a.raw]),
};

registry.register(topCommand);

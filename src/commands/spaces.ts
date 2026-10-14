/**
 * `paw spaces` — what the broker is holding, per space. `paw spaces prune` — the dry-run plan for
 * deleting dead spaces' streams; `--yes` executes it. See src/prune.ts for what "dead" means.
 *
 * Read-only unless `prune --yes`. Never boots a mesh (an unreachable broker fails loud).
 */
import { registry, type Command } from "@cotal-ai/core";
import { attributeStreams, executePrune, fmtAge, gatherProtected, parseDuration, planPrune, readBroker, type SpaceRow } from "../prune.ts";
import { pawServer } from "../server.ts";
import { writeJson } from "../stdout.ts";

const USAGE = "spaces [prune [--yes] [--keep <space>]… [--min-idle <dur, default 1h>]] [--json]";

export interface SpacesArgs {
  prune: boolean;
  yes: boolean;
  keep: string[];
  minIdleMs: number;
  json: boolean;
  /** bin injects the current space; it is protected like a --keep. */
  space?: string;
}

export function parseSpacesArgs(argv: string[]): SpacesArgs {
  const out: SpacesArgs = { prune: false, yes: false, keep: [], minIdleMs: 3_600_000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${a} needs a value — ${USAGE}`);
      return v;
    };
    if (a === "prune" && i === 0) out.prune = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--keep") out.keep.push(value());
    else if (a === "--min-idle") out.minIdleMs = parseDuration(value());
    else if (a === "--json") out.json = true;
    else if (a === "--space") out.space = value();
    else throw new Error(`paw: unexpected "${a}" — ${USAGE}`);
  }
  if (!out.prune && (out.yes || out.keep.length > 0 || out.minIdleMs !== 3_600_000)) throw new Error(`paw: --yes/--keep/--min-idle belong to \`paw spaces prune\` — ${USAGE}`);
  return out;
}

const mb = (b: number): string => `${(b / 1048576).toFixed(1)}MB`;
const row = (s: SpaceRow, now: number): string =>
  `${s.space.padEnd(28)} ${String(s.streams.length).padStart(4)} ${mb(s.bytes).padStart(9)} ${String(s.msgs).padStart(7)} ${String(s.consumers).padStart(5)}  ${fmtAge(now - s.lastActive).padStart(4)} ago`;
const HEADER = `${"SPACE".padEnd(28)} ${"STRM".padStart(4)} ${"BYTES".padStart(9)} ${"MSGS".padStart(7)} ${"CONS".padStart(5)}  LAST`;

async function spaces(argv: string[]): Promise<void> {
  const args = parseSpacesArgs(argv);
  const server = pawServer();
  const now = Date.now();
  const { spaces: bySpace, unowned } = attributeStreams(await readBroker(server));
  if (!args.prune) {
    const rows = [...bySpace.values()].sort((a, b) => b.lastActive - a.lastActive);
    if (args.json) return writeJson({ server, spaces: rows.map(({ streams, ...r }) => ({ ...r, streams: streams.length })), unowned });
    console.log(HEADER);
    for (const r of rows) console.log(row(r, now));
    console.log(`${rows.length} spaces · ${rows.reduce((n, r) => n + r.streams.length, 0)} streams${unowned.length ? ` · ${unowned.length} unattributed` : ""} on ${server}`);
    return;
  }
  const plan = planPrune(bySpace, unowned, gatherProtected(args.space ? [...args.keep, args.space] : args.keep), now, args.minIdleMs);
  const sum = (rs: SpaceRow[]) => ({ spaces: rs.length, streams: rs.reduce((n, r) => n + r.streams.length, 0), bytes: rs.reduce((n, r) => n + r.bytes, 0), consumers: rs.reduce((n, r) => n + r.consumers, 0) });
  const removeSum = sum(plan.remove);
  if (args.json && !args.yes) {
    return writeJson({
      server,
      dryRun: true,
      remove: plan.remove.map((r) => ({ space: r.space, streams: r.streams.length, bytes: r.bytes, lastActive: r.lastActive })),
      keep: plan.keep.map(({ row: r, reason }) => ({ space: r.space, reason })),
      unowned: plan.unowned.map((r) => r.name),
      totals: removeSum,
    });
  }
  console.log(`keep (${plan.keep.length}):`);
  for (const { row: r, reason } of plan.keep) console.log(`  ${r.space.padEnd(28)} ${reason}`);
  if (plan.unowned.length) console.log(`unattributed streams, never touched (${plan.unowned.length}): ${plan.unowned.map((r) => r.name).join(" ")}`);
  console.log(`\nremove (${removeSum.spaces}):`);
  console.log(`  ${HEADER}`);
  for (const r of plan.remove) console.log(`  ${row(r, now)}`);
  console.log(`\n${removeSum.spaces} spaces · ${removeSum.streams} streams · ${mb(removeSum.bytes)} · ${removeSum.consumers} consumers on ${server}`);
  if (!args.yes) {
    console.log("dry run — nothing deleted. Re-run with --yes to delete these spaces' streams.");
    return;
  }
  await executePrune(server, plan, (r) => console.log(`deleted ${r.space} (${r.streams.length} streams)`));
  console.log(`pruned ${removeSum.spaces} spaces (${removeSum.streams} streams, ${mb(removeSum.bytes)})`);
}

const spacesCommand: Command = {
  kind: "command",
  name: "spaces",
  group: "Lifecycle",
  summary: "streams the broker holds per space; `prune` deletes dead spaces' streams (dry run unless --yes)",
  usage: USAGE,
  run: (a) => spaces([...a.raw]),
};

registry.register(spacesCommand);

/**
 * `paw nice [<name> <0-20>] [--apply]` — per-agent CPU priority. New launches run under `nice -n <n>`
 * (src/connector.ts; persona `nice:` > PAW_NICE > 10), so builds, tests and dev servers an agent starts
 * only get the CPU the operator's own apps leave free.
 *  - no args: each live agent's configured vs actual priority.
 *  - `<name> <n>`: write `nice: n` to the persona AND renice the agent's running process tree now.
 *  - `--apply`: renice every live agent to its configured value — the default takes effect without a restart.
 * renice only changes scheduling; it never stops, restarts or interrupts an agent.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { personaFilePath, setPersonaKeys } from "../addressing.ts";
import { snapshotFleet, type AgentProcs } from "../fleet.ts";
import { resolveSpace } from "../lifecycle.ts";
import { parseNice, readNice } from "../session.ts";

const USAGE = "nice [<name> <0-20>] [--apply]";

export function parseNiceArgs(argv: string[]): { space?: string; name?: string; value?: number; apply: boolean } {
  const out: { space?: string; name?: string; value?: number; apply: boolean } = { apply: false };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-") && !/^-?\d+$/.test(a)) throw new Error(`paw: unknown flag "${a}" — ${USAGE}`);
    else pos.push(a);
  }
  if (pos.length === 1 || pos.length > 2) throw new Error(`paw: give a name AND a value — ${USAGE}`);
  if (pos.length === 2) {
    if (out.apply) throw new Error(`paw: --apply renices the whole fleet; drop it to set one agent — ${USAGE}`);
    out.name = pos[0];
    out.value = parseNice(pos[1], "the command line");
  }
  return out;
}

/** Every pid in the agent's tree: its roots plus each subprocess subtree. */
export function treePids(procs: AgentProcs): number[] {
  return [...new Set([...procs.roots, ...procs.items.flatMap((it) => it.pids)])];
}

function renice(pids: number[], n: number): number {
  let done = 0;
  for (const pid of pids) {
    try {
      execFileSync("/usr/bin/renice", [String(n), "-p", String(pid)], { stdio: "ignore" });
      done++;
    } catch {
      // the process exited between the snapshot and now — nothing to renice
    }
  }
  return done;
}

function actualNice(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "nice=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

const configured = (space: string, name: string) => {
  const file = personaFilePath(space, name);
  return readNice(existsSync(file) ? file : undefined);
};

async function nice(argv: string[]): Promise<void> {
  const args = parseNiceArgs(argv);
  const space = args.space ?? resolveSpace();
  const fleet = await snapshotFleet(space);

  if (args.name !== undefined) {
    if (!existsSync(personaFilePath(space, args.name))) throw new Error(`paw: no agent "${args.name}" in space ${space}`);
    setPersonaKeys(space, args.name, { nice: String(args.value) });
    const procs = fleet.agents[args.name];
    if (!procs) return console.log(`✓ ${args.name}: nice ${args.value} — not running; applies at its next start`);
    const pids = treePids(procs);
    const n = renice(pids, args.value!);
    console.log(`✓ ${args.name}: nice ${args.value} — reniced ${n}/${pids.length} running process(es) now`);
    // macOS lets a user lower priority but never raise it back without root.
    if (n < pids.length) console.log(`  the rest exited, or were already lower than ${args.value} (raising priority needs root: \`sudo renice ${args.value} -p <pid>\`, or it applies at the next restart)`);
    return;
  }

  const live = Object.entries(fleet.agents).sort(([a], [b]) => a.localeCompare(b));
  if (args.apply) {
    for (const [name, procs] of live) {
      const want = configured(space, name);
      console.log(`${name.padEnd(18)} nice ${String(want).padStart(2)}  reniced ${renice(treePids(procs), want)}`);
    }
    return;
  }
  console.log(`${"NAME".padEnd(18)} WANT  NOW`);
  for (const [name, procs] of live) console.log(`${name.padEnd(18)} ${String(configured(space, name)).padStart(4)}  ${actualNice(procs.roots[0]).padStart(3)}`);
}

const niceCommand: Command = {
  kind: "command",
  name: "nice",
  group: "Lifecycle",
  summary: "per-agent CPU priority (default 10): show, set + renice live, or --apply to the whole fleet",
  usage: USAGE,
  run: (a) => nice([...a.raw]),
};

registry.register(niceCommand);

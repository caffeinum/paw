/**
 * `paw stop <name|folder> [--name n]` — stop one managed agent via the control plane (the ADMIN
 * `stop` op, through addressing's `stopAgent`). Unlike cotal's flags-only `stop --name`, the
 * positional resolves the folder-addressed way paw's other verbs do: a registered agent NAME
 * (reverse lookup) or a folder mapped in the registry — the simpler subset of `paw rm`'s
 * resolution (no worktree/github handles; those agents are still stoppable by name). Read-only on
 * the registry: never registers a folder just to stop it. `--name` is the cotal-parity escape
 * hatch: it goes STRAIGHT to the manager, no registry resolution — the manager legitimately holds
 * agents paw's registry doesn't know (an auto-numbered duplicate like `web-2`, a raw
 * `paw cotal start`), and those must stay stoppable.
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  canonicalDir,
  folderForName,
  lookupFolderName,
  stopAgent,
} from "../addressing.js";
import { withManagerControl } from "../control.js";
import { readForeground, unregisterForeground } from "../foreground.js";
import { resolveSpace } from "../lifecycle.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2") };

function parseArgs(argv: string[]): { space?: string; target?: string; rawName?: string } {
  const out: { space?: string; target?: string; rawName?: string } = {};
  const dupe = (): never => {
    throw new Error("paw: stop takes a single target — a positional OR --name, not both");
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--name") {
      const v = argv[++i];
      if (v === undefined) throw new Error("paw: --name needs a value");
      if (out.target !== undefined || out.rawName !== undefined) dupe();
      out.rawName = v;
    } else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — stop <name|folder> [--space s]`);
    else {
      if (out.target !== undefined || out.rawName !== undefined) dupe();
      out.target = a;
    }
  }
  return out;
}

/** Resolve a stop target to its agent name: a registered agent NAME first, else a folder whose
 *  registry mapping names the agent. Fails loud on an unmapped folder or an unknown token —
 *  never registers or spawns anything. */
export function resolveStopName(space: string, target: string): string {
  const byName = folderForName(space, target); // an agent NAME (reverse lookup)?
  if (byName) return target;

  let folder: string | undefined;
  try {
    folder = canonicalDir(target);
  } catch {
    folder = undefined; // not a folder — fall through to the unknown-target error
  }
  if (folder) {
    const name = lookupFolderName(space, folder);
    if (name) return name;
    throw new Error(`paw: no agent registered for ${folder} (\`paw status\` to list)`);
  }

  throw new Error(`paw: no agent "${target}" — not a registered name or a folder (\`paw ps\` for live names)`);
}

async function stop(argv: string[]): Promise<void> {
  const { space: spaceArg, target, rawName } = parseArgs(argv);
  if (!target && !rawName) throw new Error("paw: usage — stop <name|folder> (or stop --name <n>)");
  const space = spaceArg ?? resolveSpace();

  let name: string;
  if (rawName !== undefined) {
    name = rawName; // --name: raw manager name, no registry — reaches registry-less agents (web-2, `paw cotal start`)
  } else {
    assertUnambiguousTarget(space, target!); // a bare token that's BOTH a known name and a folder here → fail loud
    name = resolveStopName(space, target!);
  }

  // A FOREGROUND `paw claude` agent isn't a manager agent (stopAgent would no-op it) — SIGTERM its own
  // process and drop its registry entry so it stops for real.
  const fg = readForeground(space, name);
  if (fg) {
    try {
      process.kill(fg.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    unregisterForeground(space, name);
    console.log(`✓ stopped ${name} (foreground claude, pid ${fg.pid})`);
    return;
  }

  const stopped = await withManagerControl(space, DEFAULT_SERVER, (ctl) => stopAgent(ctl, name));
  if (stopped) console.log(`✓ stopped ${name}`);
  else console.log(c.dim(`"${name}" isn't running — nothing to stop`));
}

const stopCommand: Command = {
  kind: "command",
  name: "stop",
  group: "Mesh",
  summary: "stop a managed agent — stop <name|folder> (folder-aware; `paw chat`/`paw open` wakes it back up)",
  usage: "stop <name|folder> [--name <n>] [--space s]",
  run: (a) => stop([...a.raw]),
};

registry.register(stopCommand);

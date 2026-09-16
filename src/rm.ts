/**
 * `paw rm <name|folder|repo@branch|github:owner/repo>` — forget an agent: stop it if it's live, drop
 * its persona (which is its registration). The claude TRANSCRIPT is ALWAYS kept (the session is
 * the conversation history — `paw chat --fresh`/`paw adopt --resume <id>` can revive it). The remove
 * verb of the lifecycle set: chat --fresh = new, adopt = resume, rename = relabel, rm = forget.
 *
 * Resolves the target three ways (no spawning, no cloning): a registered agent NAME, a folder/handle
 * with a registered agent, or an orphaned persona (a personas/<name>.md with no folder). In
 * NEEDS_MANAGER so the mesh+manager are up to stop a live agent (a no-op if it's already offline).
 */
import { existsSync, rmSync } from "node:fs";
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { agentNamesForFolder, assertUnambiguousTarget, canonicalDir, folderForName, listAgents, lookupFolderName, personaFilePath, stopAgent } from "./addressing.js";
import { withManagerControl } from "./control.js";
import { readForeground, unregisterForeground } from "./foreground.js";
import { parseGithubHandle, repoDir } from "./github.js";
import { resolveSpace } from "./lifecycle.js";
import { readResumeId } from "./session.js";
import { parseWorktreeRef, resolveWorktreeFolder } from "./worktree.js";

function parseArgs(argv: string[]): { space?: string; target?: string } {
  const out: { space?: string; target?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — rm takes <name|folder|repo@branch|github:owner/repo>`);
    else if (out.target === undefined) out.target = a;
    else throw new Error(`paw: unexpected argument "${a}" — rm takes a single target`);
  }
  return out;
}

/** Resolve a target to the agent to forget: its name + folder (undefined for an orphaned persona with no
 *  folder). Tries agent name → folder/handle (its DEFAULT) → orphaned persona; never spawns or clones (a
 *  github handle resolves to its clone dir without fetching). Forgetting is deleting the persona, so an
 *  extra and a default are removed the same way — the folder's other agents are separate files. */
export function resolveRemoval(space: string, target: string): { name: string; folder?: string } {
  const byName = folderForName(space, target); // an agent NAME (default or extra)?
  if (byName) return { name: target, folder: byName };

  let folder: string | undefined; // a folder / worktree / github handle with a registered agent?
  try {
    if (target.startsWith("github:")) {
      const h = parseGithubHandle(target);
      folder = h ? repoDir(h.owner, h.repo) : undefined; // the clone dir — do NOT fetch
    } else if (parseWorktreeRef(target)) {
      folder = resolveWorktreeFolder(target);
    } else {
      folder = canonicalDir(target);
    }
  } catch {
    folder = undefined; // not a resolvable path/handle — fall through to the orphaned-persona check
  }
  if (folder) {
    const name = lookupFolderName(space, folder);
    if (name) return { name, folder };
    // The folder resolves but has no DEFAULT — only EXTRA instances (e.g. `paw chat <folder> --name x`
    // that never minted a default). Don't claim "no agent"; name the extras + point at removing by name.
    const extras = agentNamesForFolder(space, folder);
    if (extras.length) {
      throw new Error(
        `paw: ${folder} has no default agent, only extra instance(s): ${extras.join(", ")} — ` +
          `remove one by name (\`paw rm ${extras[0]}\`), or \`paw status\` to list`,
      );
    }
  }

  // An orphaned persona: a personas/<name>.md with no folder left (e.g. after a folder was re-registered
  // under a different name). Remove it by name.
  if (/^[A-Za-z0-9_-]+$/.test(target) && existsSync(personaFilePath(space, target))) return { name: target };

  throw new Error(`paw: no agent "${target}" in the registry (\`paw status\` to list)`);
}

async function rm(argv: string[]): Promise<void> {
  const { space: spaceArg, target } = parseArgs(argv);
  if (!target) throw new Error("paw: usage — rm <name|folder|repo@branch|github:owner/repo>");
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud

  const { name, folder } = resolveRemoval(space, target);
  const persona = personaFilePath(space, name);
  const pin = existsSync(persona) ? readResumeId(persona) : undefined;

  // A FOREGROUND `paw claude` agent isn't a manager agent — stop it by SIGTERMing its own process; only
  // fall through to the manager stop for a managed agent.
  const fg = readForeground(space, name);
  let stopped: boolean;
  if (fg) {
    try {
      process.kill(fg.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    unregisterForeground(space, name);
    stopped = true;
  } else {
    stopped = await withManagerControl(space, DEFAULT_SERVER, (ctl) => stopAgent(ctl, name)); // no-op if offline
  }
  rmSync(persona, { force: true }); // the persona IS the registration — deleting it forgets the agent

  console.log(`✓ removed "${name}"${stopped ? " (stopped + forgotten)" : " (forgotten)"} — persona deleted`);
  if (pin) {
    // The session may still belong to another agent (a second name for one conversation) — then there is
    // nothing to revive, and the adopt hint would be refused as two agents on one transcript.
    const holders = listAgents(space).map((a) => a.name).filter((n) => readResumeId(personaFilePath(space, n)) === pin);
    if (holders.length) console.log(`  its session ${pin} lives on in ${holders.map((n) => `"${n}"`).join(", ")} — nothing lost`);
    else console.log(`  transcript kept (session ${pin}) — revive with \`paw adopt${folder ? ` "${folder}"` : ""} --resume ${pin}\``);
  }
}

const rmCommand: Command = {
  kind: "command",
  name: "rm",
  group: "Mesh",
  summary: "forget an agent: stop if live, delete its persona (keeps the transcript) — rm <name|folder|repo@branch|github:owner/repo>",
  usage: "rm <name|folder|repo@branch|github:owner/repo>   (always keeps the claude transcript)",
  run: (a) => rm([...a.raw]),
};

registry.register(rmCommand);

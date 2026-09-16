/**
 * `paw rename <folder|name> <newname>` — relabel an agent: its persona file (the registry — folder,
 * resume pin + body carried over, `name:` frontmatter rewritten) and its live mesh name. The pin moves
 * with it, so the agent keeps its conversation. paw's OWN command, not a cotal verb. The set: chat
 * --fresh = new, adopt = resume a past session, rename = relabel an existing agent.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import {
  agentRecord,
  assertUnambiguousTarget,
  cleanAgentName,
  ensureAgentSpawned,
  folderForName,
  lookupFolderName,
  personaFilePath,
  stopAgent,
  withRegistryLock,
} from "./addressing.js";
import { withManagerControl } from "./control.js";
import { resolveSpace } from "./lifecycle.js";
import { resolveExistingFolderArg } from "./address.js";

function parseArgs(argv: string[]): { space?: string; target?: string; newName?: string } {
  const out: { space?: string; target?: string; newName?: string } = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — rename takes <folder|name> <newname> [--space <s>]`);
    else pos.push(a);
  }
  if (pos.length > 2) throw new Error(`paw: too many arguments — rename takes exactly <folder|name> <newname>`);
  out.target = pos[0];
  out.newName = pos[1];
  return out;
}

/** Resolve the first arg to a canonical folder: a known agent NAME (reverse lookup), a
 *  `<repo>@<branch>` worktree, or a plain folder path. */
function resolveTarget(space: string, arg: string): string {
  if (!arg.includes("@")) {
    const byName = folderForName(space, arg);
    if (byName) return byName;
  }
  return resolveExistingFolderArg(arg); // worktree or plain folder; a URL/gh:/web: handle fails loud (rename never clones/mints)
}

/**
 * Move an agent's on-disk identity from its current name to `desired`: the persona file IS the
 * registration, so moving it (and rewriting `name:`, the mesh identity) moves the folder, the pin, the
 * extra/default role and the body together. `currentName` names the specific agent at `canonical`
 * (an EXTRA is addressed by its own name); absent, the folder's DEFAULT is relabeled. Pure — no mesh.
 *
 * Fails loud on an empty/invalid name, a no-op, or a name already held by ANY other agent. Never
 * fabricates a hash-qualified fallback: the caller must pick a free name.
 */
export function renameAgentOnDisk(
  space: string,
  canonical: string,
  desired: string,
  currentName?: string,
): { from: string; to: string } {
  return withRegistryLock(space, () => {
    const named = currentName !== undefined && agentRecord(space, currentName)?.folder === canonical;
    const from = named ? currentName! : lookupFolderName(space, canonical);
    if (!from) {
      throw new Error(`paw: no agent is mapped for ${canonical} — nothing to rename (\`paw chat --fresh "${canonical}"\` first)`);
    }
    const to = cleanAgentName(desired);
    if (!to) throw new Error(`paw: "${desired}" has no usable name characters (allowed: letters, digits, _ and -)`);
    if (to === from) throw new Error(`paw: "${from}" already has that name — nothing to rename`);
    // Checked BEFORE anything moves, so a rejected rename leaves the agent exactly as it was.
    const holder = folderForName(space, to);
    if (holder !== undefined) throw new Error(`paw: the name "${to}" is already used by an agent at ${holder} — pick another`);
    const toFile = personaFilePath(space, to);
    renameSync(personaFilePath(space, from), toFile);
    writeFileSync(toFile, readFileSync(toFile, "utf8").replace(/^name:.*$/m, `name: ${to}`));
    return { from, to };
  });
}

async function rename(argv: string[]): Promise<void> {
  const { space: spaceArg, target, newName } = parseArgs(argv);
  if (!target || !newName) throw new Error(`paw: usage — paw rename <folder|name> <newname>`);
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud
  const canonical = resolveTarget(space, target);
  // An agent NAME renames that agent (default or extra); a folder path relabels the folder's default.
  const { from, to } = renameAgentOnDisk(space, canonical, newName, target);

  // If the agent is live under the old name, retire it and respawn under the new one — it resumes
  // via the moved persona pin. The mesh + manager are already up (rename is in NEEDS_MANAGER).
  const restarted = await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
    const wasLive = await stopAgent(ctl, from);
    if (wasLive) await ensureAgentSpawned(ctl, { space, name: to, cwd: canonical });
    return wasLive;
  });

  console.log(`✓ renamed "${from}" → "${to}"`);
  console.log(
    restarted
      ? `  live on the mesh as "${to}" (resumed)`
      : `  renamed on disk — \`paw chat ${to}\` to bring it up as "${to}"`,
  );
}

const renameCommand: Command = {
  kind: "command",
  name: "rename",
  group: "Mesh",
  summary: "rename an agent (mesh name + persona + folder map), keeping its session — rename <folder|name> <newname>",
  usage: "rename <folder|name> <newname>   (relabels the agent; resume pin carries over; restarts it if live)",
  run: (a) => rename([...a.raw]),
};

registry.register(renameCommand);

/**
 * `paw rename <folder|name> <newname>` — relabel an agent: its folder→name mapping (folders.json),
 * its persona file (resume pin + body carried over, `name:` frontmatter rewritten), and its live mesh
 * name. The pin moves with it, so the agent keeps its conversation. paw's OWN command, not a cotal
 * verb. The set: chat --fresh = new, adopt = resume a past session, rename = relabel an existing agent.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  ensureAgentSpawned,
  folderForName,
  lookupFolderName,
  personaFilePath,
  readAgentIndex,
  registerInstance,
  removeAgentName,
  setFolderName,
  stopAgent,
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
 * Move an agent's on-disk identity from its current name to `desired`: rename its registry entry and
 * move its persona file (preserving its `resume:` pin + body, rewriting the `name:` frontmatter so the
 * mesh identity matches). Pure — no mesh — so it's unit-testable. Returns the `{from, to}` names.
 *
 * Two kinds of agent, one entry each:
 *   - DEFAULT (folders.json, folder → its one default name): relabel via `setFolderName`. `currentName`
 *     is absent → the renamed agent is the folder's default (`lookupFolderName`). BYTE-IDENTICAL to the
 *     pre-multi-instance behavior.
 *   - EXTRA (agents.json, a 2nd+ agent minted via `--name`): `currentName` names the specific extra and
 *     `readAgentIndex(space)[currentName] === canonical` confirms it's an extra of THIS folder. Relabel
 *     by moving the agents.json key: `registerInstance` under the new name, then `removeAgentName` the
 *     old — the folder's DEFAULT is untouched (never call `setFolderName` for an extra).
 *
 * Fails loud on an empty/invalid name, a no-op, or a name already held by ANY other agent (a different
 * folder's default, another extra, or — for an extra rename — this folder's own default). Never
 * fabricates a hash-qualified fallback: the caller must pick a free name.
 */
export function renameAgentOnDisk(
  space: string,
  canonical: string,
  desired: string,
  currentName?: string,
): { from: string; to: string } {
  // An EXTRA is addressed by its own name; a DEFAULT by its folder. currentName (set only when the
  // rename target was an extra name) disambiguates which agent at the folder we're relabeling.
  const isExtra = currentName !== undefined && readAgentIndex(space)[currentName] === canonical;
  const current = isExtra ? currentName! : lookupFolderName(space, canonical);
  if (!current) {
    throw new Error(`paw: no agent is mapped for ${canonical} — nothing to rename (\`paw chat --fresh "${canonical}"\` first)`);
  }
  const cleaned = desired.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error(`paw: "${desired}" has no usable name characters (allowed: letters, digits, _ and -)`);
  if (cleaned === current) throw new Error(`paw: "${current}" already has that name — nothing to rename`);

  // The new name must be globally free. folderForName resolves every DEFAULT and EXTRA, and `cleaned`
  // isn't `current` (checked above), so ANY hit is a genuine clash — including one of THIS folder's own
  // extras (holder === canonical). Reject before mutating either registry: for a DEFAULT rename this is
  // the fix for the partial-write-then-throw bug where setFolderName would hash-qualify + commit
  // folders.json against a same-folder extra, then throw (losing the default's session). Same guard for
  // both branches.
  const holder = folderForName(space, cleaned);
  if (holder !== undefined) {
    throw new Error(`paw: the name "${cleaned}" is already used by an agent at ${holder} — pick another`);
  }

  let from: string;
  let to: string;
  if (isExtra) {
    // Register the new key FIRST (its own locked global-uniqueness guard fails loud without touching
    // the old entry), then drop the old key — so a rejected rename leaves the extra intact.
    to = registerInstance(space, canonical, cleaned);
    removeAgentName(space, current);
    from = current;
  } else {
    const { name, previous } = setFolderName(space, canonical, cleaned);
    if (name !== cleaned) {
      // Defensive: the holder check above already rejected every collision, so setFolderName cannot have
      // hash-qualified. Unreachable in practice — kept as a belt-and-suspenders that fails loud, never
      // silently accepts a mis-qualified default name.
      throw new Error(`paw: refusing to rename — "${cleaned}" resolved to "${name}" (unexpected name collision)`);
    }
    to = name;
    from = previous ?? current;
  }

  const fromFile = personaFilePath(space, from);
  const toFile = personaFilePath(space, to);
  if (existsSync(fromFile)) {
    if (fromFile !== toFile) renameSync(fromFile, toFile);
    // The persona's `name:` IS the agent's mesh identity — keep it in sync with the new file name.
    const body = readFileSync(toFile, "utf8").replace(/^name:.*$/m, `name: ${to}`);
    writeFileSync(toFile, body);
  }
  // No persona yet (agent never spawned) → the registry rename is enough; the next spawn writes one.
  return { from, to };
}

async function rename(argv: string[]): Promise<void> {
  const { space: spaceArg, target, newName } = parseArgs(argv);
  if (!target || !newName) throw new Error(`paw: usage — paw rename <folder|name> <newname>`);
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud
  const canonical = resolveTarget(space, target);
  // If the target is an EXTRA agent's name (agents.json key), rename THAT instance — not the folder's
  // default. A folder path / default name isn't an agents.json key, so currentName stays undefined and
  // the folder's default is relabeled (the unchanged 1:1 path).
  const currentName = readAgentIndex(space)[target] !== undefined ? target : undefined;

  const { from, to } = renameAgentOnDisk(space, canonical, newName, currentName);

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

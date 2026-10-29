/**
 * `paw rename <folder|name> <newname>` — relabel an agent: its persona file (the registry — folder,
 * resume pin + body carried over, `name:` frontmatter rewritten) and its live mesh name. The pin moves
 * with it, so the agent keeps its conversation. paw's OWN command, not a cotal verb. The set: chat
 * --fresh = new, adopt = resume a past session, rename = relabel an existing agent.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readSandbox, sandboxStateDir } from "./session.ts";
import { readSandboxHomeOwner, sandboxHomeDir, sandboxHomeOwnerFile } from "./sandbox.ts";
import { registry, type Command } from "@cotal-ai/core";
import {
  agentRecord,
  assertUnambiguousTarget,
  cleanAgentName,
  elsewhereHint,
  ensureAgentSpawned,
  folderForName,
  listAgents,
  lookupFolderName,
  personaFilePath,
  stopAgent,
  withRegistryLock,
} from "./addressing.ts";
import { resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { resolveExistingFolderArg } from "./address.ts";
import { renameInFleetJob } from "./commands/launchd.ts";
import { reassignOpenTasks } from "./tasks.ts";
import { renameInCompanies } from "./company-service.ts";

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

/**
 * A bare word that is neither an agent here nor a folder in the cwd (`paw rename 2027-skills skills` used
 * to die on `ENOENT: lstat '…/2027-skills'`). When an agent's REGISTERED folder has that basename and is
 * gone from disk, the operator renamed the folder, not the agent — point at `paw relocate`.
 */
export function noAgentNamed(space: string, word: string): string {
  const gone = listAgents(space).filter((a) => basename(a.folder) === word && !existsSync(a.folder));
  const hint = gone.length
    ? ` — ${gone.map((a) => `"${a.name}" ran in ${a.folder}`).join(", ")}, which is gone: if you moved that folder, \`paw relocate ${gone[0].name}#${space} <new-folder>\` makes the agent follow it`
    : elsewhereHint(space, word) || ` (\`paw status --space ${space}\` lists them)`;
  return `paw: no agent named "${word}" in space "${space}", and no folder ./${word} here${hint}`;
}

/** Resolve the first arg to a canonical folder: a known agent NAME (reverse lookup), a
 *  `<repo>@<branch>` worktree, or a plain folder path. */
function resolveTarget(space: string, arg: string): string {
  if (!arg.includes("@")) {
    const byName = folderForName(space, arg);
    if (byName) return byName;
    if (/^[A-Za-z0-9_.-]+$/.test(arg) && arg !== "." && arg !== ".." && !existsSync(resolve(arg))) throw new Error(noAgentNamed(space, arg));
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
    // A sandboxed agent's own claude store (its transcripts) is keyed by its name: it moves with the persona.
    const fromSandbox = sandboxStateDir(personaFilePath(space, from));
    const toSandbox = sandboxStateDir(toFile);
    if (existsSync(toSandbox)) throw new Error(`paw: ${toSandbox} already exists — a sandbox store for "${to}" is in the way; move it aside first`);
    // …and so is its persistent home ($PAW_HOME/containers/<name>, its ~/.env + installs) — when THIS space owns it.
    const carryHome = readSandbox(personaFilePath(space, from)) !== undefined && readSandboxHomeOwner(from) === space;
    if (carryHome) {
      for (const p of [sandboxHomeDir(to), sandboxHomeOwnerFile(to)])
        if (existsSync(p)) throw new Error(`paw: ${p} already exists — "${to}" already has a sandbox home (another space's agent, or a leftover); move it aside first`);
    }
    renameSync(personaFilePath(space, from), toFile);
    if (existsSync(fromSandbox)) renameSync(fromSandbox, toSandbox);
    if (carryHome) {
      if (existsSync(sandboxHomeDir(from))) renameSync(sandboxHomeDir(from), sandboxHomeDir(to));
      renameSync(sandboxHomeOwnerFile(from), sandboxHomeOwnerFile(to));
    }
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
  // Mesh + manager up BEFORE anything moves on disk (as the bin/paw.ts gate had it), on ONE control
  // handle that also serves ensure()'s probe — see ensureManagerOn.
  const { from, to, restarted } = await withEnsuredManager(
    space,
    async (ctl) => {
      // An agent NAME renames that agent (default or extra); a folder path relabels the folder's default.
      const { from, to } = renameAgentOnDisk(space, canonical, newName, target);
      // If the agent is live under the old name, retire it and respawn under the new one — it resumes
      // via the moved persona pin.
      const wasLive = await stopAgent(ctl, from);
      if (wasLive) await ensureAgentSpawned(ctl, { space, name: to, cwd: canonical });
      return { from, to, restarted: wasLive };
    },
    { ensureSpace: resolveSpace() },
  );

  const fleetPlist = renameInFleetJob(space, from, to);
  // The agent's queue follows it: open beads assigned to the old name would otherwise be orphaned.
  // The rename itself already happened, so a bd failure is reported loud with the fix, not swallowed.
  let moved: string[] = [];
  try {
    moved = await reassignOpenTasks(from, to);
  } catch (e) {
    process.exitCode = 1;
    console.error(`paw: ⚠ renamed, but couldn't move "${from}"'s open beads (${(e as Error).message}) — run: bd list -a ${from}  then  bd update <id> -a ${to}`);
  }

  // Companies keep the agent by NAME (metadata.org key + the lead's assignee) — follow it too.
  let companies: string[] = [];
  try {
    companies = await renameInCompanies(from, to);
  } catch (e) {
    process.exitCode = 1;
    console.error(`paw: ⚠ renamed, but couldn't update "${from}" in company rosters (${(e as Error).message}) — fix metadata.org on the company epic: bd show <epic> --json`);
  }

  console.log(`✓ renamed "${from}" → "${to}"`);
  if (companies.length) console.log(`  company roster(s) now say "${to}": ${companies.join(", ")}`);
  if (moved.length) console.log(`  moved ${moved.length} open bead(s) to "${to}": ${moved.join(", ")}`);
  if (fleetPlist) console.log(`  login fleet job now starts "${to}" (${fleetPlist}; takes effect at next login)`);
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

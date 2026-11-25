/**
 * `paw rename <folder|name> <newname>` — relabel an agent: its persona file (the registry — folder,
 * resume pin + body carried over, `name:` frontmatter rewritten) and its live mesh name. The pin moves
 * with it, so the agent keeps its conversation. paw's OWN command, not a cotal verb. The set: chat
 * --fresh = new, adopt = resume a past session, rename = relabel an existing agent.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readResumeId, readSandbox, sandboxStateDir } from "./session.ts";
import { readSandboxHomeOwner, sandboxHomeDir, sandboxHomeOwnerFile } from "./sandbox.ts";
import { registry, type Command } from "@cotal-ai/core";
import {
  agentRecord,
  assertUnambiguousTarget,
  cleanAgentName,
  defaultedSpace,
  elsewhereHint,
  ensureAgentSpawned,
  folderForName,
  listAgents,
  lookupFolderName,
  personaFilePath,
  stopAgent,
  withRegistryLock,
} from "./addressing.ts";
import { ensureSpaceFor, finishDetachedHandoff, handoffEnvKey, handoffLogPath, pawHomeDir, spawnDetachedHandoff, wakeAgent, withEnsuredManager } from "./lifecycle.ts";
import { readRenameTrail, withRename, writeRenameTrail } from "./rename-trail.ts";
import { dropSharedManagerControl } from "./control.ts";
import { pawServer } from "./server.ts";
import { moveCronJobs } from "./cron.ts";
import { spaceWasChosen } from "./space.ts";
import { assertMutableByName } from "./namespace.ts";
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
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — rename takes [<folder|name>] <newname> [--space <s>]`);
    else pos.push(a);
  }
  if (pos.length > 2) throw new Error(`paw: too many arguments — rename takes [<folder|name>] <newname>`);
  if (pos.length === 1) out.newName = pos[0]; // inside an agent: rename yourself
  else {
    out.target = pos[0];
    out.newName = pos[1];
  }
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
    // Read (and validate) the trail BEFORE anything moves: a corrupt renamed.json must fail the rename whole.
    const trail = readRenameTrail(space);
    const named = currentName !== undefined && agentRecord(space, currentName)?.folder === canonical;
    const from = named ? currentName! : lookupFolderName(space, canonical);
    if (!from) {
      throw new Error(`paw: no agent is mapped for ${canonical} — nothing to rename (\`paw chat --fresh "${canonical}"\` first)`);
    }
    // A teleported frozen copy (or another machine's agent) is not this machine's to relabel: renaming the
    // file here would split one identity in two (the seat elsewhere keeps the old name) — 2026-11-11.
    assertMutableByName(space, from, "rename");
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
    writeRenameTrail(space, withRename(trail, from, to)); // a chat filtered to the old name follows it (src/rename-trail.ts)
    return { from, to };
  });
}

/** Read-only refusals of `from → desired`, run where the caller sees them (a self-rename's own turn). */
export function assertRenamable(space: string, from: string, desired: string): string {
  const to = cleanAgentName(desired);
  if (!to) throw new Error(`paw: "${desired}" has no usable name characters (allowed: letters, digits, _ and -)`);
  if (to === from) throw new Error(`paw: "${from}" already has that name — nothing to rename`);
  const holder = folderForName(space, to);
  if (holder !== undefined) throw new Error(`paw: the name "${to}" is already used by an agent at ${holder} — pick another`);
  return to;
}

/** What a self-renamed agent is told when it comes back under its new name. */
export function renamedWakeText(from: string, to: string): string {
  return `↻ you are "${to}" now (renamed from "${from}"; same session) — carry on with your task`;
}

/** What a self-rename's two halves reach outside this module — real by default, stubbed by check:rename. */
export interface SelfRenameDeps {
  spawn: (space: string, sub: string[], key: string) => boolean;
  /** Open a turn watch on `name`: `wait` blocks until its turn has ended (settled), `idle` reads it once. */
  watch: (space: string, name: string) => Promise<{ wait: () => Promise<{ ended: true } | { ended: false; why: string }>; idle: () => Promise<{ ended: boolean; why: string }>; close: () => Promise<void> }>;
  renameNow: (space: string, target: string, newName: string, beforeMove: () => Promise<void>) => Promise<void>;
  wake: (space: string, name: string, text: string) => { ok: boolean; detail: string };
  finish: (space: string, key: string) => void;
  log: (line: string) => void;
}

const realDeps: SelfRenameDeps = {
  spawn: (space, sub, key) => spawnDetachedHandoff(space, "rename", sub, { PAW_SPACE: space }, { key, cwd: pawHomeDir() }),
  watch: async (space, name) => {
    const { turnReader, waitForTurnEnd, turnEnded } = await import("./archive.ts");
    const reader = await turnReader(space, name);
    return {
      wait: async () => {
        const w = await waitForTurnEnd({ read: reader.read, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (l) => console.log(l) });
        return w.ended ? { ended: true } : { ended: false, why: `did not finish its turn within ${Math.round(w.waitedMs / 60_000)}m (last: ${w.last})` };
      },
      idle: async () => turnEnded(await reader.read()),
      close: async () => {
        await reader.close();
        await dropSharedManagerControl(space, pawServer(space)); // the reader's shared handle would keep this one-shot child alive
      },
    };
  },
  renameNow: (space, target, newName, beforeMove) => renameNow(space, target, newName, beforeMove),
  wake: wakeAgent,
  finish: (space, key) => finishDetachedHandoff(space, "rename", key),
  log: (l) => console.log(l),
};

/**
 * `paw rename` run from INSIDE the agent being renamed. The rename restarts the agent, and the agent's
 * own turn is running this command: stopping it here would kill the command half-way (persona moved,
 * nobody respawned). So it hands off to a detached child keyed `rename.<name>` that waits for the turn
 * to END (as a self-archive does), then renames + respawns it, then DMs it under the new name so it
 * resumes. Every refusal runs here first, so the agent sees it.
 */
export function renameSelf(space: string, from: string, newName: string, d: SelfRenameDeps = realDeps): string {
  const to = assertRenamable(space, from, newName);
  // PAW_SPACE pins the child to this space (realDeps.spawn): COTAL_* is stripped from it, and a bare
  // resolveSpace() there (the manager/mailbox ensure) would otherwise land on the default space.
  if (!d.spawn(space, ["rename", from, to, "--space", space], from))
    throw new Error(`paw: a rename of "${from}" is already in flight — progress: ${handoffLogPath(space, "rename", from)}`);
  d.log(`⟳ "${from}" becomes "${to}" once THIS turn ends — end your turn now (a one-line reply).`);
  d.log(`  a detached child waits for the turn to end, renames you, restarts you as "${to}" on this same session and wakes you with a DM.`);
  d.log(`  progress: ${handoffLogPath(space, "rename", from)}`);
  return to;
}

/**
 * The detached child: wait for the turn to end (nothing is stopped mid-turn), check it is STILL idle right
 * before anything moves (an operator line typed during the wait starts a new turn — wait that one out too),
 * rename + respawn, and tell the agent either way: it ended its turn waiting to be woken.
 */
export async function renameChild(space: string, target: string, newName: string, d: SelfRenameDeps = realDeps): Promise<void> {
  try {
    d.log(`[${new Date().toISOString()}] rename: waiting for "${target}" to finish its turn…`);
    const watch = await d.watch(space, target);
    try {
      const w = await watch.wait();
      if (!w.ended) {
        const msg = `"${target}" ${w.why} — nothing was renamed`;
        const r = d.wake(space, target, `✕ paw rename gave up: ${msg}. Run \`paw rename <name>\` again and end your turn right after.`);
        if (!r.ok) console.error(`paw: couldn't tell ${target} (${r.detail})`);
        throw new Error(`paw: ${msg}`);
      }
      const beforeMove = async (): Promise<void> => {
        for (;;) {
          const now = await watch.idle();
          if (now.ended) return;
          d.log(`  a new turn started (${now.why}) — waiting for it to end before anything moves`);
          const again = await watch.wait();
          if (!again.ended) throw new Error(`"${target}" ${again.why} — nothing was renamed`);
        }
      };
      try {
        await d.renameNow(space, target, newName, beforeMove);
      } catch (e) {
        const r = d.wake(space, target, `✕ paw rename to "${newName}" failed: ${(e as Error).message} — you are still "${target}"; rerun \`paw rename <name>\`, or carry on with your task`);
        if (!r.ok) console.error(`paw: couldn't tell ${target} (${r.detail})`);
        throw e;
      }
    } finally {
      await watch.close();
    }
  } finally {
    d.finish(space, target);
  }
}

async function rename(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const { newName } = parsed;
  if (!newName) throw new Error(`paw: usage — paw rename [<folder|name>] <newname>`);
  // A defaulted space yields to the calling agent's own (COTAL_SPACE), as archive's does — an agent on team2027
  // renaming itself must not land in `paw`. (Not a CALLER_SPACE_VERBS entry: see archiveSpace.)
  const { archiveSpace, selfIn, callerIs } = await import("./archive.ts");
  const space = archiveSpace(parsed.space, spaceWasChosen(), process.env);
  if (process.env[handoffEnvKey("rename")] !== undefined) {
    if (parsed.target === undefined) throw new Error("paw: the detached rename child needs <name> <newname>");
    return renameChild(space, parsed.target, newName);
  }
  let target = parsed.target;
  if (target === undefined) {
    const me = await selfIn(space, process.env, "rename");
    if (!me) throw new Error(`paw: rename with one name renames the agent you are inside — none here; outside an agent: paw rename <folder|name> <newname>`);
    target = me;
  }
  if (agentRecord(space, target) !== undefined && callerIs(space, target, readResumeId(personaFilePath(space, target)))) {
    assertMutableByName(space, target, "rename");
    renameSelf(space, target, newName);
    return;
  }
  await renameNow(space, target, newName);
}

async function renameNow(spaceArg: string, target: string, newName: string, beforeMove?: () => Promise<void>): Promise<void> {
  const child = beforeMove !== undefined;
  const picked = defaultedSpace(target, spaceArg, true, (s) => `paw rename ${target}#${s} ${newName}`);
  if (picked.note) console.error(picked.note);
  const space = picked.space;
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud
  const canonical = resolveTarget(space, target);
  // Refused before the mesh is even touched: nothing moves for a record that isn't this machine's.
  const current = agentRecord(space, target)?.folder === canonical ? target : lookupFolderName(space, canonical);
  if (current) assertMutableByName(space, current, "rename");
  // Mesh + manager up BEFORE anything moves on disk (as the bin/paw.ts gate had it), on ONE control
  // handle that also serves ensure()'s probe — see ensureManagerOn.
  const { from, to, restarted } = await withEnsuredManager(
    space,
    async (ctl) => {
      await beforeMove?.(); // a self-rename: the agent must still be idle right before it is stopped
      // An agent NAME renames that agent (default or extra); a folder path relabels the folder's default.
      const { from, to } = renameAgentOnDisk(space, canonical, newName, target);
      // If the agent is live under the old name, retire it and respawn under the new one — it resumes
      // via the moved persona pin.
      const wasLive = await stopAgent(ctl, from);
      if (wasLive) await ensureAgentSpawned(ctl, { space, name: to, cwd: canonical });
      return { from, to, restarted: wasLive };
    },
    { ensureSpace: ensureSpaceFor(space) },
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

  // Its schedules follow it: the keeper fires only for a registered name, so a job left on the old one
  // never fires again. Loud with the fix on failure, like the beads above.
  let crons: string[] = [];
  try {
    crons = moveCronJobs(space, from, space, to);
  } catch (e) {
    process.exitCode = 1;
    console.error(`paw: ⚠ renamed, but couldn't move "${from}"'s cron jobs (${(e as Error).message}) — \`paw cron ls --space ${space}\`, then re-add them for "${to}"`);
  }

  console.log(`✓ renamed "${from}" → "${to}"`);
  if (crons.length) console.log(`  moved ${crons.length} cron job(s) to "${to}": ${crons.join(", ")}`);
  if (companies.length) console.log(`  company roster(s) now say "${to}": ${companies.join(", ")}`);
  if (moved.length) console.log(`  moved ${moved.length} open bead(s) to "${to}": ${moved.join(", ")}`);
  if (fleetPlist) console.log(`  login fleet job now starts "${to}" (${fleetPlist}; takes effect at next login)`);
  console.log(
    restarted
      ? `  live on the mesh as "${to}" (resumed)`
      : `  renamed on disk — \`paw chat ${to}\` to bring it up as "${to}"`,
  );
  if (child && restarted) {
    const r = wakeAgent(space, to, renamedWakeText(from, to));
    if (!r.ok) {
      process.exitCode = 1;
      console.error(`paw: renamed, but couldn't wake "${to}" (${r.detail}) — \`paw dm ${to} "carry on"\``);
    }
  }
}

const renameCommand: Command = {
  kind: "command",
  name: "rename",
  group: "Mesh",
  summary: "rename an agent (mesh name + persona + folder map), keeping its session — rename [<folder|name>] <newname> (one name inside an agent = itself)",
  usage: "rename [<folder|name>] <newname>   (relabels the agent; resume pin carries over; restarts it if live. Inside an agent, `rename <newname>` renames ITSELF once its turn ends, then wakes it under the new name)",
  run: (a) => rename([...a.raw]),
};

registry.register(renameCommand);

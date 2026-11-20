/**
 * `paw archive [<name|folder>]` / `paw unarchive <name>` / `paw archive --list` — retire an agent whose task is
 * done (the `/hire` flow: an agent named after a bead owns it through PR, merge and a prod check), keeping all it
 * takes to bring it back. `paw rm` forgets; archive retires.
 *
 * Why not `paw rm` on itself: measured (scripts/e2e-archive.ts part A, pty runtime) it does finish — the Bash child
 * outlives the seat's reap and deletes the persona — but it stops the agent in the middle of its own turn, keeps no
 * record to restore from, leaves the folder, cron jobs and GitHub watches behind. Self-archive
 * hands off like self-adopt / self-relocate (lifecycle `spawnDetachedHandoff`): every check runs in the caller, a
 * detached child (cwd outside the folder it may remove) waits until the agent's turn has ENDED — the same signals
 * `paw status` reads (`collectStatus`: presence + the transcript's turn markers) — then retires it. The wait is
 * bounded ({@link IDLE_WAIT_MS}); an agent that never goes idle is left alone and told so, never stopped mid-turn.
 * From outside, archive waits the same way unless `--now`.
 *
 * Retiring = stop it (a foreground `paw claude` too) → its persona (= its registration, folder mapping included)
 * moves to `personas/archived/` with a record (src/archive-store.ts) → off every revival path → its folder removed
 * when it is a merged, clean, pushed, unused linked worktree (src/archive-worktree.ts), else kept with the reasons.
 * The transcript is never touched. Revival paths: live.json + restart-revive.json lose the name; cron jobs and
 * GitHub watches/mutes/queued DMs move into the record; sleep state is cleared; the office bridge walks it out
 * once its row is gone; everything else (`paw start [--boot]`, DM wakes, the artil relay, branch/author GitHub
 * follows) reads registered personas, and there is none.
 *
 * `paw unarchive` refuses a name or session taken since, puts a removed worktree back (`git worktree add`, branch
 * kept) and the persona back; the agent stays offline until `paw start`/a chat, which resumes its pinned session.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CotalEndpoint, registry, type Command } from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  humanEndpointAuth,
  lookupOwnedFolderName,
  personaFilePath,
  pinOwnsSession,
  stopAgent,
  withRegistryLock,
  listAgents,
  agentRecord,
} from "./addressing.ts";
import { archivedPersonaPath, listArchived, markRestored, newestArchived, recordPath, reserveBase, writeArchiveRecord, type ArchiveRecord, type Archived } from "./archive-store.ts";
import { cwdHoldersUnder, judgeWorktree, realGh, realGit, recreateWorktree, removeWorktree, type WorktreeVerdict } from "./archive-worktree.ts";
import { dropFromLiveRecord } from "./boot-live.ts";
import { fleetJobStarts } from "./commands/launchd.ts";
import { sharedManagerControl } from "./control.ts";
import { takeCronJobs } from "./cron.ts";
import { readForeground, unregisterForeground } from "./foreground.ts";
import { forgetAgent } from "./github-relay.ts";
import { machineName } from "./host-stamp.ts";
import {
  finishDetachedHandoff,
  handoffEnvKey,
  handoffInFlight,
  handoffLogPath,
  pawHomeDir,
  resolveSpace,
  restartInFlight,
  spawnDetachedHandoff,
  wakeAgent,
  withEnsuredManager,
} from "./lifecycle.ts";
import { heldOnMesh, assertMutableByName } from "./namespace.ts";
import { isSelfAncestor, liveSessionProcs, liveSessionProcsMany } from "./named.ts";
import { dropFromReviveList } from "./revive.ts";
import { resolveRemoval, sandboxHomeKept } from "./rm.ts";
import { reapSandbox } from "./sandbox.ts";
import { isRemoteSpace, meshTls, pawServer } from "./server.ts";
import { personaTranscriptRoots, personaValue, readAgentType, readCwd, readResumeId, readSandbox, transcriptPath } from "./session.ts";
import { clearSleep, sleepState } from "./sleep-state.ts";
import { collectStatus } from "./status.ts";
import { spaceWasChosen } from "./space.ts";

/** How long a self-archive (or an archive from outside without --now) waits for the agent's turn to end. */
export const IDLE_WAIT_MS = 30 * 60_000;
/** Idle must hold this long — a turn that ends and a DM that starts the next are seconds apart. */
export const IDLE_SETTLE_MS = 8_000;
const IDLE_POLL_MS = 4_000;
/** After the stop: how long the agent's processes get to leave its folder before the worktree is judged. */
const CWD_RELEASE_MS = 15_000;
const SESSION_RELEASE_MS = 30_000;
const BY_ENV = "PAW_ARCHIVE_BY";
const NAME_RE = /^[A-Za-z0-9_-]+$/;

const ARCHIVE_USAGE =
  "archive [<name|folder>] [--keep-worktree] [--now] [--space s]   (no name inside an agent = itself, once its turn ends) · archive --list [--space s]";
const UNARCHIVE_USAGE = "unarchive <name> [--space s]   (persona + mapping back, removed worktree re-added; left offline — `paw start <name>` resumes its session)";

export interface ArchiveArgs {
  space?: string;
  target?: string;
  keepWorktree: boolean;
  now: boolean;
  list: boolean;
}

export function parseArchiveArgs(argv: string[]): ArchiveArgs {
  const out: ArchiveArgs = { keepWorktree: false, now: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--space") {
      const v = argv[++i];
      if (!v) throw new Error("paw: --space needs a value");
      out.space = v;
    } else if (a === "--keep-worktree") out.keepWorktree = true;
    else if (a === "--now") out.now = true;
    else if (a === "--list") out.list = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${ARCHIVE_USAGE}`);
    else if (out.target === undefined) out.target = a.replace(/^@(?=[A-Za-z0-9_])/, "");
    else throw new Error(`paw: unexpected argument "${a}" — archive takes one agent`);
  }
  if (out.list && (out.target || out.keepWorktree || out.now)) throw new Error("paw: archive --list takes only --space");
  return out;
}

export function parseUnarchiveArgs(argv: string[]): { space?: string; name: string } {
  let space: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--space") {
      space = argv[++i];
      if (!space) throw new Error("paw: --space needs a value");
    } else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${UNARCHIVE_USAGE}`);
    else if (name === undefined) name = a.replace(/^@(?=[A-Za-z0-9_])/, "");
    else throw new Error(`paw: unexpected argument "${a}" — unarchive takes one name`);
  }
  if (!name) throw new Error(`paw: usage — ${UNARCHIVE_USAGE}`);
  if (!NAME_RE.test(name)) throw new Error(`paw: "${name}" is not an agent name — unarchive takes the name \`paw archive --list\` shows`);
  return { ...(space ? { space } : {}), name };
}

/** The space archive/unarchive act on: a CHOSEN one (`--space`, `#space`, PAW_SPACE) as given; a defaulted one
 *  yields to the calling agent's own (COTAL_SPACE) — an agent on team2027 retiring itself must not land in `paw`.
 *  (Not a CALLER_SPACE_VERBS entry: src/space.ts is in the manager's import graph, so editing it forces a full
 *  restart — check:doctor A1.) */
export function archiveSpace(given: string | undefined, chosen: boolean, env: NodeJS.ProcessEnv): string {
  const space = given ?? resolveSpace();
  return chosen ? space : env.COTAL_SPACE?.trim() || space;
}

// ── who is calling ────────────────────────────────────────────────────────────────────────────────────

/** Every ancestor pid of this process (≤40 hops). */
function ancestorPids(): Set<number> {
  const out = new Set<number>();
  let pid = process.pid;
  for (let hops = 0; hops < 40 && pid > 1; hops++) {
    let ppid: number;
    try {
      ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    } catch {
      break;
    }
    if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break;
    out.add(ppid);
    pid = ppid;
  }
  return out;
}

/** The agent this process runs inside, in `space`: COTAL_NAME/COTAL_SPACE (cotal stamps them on an agent's tools),
 *  else the registered agent whose pinned session an ancestor process holds. An agent of ANOTHER space is said. */
export async function selfIn(space: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const n = env.COTAL_NAME?.trim();
  const s = env.COTAL_SPACE?.trim();
  if (n && s === space) return n;
  if (n && s) throw new Error(`paw: you are "${n}" in space ${s}, but this archive acts on space ${space} — name it: \`paw archive ${n}#${s}\``);
  const pins = new Map<string, string>();
  for (const a of listAgents(space)) {
    const pin = readResumeId(personaFilePath(space, a.name));
    if (pin) pins.set(pin, a.name);
  }
  if (!pins.size) return undefined;
  const procs = await liveSessionProcsMany(pins.keys());
  const mine = ancestorPids();
  for (const [pin, ps] of procs) if (ps.some((p) => mine.has(p.pid))) return pins.get(pin);
  return undefined;
}

/** Is this process running inside agent `name` of `space`? */
export function callerIs(space: string, name: string, pin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COTAL_NAME?.trim() === name && env.COTAL_SPACE?.trim() === space) return true;
  return !!pin && liveSessionProcs(pin).some((p) => isSelfAncestor(p.pid));
}

// ── the idle wait ─────────────────────────────────────────────────────────────────────────────────────

/** What the wait reads each poll: the agent's status row (undefined = not listed anywhere = offline). */
export type TurnRow = { live: boolean; busy?: boolean; mesh: string } | undefined;

/** Pure: has the agent's turn ended? Offline counts (nothing runs); a live agent must read `idle` and not busy. */
export function turnEnded(row: TurnRow): { ended: boolean; why: string } {
  if (!row || !row.live) return { ended: true, why: "offline" };
  if (row.busy) return { ended: false, why: `mid-turn (${row.mesh === "idle" ? "its transcript shows a turn in flight" : row.mesh})` };
  if (row.mesh !== "idle") return { ended: false, why: row.mesh };
  return { ended: true, why: "idle" };
}

export interface IdleWaitDeps {
  read: () => Promise<TurnRow>;
  /** Something else blocks a stop right now (a restart in flight) — said, and waited out like a turn. */
  blocked?: () => string | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  boundMs?: number;
  settleMs?: number;
  pollMs?: number;
}

/** Wait until the turn has ended and stayed ended for `settleMs`, at most `boundMs`. Never stops anything. */
export async function waitForTurnEnd(d: IdleWaitDeps): Promise<{ ended: true; waitedMs: number } | { ended: false; waitedMs: number; last: string }> {
  const bound = d.boundMs ?? IDLE_WAIT_MS;
  const settle = d.settleMs ?? IDLE_SETTLE_MS;
  const poll = d.pollMs ?? IDLE_POLL_MS;
  const start = d.now();
  let since: number | undefined;
  let last = "";
  for (;;) {
    let why: string;
    let ended = false;
    const block = d.blocked?.();
    if (block) why = block;
    else {
      try {
        const t = turnEnded(await d.read());
        ended = t.ended;
        why = t.why;
      } catch (e) {
        why = `status unreadable: ${(e as Error).message.split("\n")[0]}`;
      }
    }
    const now = d.now();
    if (ended) {
      since ??= now;
      if (now - since >= settle) return { ended: true, waitedMs: now - start };
    } else since = undefined;
    if (why !== last) {
      d.log(`  ${ended ? "turn ended" : "waiting"}: ${why}`);
      last = why;
    }
    if (now - start >= bound) return { ended: false, waitedMs: now - start, last: why };
    await d.sleep(poll);
  }
}

/** The status row reader over ONE presence watch for the whole wait (a fresh observer per poll leaves its KV
 *  consumers behind for minutes — beads-eic). */
async function turnReader(space: string, name: string): Promise<{ read: () => Promise<TurnRow>; close: () => Promise<void> }> {
  const auth = await humanEndpointAuth(space, "operator");
  const ep = new CotalEndpoint({
    space,
    servers: pawServer(space),
    ...(auth.creds ? { creds: auth.creds } : {}),
    ...meshTls(space),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name: "paw-archive", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  await ep.waitForPresenceSnapshot(5_000);
  return {
    read: async () => {
      // The shared handle is re-resolved after a manager restart (a stale epoch) — a 30-minute wait can outlive one.
      const ctl = await sharedManagerControl(space, pawServer(space));
      const { rows } = await collectStatus(space, ctl, { git: false, roster: () => ep.getRoster(), only: () => new Set([name]) });
      const r = rows.find((x) => x.name === name);
      return r ? { live: r.live, ...(r.busy !== undefined ? { busy: r.busy } : {}), mesh: r.mesh } : undefined;
    },
    close: () => ep.stop().catch(() => {}),
  };
}

// ── refusals ──────────────────────────────────────────────────────────────────────────────────────────

/** Refused before anything is touched: a teleported / another machine's record (like rm), a persona stamped
 *  for another machine on a remote space, and the keeper's `global` (its tick re-creates it every minute). */
export function refuseNotOurs(space: string, name: string, folder: string | undefined): void {
  assertMutableByName(space, name, "archive");
  const persona = personaFilePath(space, name);
  if (isRemoteSpace(space) && existsSync(persona)) {
    const m = personaValue(persona, "machine")?.replace(/^["']|["']$/g, "");
    if (m && m !== machineName(space)) throw new Error(`paw: "${name}" (space ${space}) is hosted on ${m}, not ${machineName(space)} — archive it there`);
  }
  const keeperFolder = join(pawHomeDir(), "global");
  if (name === "global" && folder !== undefined && existsSync(keeperFolder) && folder === realpathSync(keeperFolder))
    throw new Error("paw: \"global\" is the keeper's always-on agent — the keeper tick re-creates it every minute; `paw launchd uninstall` first if it should go");
}

/** Registered agents (any local space) whose folder is `dir` or under it, but `except`. */
export function agentsUsing(dir: string, except: { space: string; name: string }): string[] {
  const spaces = join(pawHomeDir(), "spaces");
  if (!existsSync(spaces)) return [];
  const out: string[] = [];
  for (const s of readdirSync(spaces, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const pdir = join(spaces, s, "personas");
    if (!existsSync(pdir)) continue;
    for (const f of readdirSync(pdir).filter((f) => f.endsWith(".md"))) {
      const n = f.slice(0, -".md".length);
      if (s === except.space && n === except.name) continue;
      const cwd = readCwd(join(pdir, f));
      if (cwd && (cwd === dir || cwd.startsWith(`${dir}/`))) out.push(`${n}#${s}`);
    }
  }
  return out.sort();
}

// ── retire ────────────────────────────────────────────────────────────────────────────────────────────

export interface RetireOpts {
  space: string;
  name: string;
  folder?: string;
  keepWorktree: boolean;
  now: boolean;
  by: string;
}

/** The parts of a retire that touch the mesh, processes, git or GitHub — injected so check:archive drives the rest. */
export interface RetireDeps {
  /** Wait for the turn to end (unless `o.now`), then stop it. Throws {@link TurnNeverEnded} past the bound. */
  stop: (o: RetireOpts) => Promise<boolean>;
  /** After the stop: the pids still holding the session once it had time to let go. */
  sessionStillHeld: (pin: string) => Promise<number[]>;
  /** After the stop: give its processes time to leave the folder. */
  cwdReleased: (folder: string) => Promise<void>;
  judge: (folder: string, space: string, name: string) => WorktreeVerdict;
  remove: (v: WorktreeVerdict) => string | undefined;
  forgetGithub: (space: string, name: string) => ReturnType<typeof forgetAgent>;
  fleetJob: (space: string, name: string) => string | undefined;
  log: (line: string) => void;
}

export class TurnNeverEnded extends Error {}

const judgeDeps = (space: string, name: string, withCwd: boolean) => ({
  git: realGit,
  gh: realGh,
  ...(withCwd ? { cwdHolders: (d: string) => cwdHoldersUnder(d) } : {}),
  agentsUsing: (d: string) => agentsUsing(d, { space, name }),
  fetch: true,
});

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The real mesh side: one ensured manager handle for the wait and the stop. */
async function stopOnMesh(o: RetireOpts): Promise<boolean> {
  const { space, name } = o;
  const fg = readForeground(space, name);
  const persona = personaFilePath(space, name);
  const stopped = await withEnsuredManager(space, async (ctl) => {
    if (!o.now) {
      console.log(`waiting for "${name}" to finish its turn (up to ${IDLE_WAIT_MS / 60_000}m; nothing is stopped mid-turn)…`);
      const reader = await turnReader(space, name);
      try {
        const w = await waitForTurnEnd({
          read: reader.read,
          blocked: () => (restartInFlight(space) ? `a paw restart is in flight for space ${space}` : undefined),
          now: Date.now,
          sleep: pause,
          log: (l) => console.log(l),
        });
        if (!w.ended) throw new TurnNeverEnded(`"${name}" did not finish its turn within ${Math.round(w.waitedMs / 60_000)}m (last: ${w.last}) — left alone: nothing was stopped or archived`);
      } finally {
        await reader.close();
      }
    }
    if (!fg) return stopAgent(ctl, name);
    try {
      process.kill(fg.pid, "SIGTERM"); // a foreground `paw claude` isn't the manager's: its own process goes
    } catch {
      /* already gone */
    }
    unregisterForeground(space, name);
    return true;
  });
  if (readSandbox(persona)) {
    const forced = await reapSandbox(space, name);
    if (forced.length) console.error(`paw: force-deleted ${name}'s container(s) that outlived the stop: ${forced.join(" ")}`);
  }
  return stopped;
}

export const realRetireDeps: RetireDeps = {
  stop: stopOnMesh,
  sessionStillHeld: async (pin) => {
    const deadline = Date.now() + SESSION_RELEASE_MS;
    while (liveSessionProcs(pin).length && Date.now() < deadline) await pause(1000);
    return liveSessionProcs(pin).map((p) => p.pid);
  },
  cwdReleased: async (folder) => {
    const end = Date.now() + CWD_RELEASE_MS;
    while (existsSync(folder) && Date.now() < end) {
      try {
        if (!cwdHoldersUnder(folder).length) return;
      } catch {
        return; // the verdict says it
      }
      await pause(1000);
    }
  },
  judge: (folder, space, name) => judgeWorktree(folder, judgeDeps(space, name, true)),
  remove: (v) => removeWorktree(v.facts!, v.force),
  forgetGithub: (space, name) => forgetAgent(space, name),
  fleetJob: fleetJobStarts,
  log: (l) => console.log(l),
};

function worktreeLines(v: WorktreeVerdict, folder: string, failed: string | undefined): string[] {
  if (v.remove && !failed) {
    const f = v.facts!;
    return [`  worktree removed: ${folder} (${f.branch ? `branch ${f.branch} kept` : `was detached at ${f.head.slice(0, 8)}`}; ${v.proof})`];
  }
  const why = failed ? [failed] : v.keep;
  return [`  worktree kept: ${folder}`, ...why.map((w) => `    · ${w}`), ...v.notes.map((n) => `    note: ${n}`)];
}

/** Stop → persona into the archive (with its record) → off the revival paths → the folder verdict. Returns the
 *  archive base (`<name>.<stamp>`). */
export async function retire(o: RetireOpts, d: RetireDeps = realRetireDeps): Promise<string> {
  const { space, name, folder } = o;
  const persona = personaFilePath(space, name);
  const pin = readResumeId(persona);
  const agent = readAgentType(persona);
  const homeKept = sandboxHomeKept(space, name, persona);
  const extra = agentRecord(space, name)?.extra ?? false;
  const transcript = pin ? transcriptPath(pin, personaTranscriptRoots(persona)) : undefined;
  // Before the stop's ensure(): one that brings the manager up revives a pending restart list — this name included.
  const reviveList = dropFromReviveList(space, name);
  const asleep = sleepState(space, name) !== undefined;

  const stopped = await d.stop(o);
  clearSleep(space, name); // stopAgent clears it on the manager path; a foreground agent's goes here
  const stillHeld = pin ? await d.sessionStillHeld(pin) : [];

  // The persona goes first: from here on it is not registered, whatever happens next — and the record says so.
  const at = new Date();
  const rec: ArchiveRecord = {
    name,
    space,
    at: at.toISOString(),
    by: o.by,
    ...(folder ? { folder } : {}),
    extra,
    ...(agent ? { agent } : {}),
    ...(pin ? { session: pin } : {}),
    ...(transcript ? { transcript } : {}),
    stopped,
    worktree: { outcome: folder ? (o.keepWorktree ? "skipped" : "pending") : "none", why: [], notes: [] },
    revival: { liveRecord: false, reviveList, asleep, cron: [], github: { watches: [], mutes: [], queued: 0, queuedLeft: 0 } },
  };
  const base = withRegistryLock(space, () => {
    if (!existsSync(persona)) throw new Error(`paw: "${name}"'s persona ${persona} vanished during the archive (another rm/archive/rename?) — nothing archived`);
    const b = reserveBase(space, name, at);
    writeArchiveRecord(space, b, rec);
    try {
      renameSync(persona, archivedPersonaPath(space, b));
    } catch (e) {
      rmSync(recordPath(space, b), { force: true });
      throw e;
    }
    return b;
  });

  rec.revival.liveRecord = dropFromLiveRecord(space, name);
  rec.revival.cron = takeCronJobs(space, name);
  writeArchiveRecord(space, base, rec);
  rec.revival.github = await d.forgetGithub(space, name);
  const fleet = d.fleetJob(space, name);
  if (fleet) rec.revival.fleetPlist = fleet;
  writeArchiveRecord(space, base, rec);

  let wtLines: string[] = [];
  if (folder && !o.keepWorktree) {
    await d.cwdReleased(folder);
    const v = d.judge(folder, space, name);
    if (v.facts) {
      rec.worktree = { outcome: "pending", why: [], notes: [], facts: v.facts }; // what unarchive needs, before anything goes
      writeArchiveRecord(space, base, rec);
    }
    const failed = v.remove ? d.remove(v) : undefined;
    rec.worktree = {
      outcome: v.remove && !failed ? "removed" : existsSync(folder) ? "kept" : "none",
      why: failed ? [failed] : v.keep,
      notes: [...(v.proof ? [v.proof] : []), ...v.notes],
      ...(v.facts ? { facts: v.facts } : {}),
    };
    writeArchiveRecord(space, base, rec);
    wtLines = rec.worktree.outcome === "none" ? [`  folder ${folder} was already gone`] : worktreeLines(v, folder, failed);
  } else if (folder) wtLines = [`  worktree kept: ${folder} (--keep-worktree)`];

  d.log(`✓ archived "${name}" (space ${space})${stopped ? " — stopped" : ""}; persona → ${archivedPersonaPath(space, base)}`);
  if (pin) d.log(`  transcript kept: session ${pin}${rec.transcript ? ` (${rec.transcript})` : ""}`);
  if (stillHeld.length) d.log(`  ⚠ its session is still held by pid ${stillHeld.join(", ")} after the stop`);
  for (const l of wtLines) d.log(l);
  const off = [
    rec.revival.liveRecord && "live.json",
    reviveList && "restart-revive.json",
    asleep && "its sleep record",
    rec.revival.cron.length && `${rec.revival.cron.length} cron job(s) (${rec.revival.cron.map((j) => j.id).join(", ")})`,
    rec.revival.github.watches.length + rec.revival.github.mutes.length && `${rec.revival.github.watches.length} GitHub watch(es), ${rec.revival.github.mutes.length} mute(s)`,
    rec.revival.github.queued && `${rec.revival.github.queued} queued GitHub DM(s)`,
  ].filter(Boolean);
  if (off.length) d.log(`  off the revival paths: ${off.join(", ")} — kept in ${recordPath(space, base)}`);
  if (rec.revival.github.queuedLeft) d.log(`  ${rec.revival.github.queuedLeft} queued GitHub DM(s) left to a running sweep: they fail as "not registered" and are dropped`);
  if (fleet) d.log(`  the login fleet job (${fleet}) still names it: \`paw start --boot\` skips it while archived, and starts it again after an unarchive`);
  for (const l of homeKept) d.log(l);
  d.log(`  bring it back: paw unarchive ${name}#${space}`);
  return base;
}

// ── the verbs ─────────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveDeps {
  env: NodeJS.ProcessEnv;
  /** Was the space chosen (flag / address / PAW_SPACE) rather than defaulted? (src/space.ts spaceWasChosen) */
  chosen: () => boolean;
  /** spawnDetachedHandoff for kind "archive". */
  handoff: (space: string, sub: string[], env: NodeJS.ProcessEnv, opts: { key: string; cwd: string }) => boolean;
  retire: (o: RetireOpts) => Promise<unknown>;
  /** The self-archive's preview of the folder verdict (its own cwd is still in it, so no process check). */
  preview: (folder: string, space: string, name: string) => WorktreeVerdict;
  restartInFlight: (space: string) => boolean;
  wake: (space: string, name: string, text: string) => { ok: boolean; detail: string };
  log: (line: string) => void;
}

export const realArchiveDeps: ArchiveDeps = {
  env: process.env,
  chosen: spaceWasChosen,
  handoff: (space, sub, env, opts) => spawnDetachedHandoff(space, "archive", sub, env, opts),
  retire: (o) => retire(o),
  preview: (folder, space, name) => judgeWorktree(folder, judgeDeps(space, name, false)),
  restartInFlight,
  wake: wakeAgent,
  log: (l) => console.log(l),
};

export async function runArchive(a: ArchiveArgs, d: ArchiveDeps = realArchiveDeps): Promise<void> {
  const space = archiveSpace(a.space, d.chosen(), d.env);
  if (a.list) return printList(space, d.log);
  // The detached child (it always names the agent): whatever happens, its in-flight pidfile goes at the end.
  if (d.env[handoffEnvKey("archive")] !== undefined) {
    if (!a.target) throw new Error("paw: the detached archive child needs the agent's name");
    try {
      return await archiveOne(space, a, d, true);
    } finally {
      finishDetachedHandoff(space, "archive", a.target);
    }
  }
  return archiveOne(space, a, d, false);
}

async function archiveOne(space: string, a: ArchiveArgs, d: ArchiveDeps, child: boolean): Promise<void> {
  const target = a.target ?? (await selfIn(space, d.env));
  if (!target) throw new Error(`paw: archive needs an agent outside one — ${ARCHIVE_USAGE}`);
  if (a.target) assertUnambiguousTarget(space, a.target);
  const { name, folder } = resolveRemoval(space, target);
  refuseNotOurs(space, name, folder);
  const pin = readResumeId(personaFilePath(space, name));
  const self = !child && callerIs(space, name, pin, d.env);
  if (!child && handoffInFlight(space, "archive", name)) throw new Error(`paw: an archive of "${name}" is already in flight — progress: ${handoffLogPath(space, "archive", name)}`);
  if (!child && d.restartInFlight(space)) throw new Error(`paw: a paw restart is in flight for space ${space} — it would revive "${name}"; archive once it is done`);

  if (self) {
    if (a.now) throw new Error("paw: --now stops an agent mid-turn — not yourself: your own turn is the one running this command");
    // Every check that can refuse runs HERE, so the refusal reaches the agent; the folder verdict is a preview —
    // the child judges again after the stop.
    const preview = folder && !a.keepWorktree ? d.preview(folder, space, name) : undefined;
    const sub = ["archive", name, "--space", space, ...(a.keepWorktree ? ["--keep-worktree"] : [])];
    if (!d.handoff(space, sub, { [BY_ENV]: "itself" }, { key: name, cwd: pawHomeDir() }))
      throw new Error(`paw: an archive of "${name}" is already in flight — progress: ${handoffLogPath(space, "archive", name)}`);
    d.log(`⟳ "${name}" (space ${space}) is archived once THIS turn ends — the reply you write now is your last.`);
    d.log(`  a detached child waits for the turn to end (up to ${IDLE_WAIT_MS / 60_000}m; never mid-turn), then stops you, moves your persona to the archive and keeps your transcript${pin ? ` (session ${pin})` : ""}.`);
    if (!folder) d.log("  no folder registered — nothing to remove");
    else if (a.keepWorktree) d.log(`  your folder stays: ${folder} (--keep-worktree)`);
    else if (preview?.remove) d.log(`  your folder ${folder} will be removed if nothing changes (${preview.proof}); its branch is kept`);
    else if (preview) {
      d.log(`  your folder ${folder} will be KEPT unless this changes before the turn ends:`);
      for (const k of preview.keep) d.log(`    · ${k}`);
    }
    d.log(`  progress: ${handoffLogPath(space, "archive", name)} · undo: paw unarchive ${name}#${space}`);
    return;
  }

  const by = child ? d.env[BY_ENV] || "itself" : d.env.COTAL_NAME?.trim() || "operator";
  try {
    if (child) d.log(`[${new Date().toISOString()}] archive ${name}#${space} (by ${by})`);
    await d.retire({ space, name, ...(folder ? { folder } : {}), keepWorktree: a.keepWorktree, now: a.now, by });
  } catch (e) {
    if (child && e instanceof TurnNeverEnded) {
      d.log(`✗ ${e.message}`);
      const r = d.wake(space, name, `✗ paw archive gave up: your turn did not end within ${IDLE_WAIT_MS / 60_000}m, so nothing was stopped or archived — run \`paw archive\` again as your last step when you are done`);
      if (!r.ok) d.log(`paw: couldn't tell ${name} (${r.detail})`);
    }
    throw e;
  }
}

export function printList(space: string, log: (line: string) => void = (l) => console.log(l)): void {
  const all = listArchived(space);
  if (!all.length) {
    log(`no archived agents in space ${space}`);
    return;
  }
  log(`archived agents in space ${space} (${all.length}):`);
  for (const { rec } of all) {
    const wt = rec.worktree.outcome === "removed" ? `worktree removed${rec.worktree.facts?.branch ? `, branch ${rec.worktree.facts.branch} kept` : ""}` : rec.worktree.outcome === "none" ? "no folder" : `folder ${rec.worktree.outcome}`;
    log(`  ${rec.name.padEnd(20)} ${rec.at.replace("T", " ").slice(0, 16)}Z by ${rec.by} · ${rec.folder ?? "(no folder)"} (${wt})${rec.session ? ` · session ${rec.session.slice(0, 8)}` : ""}`);
  }
  const newest = all.at(-1)!.rec;
  log(`  bring one back: paw unarchive <name>#${space}   (e.g. paw unarchive ${newest.name}#${space}; a name archived twice restores its newest)`);
}

/** Every persona (any local space) that pins `session`, but the one being restored. */
function sessionHolders(session: string): string[] {
  const spaces = join(pawHomeDir(), "spaces");
  if (!existsSync(spaces)) return [];
  const out: string[] = [];
  for (const s of readdirSync(spaces)) {
    const dir = join(spaces, s, "personas");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) if (pinOwnsSession(join(dir, f), session)) out.push(`${f.slice(0, -".md".length)}#${s}`);
  }
  return out;
}

export function unarchiveRefusal(space: string, a: Archived): string | undefined {
  const { rec } = a;
  const persona = personaFilePath(space, rec.name);
  if (existsSync(persona)) return `the name "${rec.name}" is taken in space ${space} now (${persona}) — rename or archive that agent first`;
  if (heldOnMesh(space, rec.name) === "elsewhere") return `another machine runs an agent named "${rec.name}" on the ${space} mesh now`;
  if (!existsSync(archivedPersonaPath(space, a.base))) return `its archived persona ${archivedPersonaPath(space, a.base)} is missing`;
  if (rec.session) {
    const holders = sessionHolders(rec.session);
    if (holders.length) return `its session ${rec.session} is pinned by ${holders.join(", ")} now — two agents on one transcript corrupt it`;
  }
  if (rec.folder && !rec.extra) {
    const now = lookupOwnedFolderName(space, rec.folder);
    if (now) return `its folder ${rec.folder} has a default agent now ("${now}") — archive or rename it first`;
  }
  return undefined;
}

export async function runUnarchive(argv: string[], log: (line: string) => void = (l) => console.log(l)): Promise<void> {
  const { space: spaceArg, name } = parseUnarchiveArgs(argv);
  const space = archiveSpace(spaceArg, spaceWasChosen(), process.env);
  const found = newestArchived(space, name);
  if (!found) throw new Error(`paw: no archived agent "${name}" in space ${space} (\`paw archive --list --space ${space}\`)`);
  const refusal = unarchiveRefusal(space, found);
  if (refusal) throw new Error(`paw: can't unarchive "${name}": ${refusal} — nothing was changed`);
  const { rec } = found;
  const notes: string[] = [];
  if (rec.folder && !existsSync(rec.folder)) {
    const facts = rec.worktree.facts;
    if (!facts || (rec.worktree.outcome !== "removed" && rec.worktree.outcome !== "pending"))
      throw new Error(`paw: can't unarchive "${name}": its folder ${rec.folder} is gone and paw did not remove it — put it back, then rerun; nothing was changed`);
    notes.push(...recreateWorktree(facts));
  }
  const persona = personaFilePath(space, name);
  withRegistryLock(space, () => {
    if (existsSync(persona)) throw new Error(`paw: can't unarchive "${name}": the name was just taken (${persona})`);
    renameSync(archivedPersonaPath(space, found.base), persona);
  });
  const kept = markRestored(space, found, new Date());
  log(`✓ unarchived "${name}" (space ${space}) — registered again${rec.folder ? ` at ${rec.folder}` : ""}, offline`);
  for (const n of notes) log(`  ${n}`);
  log(rec.session ? `  \`paw start ${name}#${space}\` (or \`paw chat @${name}#${space}\`) resumes its session ${rec.session}` : `  \`paw start ${name}#${space}\` brings it up`);
  const left = [
    rec.revival.cron.length && `${rec.revival.cron.length} cron job(s)`,
    rec.revival.github.watches.length && `${rec.revival.github.watches.length} GitHub watch(es)`,
    rec.revival.github.mutes.length && `${rec.revival.github.mutes.length} GitHub mute(s)`,
  ].filter(Boolean);
  if (left.length) log(`  archived with it, not restored: ${left.join(", ")} — they are in ${kept}`);
}

const archiveCommand: Command = {
  kind: "command",
  name: "archive",
  group: "Lifecycle",
  summary: "retire an agent whose task is done: stop it once its turn ends, archive its persona, drop it from every revival path, remove its merged worktree — archive [<name>]",
  usage: ARCHIVE_USAGE,
  run: (a) => runArchive(parseArchiveArgs([...a.raw])),
};
const unarchiveCommand: Command = {
  kind: "command",
  name: "unarchive",
  group: "Lifecycle",
  summary: "bring an archived agent back (persona, folder mapping, its worktree) — offline until started; resumes its session — unarchive <name>",
  usage: UNARCHIVE_USAGE,
  run: (a) => runUnarchive([...a.raw]),
};

registry.register(archiveCommand);
registry.register(unarchiveCommand);

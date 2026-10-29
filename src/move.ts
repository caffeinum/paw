/**
 * `paw move <agent>[#<space>] --to-space <space> [--as <newname>] [--keep-beads] [--dry-run] [--yes]` —
 * move an agent from one space to another on THIS machine. The hand recipe it replaces (twice, paw →
 * team2027): stop it, copy its persona into the other space, back the old one up under
 * `spaces/<from>/moved-to-<to>/`, copy its kit dir, start it there. Teleport is the other axis (same
 * space, another box); docs/notes/addressing.md#paw-move has the design.
 *
 * What moves is every file under `spaces/<from>/` keyed by the agent's name that is still TRUE in
 * another space ({@link moveItems}), plus a paw-owned hermes profile (it holds the agent's login). What
 * stays: its session/transcript (keyed by its folder, which doesn't change) and its beads (one machine-
 * wide db, assigned by name — reassigned on `--as`, as `paw rename` does). Pure planning
 * ({@link moveDisk}, {@link moveBlockers}, {@link movePlan}) is split from the cutover
 * ({@link applyMove}), whose stop/start are injected so check:move drives the rollback hermetically.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { registry, type Command } from "@cotal-ai/core";
import {
  agentRecord,
  cleanAgentName,
  ensureAgentSpawned,
  findUnmanagedAgent,
  listAgents,
  personaFilePath,
  psRowAlive,
  quietFor,
  SESSION_RELEASE_MS,
  stopAgent,
  withRegistryLock,
  type PsRow,
} from "./addressing.ts";
import { addressDeps } from "./dispatch.ts";
import { readForeground } from "./foreground.ts";
import { hermesProfileId, hermesRoot, HERMES_AGENT } from "./hermes-profile.ts";
import { resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { liveSessionProcs, meshIdentity } from "./named.ts";
import { isRemoteSpace } from "./server.ts";
import { isClaudeHarness, personaTranscriptRoots, readAgentType, readCwd, readHermesHome, readResumeId, readSandbox, transcriptExists, transcriptMtime } from "./session.ts";
import { KIT_AGENT } from "./kit.ts";
import { sleepState } from "./sleep-state.ts";
import { readTeleported } from "./teleport-plan.ts";
import { fleetJobStarts } from "./commands/launchd.ts";
import { openTaskIds, reassignOpenTasks } from "./tasks.ts";
import { renameInCompanies } from "./company-service.ts";

export const MOVE_USAGE = "move <agent>[#<space>] --to-space <space> [--as <newname>] [--keep-beads] [--dry-run] [--yes]";

/** A running agent whose transcript was written this recently is mid-work: moving it needs `--yes`. */
export const MOVE_BUSY_MS = 10 * 60_000;

export type MoveArgs = { name: string; space?: string; to: string; as?: string; keepBeads: boolean; dryRun: boolean; yes: boolean };

export function parseMoveArgs(argv: string[]): MoveArgs {
  const out: Partial<MoveArgs> & { keepBeads: boolean; dryRun: boolean; yes: boolean } = { keepBeads: false, dryRun: false, yes: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${flag} needs a value — ${MOVE_USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = value(++i, "--space");
    else if (a === "--to-space") out.to = value(++i, "--to-space");
    else if (a.startsWith("--to-space=")) out.to = a.slice("--to-space=".length);
    else if (a === "--as") out.as = value(++i, "--as");
    else if (a.startsWith("--as=")) out.as = a.slice("--as=".length);
    else if (a === "--keep-beads") out.keepBeads = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${MOVE_USAGE}`);
    else if (out.name === undefined) out.name = a;
    else throw new Error(`paw: unexpected argument "${a}" — move takes one agent`);
  }
  if (!out.name) throw new Error(`paw: which agent? — ${MOVE_USAGE}`);
  if (!/^[A-Za-z0-9_-]+$/.test(out.name)) throw new Error(`paw: "${out.name}" is not an agent name — move addresses an agent by name`);
  if (!out.to) throw new Error(`paw: which space? — ${MOVE_USAGE}`);
  if (out.as !== undefined && cleanAgentName(out.as) !== out.as)
    throw new Error(`paw: --as "${out.as}" is not an agent name (allowed: letters, digits, _ and -)`);
  if (out.keepBeads && out.as === undefined) throw new Error("paw: --keep-beads only means something with --as (beads follow the name, and a move without --as keeps it)");
  return out as MoveArgs;
}

function pawHome(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

const spaceRoot = (space: string) => join(pawHome(), "spaces", space);

/** One space-scoped path that moves: `src` (in the source space) → `dst` (the target), `backup` = where
 *  the source copy is kept (`spaces/<from>/moved-to-<to>/…`, never deleted). */
export type MoveItem = { what: string; src: string; dst: string; backup: string; persona?: true };

/**
 * Every per-name path under `spaces/<s>/` that is the agent's own and still means the same thing in
 * another space. Deliberately NOT here (docs/notes/addressing.md#paw-move):
 *  - `sleep/<name>.*` — a sleeping agent is refused; its stand-in key is an identity on the SOURCE mesh;
 *  - `foreground/<name>.json` — a foreground agent is refused;
 *  - `headless/<name>/` — its runtime pipes, recreated at every launch;
 *  - `spawn.<name>.lock` — transient;
 *  - space-wide state merely mentioning it (peers.json, tidy.json, stale-forward.json, cursors,
 *    images, the legacy folders.json/agents.json the personas replaced at registry.v2).
 */
export function moveItems(from: string, to: string, name: string, newName: string, backupRoot: string): MoveItem[] {
  const rels: Array<[what: string, src: string, dst: string, backup: string]> = [
    ["persona", join("personas", `${name}.md`), join("personas", `${newName}.md`), `${name}.md`],
    ["kit", join("kit", name), join("kit", newName), join("kit", name)],
    ["restarts", join("restarts", `${name}.json`), join("restarts", `${newName}.json`), join("restarts", `${name}.json`)],
    ["unstick", join("unstick", name), join("unstick", newName), join("unstick", name)],
    ["unstick", join("unstick-tool", name), join("unstick-tool", newName), join("unstick-tool", name)],
  ];
  return rels
    .map(([what, s, d, b]) => ({ what, src: join(spaceRoot(from), s), dst: join(spaceRoot(to), d), backup: join(backupRoot, b), ...(what === "persona" ? { persona: true as const } : {}) }))
    .filter((it) => it.persona || existsSync(it.src));
}

/** The source copies' home: `spaces/<from>/moved-to-<to>/`, or a stamped subdir when an earlier move
 *  already left a backup there (a move back and forth) — a backup is never overwritten. */
export function backupRootFor(from: string, to: string, name: string, stamp: string): string {
  const base = join(spaceRoot(from), `moved-to-${to}`);
  const taken = moveItems(from, to, name, name, base).some((it) => existsSync(it.backup));
  return taken ? join(base, stamp) : base;
}

/** What the disk says about the move. Pure reads; check:move builds it over a temp PAW_HOME. */
export type MoveDisk = {
  from: string;
  to: string;
  name: string;
  newName: string;
  personaFrom: string;
  personaExists: boolean;
  pin?: string;
  cwd?: string;
  agent: string;
  extra: boolean;
  teleported?: { to: string; at?: string };
  foregroundPid?: number;
  sleep?: string;
  toKnown: boolean;
  /** The target already has a persona (an agent, or an orphan) under the new name. */
  targetTaken: boolean;
  /** The target's DEFAULT agent for the same folder — a second default would make the folder ambiguous. */
  targetDefault?: string;
  items: MoveItem[];
  /** A paw-owned hermes profile (holds the agent's login): renamed to the target space's profile id. */
  hermes?: { src: string; dst: string };
  backupRoot: string;
  /** Target paths that already exist (left over from somewhere) — never clobbered. */
  occupied: string[];
};

export function moveDisk(a: { from: string; to: string; name: string; newName?: string; stamp?: string }, isKnownSpace = addressDeps().isKnownSpace): MoveDisk {
  const { from, to, name } = a;
  const newName = a.newName ?? name;
  const personaFrom = join(spaceRoot(from), "personas", `${name}.md`);
  const personaExists = existsSync(personaFrom);
  const rec = personaExists ? agentRecord(from, name) : undefined;
  const cwd = personaExists ? readCwd(personaFrom) : undefined;
  const agent = (personaExists && readAgentType(personaFrom)) || "claude";
  const backupRoot = backupRootFor(from, to, name, a.stamp ?? new Date().toISOString().replace(/[:.]/g, "-"));
  const items = moveItems(from, to, name, newName, backupRoot);
  const toKnown = from !== to && isKnownSpace(to);
  const targetPersona = join(spaceRoot(to), "personas", `${newName}.md`);
  const targetDefault =
    toKnown && cwd && !rec?.extra && existsSync(join(spaceRoot(to), "personas")) ? listAgents(to).find((r) => r.folder === cwd && !r.extra && r.name !== newName)?.name : undefined;
  const hermesSrc = join(hermesRoot(), "profiles", hermesProfileId(from, name));
  const hermes = agent === HERMES_AGENT && !readHermesHome(personaFrom) && existsSync(hermesSrc) ? { src: hermesSrc, dst: join(hermesRoot(), "profiles", hermesProfileId(to, newName)) } : undefined;
  const fg = personaExists ? readForeground(from, name) : undefined;
  const mark = personaExists ? readTeleported(personaFrom) : undefined;
  const sleep = personaExists ? sleepState(from, name) : undefined;
  const pin = personaExists ? readResumeId(personaFrom) : undefined;
  return {
    from,
    to,
    name,
    newName,
    personaFrom,
    personaExists,
    ...(pin ? { pin } : {}),
    ...(cwd ? { cwd } : {}),
    agent,
    extra: rec?.extra ?? false,
    ...(mark ? { teleported: mark } : {}),
    ...(fg ? { foregroundPid: fg.pid } : {}),
    ...(sleep ? { sleep } : {}),
    toKnown,
    targetTaken: toKnown && existsSync(targetPersona),
    ...(targetDefault ? { targetDefault } : {}),
    items,
    ...(hermes ? { hermes } : {}),
    backupRoot,
    occupied: [...items.filter((it) => !it.persona && existsSync(it.dst)).map((it) => it.dst), ...(hermes && existsSync(hermes.dst) ? [hermes.dst] : [])],
  };
}

/** What the live mesh/processes say. `strangers`: processes holding its session that are not its own
 *  managed seat in the source space (a standalone claude, another agent, a copy the manager lost). */
export type MoveLive = {
  /** The source manager lists it (alive or a dead row — either way the stop cleans it up). */
  listed: boolean;
  running: boolean;
  activeMs?: number;
  strangers: string[];
  /** Alive on the source mesh but not under this machine's manager (another machine's, or orphaned). */
  unmanaged?: string;
  /** Someone already carries the new name on the TARGET mesh (a remote space another machine shares). */
  targetPresent?: string;
};

/** What stops this move, each with its fix. Empty ⇒ go. Pure; check:move covers every one. */
export function moveBlockers(d: MoveDisk, l: MoveLive | undefined, o: { yes: boolean; now: number }): string[] {
  const out: string[] = [];
  const at = `${d.name}#${d.from}`;
  if (d.from === d.to && d.newName === d.name) out.push(`"${d.name}" is already in space "${d.to}" — nothing to move (\`paw rename\` relabels it in place)`);
  else if (d.from === d.to) out.push(`--to-space is its own space "${d.from}" — to relabel it in place: paw rename ${at} ${d.newName}`);
  else if (!d.toKnown) out.push(`unknown space "${d.to}" — known: ${addressDeps().knownSpaces().join(", ")} (\`paw mesh add\` registers a remote one)`);
  if (!d.cwd) out.push(`"${d.name}" in "${d.from}" has no \`cwd:\` in ${d.personaFrom} — an orphan persona has no folder to run in there; \`paw rm ${at}\` it instead`);
  if (d.teleported) out.push(`"${d.name}" was teleported to ${d.teleported.to}${d.teleported.at ? ` at ${d.teleported.at}` : ""} — it runs there now; \`paw teleport ${d.name} --back\` first`);
  if (d.foregroundPid !== undefined) out.push(`"${d.name}" is a foreground \`paw claude\` (pid ${d.foregroundPid}) in a terminal here — close it first`);
  if (d.sleep) out.push(`"${d.name}" is ${d.sleep} (paw sleep) — its stand-in holds DMs for it on "${d.from}"'s mesh; wake it (\`paw start ${at}\`) or \`paw stop ${at}\` first`);
  if (d.targetTaken) out.push(`space "${d.to}" already has an agent "${d.newName}" (${join(spaceRoot(d.to), "personas", `${d.newName}.md`)}) — \`--as <newname>\`, or rename/rm the one there first`);
  if (d.targetDefault) out.push(`space "${d.to}" already has "${d.targetDefault}" as the agent for ${d.cwd} — two agents would claim that folder; \`paw rm ${d.targetDefault}#${d.to}\` first`);
  for (const p of d.occupied) out.push(`${p} already exists — left over from another agent? move it aside first (paw never overwrites it)`);
  if (l) {
    if (l.strangers.length)
      out.push(`its session ${d.pin} is held by ${l.strangers.join(", ")} — two writers on one transcript; close ${l.strangers.length === 1 ? "it" : "them"} first (\`paw status\` names who)`);
    if (l.unmanaged) out.push(`"${d.name}" is live on "${d.from}"'s mesh but not under this machine's manager (${l.unmanaged}) — paw can't stop it; \`paw restart ${at}\` re-adopts it if it runs here`);
    if (l.targetPresent) out.push(`"${d.newName}" is already present on "${d.to}"'s mesh (${l.targetPresent}) — another machine runs it; pick another name with --as`);
    if (l.running && !o.yes && l.activeMs !== undefined && o.now - l.activeMs >= 0 && o.now - l.activeMs < MOVE_BUSY_MS)
      out.push(`"${d.name}" is busy — its transcript was written ${quietFor(o.now - l.activeMs)} ago (< ${MOVE_BUSY_MS / 60_000}m); wait for it to finish, or --yes to stop it mid-work`);
  }
  return out;
}

/** The plan, teleport-style: one line per thing that moves, then what stays and why. Pure. */
export function movePlan(d: MoveDisk, l: MoveLive | undefined, o: { beads?: string[]; keepBeads: boolean; fleetJob?: string; now: number }): string[] {
  const sp = (p: string) => relative(join(pawHome(), "spaces"), p);
  const renamed = d.newName !== d.name;
  const lines = [`move ${d.name} (${d.agent}, ${d.cwd ?? "no folder"}): space ${d.from} → ${d.to}${renamed ? `, as "${d.newName}"` : ""}`];
  for (const it of d.items) {
    const tail = it.persona ? `${d.pin ? `  (resume: ${d.pin})` : ""}${renamed ? `  name: ${d.newName}` : ""}` : "";
    lines.push(`  ${it.what.padEnd(10)} ${sp(it.src)} → ${sp(it.dst)}${tail}`);
  }
  if (d.hermes) lines.push(`  ${"hermes".padEnd(10)} ${d.hermes.src} → ${d.hermes.dst}  (its profile + login, moved — no copy left behind)`);
  lines.push(`  ${"backup".padEnd(10)} ${sp(d.backupRoot)}/  (the source copies — kept, never deleted)`);
  if (l) {
    const quiet = l.activeMs !== undefined ? `, transcript written ${quietFor(o.now - l.activeMs)} ago` : "";
    lines.push(
      l.running
        ? `  ${"live".padEnd(10)} running in ${d.from}${quiet} — stopped there, started in ${d.to} as "${d.newName}"`
        : `  ${"live".padEnd(10)} not running — moved on disk only; \`paw start ${d.newName}#${d.to}\` brings it up`,
    );
  }
  lines.push(`  ${"session".padEnd(10)} stays — ${d.pin ?? "(no pin yet)"} is keyed by its folder, which doesn't change`);
  if (!renamed) lines.push(`  ${"beads".padEnd(10)} stay — one machine-wide db, assigned by name, and the name doesn't change`);
  else if (o.keepBeads) lines.push(`  ${"beads".padEnd(10)} --keep-beads: open beads stay assigned to "${d.name}"`);
  else if (o.beads) lines.push(`  ${"beads".padEnd(10)} ${o.beads.length} open bead(s) reassigned "${d.name}" → "${d.newName}"${o.beads.length ? `: ${o.beads.join(", ")}` : ""}; company rosters follow (--keep-beads leaves them)`);
  lines.push(`  ${"stays".padEnd(10)} DMs still queued for ${d.name} on ${d.from}'s mesh, its headless pipes, ${d.from}'s space-wide state`);
  if (o.fleetJob) lines.push(`  ${"note".padEnd(10)} the login fleet job (${o.fleetJob}) starts ${d.name} in ${d.from} — it will skip it; \`paw launchd install …\` to update`);
  return lines;
}

/** The persona text that lands in the target: `name:` rewritten on `--as`. */
export function targetPersonaText(text: string, newName: string): string {
  return /^name:.*$/m.test(text) ? text.replace(/^name:.*$/m, `name: ${newName}`) : text;
}

export type MoveDeps = {
  stop(space: string, name: string, pin: string | undefined): Promise<{ wasLive: boolean; released: boolean }>;
  start(space: string, name: string, cwd: string): Promise<void>;
  log(line: string): void;
};

/**
 * The cutover. Never two writers: stop in the source (and wait for the session to be let go) → write
 * the target → move the source copies into the backup → start in the target only when it ran before.
 * Any failure after the stop undoes every disk step in reverse and restarts it in the source.
 */
export async function applyMove(d: MoveDisk, l: MoveLive, deps: MoveDeps): Promise<{ started: boolean }> {
  const { from, to, name, newName } = d;
  const cwd = d.cwd ?? fail(`paw: "${name}" has no cwd — refused before this point`);
  if (l.listed) {
    deps.log(`→ stopping ${name} in ${from} …`);
    const r = await deps.stop(from, name, d.pin);
    if (!r.released) {
      await restartSource(d, l, deps);
      throw new Error(`paw: "${name}"'s session ${d.pin} is still held ${SESSION_RELEASE_MS / 1000}s after the stop — nothing was moved`);
    }
  }
  const undo: Array<{ what: string; run: () => void }> = [];
  try {
    withRegistryLock(to, () =>
      withRegistryLock(from, () => {
        for (const it of d.items) {
          mkdirSync(dirname(it.dst), { recursive: true });
          if (it.persona) writeFileSync(it.dst, targetPersonaText(readFileSync(it.src, "utf8"), newName), { flag: "wx" });
          else cpSync(it.src, it.dst, { recursive: true, errorOnExist: true, force: false });
          undo.push({ what: `remove ${it.dst}`, run: () => rmSync(it.dst, { recursive: true, force: true }) });
        }
        if (d.hermes) {
          const h = d.hermes;
          if (existsSync(h.dst)) throw new Error(`paw: ${h.dst} appeared during the move — not overwriting it`);
          mkdirSync(dirname(h.dst), { recursive: true });
          renameSync(h.src, h.dst);
          undo.push({ what: `move ${h.dst} back to ${h.src}`, run: () => renameSync(h.dst, h.src) });
        }
        for (const it of d.items) {
          if (existsSync(it.backup)) throw new Error(`paw: backup path ${it.backup} appeared during the move — not overwriting it`);
          mkdirSync(dirname(it.backup), { recursive: true });
          renameSync(it.src, it.backup);
          undo.push({ what: `move ${it.backup} back to ${it.src}`, run: () => renameSync(it.backup, it.src) });
        }
      }),
    );
    if (l.running) {
      deps.log(`→ starting ${newName} in ${to} …`);
      await deps.start(to, newName, cwd);
    }
    return { started: l.running };
  } catch (e) {
    const msg = (e as Error).message;
    const notes: string[] = [];
    if (l.running) {
      try {
        await deps.stop(to, newName, d.pin);
      } catch (se) {
        notes.push(`stopping it in ${to} failed: ${(se as Error).message}`);
      }
    }
    for (const u of undo.reverse()) {
      try {
        u.run();
      } catch (ue) {
        notes.push(`${u.what} FAILED: ${(ue as Error).message}`);
      }
    }
    const restarted = await restartSource(d, l, deps);
    if (restarted) notes.push(restarted);
    throw new Error(
      `paw: move ${name} → ${to} failed: ${msg}\n  rolled back — ${notes.length ? notes.join("; ") : `everything is in ${from} as before${l.running ? ", running again" : ""}`}`,
    );
  }
}

/** Put it back up in the source after a failed cutover; returns a note when that failed too. */
async function restartSource(d: MoveDisk, l: MoveLive, deps: MoveDeps): Promise<string | undefined> {
  if (!l.running) return undefined;
  try {
    await deps.start(d.from, d.name, d.cwd!);
    return undefined;
  } catch (e) {
    return `restarting it in ${d.from} FAILED (${(e as Error).message}) — start it by hand: paw start ${d.name}#${d.from}`;
  }
}

/** After the move: on `--as`, its open beads and company rosters follow the new name (as `paw rename`).
 *  A bd failure is loud with the fix — the move itself already happened and is not undone for it. */
export async function moveBeads(from: string, to: string): Promise<{ moved: string[]; companies: string[]; errors: string[] }> {
  const errors: string[] = [];
  let moved: string[] = [];
  let companies: string[] = [];
  try {
    moved = await reassignOpenTasks(from, to);
  } catch (e) {
    errors.push(`couldn't move "${from}"'s open beads (${(e as Error).message}) — run: bd list -a ${from}  then  bd update <id> -a ${to}`);
  }
  try {
    companies = await renameInCompanies(from, to);
  } catch (e) {
    errors.push(`couldn't update "${from}" in company rosters (${(e as Error).message}) — fix metadata.org on the company epic: bd show <epic> --json`);
  }
  return { moved, companies, errors };
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** The live half of preflight: what the source manager, the session's processes and (for a remote target)
 *  the target mesh say. Brings each space's mesh + manager up, as every agent verb does. */
async function moveLive(d: MoveDisk): Promise<MoveLive> {
  const row = await withEnsuredManager(d.from, async (ctl) => {
    const ps = await ctl.ps();
    if (!ps.ok) throw new Error(`paw: "${d.from}"'s manager isn't answering (${ps.error ?? "no reply"})`);
    return ((ps.data as PsRow[]) ?? []).find((r) => r.name === d.name);
  });
  const running = row !== undefined && psRowAlive(row);
  const own = (pid: number, mesh: boolean) => {
    if (!running || !mesh) return false;
    const id = meshIdentity(pid);
    return id.name === d.name && id.space === d.from;
  };
  const lost = row ? undefined : await findUnmanagedAgent(d.from, d.name);
  const strangers = (d.pin ? liveSessionProcs(d.pin) : [])
    .filter((p) => !own(p.pid, p.mesh) && !lost?.pids.includes(p.pid))
    .map((p) => `pid ${p.pid}${p.mesh ? " (a mesh agent)" : " (a standalone claude)"}`);
  const unmanaged = lost ? [lost.id && `peer ${lost.id}`, lost.pids.length && `pid ${lost.pids.join(", ")}`].filter(Boolean).join(", ") : undefined;
  const there = isRemoteSpace(d.to) ? await findUnmanagedAgent(d.to, d.newName) : undefined;
  const activeMs = d.pin ? transcriptMtime(d.pin, personaTranscriptRoots(d.personaFrom)) : undefined;
  return {
    listed: row !== undefined,
    running,
    ...(activeMs !== undefined ? { activeMs } : {}),
    strangers,
    ...(unmanaged ? { unmanaged } : {}),
    ...(there?.id ? { targetPresent: `peer ${there.id}` } : {}),
  };
}

const liveDeps: MoveDeps = {
  stop: async (space, name, pin) => {
    const wasLive = await withEnsuredManager(space, (ctl) => stopAgent(ctl, name));
    const deadline = Date.now() + SESSION_RELEASE_MS;
    while (pin && liveSessionProcs(pin).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    return { wasLive, released: !pin || liveSessionProcs(pin).length === 0 };
  },
  start: async (space, name, cwd) => {
    const r = await withEnsuredManager(space, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd, reuseUnmanaged: false }));
    if (r.stuck) throw new Error(`paw: "${name}" is stuck starting in ${space}: ${r.stuck}`);
  },
  log: (s) => console.log(s),
};

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** The line `paw move` ends on. "resumed its session" only when its pin HAS a transcript: a pin with none
 *  boots fresh at that id (session.ts transcriptExists). Other harnesses keep their own session, which
 *  paw doesn't read, so their line is unchanged. */
export function moveStartLine(d: MoveDisk, started: boolean, hasTranscript: (pin: string) => boolean): string {
  if (!started) return `  not started — \`paw start ${d.newName}#${d.to}\` brings it up there`;
  const pinned = isClaudeHarness(d.agent) || d.agent === KIT_AGENT;
  const fresh = pinned && !(d.pin && hasTranscript(d.pin));
  return `  live in ${d.to} as "${d.newName}" (${fresh ? "fresh session — no turns yet" : "resumed its session"})`;
}

export async function move(a: MoveArgs): Promise<void> {
  const from = a.space?.trim() || resolveSpace();
  const d = moveDisk({ from, to: a.to, name: a.name, ...(a.as ? { newName: a.as } : {}) });
  if (!d.personaExists) throw new Error(`paw: no agent "${a.name}" in space "${from}" (\`paw status --space ${from}\` lists them)`);
  // v1: its transcript lives in spaces/<from>/sandbox/<name>, which move does not carry (docs/notes/sandbox.md).
  if (readSandbox(d.personaFrom)) throw new Error(`paw: "${a.name}" is sandboxed (sandbox: container) — paw move does not carry a sandboxed agent's own claude store yet`);
  const early = moveBlockers(d, undefined, { yes: a.yes, now: Date.now() });
  const l = early.length ? undefined : await moveLive(d);
  const now = Date.now();
  const blockers = l ? moveBlockers(d, l, { yes: a.yes, now }) : early;
  const renamed = d.newName !== d.name;
  const beads =
    renamed && !a.keepBeads && !blockers.length
      ? await openTaskIds(d.name).catch((e: Error) => fail(`paw: reading "${d.name}"'s open beads failed (${e.message}) — fix bd, or --keep-beads to move without them`))
      : undefined;
  const fleetJob = fleetJobStarts(from, d.name);
  for (const line of movePlan(d, l, { ...(beads ? { beads } : {}), keepBeads: a.keepBeads, ...(fleetJob ? { fleetJob } : {}), now })) console.log(line);
  if (blockers.length) {
    console.log("");
    console.log(`blocked — ${blockers.length} thing(s) to fix first:`);
    for (const b of blockers) console.log(`  ✗ ${b}`);
    throw new Error(`paw: move ${d.name} is blocked (${blockers.length}) — nothing was moved`);
  }
  if (a.dryRun) {
    console.log("");
    console.log("dry run — preflight passed; nothing was stopped, moved or started");
    return;
  }
  const live = l!;
  if (!a.yes) {
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new Error(`paw: no terminal to confirm on — pass --yes to move ${d.name}${live.running ? " (it is running: --yes stops it in " + from + " and starts it in " + d.to + ")" : ""}`);
    const q = `move ${d.name} from ${from} to ${d.to}${renamed ? ` as "${d.newName}"` : ""}${live.running ? ` — it is running: stop it in ${from} and start it in ${d.to}` : ""}? [y/N] `;
    if (!(await confirm(q))) throw new Error("paw: move cancelled — nothing was moved");
  }
  const { started } = await applyMove(d, live, liveDeps);
  console.log(`✓ moved ${d.name}: ${from} → ${d.to}${renamed ? ` as "${d.newName}"` : ""}  (source copies in ${d.backupRoot})`);
  if (renamed && !a.keepBeads) {
    const b = await moveBeads(d.name, d.newName);
    if (b.moved.length) console.log(`  moved ${b.moved.length} open bead(s) to "${d.newName}": ${b.moved.join(", ")}`);
    if (b.companies.length) console.log(`  company roster(s) now say "${d.newName}": ${b.companies.join(", ")}`);
    for (const e of b.errors) {
      process.exitCode = 1;
      console.error(`paw: ⚠ moved, but ${e}`);
    }
  }
  const personaTo = personaFilePath(d.to, d.newName);
  console.log(moveStartLine(d, started, (pin) => transcriptExists(pin, personaTranscriptRoots(personaTo))));
}

const moveCommand: Command = {
  kind: "command",
  name: "move",
  group: "Lifecycle",
  summary: "move an agent to another space on this machine (persona + kit dir + per-agent state; session and beads stay) — move <agent>#<from> --to-space <to>",
  usage: MOVE_USAGE,
  run: (a) => move(parseMoveArgs([...a.raw])),
};

registry.register(moveCommand);

/**
 * The problems view — `paw status --problems` / `paw top --problems`: every agent that needs a human,
 * grouped by what is wrong, with the one command that addresses it. A PURE classifier over
 * {@link collectStatus} rows plus four side reads (live.json, sleep records + their backlog, a sandboxed
 * seat's launcher.log, tidy's background-work asks) — nothing here is a second source of truth.
 *
 * Read-only: it never calls ensure(), so a down manager is reported, never repaired as a side effect.
 * Nothing here acts — the TUI (src/problems-tui.ts) runs an existing verb only on a keypress.
 * docs/notes/status.md#problems has the rules table and the safety classes.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLiveRecord, spaceDirs, type LiveRecord } from "./boot-live.ts";
import { tidyAsks, type Ask } from "./commands/tidy.ts";
import { withManagerControl } from "./control.ts";
import { failureWord, fmtMb, snapshotFleet, type Fleet } from "./fleet.ts";
import { elsewhereLabel, localManagerInstanceId, localMachine } from "./hosted.ts";
import { managerProcs } from "./lifecycle.ts";
import { isLocalHere } from "./namespace.ts";
import { personaFilePath } from "./addressing.ts";
import { isRemoteSpace, pawServer } from "./server.ts";
import { readSandbox, sandboxStateDir } from "./session.ts";
import { DEFAULT_SPACE } from "./space.ts";
import { readSleepRecord, readStandInIdentity, readWakingRecord, standInActor, type SleepRecord } from "./sleep-state.ts";
import { ago, collectStatus, folderGone, hungTool, inboxStuck, inboxText, tilde, toolLabel, type AgentStatus, type InboxState } from "./status.ts";
import { UNSTICK_TOOL_DEFAULT_MIN } from "./unstick.ts";
import { FAIL, LIVE, OFF, OK, problemLine, reasonOf, WARN } from "./ux.ts";

export const QUIET_TURN_MS = 10 * 60_000;
export const IDLE_BG_MS = 60 * 60_000;
export const WEDGE_WINDOW_MS = 24 * 3_600_000;
export const WAKING_SLOW_MS = 2 * 60_000;
export const BACKLOG_READ_MS = 5_000;
const HUNG_MS = UNSTICK_TOOL_DEFAULT_MIN * 60_000;
const WEDGE_TAIL = 64 * 1024;

export type Group = "dead" | "stuck" | "asleep" | "folder-gone" | "elsewhere" | "idle-bg";
export type Reason =
  | "manager-down"
  | "restart-stuck"
  | "seat-exited"
  | "live-record"
  | "hung-tool"
  | "failure"
  | "off-mesh"
  | "inbox"
  | "wedged"
  | "quiet-turn"
  | "wake-failed"
  | "waking-slow"
  | "backlog"
  | "sleep-corrupt"
  | "folder-gone"
  | "offline-elsewhere"
  | "idle-bg";
export type SinceWhat = "tool started" | "failed" | "last active" | "was live" | "since" | "asleep" | "idle" | "quiet" | "last" | "wake asked";
export type ActionClass = "start" | "disruptive" | "message" | "read" | "shown";

/** The order rules are tried in; the FIRST match is the row's reason, the rest go to `also`. */
const ORDER: Reason[] = [
  "manager-down", "restart-stuck", "seat-exited", "live-record",
  "hung-tool", "failure", "off-mesh", "inbox", "wedged", "quiet-turn",
  "wake-failed", "waking-slow", "backlog", "sleep-corrupt",
  "folder-gone", "offline-elsewhere", "idle-bg",
];
const GROUP_OF: Record<Reason, Group> = {
  "manager-down": "dead", "restart-stuck": "dead", "seat-exited": "dead", "live-record": "dead",
  "hung-tool": "stuck", failure: "stuck", "off-mesh": "stuck", inbox: "stuck", wedged: "stuck", "quiet-turn": "stuck",
  "wake-failed": "asleep", "waking-slow": "asleep", backlog: "asleep", "sleep-corrupt": "asleep",
  "folder-gone": "folder-gone", "offline-elsewhere": "elsewhere", "idle-bg": "idle-bg",
};
export const GROUPS: Array<{ group: Group; title: string; glyph: string }> = [
  { group: "dead", title: "DEAD", glyph: FAIL },
  { group: "stuck", title: "STUCK", glyph: WARN },
  { group: "asleep", title: "ASLEEP WITH MAIL", glyph: OFF },
  { group: "folder-gone", title: "FOLDER GONE", glyph: WARN },
  { group: "elsewhere", title: "OFFLINE ON ANOTHER MACHINE", glyph: OFF },
  { group: "idle-bg", title: "IDLE WITH BACKGROUND WORK", glyph: LIVE },
];
const DEAD = new Set<Reason>(["manager-down", "restart-stuck", "seat-exited", "live-record"]);
const SLEEP_WORDS = new Set(["asleep", "waking", "wake failed", "sleep record corrupt"]);

export interface Action {
  /** The TUI key; absent on a `shown` action (text for the operator, never run). */
  key?: "s" | "w" | "r" | "u" | "o" | "l" | "d" | "t";
  /** The paw argv (no `paw`); absent when the action is only words (`fix or delete …`). */
  argv?: string[];
  cmd: string;
  /** Whether THIS machine may run it — false for an agent another machine runs. */
  here: boolean;
  class: ActionClass;
  confirm?: true;
}

export interface Problem {
  group: Group;
  reason: Reason;
  name: string;
  space: string;
  where?: { label: string; here: boolean };
  fact: string;
  since?: number;
  sinceWhat?: SinceWhat;
  backlog?: number;
  actions: Action[];
  also: Reason[];
  /** The row's primary action (the DO column). */
  primary?: Action;
  row?: AgentStatus;
}

export interface SleepFacts {
  since?: number;
  failures?: number;
  lastError?: string;
  wakeRequestedAt?: number;
  /** DMs waiting since the sleep cursor; "error" = the read failed (reported in `errors`, never a row). */
  backlog?: number | "error";
}

export interface Wedge {
  count: number;
  last: number;
  persona: string;
}

export interface SpaceInput {
  space: string;
  machine: string;
  /** live.json — undefined when there is none. */
  live?: LiveRecord;
  rows: AgentStatus[];
  sleep: ReadonlyMap<string, SleepFacts>;
  wedges: ReadonlyMap<string, Wedge>;
  asks: Ask[];
  /** Registered agents whose folder is gone ({@link folderGone}). */
  gone: ReadonlySet<string>;
  /** {@link isLocalHere}: a persona here that is this machine's. */
  ownedHere: (name: string) => boolean;
}

export const problemId = (p: Pick<Problem, "name" | "space">) => `${p.name}#${p.space}`;
export const dismissKey = (p: Pick<Problem, "reason" | "name" | "space">) => `${p.reason}:${p.name}#${p.space}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cmdOf = (argv: string[]) => `paw ${argv.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
const listNames = (names: string[], max = 4) => `${names.slice(0, max).join(", ")}${names.length > max ? ` +${names.length - max}` : ""}`;

/** The WHERE cell, from evidence only (see docs/notes/status.md#problems). */
export function whereOf(row: AgentStatus, input: Pick<SpaceInput, "machine" | "ownedHere">): { label: string; here: boolean } | undefined {
  if (row.host) return { label: row.host.label, here: row.host.here };
  if (row.elsewhere) return { label: row.elsewhere.where, here: false };
  if (input.ownedHere(row.name)) return { label: input.machine, here: true };
  return undefined;
}

/** Does this machine run (or own) the agent — may it start, restart or attach to it? */
export function runsHere(row: AgentStatus, ownedHere: (name: string) => boolean): boolean {
  return !row.elsewhere && (row.host ? row.host.here : ownedHere(row.name));
}

/** Pure: the launcher.log watchdog's WEDGED lines in the window. `truncated` = the text starts mid-file
 *  (its first line may be partial, so it is dropped). */
export function wedgesIn(text: string, now: number, truncated: boolean): { count: number; last: number } | undefined {
  const lines = text.split("\n");
  if (truncated) lines.shift();
  let count = 0;
  let last: number | undefined;
  for (const l of lines) {
    const m = /^(\S+) \[\d+\] watchdog: \S+ is WEDGED/.exec(l);
    if (!m) continue;
    const ts = Date.parse(m[1]!);
    if (!Number.isFinite(ts) || ts > now || now - ts > WEDGE_WINDOW_MS) continue;
    count++;
    last = last === undefined ? ts : Math.max(last, ts);
  }
  return count && last !== undefined ? { count, last } : undefined;
}

/** The newest WEDGED lines of a sandboxed agent's launcher.log, or undefined (not sandboxed, no log, none recent). */
export function readWedge(space: string, name: string, now: number): Wedge | undefined {
  const persona = personaFilePath(space, name);
  if (!existsSync(persona) || !readSandbox(persona)) return undefined;
  const log = join(sandboxStateDir(persona), "launcher.log");
  if (!existsSync(log)) return undefined;
  const size = statSync(log).size;
  const start = Math.max(0, size - WEDGE_TAIL);
  const fd = openSync(log, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const w = wedgesIn(buf.toString("utf8"), now, start > 0);
    return w ? { ...w, persona } : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Every rule that matches a registered row, in {@link ORDER}. */
function reasonsOf(row: AgentStatus, input: SpaceInput, now: number): Reason[] {
  const out: Reason[] = [];
  const asleep = SLEEP_WORDS.has(row.mesh);
  const sl = input.sleep.get(row.name);
  if (row.stuck && !row.live) out.push("restart-stuck");
  if (row.seat === "exited" && !asleep) out.push("seat-exited");
  if (input.live?.names.includes(row.name) && !row.live && !row.seat && !asleep && !row.elsewhere && !input.gone.has(row.name)) out.push("live-record");
  if (hungTool(row, now, HUNG_MS) !== undefined) out.push("hung-tool");
  if (row.live && row.failure) out.push("failure");
  if (row.seat === "off-mesh") out.push("off-mesh");
  if (inboxStuck(row)) out.push("inbox");
  if (input.wedges.has(row.name)) out.push("wedged");
  // `waiting` is the agent's own claim that it waits on a human — not a quiet turn.
  if (row.live && row.busy && row.mesh !== "waiting" && !row.tool && row.activeMs !== undefined && now - row.activeMs >= QUIET_TURN_MS) out.push("quiet-turn");
  if (row.mesh === "wake failed") out.push("wake-failed");
  if (row.mesh === "waking" && sl?.wakeRequestedAt !== undefined && now - sl.wakeRequestedAt >= WAKING_SLOW_MS) out.push("waking-slow");
  if (row.mesh === "asleep" && typeof sl?.backlog === "number" && sl.backlog > 0) out.push("backlog");
  if (row.mesh === "sleep record corrupt") out.push("sleep-corrupt");
  if (input.gone.has(row.name)) out.push("folder-gone");
  if (row.elsewhere && !row.live) out.push("offline-elsewhere");
  if (row.live && !row.busy && row.mesh !== "working" && row.activeMs !== undefined && now - row.activeMs >= IDLE_BG_MS && input.asks.some((a) => a.agent === row.name)) out.push("idle-bg");
  return out.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

function factOf(reason: Reason, row: AgentStatus, input: SpaceInput, now: number): { fact: string; since?: number; sinceWhat?: SinceWhat } {
  const sl = input.sleep.get(row.name);
  const lastActive = row.activeMs !== undefined ? { since: row.activeMs, sinceWhat: "last active" as const } : {};
  switch (reason) {
    case "restart-stuck":
      return { fact: `wake gate gave up — restarted ${row.stuck!.restarts}× without reaching the mesh`, since: row.stuck!.since, sinceWhat: "since" };
    case "seat-exited":
      return { fact: "seat exited — the manager lists it, nothing runs", ...lastActive };
    case "live-record":
      return { fact: "not running — live.json says it was up", since: Date.parse(input.live!.at), sinceWhat: "was live" };
    case "hung-tool":
      return { fact: `tool running — ${toolLabel(row.tool!)}`, since: row.tool!.startedMs, sinceWhat: "tool started" };
    case "failure":
      return { fact: failureWord(row.failure!.text, row.name).replace(/^⚠ /, ""), since: row.failure!.ts, sinceWhat: "failed" };
    case "off-mesh":
      return { fact: "process running, off the mesh — not reachable by DM", ...lastActive };
    case "inbox":
      return { fact: inboxFact(row.inbox), ...(row.activeMs !== undefined ? { since: row.activeMs, sinceWhat: "quiet" as const } : {}) };
    case "wedged": {
      const w = input.wedges.get(row.name)!;
      return { fact: `sandbox VM wedged ${w.count}× in 24h — out of memory? raise sandboxMemory`, since: w.last, sinceWhat: "last" };
    }
    case "quiet-turn":
      return { fact: "mid-turn, transcript quiet — no tool running", since: row.activeMs, sinceWhat: "quiet" };
    case "wake-failed": {
      const n = sl?.failures !== undefined ? ` (${sl.failures}×)` : "";
      const why = sl?.lastError !== undefined ? `: ${reasonOf(sl.lastError)}` : "";
      return { fact: `wake failed${n}${why}`, ...(sl?.since !== undefined ? { since: sl.since, sinceWhat: "asleep" as const } : {}) };
    }
    case "waking-slow":
      return { fact: "waking — the sleep host hasn't finished", since: sl!.wakeRequestedAt, sinceWhat: "wake asked" };
    case "backlog":
      return { fact: `asleep, ${plural(sl!.backlog as number, "DM")} waiting — not woken`, ...(sl?.since !== undefined ? { since: sl.since, sinceWhat: "asleep" as const } : {}) };
    case "sleep-corrupt":
      return { fact: `sleep record unreadable — spaces/${input.space}/sleep/${row.name}.json` };
    case "folder-gone":
      return { fact: `folder gone: ${tilde(row.folder)}`, ...lastActive };
    case "offline-elsewhere":
      return { fact: `offline there — ${elsewhereLabel(row.elsewhere!)}${row.elsewhere!.how === "teleported" ? " (teleported)" : ""}` };
    case "idle-bg": {
      const items = input.asks.find((a) => a.agent === row.name)!.items;
      const mem = items.some((i) => i.mem === undefined) ? undefined : items.reduce((s, i) => s + i.mem!, 0);
      const labels = items.map((i) => `${i.label}${i.ports.map((p) => ` :${p}`).join("")}`);
      return { fact: `idle, holds ${plural(items.length, "background proc")} ${fmtMb(mem)}: ${listNames(labels, 2)}`, since: row.activeMs, sinceWhat: "idle" };
    }
    case "manager-down":
      throw new Error("paw: manager-down is a space row, not an agent's");
  }
}

/** `inbox stuck — 3 queued, not consuming`, with the TUI's growth since its last refresh when it rose. */
export function inboxFact(inbox: InboxState, grew?: number): string {
  return `inbox stuck — ${inboxText(inbox)}${grew ? ` (+${grew})` : ""}, not consuming`;
}

/** The reason-specific DO key (the 5.1 layout: a refused turn is read, a quiet turn is looked at). */
const PRIMARY: Partial<Record<Reason, Action["key"]>> = {
  "manager-down": "s", "seat-exited": "s", "live-record": "s", "restart-stuck": "r",
  "hung-tool": "u", failure: "l", "off-mesh": "r", inbox: "r", "quiet-turn": "o",
  "wake-failed": "w", backlog: "w", "offline-elsewhere": "s", "idle-bg": "t",
};
const FALLBACK_ORDER: Array<Action["key"]> = ["s", "w", "u", "r", "t", "o", "l"];

function actionsOf(reasons: Reason[], row: AgentStatus, space: string, here: boolean, wedge?: Wedge): Action[] {
  const has = (r: Reason) => reasons.includes(r);
  const n = row.name;
  const act = (key: Action["key"], argv: string[], cls: ActionClass, confirm = false): Action => ({ key, argv, cmd: cmdOf(argv), here, class: cls, ...(confirm ? { confirm: true as const } : {}) });
  const out: Action[] = [];
  if (reasons.some((r) => DEAD.has(r)) || has("offline-elsewhere")) out.push(act("s", ["start", n, "--space", space], "start"));
  if (has("backlog") || has("wake-failed")) out.push(act("w", ["start", n, "--space", space], "start"));
  if (reasons[0] !== "folder-gone" && !row.elsewhere) out.push(act("r", ["restart", n, "--space", space], "disruptive", true));
  if (has("hung-tool")) out.push(act("u", ["unstick", n, "--space", space], "disruptive", true));
  if (row.live) out.push(act("o", ["attach", n, "--space", space], "read"));
  if (row.durable) out.push(act("l", ["log", n, "--space", space, "--tail", "40"], "read"));
  if (has("idle-bg")) out.push(act("t", ["tidy", n, "--space", space], "message"));
  // dm goes over the mesh — any machine may send it.
  out.push({ key: "d", argv: ["dm", `${n}#${space}`], cmd: `paw dm ${n}#${space} "<text>"`, here: true, class: "message" });
  const shown = (cmd: string, argv?: string[]): Action => ({ ...(argv ? { argv } : {}), cmd, here, class: "shown" });
  if (reasons[0] === "folder-gone") out.push(shown(cmdOf(["rm", n, "--space", space]), ["rm", n, "--space", space]));
  if (has("waking-slow")) out.push(shown(cmdOf(["restart", "--mailbox", "--space", space]), ["restart", "--mailbox", "--space", space]));
  if (has("sleep-corrupt")) out.push(shown("fix or delete that record"));
  if (has("wedged") && wedge) out.push(shown(`edit sandboxMemory in ${tilde(wedge.persona)}, then r`));
  return out;
}

function primaryOf(reason: Reason, actions: Action[]): Action | undefined {
  const k = PRIMARY[reason];
  const byKey = (key: Action["key"]) => actions.find((a) => a.key === key && a.key !== "d");
  return (k && byKey(k)) || actions.find((a) => a.class === "shown") || FALLBACK_ORDER.map(byKey).find(Boolean);
}

/** Pure: one space's problems. Rows only for registered agents (unregistered/roster-only peers are never problems here). */
export function classify(input: SpaceInput, now: number): Problem[] {
  const { space } = input;
  if (!input.rows.length && input.live && input.live.names.length) {
    const names = input.live.names;
    const argv = ["start", ...names, "--space", space];
    const s: Action = { key: "s", argv, cmd: cmdOf(argv), here: true, class: "start" };
    return [{
      group: "dead", reason: "manager-down", name: space, space,
      where: { label: input.machine, here: true },
      fact: `manager not running on this machine — live.json lists ${names.length}: ${listNames(names)}`,
      since: Date.parse(input.live.at), sinceWhat: "was live",
      actions: [s], also: [], primary: s,
    }];
  }
  const out: Problem[] = [];
  for (const row of input.rows) {
    if (row.unregistered) continue;
    const reasons = reasonsOf(row, input, now);
    if (!reasons.length) continue;
    const reason = reasons[0]!;
    const here = runsHere(row, input.ownedHere);
    const actions = actionsOf(reasons, row, space, here, input.wedges.get(row.name));
    const f = factOf(reason, row, input, now);
    const where = whereOf(row, input);
    const sl = input.sleep.get(row.name);
    out.push({
      group: GROUP_OF[reason], reason, name: row.name, space,
      ...(where ? { where } : {}),
      fact: f.fact,
      ...(f.since !== undefined && Number.isFinite(f.since) ? { since: f.since, sinceWhat: f.sinceWhat } : {}),
      ...(reason === "backlog" ? { backlog: sl!.backlog as number } : {}),
      actions, also: reasons.slice(1),
      ...((p) => (p ? { primary: p } : {}))(primaryOf(reason, actions)),
      row,
    });
  }
  return out;
}

/** Pure: group order, then oldest `since` first (none last), then name. */
export function sortProblems(ps: Problem[]): Problem[] {
  const g = (p: Problem) => GROUPS.findIndex((x) => x.group === p.group);
  return [...ps].sort((a, b) => g(a) - g(b) || (a.since ?? Infinity) - (b.since ?? Infinity) || a.name.localeCompare(b.name) || a.space.localeCompare(b.space));
}

// ---------- the collect ----------

export interface SpaceRead {
  space: string;
  remote: boolean;
  server: string;
  read: "ok" | "manager-down" | "error";
  error?: string;
}

export interface ProblemsReport {
  now: number;
  machine: string;
  spaces: SpaceRead[];
  notRead: string[];
  problems: Problem[];
  errors: string[];
}

export interface CollectDeps {
  now: () => number;
  managerUp: (space: string) => boolean;
  liveRecord: (space: string) => LiveRecord | undefined;
  status: (space: string) => Promise<{ rows: AgentStatus[]; errors: string[] }>;
  fleet: (space: string) => Promise<Fleet>;
  sleepFacts: (space: string, name: string) => { rec?: SleepRecord; facts: SleepFacts };
  backlog: (space: string, name: string, rec: SleepRecord) => Promise<number | "skip">;
  wedge: (space: string, name: string, now: number) => Wedge | undefined;
  ownedHere: (space: string, name: string) => boolean;
  folderGone: (row: AgentStatus) => boolean;
  remote: (space: string) => boolean;
  server: (space: string) => string;
  machine: (space: string) => string;
}

const sleepFactsOf = (space: string, name: string): { rec?: SleepRecord; facts: SleepFacts } => {
  const rec = readSleepRecord(space, name) ?? readWakingRecord(space, name);
  if (!rec) return { facts: {} };
  return {
    rec,
    facts: {
      since: rec.since,
      ...(rec.wakeFailures !== undefined ? { failures: rec.wakeFailures } : {}),
      ...(rec.lastError !== undefined ? { lastError: rec.lastError } : {}),
      ...(rec.wakeRequestedAt !== undefined ? { wakeRequestedAt: rec.wakeRequestedAt } : {}),
    },
  };
};

/** The DMs waiting for an asleep agent hosted here; "skip" when it is another machine's (remote space). */
async function backlogOf(space: string, name: string, rec: SleepRecord): Promise<number | "skip"> {
  const { standInRefusal, backlogFilters, dmsSince } = await import("./sleep-host.ts");
  const remote = isRemoteSpace(space);
  if (standInRefusal({ remote, rec, localInstanceId: remote ? localManagerInstanceId(space) : undefined, personaHere: existsSync(personaFilePath(space, name)) })) return "skip";
  // Read-only: an existing stand-in identity, never a freshly minted one (standInPrincipal would mint).
  const standIn = remote ? readStandInIdentity(space, name)?.id : standInActor(space, name);
  if (!standIn) throw new Error("no stand-in identity minted for it yet");
  const { DEV_OWNER } = await import("@cotal-ai/core");
  return dmsSince(space, name, backlogFilters(space, rec, { owner: DEV_OWNER, actor: standIn }), rec.cursorSeq);
}

export const realDeps: CollectDeps = {
  now: () => Date.now(),
  managerUp: (s) => managerProcs(s).length > 0,
  liveRecord: readLiveRecord,
  status: (s) => withManagerControl(s, pawServer(s), (ctl) => collectStatus(s, ctl, { git: false }), { only: ["ps"] }),
  fleet: (s) => snapshotFleet(s, { sampleMs: 0 }),
  sleepFacts: sleepFactsOf,
  backlog: backlogOf,
  wedge: readWedge,
  ownedHere: (s, n) => isLocalHere(s, n),
  folderGone,
  remote: isRemoteSpace,
  server: pawServer,
  machine: (s) => localMachine(s).name,
};

/** Which spaces a `--problems` run looks at: the one chosen, or every space dir on this machine when defaulted. */
export function problemSpaces(space: string, how: string, dirs: () => string[] = spaceDirs): string[] {
  return how === "default" ? dirs() : [space];
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms).unref())]);

async function readSpace(space: string, d: CollectDeps, errors: string[]): Promise<{ read: SpaceRead; input?: SpaceInput } | { notRead: true }> {
  const base = { space, remote: d.remote(space), server: d.server(space) };
  const machine = d.machine(space);
  try {
    const live = d.liveRecord(space);
    if (!d.managerUp(space)) {
      if (!live?.names.length) return { notRead: true };
      return { read: { ...base, read: "manager-down" }, input: { space, machine, live, rows: [], sleep: new Map(), wedges: new Map(), asks: [], gone: new Set(), ownedHere: () => true } };
    }
    const fleet = d.fleet(space).catch((e: Error) => {
      errors.push(`paw: couldn't read ${space}'s background processes (${reasonOf(e.message)})`);
      return undefined;
    });
    const status = await d.status(space);
    errors.push(...status.errors);
    const now = d.now();
    const sleep = new Map<string, SleepFacts>();
    await Promise.all(
      status.rows
        .filter((r) => !r.unregistered && SLEEP_WORDS.has(r.mesh) && r.mesh !== "sleep record corrupt")
        .map(async (r) => {
          const { rec, facts } = d.sleepFacts(space, r.name);
          if (r.mesh === "asleep" && rec) {
            try {
              const n = await withTimeout(d.backlog(space, r.name, rec), BACKLOG_READ_MS);
              if (n !== "skip") facts.backlog = n;
            } catch (e) {
              facts.backlog = "error";
              errors.push(`paw: couldn't count ${r.name}#${space}'s waiting DMs (${reasonOf((e as Error).message)})`);
            }
          }
          sleep.set(r.name, facts);
        }),
    );
    const wedges = new Map<string, Wedge>();
    for (const r of status.rows) {
      if (r.unregistered || r.elsewhere) continue;
      const w = d.wedge(space, r.name, now);
      if (w) wedges.set(r.name, w);
    }
    const f = await fleet;
    const asks = f ? tidyAsks(f, now, { olderMs: IDLE_BG_MS, minMb: 20 }) : [];
    const gone = new Set(status.rows.filter((r) => d.folderGone(r)).map((r) => r.name));
    const owned = new Map<string, boolean>();
    const ownedHere = (n: string) => owned.get(n) ?? (owned.set(n, d.ownedHere(space, n)), owned.get(n)!);
    return { read: { ...base, read: "ok" }, input: { space, machine, live, rows: status.rows, sleep, wedges, asks, gone, ownedHere } };
  } catch (e) {
    return { read: { ...base, read: "error", error: reasonOf((e as Error).message) } };
  }
}

/** Read every space concurrently and classify. Never ensure()s; a failed space read is its `error`. */
export async function collectProblems(spaces: string[], deps: Partial<CollectDeps> = {}): Promise<ProblemsReport> {
  const d = { ...realDeps, ...deps };
  const errors: string[] = [];
  const reads = await Promise.all(spaces.map((s) => readSpace(s, d, errors)));
  const now = d.now();
  const out: ProblemsReport = { now, machine: [...new Set(spaces.map(d.machine))].join(" / ") || d.machine(DEFAULT_SPACE), spaces: [], notRead: [], problems: [], errors };
  reads.forEach((r, i) => {
    if ("notRead" in r) {
      out.notRead.push(spaces[i]!);
      return;
    }
    out.spaces.push(r.read);
    if (r.input) out.problems.push(...classify(r.input, now));
  });
  out.problems = sortProblems(out.problems);
  return out;
}

// ---------- the view (pure) ----------

const paintWith = (on: boolean) => (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
const GLYPH_COLOR: Record<Group, string> = { dead: "31", stuck: "33", asleep: "2", "folder-gone": "33", elsewhere: "2", "idle-bg": "2" };

export const sinceText = (p: Pick<Problem, "since" | "sinceWhat">, now: number): string => {
  if (p.since === undefined) return "—";
  const bare = p.sinceWhat === "tool started" || p.sinceWhat === "failed" || p.sinceWhat === "wake asked";
  return `${bare ? "" : `${p.sinceWhat} `}${ago(p.since, now)}`;
};

/** The DO cell: the primary action's command, prefixed with the machine that may run it when it isn't this one. */
export const doText = (p: Problem): string => {
  const a = p.primary;
  if (!a) return "";
  return a.here || a.class === "shown" ? a.cmd : `on ${p.where?.label ?? "another machine"}: ${a.cmd}`;
};

export interface Line {
  text: string;
  /** The problem this line belongs to (its first line) — the TUI's cursor target. */
  id?: string;
}

const elideRight = (s: string, max: number) => (s.length <= max ? s : max <= 1 ? "…" : `${s.slice(0, max - 1)}…`);

/** The groups as lines. `doColumn: false` (the TUI) leaves the command to the footer. `fact` overrides a row's FACT (the TUI's inbox growth). */
export function problemLines(problems: Problem[], o: { width: number; now: number; tty: boolean; doColumn?: boolean; fact?: (p: Problem) => string }): Line[] {
  const paint = paintWith(o.tty);
  const doCol = o.doColumn !== false;
  const nameOf = (p: Problem) => (p.reason === "manager-down" ? `${p.space} (space)` : problemId(p));
  const factOf = (p: Problem) => o.fact?.(p) ?? p.fact;
  const nameW = Math.max(0, ...problems.map((p) => nameOf(p).length));
  const whereW = Math.max(1, ...problems.map((p) => (p.where?.label ?? "—").length));
  const forW = Math.max(1, ...problems.map((p) => sinceText(p, o.now).length));
  const factMax = Math.max(1, ...problems.map((p) => factOf(p).length));
  const fixed = 2 + nameW + 2 + whereW + 2 + 2 + forW;
  const doW = doCol ? Math.max(0, ...problems.map((p) => doText(p).length)) : 0;
  // DO rides the row only when the FACT keeps a readable width beside it; else it gets a `↳` line.
  const inlineFact = Math.min(factMax, o.width - fixed - 2 - doW);
  const narrow = o.width < 120 || inlineFact < Math.min(factMax, 40);
  const factW = Math.max(12, narrow ? Math.min(factMax, o.width - fixed) : inlineFact);
  const lines: Line[] = [];
  for (const g of GROUPS) {
    const ps = problems.filter((p) => p.group === g.group);
    if (!ps.length) continue;
    lines.push({ text: paint("1")(`${g.title} ${ps.length}`) });
    for (const p of ps) {
      const fact = elideRight(factOf(p), factW);
      const doCell = doCol ? doText(p) : "";
      const head = `${paint(GLYPH_COLOR[g.group])(g.glyph)} ${nameOf(p).padEnd(nameW)}  ${(p.where?.label ?? "—").padEnd(whereW)}  ${fact.padEnd(factW)}  `;
      const forCell = sinceText(p, o.now);
      if (doCell && !narrow) lines.push({ id: problemId(p), text: `${head}${forCell.padEnd(forW)}  ${doCell}` });
      else {
        lines.push({ id: problemId(p), text: `${head}${forCell}`.trimEnd() });
        if (doCell) lines.push({ text: `  ↳ ${doCell}` });
      }
    }
  }
  return lines;
}

const brokerText = (s: SpaceRead) => (s.remote ? `remote broker ${s.server}` : "local broker");
const needText = (n: number) => `${n} ${n === 1 ? "needs" : "need"} attention`;
const NOT_READ_WHY = "no manager here, nothing recorded live";

/** The one-shot text — `paw status --problems` and `paw top --problems` off a tty print exactly this. */
export function renderProblems(report: ProblemsReport, o: { width: number; now: number; tty: boolean }): string {
  const out: string[] = [];
  const notRead = report.notRead.length ? [`not read: ${report.notRead.join(", ")} (${NOT_READ_WHY})`] : [];
  const read = report.spaces.filter((s) => s.read !== "error").map((s) => s.space);
  if (!report.problems.length) {
    const ok = paintWith(o.tty)("32")(OK);
    out.push(`${ok} nothing needs attention — ${read.length ? `${read.join(", ")} read on ${report.machine}` : `no space read on ${report.machine}`}`);
    if (notRead.length) out.push(...notRead);
    return out.join("\n");
  }
  const spaces = report.spaces.map((s) => `${s.space} (${brokerText(s)})`).join(" · ");
  out.push(`problems on ${report.machine} · ${spaces} · ${needText(report.problems.length)}`, "");
  out.push(...problemLines(report.problems, o).map((l) => l.text));
  if (notRead.length) out.push("", ...notRead);
  return out.join("\n");
}

/** A failed space read, as the one line stderr (and the TUI) shows. */
export const spaceErrorLine = (s: SpaceRead): string => problemLine(FAIL, `${s.space} — couldn't read (${s.error})`);

/** The JSON payload: the report as-is (rows verbatim from collectStatus), `primary` folded into `actions`. */
export function problemsJson(report: ProblemsReport): unknown {
  return {
    now: report.now,
    machine: report.machine,
    spaces: report.spaces.map((s) => ({ space: s.space, remote: s.remote, read: s.read, ...(s.error ? { error: s.error } : {}) })),
    notRead: report.notRead,
    problems: report.problems.map(({ primary: _primary, ...p }) => p),
    errors: report.errors,
  };
}

// ---------- the CLI entry (status --problems / top --problems) ----------

export const PROBLEMS_USAGE = "paw: --problems takes only [--json] [--space s]";

/** Parse `--problems [--json] [--space s]` — anything else alongside it fails loud before any read. */
export function parseProblemsArgs(argv: string[]): { json: boolean; space?: string } {
  let json = false;
  let space: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--problems") continue;
    if (a === "--json") json = true;
    else if (a === "--space") {
      space = argv[++i];
      if (!space) throw new Error(PROBLEMS_USAGE);
    } else throw new Error(PROBLEMS_USAGE);
  }
  return { json, ...(space ? { space } : {}) };
}

/** Run the problems view. `live` = `paw top --problems` (a TUI when stdin and stdout are ttys and no --json). */
export async function runProblems(argv: string[], o: { live: boolean }): Promise<void> {
  const args = parseProblemsArgs(argv);
  const { resolveSpace } = await import("./lifecycle.ts");
  const { spaceChoice } = await import("./space.ts");
  const space = args.space ?? resolveSpace();
  const spaces = problemSpaces(space, spaceChoice(space).how);
  const collect = () => collectProblems(spaces);
  if (o.live && !args.json && process.stdin.isTTY && process.stdout.isTTY) {
    const { runProblemsTui } = await import("./problems-tui.ts");
    process.exitCode = await runProblemsTui({ collect });
    return;
  }
  const report = await collect();
  const failed = report.spaces.filter((s) => s.read === "error");
  if (args.json) {
    const { writeJson } = await import("./stdout.ts");
    writeJson(problemsJson(report));
  } else {
    const width = process.stdout.isTTY ? (process.stdout.columns ?? 100) : Number.POSITIVE_INFINITY;
    const { writeOut } = await import("./stdout.ts");
    writeOut(renderProblems(report, { width, now: report.now, tty: process.stdout.isTTY === true && !process.env.NO_COLOR }) + "\n");
  }
  for (const s of failed) process.stderr.write(spaceErrorLine(s) + "\n");
  for (const e of report.errors) process.stderr.write(e + "\n");
  if (failed.length) process.exitCode = 1;
}

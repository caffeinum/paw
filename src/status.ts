/**
 * `paw status [--space]` — the ONE view of every registered agent (the former `paw ps` + `paw status`
 * merged). One row per agent, live or not: mesh STATUS (idle/working/starting/offline), the manager
 * RUNTIME it's under, its CWD, its SESSION (human name / adopted / short id), its INBOX (durable
 * DM-consumer lag — queued/unread, the zombie detector presence can't be), LAST ACTIVE (transcript
 * mtime), and durability/two-writer warnings. `ps` was a native reimpl of the manager's ps (still at
 * `paw cotal ps` for the raw view); status now carries the liveness column too, so there's one command.
 */
import { sleepState } from "./sleep-state.ts";
import { dmDurable, dmStream, parsePrincipalKey, type Command, registry } from "@cotal-ai/core";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { agentNamesForFolder, canonicalDir, controlCreds, listAgents, personaFilePath, psRowAlive, terminalLost, type PsRow, wirePrincipal } from "./addressing.ts";
import { withManagerControl, type ManagerControl } from "./control.ts";
import { listForeground } from "./foreground.ts";
import { ensure, formatHubLine, hubState, READY_PROBE_MS, readRuntimeMarker, resolveSpace, type HubState, type Runtime } from "./lifecycle.ts";
import { writeJson } from "./stdout.ts";
import { liveSessionProcsMany, nameForSession, readIndex as readSessionIndex, type LiveSessionProc } from "./named.ts";
import { isClaudeHarness, readAgentType, readResumeId, transcriptPath, transcriptPaths } from "./session.ts";
import { lastFailure, lastUsage, type ContextUsage } from "./transcript.ts";
import { tailRead, turnState, type PendingTool, type TurnState } from "./transcript.ts";
import { gitInfoMany, type GitInfo } from "./git.ts";
import { pawServer } from "./server.ts";
import { presenceLive, readMeshRoster } from "./roster.ts";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), green: wrap("32"), yellow: wrap("33"), red: wrap("31") };

/** An agent's durable DM-consumer lag (`dm_<id>` on the `DM_<space>` stream) — the "is it actually
 *  consuming its inbox?" signal presence can't give. A zombie (mesh presence alive but deaf) shows
 *  healthy `idle` while DMs pile up; this makes that visible.
 *  - lag:   the consumer exists — `queued` = num_pending (undelivered), `unread` = num_ack_pending
 *           (delivered but never acked).
 *  - none:  no durable consumer (agent never connected, or no ps id) — a legitimate state, not an error.
 *  - error: the JetStream query FAILED — rendered "?" (never a fabricated 0); detail goes to stderr. */
export type InboxState =
  | { kind: "lag"; queued: number; unread: number }
  | { kind: "none" }
  | { kind: "error" };

export interface AgentStatus {
  name: string;
  folder: string;
  mesh: string; // display status: idle | working | waiting | starting | offline
  live: boolean; // reachable on the mesh (psRowAlive, or a live foreground claude) — drives RUNTIME
  runtime?: Runtime | "fg"; // the manager runtime (live managed agent), or "fg" for a foreground `paw claude`
  pin?: string; // pinned resume session id, if any
  sessionName?: string; // human session name (claude --session-name / /rename), if recorded
  durable: boolean; // pin's transcript exists → survives a restart
  activeMs?: number; // transcript mtime — "last active"
  /** paw's own inference that a turn is IN FLIGHT (see {@link inferBusy}). Deliberately its own field
   *  rather than folded into `mesh`: one is what the agent CLAIMED, the other is what paw WORKED OUT,
   *  and a reader has to be able to tell them apart. */
  busy?: boolean;
  /** The tool call the agent's running turn is sitting INSIDE (tool_use with no tool_result yet) — set
   *  only for a live agent whose transcript shows one. With `startedMs` it says how long; without, no
   *  age is claimed. A hung tool blocks every later DM until it returns (see {@link hungTool}). */
  tool?: PendingTool;
  /** Repo, branch and worktree for the agent's folder — the thing you actually want to know when a
   *  dozen agents are working. Absent when the folder isn't a git checkout. */
  git?: GitInfo;
  conflictPids: number[]; // standalone claude procs holding the pin (two-writer hazard)
  inbox: InboxState; // durable DM-consumer lag — the zombie detector
  /** The agent's LAST turn was a runtime failure (session limit, login expired, API error…): the
   *  model never ran, so the DM that woke it got no reply and the mesh still shows a healthy idle
   *  agent. Read from the transcript (`lastFailure`), the only place claude writes it. */
  failure?: { text: string; ts: number };
  /** How full the agent's context window is (see {@link ContextUsage}). Read from the transcript —
   *  cotal carries no token information at all — so it is claude-only and absent for a codex/opencode
   *  harness, an unpinned agent, or a session that hasn't taken a turn yet. */
  context?: ContextUsage;
  /** The manager lists the agent's terminal as gone (`exited`) while the agent heartbeats on the mesh —
   *  it's alive and answers DMs, but nothing can attach or type into it (see psRowAlive). */
  terminalLost?: boolean;
  /** Live on the mesh (fresh presence heartbeat) but NOT in the current manager's ps — spared by a
   *  previous manager's stop (cotal >=0.49). Reachable by DM; `paw restart <name>` re-adopts it. */
  unmanaged?: boolean;
  /** The manager lists this agent but paw's registry does NOT (a `cotal_spawn` / `paw cotal spawn`
   *  peer, 2026-09-09): shown so the dashboard agrees with the mesh, with the harness the manager
   *  reports. No folder, pin, transcript or revival — paw only ever knows what the ps row says. */
  unregistered?: { agent: string };
  /** Persona `agent:` pin (claude/opencode/codex/…). Absent = paw's default claude. The claude-only
   *  pin/transcript columns must not be judged against a non-claude harness. */
  harness?: string;
}

/** Map a manager ps row to the display status. Not listed → offline; "absent" (mid-start) → starting. */
/**
 * How recently the transcript must have been written for paw to call an agent BUSY.
 *
 * This is an INFERENCE, not something the agent told us, which is why it gets its own word. The mesh
 * publishes `working` only on the connector's `UserPromptSubmit` hook — but a turn woken by a mesh DM
 * arrives through the channel nudge and inbox drain, which submits no user prompt, so essentially
 * every agent-to-agent turn runs while presence still reads `idle`. Transcript mtime is the one local
 * signal that moves during a turn regardless of how it started.
 */
const BUSY_WINDOW_MS = 10_000;

/** Is this agent almost certainly mid-turn? Only meaningful for a LIVE agent whose mesh status hasn't
 *  already told us something more specific (`working`/`waiting` come from the agent itself and win). */
/**
 * Is this agent mid-turn?
 *
 * Preferred evidence is the transcript's own turn markers, which are EXACT: claude closes a completed
 * turn with a `system/turn_duration` record, and a running one ends on a tool_use/tool_result pair with
 * no such marker. That holds however long the agent thinks or however slow its tool is — where the
 * mtime heuristic below only ever meant "wrote something in the last 10 seconds" and went dark on an
 * agent stuck on a long command.
 *
 * Falls back to that heuristic when the markers cannot be read (no pin, no transcript yet, or hooks
 * disabled so no turn_duration was ever written). The agent's OWN `working` claim still wins over both.
 */
function liveTurn(t: TranscriptRead | undefined, mesh: string): { busy: boolean; tool?: PendingTool } {
  const state = t?.turn();
  const tool = state?.inFlight ? state.tool : undefined;
  if (mesh === "working" || mesh === "waiting") return { busy: true, tool }; // what the agent said beats what we infer
  if (state?.inFlight !== undefined) return { busy: state.inFlight, tool };
  return { busy: inferBusy(mesh, true, t?.mtimeMs, Date.now()) };
}

const TAIL_SMALL = 64 * 1024;
const TAIL_CONTEXT = 128 * 1024;
const TAIL_TURN_WIDE = 2 * 1024 * 1024;

/** The last 128KB and the last 64KB of a transcript from ONE read — byte-for-byte what
 *  `tailRead(file, 128K)` and `tailRead(file, 64K)` return (the partial first line dropped from each),
 *  so the failure, context and turn readers below see exactly what they did when each read its own. */
export function transcriptTails(file: string): { small: string; context: string } {
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_CONTEXT);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const from = (offset: number) => {
      const s = buf.subarray(offset - start).toString("utf8");
      return offset > 0 ? s.slice(s.indexOf("\n") + 1) : s;
    };
    return { small: from(Math.max(0, size - TAIL_SMALL)), context: from(start) };
  } finally {
    closeSync(fd);
  }
}

/** One transcript, read once: its mtime eagerly, its tails once, and each derived reading on demand
 *  (the turn state is only wanted for a LIVE agent). Undefined ⇔ no transcript (not durable). */
interface TranscriptRead {
  mtimeMs: number;
  failure(): { text: string; ts: number } | undefined;
  context(): ContextUsage | undefined;
  turn(): TurnState | undefined;
}

function readTranscript(file: string | undefined): TranscriptRead | undefined {
  if (!file) return undefined;
  const mtimeMs = statSync(file).mtimeMs;
  let tails: { small: string; context: string } | undefined;
  try {
    tails = transcriptTails(file);
  } catch {
    tails = undefined; // unreadable → every reading below is "no claim", as each was on its own
  }
  const lines = (s: string) => s.split("\n").filter(Boolean);
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    mtimeMs,
    failure: () => (tails ? attempt(() => lastFailure(lines(tails!.small))) : undefined),
    context: () => (tails ? attempt(() => lastUsage(lines(tails!.context))) : undefined),
    turn: () => (tails ? attempt(() => turnStateFrom(file, tails!.small)) : undefined),
  };
}

/** {@link readTurnState} over an already-read 64KB tail. */
function turnStateFrom(file: string, small: string): TurnState {
  const st = turnState(small);
  return st.inFlight !== undefined ? st : turnState(tailRead(file, TAIL_TURN_WIDE));
}

/**
 * The pinned transcript's turn state, read from its tail. 64KB first (cheap on a 50MB file); if that
 * window holds NO message record at all, widen to 2MB — a tool hung for an hour buries its own
 * tool_use under `queue-operation` records (one per DM wake nudge, ~3/min in the queue-ea incident),
 * and a 64KB tail of only those would read as "cannot tell" exactly when it matters most.
 * Undefined when there is no transcript or it can't be read.
 */
export function readTurnState(pin: string): TurnState | undefined {
  const file = transcriptPath(pin);
  if (!file) return undefined;
  try {
    return turnStateFrom(file, tailRead(file, TAIL_SMALL));
  } catch {
    return undefined; // unreadable → no claim either way
  }
}

/** How long a tool must have been running before `paw status` calls it out (`in tool 12m`). Short tools
 *  are the normal state of a working agent; this marks the ones that are plausibly stuck. */
export const HUNG_TOOL_SHOW_MS = 5 * 60_000;

/** Pure: the running tool's age in ms when it has run at least `minMs`, else undefined. Needs a live
 *  agent and a known start — an unknown start is no claim, and a future start (clock skew) is not
 *  evidence. */
export function hungTool(r: Pick<AgentStatus, "live" | "tool">, now: number, minMs = HUNG_TOOL_SHOW_MS): number | undefined {
  if (!r.live || !r.tool || r.tool.startedMs === undefined) return undefined;
  const age = now - r.tool.startedMs;
  return age >= minMs ? age : undefined;
}

/** `Bash: fly ssh console -a …` — the tool and the first ~60 chars of its gist. */
export function toolLabel(t: PendingTool): string {
  const gist = t.summary.length > 60 ? `${t.summary.slice(0, 59)}…` : t.summary;
  return gist ? `${t.name}: ${gist}` : t.name;
}

/** The newest turn's runtime failure, if the newest turn IS one. Tail-reads the pinned transcript
 *  (last 64KB — a failure turn is small and recent by definition); a missing transcript is undefined. */
export function transcriptFailure(pin: string): { text: string; ts: number } | undefined {
  const file = transcriptPath(pin);
  if (!file) return undefined;
  try {
    return lastFailure(tailRead(file, TAIL_SMALL).split("\n").filter(Boolean));
  } catch {
    return undefined;
  }
}

/**
 * The agent's context fill, from the pinned transcript's tail.
 *
 * 128KB rather than the failure read's 64KB: a failure turn is tiny and by definition the last thing
 * written, whereas the newest `usage` can sit behind one fat tool_result (a Read of a big file). Still
 * a tail read, so it stays cheap on the 100s-MB transcripts in this fleet. A tail with no assistant
 * turn in it yields undefined — unknown, never a zero that would draw an empty context bar.
 */
export function transcriptContext(pin: string): ContextUsage | undefined {
  const file = transcriptPath(pin);
  if (!file) return undefined;
  try {
    return lastUsage(tailRead(file, TAIL_CONTEXT).split("\n").filter(Boolean));
  } catch {
    return undefined;
  }
}

function sessionConflicts(all: LiveSessionProc[]): number[] {
  return (all.length > 1 ? all : all.filter((p) => !p.mesh)).map((p) => p.pid); // one index read, not two
}

export function inferBusy(mesh: string, live: boolean, activeMs: number | undefined, now: number): boolean {
  if (!live || mesh !== "idle" || activeMs === undefined) return false;
  const age = now - activeMs;
  // A clock skew (mtime in the future) is not evidence of anything — don't report on it.
  return age >= 0 && age < BUSY_WINDOW_MS;
}

export function meshStatus(row: PsRow | undefined): { text: string; live: boolean } {
  if (!row) return { text: "offline", live: false };
  const live = psRowAlive(row);
  if (row.mesh === "absent") return { text: "starting", live: true };
  if (!row.mesh || row.mesh === "offline") return { text: "offline", live: false };
  return { text: row.mesh, live };
}

/** How to refer to an agent's session: its human name (claude --session-name / /rename — what an
 *  adopted-from-claude session carries) if set, else a short id, else — for a pinless agent. */
function sessionRef(r: AgentStatus): string {
  if (r.sessionName) return `"${r.sessionName}"`;
  if (r.pin) return `${r.pin.slice(0, 8)}…`;
  return "—";
}

/** The INBOX column text: consumer lag rendered plainly, "—" for no consumer, "?" for a failed
 *  query (never a fabricated ✓/0 — fail-loud discipline). */
export function inboxText(s: InboxState): string {
  if (s.kind === "none") return "—";
  if (s.kind === "error") return "?";
  const bits = [s.queued > 0 && `${s.queued} queued`, s.unread > 0 && `${s.unread} unread`].filter(Boolean);
  return bits.length ? bits.join(", ") : "✓";
}

/** A live-on-the-mesh agent with mail sitting in its durable DM consumer is a ZOMBIE: presence says
 *  alive, but it isn't draining its inbox (the team2027-research incident of 2026-07-12 — a DM sat
 *  unacked for hours behind a healthy-looking `idle`). Presence-based liveness can't see this. */
export function inboxStuck(r: AgentStatus): boolean {
  // An agent MID-TURN holds the very message it is answering: cotal acks a DM when the turn ends, so
  // `1 unread` on a working agent is the work in flight, not a deaf consumer. Reported as "stuck" it
  // is a false alarm on the healthiest state there is — `research` read its own row that way and took
  // it for a defect. The detector's real target is the ZOMBIE: presence says idle, nothing is running,
  // and the mail sits. Both `working` (the agent's own claim) and `busy` (paw's inference from
  // transcript activity in the last 10s) are positive evidence that a turn is running, so neither can
  // be the zombie this looks for. An agent that is genuinely wedged stops writing its transcript and
  // falls out of `busy` within seconds, so the warning still arrives — just not aimed at working peers.
  if (r.busy === true || r.mesh === "working") return false;
  return r.live && r.inbox.kind === "lag" && (r.inbox.queued > 0 || r.inbox.unread > 0);
}

/** A trailing durability/health note, or "" when the agent is quietly durable. */
function note(r: AgentStatus, now: number): string {
  if (r.unregistered) return `unregistered ${r.unregistered.agent} peer (cotal_spawn) — paw restart registers + revives it`;
  // A hung tool outranks everything: it is WHY the inbox isn't draining, and `paw unstick` is the fix.
  const hung = hungTool(r, now);
  if (hung !== undefined && r.tool) return `⚠ tool running ${ago(now - hung, now)} (${toolLabel(r.tool)}) — \`paw unstick ${r.name}\``;
  // A refused turn is the most actionable note: the mesh reads "idle" while the agent can't answer.
  // The cause, not the advice that follows it ("… limit. Run /usage-credits to finish…"). Cutting at
  // the advice leaves a dangling verb ("limit. Run"), which reads like the line was truncated by
  // accident — so the orphan goes too.
  if (r.failure) return `⚠ ${r.failure.text.split(/\s+\/usage|\n/)[0].slice(0, 80).replace(/\s+(Run|Please run)$/, "")}`;
  if (r.unmanaged) return `not managed by the current manager — \`paw restart ${r.name}\` re-adopts it`;
  if (r.terminalLost) return `⚠ terminal lost — live on the mesh, but the manager can't reach its tmux window (\`paw attach ${r.name}\` explains)`;
  if (r.conflictPids.length) return `⚠ two writers (pid ${r.conflictPids.join(", ")})`;
  if (inboxStuck(r)) return `⚠ inbox stuck — ${inboxText(r.inbox)}, agent not consuming`;
  if (!r.pin && isClaudeHarness(r.harness)) return "⚠ no pin — resets on restart";
  if (!r.durable && isClaudeHarness(r.harness)) return "fresh (new session on first boot)";
  return "";
}

/**
 * The CTX cell: `152k`, or `152k/1M 15%` once the transcript has proved which window this session runs
 * under. Never a bare percentage — the tokens are the measurement, the share is the interpretation, and
 * on a fleet running both window sizes only one of those is always knowable.
 */
export function contextText(u: ContextUsage | undefined): string {
  if (!u) return "—";
  const n = (t: number) => (t >= 1_000_000 ? `${(t / 1_000_000).toFixed(t % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(t / 1000)}k`);
  if (u.limit === undefined) return n(u.tokens);
  return `${n(u.tokens)}/${n(u.limit)} ${Math.round((u.tokens / u.limit) * 100)}%`;
}

/** At what share of the window the cell starts warning. Autocompact fires near the top, and a compaction
 *  costs the agent its working memory — so "nearly full" is worth seeing BEFORE it happens. */
const CTX_WARN = 0.75;
const CTX_HIGH = 0.9;

/** How full is it, as a fraction — undefined when the window is unknown (no share to report). */
export function contextShare(u: ContextUsage | undefined): number | undefined {
  return u?.limit ? u.tokens / u.limit : undefined;
}

function tilde(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** Relative "how long ago", compact (s/m/h/d). `now` is injected so the formatter stays pure/testable. */
export function ago(ms: number | undefined, now: number): string {
  if (ms === undefined) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function statusColor(text: string): (s: string) => string {
  // `busy` is paw's inference and `working` is the agent's own claim — same colour, because to a
  // reader scanning the column they mean the same thing: this agent is doing something.
  if (text === "idle" || text === "working" || text === "busy" || text === "live (unmanaged)") return c.green;
  if (text === "starting" || text === "waiting" || text.startsWith("in tool")) return c.yellow;
  return c.dim; // offline
}

/** Pad a (possibly colored) value to `width` using its known PLAIN length — color codes don't count. */
function pad(value: string, plainLen: number, width: number): string {
  return value + " ".repeat(Math.max(0, width - plainLen));
}

/** Keep the END: a folder's tail (`…/evals/sc-entangled-fluxon-080a`) is what distinguishes it, while
 *  every worktree in the fleet shares the head. Truncating from the right would leave 30 rows reading
 *  `~/.superconductor/worktre…`, which identifies nothing. */
export function elideLeft(s: string, max: number): string {
  return s.length <= max ? s : "…" + s.slice(s.length - (max - 1));
}

/** Keep the START: a NAME or a note is read from its beginning, and it's the beginning you type. */
export function elideRight(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

const GAP = 2; // spaces between columns
/** Below this the columns stop being a table. A terminal narrower than this gets the squeezed layout
 *  anyway — wrapping is worse than eliding, which is the whole point. */
const MIN_NAME = 14;
const MIN_CWD = 18;
/** An inline note shorter than this says nothing ("⚠ You've reac…"), so it moves to its own line. */
const MIN_NOTE = 24;
/** Ceilings for the two columns whose widest value is usually an OUTLIER — see the call site. */
const NAME_CAP = 28;
const SESS_CAP = 24;

export interface ColumnPlan {
  name: number;
  status: number;
  rt: number;
  cwd: number;
  sess: number;
  inbox: number;
  ctx: number;
  active: number;
  /** Columns dropped to fit. RUNTIME goes first (it reads `tmux` on every row of this fleet — a column
   *  whose every cell is identical carries no information), SESSION second (it usually echoes the
   *  name). Both survive at full width, and `--wide` keeps them at any width. */
  showRt: boolean;
  showSess: boolean;
  /** Room left for a note on the SAME line. 0 ⇒ the note goes on its own indented line rather than
   *  wrapping the table — a warning that spills mid-column is what made this unreadable. */
  noteInline: number;
}

/**
 * Fit the table to the terminal.
 *
 * The old layout padded every column to its widest value and let the terminal wrap, so one 60-char
 * worktree path pushed CTX and ACTIVE onto a second line and the whole table became a stack of
 * ragged fragments (reported with a screenshot, 2026-09-17). Nothing here invents room: it drops the
 * two columns that repeat themselves, elides the two that are long, and moves a note that can't fit
 * onto its own line. Pure, so `check:status` can assert each step.
 */
export function planColumns(nat: Omit<ColumnPlan, "showRt" | "showSess" | "noteInline">, width: number, opts: { wide?: boolean } = {}): ColumnPlan {
  const p: ColumnPlan = { ...nat, showRt: true, showSess: true, noteInline: 0 };
  const total = (q: ColumnPlan) => {
    const cols = [q.name, q.status, q.showRt ? q.rt : -GAP, q.cwd, q.showSess ? q.sess : -GAP, q.inbox, q.ctx, q.active];
    return cols.reduce((a, b) => a + b + GAP, -GAP);
  };
  if (opts.wide || !Number.isFinite(width)) return { ...p, noteInline: Number.POSITIVE_INFINITY };

  // The COLUMNS are fitted first and the note takes whatever is left, never the other way round. A note
  // belongs to ONE row; sizing the table so a single ⚠ fits would cost every other row a column to buy
  // space for a warning that has a continuation line available anyway.
  if (total(p) > width) p.showRt = false;
  if (total(p) > width) p.showSess = false;
  if (total(p) > width) p.cwd = Math.max(MIN_CWD, p.cwd - (total(p) - width));
  if (total(p) > width) p.name = Math.max(MIN_NAME, p.name - (total(p) - width));
  const left = width - total(p) - GAP;
  return { ...p, noteInline: left >= MIN_NOTE ? left : 0 };
}

/** The terminal's width. Not a tty (piped into `grep`/a file) ⇒ no limit: a pipe has no width, and
 *  eliding there would truncate the very text the reader is grepping for. */
function termWidth(): number {
  return process.stdout.isTTY ? (process.stdout.columns ?? 100) : Number.POSITIVE_INFINITY;
}

/** Render the unified status table. Pure (no I/O; `now` and the terminal width injected) so it's
 *  unit-testable — `width` defaults to the live terminal, `wide` keeps every column at any width. */
export function formatStatus(rows: AgentStatus[], now: number, width: number = termWidth(), wide = false): string {
  if (rows.length === 0) return "(no agents registered)";
  /** What the STATUS cell says. `busy` is paw's own inference from transcript activity — deliberately
   *  a different word from the mesh's `working`, so a reader can tell "the agent said so" from
   *  "paw worked it out". See inferBusy. */
  const statusText = (r: AgentStatus) => {
    const hung = hungTool(r, now);
    if (hung !== undefined) return `in tool ${ago(now - hung, now)}`;
    if (r.unmanaged) return "live (unmanaged)";
    return (r.busy ?? inferBusy(r.mesh, r.live, r.activeMs, now)) ? "busy" : r.mesh;
  };
  const cwd = (r: AgentStatus) => (r.folder ? tilde(r.folder) : "—");
  const rtText = (r: AgentStatus) => (r.live && r.runtime ? r.runtime : "—");
  const notes = new Map(rows.map((r) => [r.name, note(r, now)]));
  const w = planColumns(
    {
      // CAPPED, not simply "as wide as the widest": one 37-char name
      // (`fix-verifier-retry-connect-unavailable`) otherwise sets the column for all 118 rows and takes
      // that width out of CWD on every one of them. An outlier elides; the fleet keeps its paths.
      name: Math.min(NAME_CAP, Math.max(4, ...rows.map((r) => r.name.length))),
      status: Math.max(6, ...rows.map((r) => statusText(r).length)),
      rt: Math.max(7, ...rows.map((r) => rtText(r).length)),
      cwd: Math.max(3, ...rows.map((r) => cwd(r).length)),
      sess: Math.min(SESS_CAP, Math.max(7, ...rows.map((r) => sessionRef(r).length))),
      inbox: Math.max(5, ...rows.map((r) => inboxText(r.inbox).length)),
      ctx: Math.max(3, ...rows.map((r) => contextText(r.context).length)),
      active: 6,
    },
    width,
    { wide },
  );
  const header = c.dim(
    `${"NAME".padEnd(w.name)}  ${"STATUS".padEnd(w.status)}  ${w.showRt ? `${"RUNTIME".padEnd(w.rt)}  ` : ""}${"CWD".padEnd(w.cwd)}  ${w.showSess ? `${"SESSION".padEnd(w.sess)}  ` : ""}${"INBOX".padEnd(w.inbox)}  ${"CTX".padEnd(w.ctx)}  ACTIVE`,
  );
  const lines = rows.flatMap((r) => {
    const rt = rtText(r);
    const sess = elideRight(sessionRef(r), w.sess);
    const inbox = inboxText(r.inbox);
    const inboxColored = inboxStuck(r) ? c.yellow(inbox) : r.inbox.kind === "error" ? c.red(inbox) : r.inbox.kind === "lag" && inbox === "✓" ? c.green(inbox) : c.dim(inbox);
    const ctx = contextText(r.context);
    const share = contextShare(r.context);
    // Only a KNOWN share may colour: an unknown window is dim, never amber — the one thing worse than
    // no percentage is a warning colour standing in for one.
    const ctxColored = share === undefined ? c.dim(ctx) : share >= CTX_HIGH ? c.red(ctx) : share >= CTX_WARN ? c.yellow(ctx) : c.dim(ctx);
    const n = notes.get(r.name) ?? "";
    const paint = (s: string) => (n.startsWith("⚠") ? c.yellow(s) : c.dim(s));
    // A note that fits rides the row; one that doesn't gets its OWN indented line rather than wrapping
    // through the columns. Nothing is silently dropped — the reason a row is flagged is the point.
    const inline = n && n.length <= w.noteInline ? "  " + paint(n) : "";
    const name = elideRight(r.name, w.name);
    const folder = elideLeft(cwd(r), w.cwd);
    const row =
      `${pad(c.bold(name), name.length, w.name)}  ` +
      `${pad(statusColor(statusText(r))(statusText(r)), statusText(r).length, w.status)}  ` +
      (w.showRt ? `${pad(r.live ? rt : c.dim(rt), rt.length, w.rt)}  ` : "") +
      `${pad(c.dim(folder), folder.length, w.cwd)}  ` +
      (w.showSess ? `${pad(sess, sess.length, w.sess)}  ` : "") +
      `${pad(inboxColored, inbox.length, w.inbox)}  ` +
      `${pad(ctxColored, ctx.length, w.ctx)}  ` +
      `${c.dim(ago(r.activeMs, now))}${inline}`;
    return n && !inline ? [row, "  " + paint(elideRight(n, Math.max(MIN_NOTE, width - 2)))] : [row];
  });
  const conflicts = rows.filter((r) => r.conflictPids.length).length;
  const pinless = rows.filter((r) => !r.pin && isClaudeHarness(r.harness) && !r.unregistered).length;
  const stuck = rows.filter(inboxStuck).length;
  const hung = rows.filter((r) => hungTool(r, now) !== undefined).length;
  const out = [header, ...lines];
  if (conflicts || pinless || stuck || hung) {
    const bits = [
      hung && `${hung} agent(s) inside a long-running tool`,
      conflicts && `${conflicts} two-writer conflict(s)`,
      stuck && `${stuck} stuck inbox(es)`,
      pinless && `${pinless} unpinned`,
    ].filter(Boolean);
    out.push("", c.yellow(`⚠ ${bits.join(", ")} — see above`));
  }
  return out.join("\n");
}

function parseSpace(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--space") return argv[++i];
  return undefined;
}

/** The positional TARGETS of `paw status [<name|folder>…]`. An unknown flag fails loud — it used to be
 *  ignored along with every positional, so `paw status canary-env-52` printed all 118 rows and looked
 *  like it had worked. */
export function statusTargets(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") i++;
    else if (a === "--json" || a === "--wide") continue;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — status takes [<name|folder|state>…] [--json] [--wide]`);
    else out.push(a);
  }
  return out;
}

/** A target that names a FOLDER rather than an agent: the same sigils the ambiguity guard exempts.
 *  A bare word is always a NAME here — reading it as a folder too is the name-vs-folder confusion
 *  `@queue` → queue-ea was (2026-09-17). */
const isPathTarget = (t: string) => t === "." || t === ".." || /^(\.{1,2}\/|\/|~)/.test(t);

/**
 * Narrow the roster to what was asked for, keeping its order (live first, then most recent).
 *
 * A NAME must match an agent exactly; a PATH selects every agent registered to that folder (its
 * default and any extras — `paw status .` answers "what's running here"). Nothing is resolved by
 * guessing: an unknown name fails loud with the names that CONTAIN it, since a typo'd name that
 * silently printed the whole fleet is the bug this replaces. Read-only — `folderAgents` must never
 * mint a registration, which is why it isn't `resolveFolderAgent`.
 */
export function selectRows<T extends StateFields>(rows: T[], targets: string[], folderAgents: (target: string) => { folder: string; names: string[] }): T[] {
  if (targets.length === 0) return rows;
  const want = new Set<string>();
  const states = new Set<RowState>();
  for (const t of targets) {
    if (isPathTarget(t)) {
      const { folder, names } = folderAgents(t);
      if (names.length === 0) throw new Error(`paw: no agent registered for ${folder} (\`paw chat ${t}\` starts one)`);
      for (const n of names) want.add(n);
      continue;
    }
    const state = STATE_WORDS[t];
    if (state && rows.some((r) => r.name === t)) {
      // An agent literally named `live` or `busy` would make the word mean two things. Refuse rather
      // than pick one — the fix is a rename, and choosing silently is how the wrong rows get shown.
      throw new Error(`paw: "${t}" is both an agent and a status — rename the agent (\`paw rename ${t} <new>\`) to use either`);
    }
    if (state) {
      states.add(state);
      continue;
    }
    if (rows.some((r) => r.name === t)) {
      want.add(t);
      continue;
    }
    const near = rows.filter((r) => r.name.includes(t)).map((r) => r.name).slice(0, 5);
    throw new Error(
      `paw: no agent "${t}"${near.length ? ` — did you mean ${near.map((n) => `"${n}"`).join(", ")}?` : ""} ` +
        `(statuses: ${Object.keys(STATE_WORDS).join(" ")})`,
    );
  }
  // Two KINDS of selector, two rules: names/folders say WHICH agents (union), states say in WHAT
  // CONDITION (union among themselves), and the two intersect — `paw status busy .` is the busy agents
  // in this folder, not every busy agent plus everything here.
  return rows.filter(
    (r) => (want.size === 0 || want.has(r.name)) && (states.size === 0 || [...states].some((st) => rowMatches(r, st))),
  );
}

type StateFields = { name: string; live?: boolean; mesh?: string; busy?: boolean };
type RowState = "live" | "offline" | "idle" | "busy" | "starting" | "waiting";

/** The words that filter by STATUS rather than naming an agent. `working` is the mesh's word for what
 *  paw shows as `busy`, so it's accepted as a synonym rather than as a second, subtly different state. */
const STATE_WORDS: Record<string, RowState> = {
  live: "live",
  online: "live",
  offline: "offline",
  idle: "idle",
  busy: "busy",
  working: "busy",
  starting: "starting",
  waiting: "waiting",
};

/**
 * Does this row match a state, judged the way the STATUS column shows it — so what you filter on is
 * what you see. `busy` covers paw's inference AND the agent's own `working`; `idle` means idle and NOT
 * busy, since an agent mid-turn with stale `idle` presence is shown as busy; `live` is anything not
 * offline, which is the one people usually want out of 118 rows mostly asleep.
 */
export function rowMatches(r: StateFields, state: RowState): boolean {
  const busy = r.busy === true || r.mesh === "working";
  switch (state) {
    case "live":
      return r.live === true;
    case "offline":
      return r.live !== true;
    case "busy":
      return r.live === true && busy;
    case "idle":
      return r.live === true && !busy && r.mesh === "idle";
    case "starting":
    case "waiting":
      return r.live === true && r.mesh === state;
  }
}

/**
 * Every consumer on the space's DM stream, from ONE listing. It used to be one full listing PER AGENT
 * (each walked every consumer looking for its own prefix), so the cost grew with the square of the
 * fleet. CotalEndpoint keeps its JetStreamManager private, so this opens its own short-lived NATS
 * connection to the same server (core's exact client libs). Started before the agents needing it are
 * known, so it overlaps the roster read — {@link inboxLag} turns it into per-agent answers.
 */
export type DmConsumerListing =
  | { kind: "ok"; consumers: Array<{ name: string; num_pending: number; num_ack_pending: number }> }
  | { kind: "no-stream" }
  | { kind: "unreachable"; message: string }
  | { kind: "failed"; message: string };

async function listDmConsumers(space: string, server: string): Promise<DmConsumerListing> {
  let nc;
  try {
    const creds = await controlCreds(space);
    nc = await connect({
      servers: server,
      ...(creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)) } : {}),
    });
  } catch (e) {
    return { kind: "unreachable", message: (e as Error).message };
  }
  try {
    const jsm = await jetstreamManager(nc);
    try {
      const consumers: Array<{ name: string; num_pending: number; num_ack_pending: number }> = [];
      for await (const ci of jsm.consumers.list(dmStream(space))) consumers.push({ name: ci.name, num_pending: ci.num_pending, num_ack_pending: ci.num_ack_pending });
      return { kind: "ok", consumers };
    } catch (e) {
      const code = e instanceof JetStreamApiError ? e.code : undefined;
      if (code === JetStreamApiCodes.StreamNotFound) return { kind: "no-stream" }; // no DM stream yet — a normal state
      return { kind: "failed", message: (e as Error).message };
    }
  } finally {
    await nc.close().catch(() => {});
  }
}

/**
 * Per-agent durable DM-consumer lag from a {@link listDmConsumers} listing: `dm_<owner>-<actor>-<uid>`
 * on `DM_<space>`, where the principal comes from the nkey the manager minted at spawn (it's in the ps
 * row — the same id in the agent's mesh card). Missing consumer / missing stream → "none" (a legit
 * never-connected state); any OTHER failure → "error" + a message pushed to `errors` (surfaced on
 * stderr — never fabricated as a healthy 0).
 */
export function inboxLag(listing: DmConsumerListing, server: string, agents: Array<{ name: string; id: string }>, errors: string[]): Map<string, InboxState> {
  const lag = new Map<string, InboxState>();
  if (agents.length === 0) return lag;
  if (listing.kind === "unreachable") {
    errors.push(`paw: can't reach JetStream at ${server} for inbox lag (${listing.message})`);
    for (const a of agents) lag.set(a.name, { kind: "error" });
    return lag;
  }
  for (const { name, id } of agents) {
    // cotal 0.11 keys the DM inbox durable by the (owner, actor) PRINCIPAL, not a single nkey. The
    // ps `id` is the manager's RAW nkey (open mesh) — normalize to the wire principal (`local.<nkey>`),
    // then re-split to name the durable `dm_<owner>-<actor>`. Fail LOUD (never a fabricated 0) if it
    // isn't a valid principal.
    const principal = parsePrincipalKey(wirePrincipal(id));
    if (!principal) {
      lag.set(name, { kind: "error" });
      errors.push(`paw: can't parse principal "${id}" for "${name}" inbox lag`);
      continue;
    }
    if (listing.kind === "no-stream") {
      lag.set(name, { kind: "none" });
      continue;
    }
    if (listing.kind === "failed") {
      lag.set(name, { kind: "error" });
      errors.push(`paw: inbox lag query failed for "${name}" (${listing.message})`);
      continue;
    }
    // cotal 0.13 keys the DM inbox durable by (owner, actor, lifecycleUid): dm_<owner>-<actor>-<uid>
    // (lifecycle-scoped — a successor incarnation gets a fresh consumer). The ps row doesn't carry the
    // lifecycleUid, so match this (owner,actor)'s durable by its lifecycle-agnostic prefix
    // (`dm_<owner>-<actor>-`). dmDurable VALIDATES the uid ([a-z0-9]{26,32}) and appends it last, so
    // build with a valid dummy uid and strip exactly its length — the format never drifts from core.
    // At most one live consumer matches.
    const dummyUid = "a".repeat(26);
    const prefix = dmDurable(principal.owner, principal.actor, dummyUid).slice(0, -dummyUid.length);
    const match = listing.consumers.find((ci) => ci.name.startsWith(prefix));
    lag.set(name, match ? { kind: "lag", queued: match.num_pending, unread: match.num_ack_pending } : { kind: "none" });
  }
  return lag;
}

/** The manager's ps rows by name — the liveness source every status row is judged against. */
export async function readManagerPs(ctl: ManagerControl, opts: { timeoutMs?: number; resolveMs?: number } = {}): Promise<Map<string, PsRow>> {
  const ps = await ctl.ps(opts.timeoutMs ?? 4000, opts.resolveMs);
  if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
  return new Map(((ps.data as PsRow[]) ?? []).map((r) => [r.name, r]));
}

export interface CollectOpts {
  /** Local git info per folder (`git` on each row). Off for the table, which never renders it. */
  git?: boolean;
  /** The manager's ps, already read by the caller (`paw status` reads it as ensure()'s probe). */
  ps?: Map<string, PsRow>;
  /** Narrow the collect to these names, given every name known (registered + manager-listed). The
   *  expensive per-row reads then run only for the rows asked for — `paw status <name>` used to read
   *  the whole fleet and throw all but one row away. */
  only?: (names: string[]) => Set<string>;
}

/**
 * Gather every registered agent's live state — the DATA behind `paw status`, with no rendering.
 *
 * Split out so a second surface (the web UI) shows exactly what the table shows. The rows and the
 * inbox-lag `errors` travel together on purpose: an error here means a lag figure is UNKNOWN, and a
 * consumer that got the rows without the errors would render "—" as if it were a measured zero.
 *
 * Cost discipline (a 126-agent fleet took ~3.5s): every per-agent question is asked ONCE for the whole
 * fleet — one session-index read, one `ps` for its pids, one listing of the transcript dirs, one tail
 * read per transcript, one DM-consumer listing — and the network reads run concurrently.
 */
export async function collectStatus(space: string, ctl?: ManagerControl, opts: CollectOpts = {}): Promise<{ rows: AgentStatus[]; errors: string[] }> {
  const server = pawServer();
  const consumers = listDmConsumers(space, server); // independent of everything below — start it now
  consumers.catch(() => {}); // awaited later; never an unhandled rejection meanwhile
  let agents = listAgents(space);
  const runtime = readRuntimeMarker(space);
  // A caller that polls (paw web) passes its long-lived handle; a one-shot CLI opens and closes one.
  let psByName = opts.ps ?? (ctl ? await readManagerPs(ctl) : await withManagerControl(space, server, (c) => readManagerPs(c)));
  if (opts.only) {
    const keep = opts.only([...new Set([...agents.map((a) => a.name), ...psByName.keys()])]);
    agents = agents.filter((a) => keep.has(a.name));
    psByName = new Map([...psByName].filter(([name]) => keep.has(name)));
  }
  // Foreground `paw claude` agents (live in a terminal, not under the manager). A registered agent that's
  // ABSENT from ps but present here is LIVE — its mesh status + card.id come from the roster, not ps.
  const fgByName = new Map(listForeground(space).map((e) => [e.name, e]));
  // Every registered agent the manager doesn't list is looked up on the presence ROSTER: a foreground
  // agent's presence + card.id live there, and so does an agent a previous manager spared on its way
  // down (cotal >=0.49) — running and reachable, but invisible to this manager's ps.
  const unlisted = agents.map(({ name }) => name).filter((name) => !psByName.has(name));
  const roster = controlCreds(space).then((creds) => readMeshRoster(space, server, creds, new Set(unlisted)));
  roster.catch(() => {});
  // One CONCURRENT pass over every folder before the rows are built. Serially, 54 agents × 5 git
  // processes was 2.5s of a 3.9s collect — what the Raycast roster sat on showing "Reading the roster…".
  const git = opts.git === false ? Promise.resolve(new Map<string, GitInfo | undefined>()) : gitInfoMany(agents.map(({ folder }) => folder));
  git.catch(() => {});

  // The local reads, done while the roster/consumer/git reads are in flight.
  const local = new Map(
    agents.map(({ name }) => {
      const file = personaFilePath(space, name);
      const has = existsSync(file);
      return [name, { pin: has ? readResumeId(file) : undefined, harness: has ? readAgentType(file) : undefined }];
    }),
  );
  const pins = [...new Set([...local.values()].flatMap((l) => (l.pin ? [l.pin] : [])))];
  const sessionIndex = readSessionIndex();
  const procsByPin = liveSessionProcsMany(pins, sessionIndex);
  const files = transcriptPaths(pins);
  const transcripts = new Map(pins.map((pin) => [pin, readTranscript(files.get(pin))]));

  const rosterByName = await roster;
  const now = Date.now();
  const unmanagedLive = (name: string) => {
    const ros = rosterByName.get(name);
    return !fgByName.has(name) && !!ros && presenceLive(ros, now);
  };
  // Inbox lag needs the agent's mesh id: a ps-listed agent's nkey (minted at spawn), or a foreground
  // agent's roster card.id. A registered-but-unlisted, non-foreground agent has no consumer → "—".
  const withIds = agents
    .map(({ name }) => ({ name, id: psByName.get(name)?.id ?? (fgByName.has(name) || unmanagedLive(name) ? rosterByName.get(name)?.id : undefined) }))
    .concat([...psByName.values()].filter((r) => !agents.some((a) => a.name === r.name)).map((r) => ({ name: r.name, id: r.id })))
    .filter((a): a is { name: string; id: string } => typeof a.id === "string" && a.id.length > 0);
  const inboxErrors: string[] = [];
  const inboxByName = inboxLag(withIds.length ? await consumers : { kind: "no-stream" }, server, withIds, inboxErrors);
  const gitByFolder = await git;
  const rows: AgentStatus[] = agents.map(({ folder, name }) => {
    const { pin, harness } = local.get(name)!;
    const sessionName = pin ? nameForSession(pin, sessionIndex) : undefined;
    const t = pin ? transcripts.get(pin) : undefined;
    const psRow = psByName.get(name);
    const fg = psRow ? undefined : fgByName.get(name); // ps wins; a foreground agent is only surfaced when not managed
    let mesh: string;
    let live: boolean;
    let rowRuntime: Runtime | "fg" | undefined;
    const unmanaged = !psRow && unmanagedLive(name);
    if (unmanaged) {
      live = true;
      mesh = rosterByName.get(name)!.status;
    } else if (fg) {
      const ros = rosterByName.get(name);
      live = true; // its process is alive (listForeground self-reaps dead pids)
      rowRuntime = "fg";
      mesh = ros && ros.status !== "offline" ? ros.status : "starting"; // roster presence, else mid-connect
    } else {
      const s = meshStatus(psRow);
      // A hibernated agent (`paw sleep`) is offline on purpose and a DM wakes it — say so, not "offline".
      mesh = (!s.live && sleepState(space, name)) || s.text;
      live = s.live;
      rowRuntime = live ? runtime : undefined;
    }
    return {
      name,
      folder,
      mesh,
      live,
      runtime: rowRuntime,
      pin,
      harness,
      sessionName,
      durable: !!t,
      activeMs: t?.mtimeMs,
      failure: t?.failure(),
      terminalLost: psRow ? terminalLost(psRow) : undefined,
      ...(unmanaged ? { unmanaged: true } : {}),
      context: t?.context(),
      // A standalone claude on the pin, OR more than one process of any kind (a leftover `<name>_2` mesh
      // duplicate resuming the same session) — both put two writers on one transcript.
      conflictPids: pin ? sessionConflicts(procsByPin.get(pin) ?? []) : [],
      inbox: inboxByName.get(name) ?? { kind: "none" },
      // Computed HERE, not at render time. It used to live only inside formatStatus, so `paw status`
      // printed "busy" while `--json` and the web UI — reading the very same rows — saw a plain "idle"
      // and drew a working agent as merely online. Every surface now gets the same answer.
      ...(live ? liveTurn(t, mesh) : { busy: false }),
      // Local git only; the PR lookup is network and stays lazy. Read CONCURRENTLY above rather than
      // one folder at a time here — see gitInfoMany.
      git: gitByFolder.get(folder),
    };
  });
  // Manager-listed agents paw never registered — a `cotal_spawn(name, agent: "codex", …)` peer sits on
  // the roster and in `paw cotal ps` and was INVISIBLE here ("it's on the mesh but my mesh dashboard
  // doesn't show it", relayed by personal 2026-09-09). Two sources of truth is the honest description,
  // but a dashboard that omits a live agent answers the wrong question, so they get a row with what the
  // ps row carries and nothing invented: no folder, no pin, no transcript, and a note saying so.
  const registered = new Set(agents.map(({ name }) => name));
  for (const [name, psRow] of psByName) {
    if (registered.has(name) || fgByName.has(name)) continue;
    const s = meshStatus(psRow);
    rows.push({
      name,
      folder: psRow.cwd ?? "", // the manager knows where a live peer runs; paw invents nothing beyond it
      mesh: s.text,
      live: s.live,
      runtime: s.live ? runtime : undefined,
      durable: false,
      conflictPids: [],
      inbox: inboxByName.get(name) ?? { kind: "none" },
      busy: false,
      unregistered: { agent: psRow.agent ?? "?" },
      harness: psRow.agent,
    });
  }
  // Live agents first, then most-recently-active, so the useful rows sit at the top.
  rows.sort((a, b) => Number(b.live) - Number(a.live) || (b.activeMs ?? 0) - (a.activeMs ?? 0));
  return { rows, errors: inboxErrors };
}

async function status(argv: string[]): Promise<void> {
  const space = parseSpace(argv) ?? resolveSpace();
  // `--json` emits the AgentStatus rows verbatim for other tools to consume (the Raycast extension
  // reads exactly this). Deliberately the SAME rows the table renders, so the two can never disagree.
  const asJson = argv.includes("--json");
  const targets = statusTargets(argv); // parsed BEFORE the collect, so a bad flag fails in ms, not after a roster read
  const folderAgents = (t: string) => {
    const folder = canonicalDir(t);
    return { folder, names: agentNamesForFolder(space, folder) };
  };
  // Names and folders say WHICH rows before anything is read, so only those rows are collected. A
  // STATE word (`busy`, `live`…) is judged on collected rows, so it still reads the whole fleet.
  const byState = targets.some((t) => !isPathTarget(t) && STATE_WORDS[t]);
  const only = targets.length && !byState ? (names: string[]) => new Set(selectRows(names.map((name) => ({ name })), targets, folderAgents).map((r) => r.name)) : undefined;
  const { all, hub } = await withManagerControl(space, pawServer(), async (ctl) => {
    // ONE control rail for both ensure()'s "is the manager up?" probe and the status read: the probe
    // IS the ps this command needs. (`bin/paw.ts` used to ensure() first and status then resolved the
    // service a second time — ~0.65s of Ajv compile and a round trip, twice.) ensure() still runs in
    // full: mesh, hub, mailbox, and the manager started if the probe fails. Same space ensure() always
    // used (the default one), so the probe is only shared when that is the space being read.
    let ps: Map<string, PsRow> | undefined;
    let hubAtProbe: Promise<HubState> | undefined;
    const managerProbe = async () => {
      // ensure() probes the manager AFTER bringing the hub up, and once the probe answers nothing else
      // in it touches hub or manager — so the hub read can run during the ps round trip.
      hubAtProbe = hubState(space);
      hubAtProbe.catch(() => {});
      ps = await readManagerPs(ctl, { timeoutMs: 2000, resolveMs: READY_PROBE_MS });
      return true;
    };
    await ensure({ needMesh: true, needManager: true, ...(space === resolveSpace() ? { managerProbe } : {}) });
    // A failed probe means ensure() went on to start a manager — read the hub (its manager env) afresh.
    const hub = ps && hubAtProbe ? hubAtProbe : hubState(space);
    hub.catch(() => {});
    const all = await collectStatus(space, ctl, { ps, git: asJson, only });
    return { all, hub: await hub };
  }, { only: ["ps"] }); // status sends nothing but ps — resolve just its contract (control.ts resolveCommands)
  const rows = selectRows(all.rows, targets, folderAgents);
  const { errors } = all;
  if (asJson) {
    writeJson({ space, rows, errors, hub }); // writeJson, NOT console.log — see src/stdout.ts
    return; // errors ride IN the payload — a consumer must see them, not have them land on stderr only
  }
  // `--wide` keeps every column at any terminal width: the squeezed layout drops RUNTIME/SESSION and
  // elides long paths, which is right for reading and wrong when you need the whole cell.
  console.log(formatStatus(rows, Date.now(), undefined, argv.includes("--wide")));
  const hubLine = formatHubLine(hub);
  if (hubLine) console.log(hubLine);
  for (const e of errors) console.error(c.red(e));
}

const statusCommand: Command = {
  kind: "command",
  name: "status",
  group: "Mesh",
  summary: "the agent roster: status · runtime · cwd · session · inbox lag · last-active · durability (was: ps + status)",
  usage: "status [<name|folder|live|busy|idle|offline|starting|waiting>…] [--json] [--wide] [--space s]",
  run: (a) => status([...a.raw]),
};

registry.register(statusCommand);

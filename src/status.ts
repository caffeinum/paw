/**
 * `paw status [--space]` — the ONE view of every registered agent (the former `paw ps` + `paw status`
 * merged). One row per agent, live or not: mesh STATUS (idle/working/starting/offline), the manager
 * RUNTIME it's under, its CWD, its SESSION (human name / adopted / short id), its INBOX (durable
 * DM-consumer lag — queued/unread, the zombie detector presence can't be), LAST ACTIVE (transcript
 * mtime), and durability/two-writer warnings. `ps` was a native reimpl of the manager's ps (still at
 * `paw cotal ps` for the raw view); status now carries the liveness column too, so there's one command.
 */
import { CotalEndpoint, DEFAULT_SERVER, dmDurable, dmStream, parsePrincipalKey, type Command, registry } from "@cotal-ai/core";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { controlCreds, listAgents, personaFilePath, psRowAlive, type PsRow, wirePrincipal } from "./addressing.js";
import { withManagerControl, type ManagerControl } from "./control.js";
import { listForeground } from "./foreground.js";
import { readRuntimeMarker, resolveSpace, type Runtime } from "./lifecycle.js";
import { writeJson } from "./stdout.js";
import { foreignWriters, nameForSession } from "./named.js";
import { isClaudeHarness, readAgentType, readResumeId, transcriptExists, transcriptMtime, transcriptPath } from "./session.js";
import { lastFailure } from "./transcript.js";
import { tailRead, turnInFlight } from "./transcript.js";
import { gitInfoMany, type GitInfo } from "./git.js";

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
  /** Repo, branch and worktree for the agent's folder — the thing you actually want to know when a
   *  dozen agents are working. Absent when the folder isn't a git checkout. */
  git?: GitInfo;
  conflictPids: number[]; // standalone claude procs holding the pin (two-writer hazard)
  inbox: InboxState; // durable DM-consumer lag — the zombie detector
  /** The agent's LAST turn was a runtime failure (session limit, login expired, API error…): the
   *  model never ran, so the DM that woke it got no reply and the mesh still shows a healthy idle
   *  agent. Read from the transcript (`lastFailure`), the only place claude writes it. */
  failure?: { text: string; ts: number };
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
function liveTurn(pin: string | undefined, mesh: string): boolean {
  if (mesh === "working" || mesh === "waiting") return true; // what the agent said beats what we infer
  const file = pin ? transcriptPath(pin) : undefined;
  if (file) {
    try {
      // 64KB is far more than one turn's tail and cheap on a 50MB file.
      const state = turnInFlight(tailRead(file, 64 * 1024));
      if (state !== undefined) return state;
    } catch {
      /* unreadable → fall through to the heuristic rather than assert either way */
    }
  }
  return inferBusy(mesh, true, pin ? transcriptMtime(pin) : undefined, Date.now());
}

/** The newest turn's runtime failure, if the newest turn IS one. Tail-reads the pinned transcript
 *  (last 64KB — a failure turn is small and recent by definition); a missing transcript is undefined. */
export function transcriptFailure(pin: string): { text: string; ts: number } | undefined {
  const file = transcriptPath(pin);
  if (!file) return undefined;
  try {
    return lastFailure(tailRead(file, 64 * 1024).split("\n").filter(Boolean));
  } catch {
    return undefined;
  }
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
function note(r: AgentStatus): string {
  if (r.unregistered) return `unregistered ${r.unregistered.agent} peer (cotal_spawn) — not revived by paw restart/start`;
  // A refused turn is the most actionable note: the mesh reads "idle" while the agent can't answer.
  if (r.failure) return `⚠ ${r.failure.text.split(/\s+\/usage|\n/)[0].slice(0, 80)}`;
  if (r.conflictPids.length) return `⚠ two writers (pid ${r.conflictPids.join(", ")})`;
  if (inboxStuck(r)) return `⚠ inbox stuck — ${inboxText(r.inbox)}, agent not consuming`;
  if (!r.pin && isClaudeHarness(r.harness)) return "⚠ no pin — resets on restart";
  if (!r.durable && isClaudeHarness(r.harness)) return "fresh (new session on first boot)";
  return "";
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
  if (text === "idle" || text === "working" || text === "busy") return c.green;
  if (text === "starting" || text === "waiting") return c.yellow;
  return c.dim; // offline
}

/** Pad a (possibly colored) value to `width` using its known PLAIN length — color codes don't count. */
function pad(value: string, plainLen: number, width: number): string {
  return value + " ".repeat(Math.max(0, width - plainLen));
}

/** Render the unified status table. Pure (no I/O; `now` injected) so it's unit-testable. */
export function formatStatus(rows: AgentStatus[], now: number): string {
  if (rows.length === 0) return "(no agents registered)";
  /** What the STATUS cell says. `busy` is paw's own inference from transcript activity — deliberately
   *  a different word from the mesh's `working`, so a reader can tell "the agent said so" from
   *  "paw worked it out". See inferBusy. */
  const statusText = (r: AgentStatus) => ((r.busy ?? inferBusy(r.mesh, r.live, r.activeMs, now)) ? "busy" : r.mesh);
  const cwd = (r: AgentStatus) => (r.folder ? tilde(r.folder) : "—");
  const rtText = (r: AgentStatus) => (r.live && r.runtime ? r.runtime : "—");
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    status: Math.max(6, ...rows.map((r) => statusText(r).length)),
    rt: Math.max(7, ...rows.map((r) => rtText(r).length)),
    cwd: Math.max(3, ...rows.map((r) => cwd(r).length)),
    sess: Math.max(7, ...rows.map((r) => sessionRef(r).length)),
    inbox: Math.max(5, ...rows.map((r) => inboxText(r.inbox).length)),
  };
  const header = c.dim(
    `${"NAME".padEnd(w.name)}  ${"STATUS".padEnd(w.status)}  ${"RUNTIME".padEnd(w.rt)}  ${"CWD".padEnd(w.cwd)}  ${"SESSION".padEnd(w.sess)}  ${"INBOX".padEnd(w.inbox)}  ACTIVE`,
  );
  const lines = rows.map((r) => {
    const rt = rtText(r);
    const sess = sessionRef(r);
    const inbox = inboxText(r.inbox);
    const inboxColored = inboxStuck(r) ? c.yellow(inbox) : r.inbox.kind === "error" ? c.red(inbox) : r.inbox.kind === "lag" && inbox === "✓" ? c.green(inbox) : c.dim(inbox);
    const n = note(r);
    const tail = n ? "  " + (n.startsWith("⚠") ? c.yellow(n) : c.dim(n)) : "";
    return (
      `${pad(c.bold(r.name), r.name.length, w.name)}  ` +
      `${pad(statusColor(statusText(r))(statusText(r)), statusText(r).length, w.status)}  ` +
      `${pad(r.live ? rt : c.dim(rt), rt.length, w.rt)}  ` +
      `${pad(c.dim(cwd(r)), cwd(r).length, w.cwd)}  ` +
      `${pad(sess, sess.length, w.sess)}  ` +
      `${pad(inboxColored, inbox.length, w.inbox)}  ` +
      `${c.dim(ago(r.activeMs, now))}${tail}`
    );
  });
  const conflicts = rows.filter((r) => r.conflictPids.length).length;
  const pinless = rows.filter((r) => !r.pin && isClaudeHarness(r.harness) && !r.unregistered).length;
  const stuck = rows.filter(inboxStuck).length;
  const out = [header, ...lines];
  if (conflicts || pinless || stuck) {
    const bits = [
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

/**
 * Per-agent durable DM-consumer lag, straight from JetStream: `dm_<id>` on `DM_<space>`, where `id`
 * is the nkey the manager minted at spawn (it's in the ps row — the same id in the agent's mesh
 * card). CotalEndpoint keeps its JetStreamManager private, so this opens its own short-lived NATS
 * connection to the same server (core's exact client libs) for the read-only `consumers.info` calls.
 * Missing consumer / missing stream → "none" (a legit never-connected state); any OTHER failure →
 * "error" + a message pushed to `errors` (surfaced on stderr — never fabricated as a healthy 0).
 */
async function fetchInboxLag(
  space: string,
  server: string,
  agents: Array<{ name: string; id: string }>,
  errors: string[],
): Promise<Map<string, InboxState>> {
  const lag = new Map<string, InboxState>();
  if (agents.length === 0) return lag;
  let nc;
  try {
    const creds = await controlCreds(space);
    nc = await connect({
      servers: server,
      ...(creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)) } : {}),
    });
  } catch (e) {
    errors.push(`paw: can't reach JetStream at ${server} for inbox lag (${(e as Error).message})`);
    for (const a of agents) lag.set(a.name, { kind: "error" });
    return lag;
  }
  try {
    const jsm = await jetstreamManager(nc);
    const stream = dmStream(space);
    await Promise.all(
      agents.map(async ({ name, id }) => {
        // cotal 0.11 keys the DM inbox durable by the (owner, actor) PRINCIPAL, not a single nkey. The
        // ps `id` is the manager's RAW nkey (open mesh) — normalize to the wire principal (`local.<nkey>`),
        // then re-split to name the durable `dm_<owner>-<actor>`. Fail LOUD (never a fabricated 0) if it
        // isn't a valid principal.
        const principal = parsePrincipalKey(wirePrincipal(id));
        if (!principal) {
          lag.set(name, { kind: "error" });
          errors.push(`paw: can't parse principal "${id}" for "${name}" inbox lag`);
          return;
        }
        try {
          // cotal 0.13 keys the DM inbox durable by (owner, actor, lifecycleUid): dm_<owner>-<actor>-<uid>
          // (lifecycle-scoped — a successor incarnation gets a fresh consumer). The ps row doesn't carry the
          // lifecycleUid, so LIST the stream's consumers and match this (owner,actor)'s durable by its
          // lifecycle-agnostic prefix (`dm_<owner>-<actor>-`). dmDurable VALIDATES the uid ([a-z0-9]{26,32})
          // and appends it last, so build with a valid dummy uid and strip exactly its length — the format
          // never drifts from core. At most one live consumer matches.
          const dummyUid = "a".repeat(26);
          const prefix = dmDurable(principal.owner, principal.actor, dummyUid).slice(0, -dummyUid.length);
          let match: { num_pending: number; num_ack_pending: number } | undefined;
          for await (const ci of jsm.consumers.list(stream)) {
            if (ci.name.startsWith(prefix)) {
              match = ci;
              break;
            }
          }
          if (match) lag.set(name, { kind: "lag", queued: match.num_pending, unread: match.num_ack_pending });
          else lag.set(name, { kind: "none" }); // no consumer for this principal — never connected (normal)
        } catch (e) {
          const code = e instanceof JetStreamApiError ? e.code : undefined;
          if (code === JetStreamApiCodes.StreamNotFound) {
            lag.set(name, { kind: "none" }); // no DM stream yet — a normal state, not an error
          } else {
            lag.set(name, { kind: "error" });
            errors.push(`paw: inbox lag query failed for "${name}" (${(e as Error).message})`);
          }
        }
      }),
    );
  } finally {
    await nc.close().catch(() => {});
  }
  return lag;
}

/** A FOREGROUND `paw claude` agent isn't in the manager's ps (it runs in the operator's terminal), so
 *  its mesh presence + card.id come from the live ROSTER instead. A short-lived presence-watching
 *  endpoint reads it; returns name → {id, status}. Best-effort — an unreachable mesh yields an empty map
 *  (the caller then shows "starting"/"—", never a fabricated healthy row). */
async function fetchRoster(space: string, server: string, want: Set<string>): Promise<Map<string, { id?: string; status: string }>> {
  const out = new Map<string, { id?: string; status: string }>();
  if (want.size === 0) return out;
  const creds = await controlCreds(space);
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name: "paw-status", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  try {
    await new Promise((r) => setTimeout(r, 1500)); // let presence heartbeats populate the roster
    for (const p of ep.getRoster()) {
      const nm = p.card.name;
      if (!want.has(nm)) continue;
      const prev = out.get(nm);
      if (!prev || p.status !== "offline") out.set(nm, { id: p.card.id, status: p.status }); // prefer a non-offline entry
    }
  } finally {
    await ep.stop().catch(() => {});
  }
  return out;
}

/**
 * Gather every registered agent's live state — the DATA behind `paw status`, with no rendering.
 *
 * Split out so a second surface (the web UI) shows exactly what the table shows. The rows and the
 * inbox-lag `errors` travel together on purpose: an error here means a lag figure is UNKNOWN, and a
 * consumer that got the rows without the errors would render "—" as if it were a measured zero.
 */
export async function collectStatus(space: string, ctl?: ManagerControl): Promise<{ rows: AgentStatus[]; errors: string[] }> {
  const agents = listAgents(space);
  const runtime = readRuntimeMarker(space);
  const readPs = async (c: ManagerControl) => {
    const ps = await c.ps();
    if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
    return new Map(((ps.data as PsRow[]) ?? []).map((r) => [r.name, r]));
  };
  // A caller that polls (paw web) passes its long-lived handle; a one-shot CLI opens and closes one.
  const psByName = ctl ? await readPs(ctl) : await withManagerControl(space, DEFAULT_SERVER, readPs);
  // Foreground `paw claude` agents (live in a terminal, not under the manager). A registered agent that's
  // ABSENT from ps but present here is LIVE — its mesh status + card.id come from the roster, not ps.
  const fgByName = new Map(listForeground(space).map((e) => [e.name, e]));
  const fgOnly = agents.map(({ name }) => name).filter((name) => !psByName.has(name) && fgByName.has(name));
  const rosterByName = await fetchRoster(space, DEFAULT_SERVER, new Set(fgOnly));
  // Inbox lag needs the agent's mesh id: a ps-listed agent's nkey (minted at spawn), or a foreground
  // agent's roster card.id. A registered-but-unlisted, non-foreground agent has no consumer → "—".
  const withIds = agents
    .map(({ name }) => ({ name, id: psByName.get(name)?.id ?? (fgByName.has(name) ? rosterByName.get(name)?.id : undefined) }))
    .concat([...psByName.values()].filter((r) => !agents.some((a) => a.name === r.name)).map((r) => ({ name: r.name, id: r.id })))
    .filter((a): a is { name: string; id: string } => typeof a.id === "string" && a.id.length > 0);
  const inboxErrors: string[] = [];
  const inboxByName = await fetchInboxLag(space, DEFAULT_SERVER, withIds, inboxErrors);
  // One CONCURRENT pass over every folder before the rows are built. Serially, 54 agents × 5 git
  // processes was 2.5s of a 3.9s collect — what the Raycast roster sat on showing "Reading the roster…".
  const gitByFolder = await gitInfoMany(agents.map(({ folder }) => folder));
  const rows: AgentStatus[] = agents.map(({ folder, name }) => {
    const file = personaFilePath(space, name);
    const pin = existsSync(file) ? readResumeId(file) : undefined;
    const harness = existsSync(file) ? readAgentType(file) : undefined;
    const sessionName = pin ? nameForSession(pin) : undefined;
    const psRow = psByName.get(name);
    const fg = psRow ? undefined : fgByName.get(name); // ps wins; a foreground agent is only surfaced when not managed
    let mesh: string;
    let live: boolean;
    let rowRuntime: Runtime | "fg" | undefined;
    if (fg) {
      const ros = rosterByName.get(name);
      live = true; // its process is alive (listForeground self-reaps dead pids)
      rowRuntime = "fg";
      mesh = ros && ros.status !== "offline" ? ros.status : "starting"; // roster presence, else mid-connect
    } else {
      const s = meshStatus(psRow);
      mesh = s.text;
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
      durable: pin ? transcriptExists(pin) : false,
      activeMs: pin ? transcriptMtime(pin) : undefined,
      failure: pin ? transcriptFailure(pin) : undefined,
      conflictPids: pin ? foreignWriters(pin).map((p) => p.pid) : [],
      inbox: inboxByName.get(name) ?? { kind: "none" },
      // Computed HERE, not at render time. It used to live only inside formatStatus, so `paw status`
      // printed "busy" while `--json` and the web UI — reading the very same rows — saw a plain "idle"
      // and drew a working agent as merely online. Every surface now gets the same answer.
      busy: live ? liveTurn(pin, mesh) : false,
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
      folder: "",
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
  const { rows, errors } = await collectStatus(space);
  if (asJson) {
    writeJson({ space, rows, errors }); // writeJson, NOT console.log — see src/stdout.ts
    return; // errors ride IN the payload — a consumer must see them, not have them land on stderr only
  }
  console.log(formatStatus(rows, Date.now()));
  for (const e of errors) console.error(c.red(e));
}

const statusCommand: Command = {
  kind: "command",
  name: "status",
  group: "Mesh",
  summary: "the agent roster: status · runtime · cwd · session · inbox lag · last-active · durability (was: ps + status)",
  usage: "status [--json] [--space s]",
  run: (a) => status([...a.raw]),
};

registry.register(statusCommand);

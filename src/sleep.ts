/**
 * `paw sleep` — opt-in hibernation of idle agents.
 *
 * Copies Claude Code's own background-session supervisor rules (code.claude.com/docs/en/agent-view):
 * an agent may sleep after it has been idle at least an hour — the prompt cache lives 1h, so resuming
 * after that costs no extra tokens over staying warm — and ONLY when nothing is running in it: no turn
 * in flight, no Monitor, no background Bash/agent/workflow task. Those die with the seat and paw cannot
 * carry them across a despawn, so an agent holding one stays up.
 *
 * Sleeping = despawn the seat; the persona, registry entry and resume pin are untouched, so a wake is the
 * ordinary spawn path (`ensureAgentSpawned`, interactive `--resume` in tmux/pty) — never `claude -p`.
 * SIGSTOP was rejected: it frees nothing and the stale presence reads as dead.
 *
 * OPT-IN per agent (`hibernate: 60m` in the persona, set by `paw sleep <name> --after 60m`), because the
 * operator's rule is that no automation touches a live agent without his go. Every sleep and wake is
 * logged to `spaces/<s>/sleep.log` with its reason.
 *
 * A DM wakes it: the sleep host (src/sleep-host.ts, inside the mailbox daemon) holds a stand-in presence
 * under the agent's name, so `cotal_dm("<name>")` resolves; the first DM to the stand-in wakes the agent
 * and is re-delivered to it once it is on the mesh. See src/sleep-state.ts for why the stand-in is needed.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { registry, DEFAULT_SERVER, dmStream, parsePrincipalKey, unicastRecvFilter, type Command } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { agentRecord, listAgents, personaFilePath, setPersonaKeys, wirePrincipal, type PsRow } from "./addressing.js";
import { withManagerControl, type ManagerControl } from "./control.js";
import { ensure, resolveSpace } from "./lifecycle.js";
import { liveSessionProcs } from "./named.js";
import { personaValue, readResumeId, transcriptMtime, transcriptPath } from "./session.js";
import { dmsSince } from "./sleep-host.js";
import { listSleeping, readSleepRecord, readWakingRecord, scanRecords, sleepLog, sleepState, writeSleepRecord, type SleepRecord } from "./sleep-state.js";
import { collectStatus, type AgentStatus } from "./status.js";
import { tailRead } from "./transcript.js";

/** The prompt cache TTL: below it a sleep would make the wake pay a cold cache. */
export const MIN_HIBERNATE_MS = 60 * 60_000;
/** Never put the always-on wake authority to sleep (and its 60s keeper tick would wake it anyway). */
const NEVER_SLEEP = new Set(["global"]);
/** The transcript lines that can open or close background work or change channel membership. */
const MARKERS = "backgroundTaskId|async_launched|Monitor started|task-notification|TaskStop|cotal_join|cotal_leave";
const MARKER_RE = new RegExp(MARKERS);
/** Fallback read when ripgrep is missing: the transcript's last 16MB. */
const TAIL_BYTES = 16 * 1024 * 1024;

/** `60m` | `2h` → ms; `off` → "off". Garbage or a value under an hour throws — a sleep that would pay a
 *  cold cache on every wake is a misconfiguration, not a preference to honour quietly. */
export function parseHibernate(raw: string): number | "off" {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  if (v === "off") return "off";
  const m = /^(\d+)(m|h)$/.exec(v);
  if (!m) throw new Error(`paw: hibernate "${raw}" is not a duration like 60m or 2h (or "off")`);
  const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
  if (ms < MIN_HIBERNATE_MS) throw new Error(`paw: hibernate ${v} is under 60m — the prompt cache lives an hour, so a shorter sleep makes every wake pay a cold cache`);
  return ms;
}

/** The agent's opt-in idle threshold, or undefined when it hasn't opted in. A bad value throws. */
export function readHibernate(space: string, name: string): number | undefined {
  const file = personaFilePath(space, name);
  if (!existsSync(file)) return undefined;
  const raw = personaValue(file, "hibernate");
  if (raw === undefined || raw === "") return undefined;
  const v = parseHibernate(raw);
  return v === "off" ? undefined : v;
}

/** Registered agents that opted in to hibernation (a bad `hibernate:` value counts — the sweep reports it). */
export function optedIn(space: string): string[] {
  return listAgents(space)
    .map((a) => a.name)
    .filter((name) => {
      const file = personaFilePath(space, name);
      return existsSync(file) && !!personaValue(file, "hibernate");
    });
}

/** Channels beyond #general in the persona's `subscribe:` list. Their replay window (1h) is shorter
 *  than any sleep, so traffic there would be lost while asleep — v1 refuses to sleep such an agent. */
export function extraChannels(subscribe: string | undefined): string[] {
  if (!subscribe) return [];
  return subscribe
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s && s !== "general");
}

/**
 * Background work and runtime channel joins in a claude session, from its transcript lines (pure).
 *
 * Tasks open on: a Bash `run_in_background` result (`toolUseResult.backgroundTaskId`), an async
 * agent/workflow launch (`toolUseResult.status: "async_launched"` + `taskId`), a Monitor (`Monitor started
 * (task X, timeout Nms)` — one with a timeout ends by itself at start+timeout). They close on a
 * `<task-notification>` with a terminal `<status>` or a `TaskStop` call. Channels: every `cotal_join` tool
 * call minus `cotal_leave`, #general excluded. Lines before `sinceMs` (the running process's start) are
 * skipped: a task from a previous incarnation died with it, and its joins were not carried over.
 */
export function scanActivity(lines: Iterable<string>, sinceMs: number, now: number): { tasks: string[]; joined: string[] } {
  const open = new Map<string, number | undefined>(); // id → deadline (ms) when the task ends by itself
  const joined = new Set<string>();
  for (const line of lines) {
    if (!MARKER_RE.test(line)) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts) && ts < sinceMs) continue;
    const tur = rec.toolUseResult as Record<string, unknown> | undefined;
    if (tur && typeof tur.backgroundTaskId === "string") open.set(tur.backgroundTaskId, undefined);
    if (tur && tur.status === "async_launched" && typeof tur.taskId === "string") open.set(tur.taskId, undefined);
    for (const m of line.matchAll(/Monitor started \(task (\w+)(?:, timeout (\d+)ms)?/g)) {
      open.set(m[1], m[2] && Number.isFinite(ts) ? ts + Number(m[2]) : undefined);
    }
    for (const seg of line.split("<task-notification>").slice(1)) {
      const body = seg.split("</task-notification>")[0];
      const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1];
      const status = /<status>([a-z_]+)<\/status>/.exec(body)?.[1];
      if (id && status && /^(completed|failed|killed|stopped)$/.test(status)) open.delete(id);
    }
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (rec.type === "assistant" && Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
        if (part.type !== "tool_use" || typeof part.name !== "string") continue;
        const ch = typeof part.input?.channel === "string" ? part.input.channel : undefined;
        if (part.name === "TaskStop" && typeof part.input?.task_id === "string") open.delete(part.input.task_id);
        if (/(^|__)cotal_join$/.test(part.name) && ch && ch !== "general") joined.add(ch);
        if (/(^|__)cotal_leave$/.test(part.name) && ch) joined.delete(ch);
      }
    }
  }
  return { tasks: [...open].filter(([, deadline]) => deadline === undefined || deadline > now).map(([id]) => id), joined: [...joined] };
}

/** Kept for readability at call sites that only care about tasks. */
export function openBackgroundTasks(lines: Iterable<string>, sinceMs: number, now: number): string[] {
  return scanActivity(lines, sinceMs, now).tasks;
}

/**
 * The marker lines of a transcript since `sinceMs`, BOUNDED in cost: ripgrep pulls only lines carrying a
 * marker (cheap on a 300MB transcript). Without ripgrep, the last 16MB — and if that window does not
 * reach back to the process start, the answer is "unknown" (which blocks the sleep), never a guess.
 */
export function markerLines(file: string, sinceMs: number): { lines: string[]; unknown?: string } {
  try {
    const out = execFileSync("rg", ["--no-messages", "-N", "-e", MARKERS, "--", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return { lines: out.split("\n") };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return { lines: [] }; // rg: no match
    if (err.code !== "ENOENT") return { lines: [], unknown: `transcript scan failed (${err.message.split("\n")[0]})` };
  }
  const tail = tailRead(file, TAIL_BYTES).split("\n");
  const firstTs = tail.map((l) => /"timestamp":"([^"]+)"/.exec(l)?.[1]).find(Boolean);
  if (firstTs && Date.parse(firstTs) > sinceMs) return { lines: [], unknown: "no ripgrep, and the transcript's last 16MB doesn't reach back to the process start" };
  return { lines: tail };
}

/** Shell processes under `pid` — a background Bash or a Monitor's command runs as one. MCP servers
 *  (node) and the claude binary itself are not shells. A hook that happens to be running counts too:
 *  that only delays a sleep by one tick, the safe direction. */
export function shellDescendants(pid: number, psOutput?: string): string[] {
  const table = (psOutput ?? execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }))
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const kids = new Map<number, typeof table>();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out: string[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      if (/^(\S*\/)?(zsh|bash|sh|dash|fish)(\s|$)/.test(k.cmd)) out.push(`${k.pid} ${k.cmd.slice(0, 80)}`);
      walk(k.pid);
    }
  };
  walk(pid);
  return out;
}

export interface Activity {
  /** Open background task ids from the transcript. */
  tasks: string[];
  /** Shell processes under the agent's claude. */
  shells: string[];
  /** Non-general channels the agent joined at runtime (cotal_join) since its process started. */
  joined?: string[];
  /** Why activity could not be read — reported, and blocks the sleep (unknown is not "nothing"). */
  unknown?: string;
}

/** What is running inside `pin`'s live claude, from both the transcript and the process tree. */
export function readActivity(pin: string, now = Date.now()): Activity {
  const procs = liveSessionProcs(pin);
  if (procs.length !== 1) return { tasks: [], shells: [], unknown: `${procs.length} live processes hold the session` };
  const proc = procs[0];
  const file = transcriptPath(pin);
  if (!file) return { tasks: [], shells: [], unknown: "no transcript" };
  if (typeof proc.startedAt !== "number") return { tasks: [], shells: [], unknown: "the session's process start time is unknown" };
  const { lines, unknown } = markerLines(file, proc.startedAt);
  if (unknown) return { tasks: [], shells: [], unknown };
  const { tasks, joined } = scanActivity(lines, proc.startedAt, now);
  return { tasks, joined, shells: shellDescendants(proc.pid) };
}

export interface SleepDecision {
  sleep: boolean;
  reason: string;
}

/** Pure: may this agent go to sleep now? Every refusal names its reason (the sweep logs them). */
export function sleepDecision(row: AgentStatus, hibernateMs: number, now: number, activity: Activity, channels: string[]): SleepDecision {
  const no = (reason: string) => ({ sleep: false, reason });
  if (NEVER_SLEEP.has(row.name)) return no("the global agent never sleeps");
  if (!row.live) return no("not live");
  if (row.runtime === "fg") return no("a foreground `paw claude` (not the manager's to despawn)");
  if (row.unregistered) return no("not registered with paw");
  if (row.harness && row.harness !== "claude" && row.harness !== "cotal") return no(`harness ${row.harness} — v1 reads only claude transcripts`);
  if (row.mesh !== "idle") return no(`mesh ${row.mesh}`);
  if (row.busy || row.tool) return no(`a turn is in flight${row.tool ? ` (${row.tool.name})` : ""}`);
  if (row.inbox.kind === "error") return no("inbox lag unknown");
  if (row.inbox.kind === "lag" && row.inbox.queued + row.inbox.unread > 0) return no(`inbox not drained (${row.inbox.queued} queued, ${row.inbox.unread} unread)`);
  if (row.conflictPids.length) return no(`session held by more than one process (${row.conflictPids.join(", ")})`);
  const allChannels = [...new Set([...channels, ...(activity.joined ?? [])])];
  if (allChannels.length) return no(`in ${allChannels.map((c) => "#" + c).join(", ")} — channel replay is 1h, traffic there would be lost asleep (v1)`);
  if (activity.unknown) return no(`can't tell what is running (${activity.unknown})`);
  if (activity.tasks.length) return no(`background task(s) running: ${activity.tasks.join(", ")}`);
  if (activity.shells.length) return no(`shell process(es) running under claude: ${activity.shells.join("; ")}`);
  if (row.activeMs === undefined) return no("no transcript activity known");
  const idle = now - row.activeMs;
  if (idle < hibernateMs) return no(`idle ${Math.round(idle / 60_000)}m < ${Math.round(hibernateMs / 60_000)}m`);
  return { sleep: true, reason: `idle ${Math.round(idle / 60_000)}m ≥ ${Math.round(hibernateMs / 60_000)}m, nothing running` };
}

/**
 * Pure: the last gate before the despawn. The decision was made on a snapshot taken AFTER `cursorSeq`
 * was captured; anything that moved since — the transcript was written, the agent left idle, or a DM
 * reached its subject after the cursor — means a turn may be starting, so the sleep is ABORTED rather
 * than killing it. This is also what keeps a DM the old seat already consumed from being re-delivered on
 * wake: a DM after the cursor aborts the sleep, one before it is never forwarded.
 */
export function preDespawnCheck(o: { snapshotActiveMs?: number; activeMsNow?: number; meshNow?: string; dmsSinceCursor: number }): string | undefined {
  if (o.activeMsNow !== o.snapshotActiveMs) return "its transcript was written after the decision";
  if (o.meshNow !== "idle") return `it is ${o.meshNow ?? "gone"} now`;
  if (o.dmsSinceCursor > 0) return `${o.dmsSinceCursor} DM(s) reached it after the decision`;
  return undefined;
}

/** Pure: a new sleep over a record that was never reconciled keeps the earlier cursor (its backlog is
 *  still owed) and the forwarded set; the old seat id is dropped since the new one supersedes it. */
export function mergeSleepRecord(prior: SleepRecord | undefined, next: SleepRecord): SleepRecord {
  if (!prior) return next;
  return { ...next, cursorSeq: Math.min(prior.cursorSeq, next.cursorSeq), forwarded: prior.forwarded };
}

/** The DM stream's last sequence — the backlog cursor. */
export async function dmLastSeq(space: string, server = DEFAULT_SERVER): Promise<number> {
  const nc = await connect({ servers: server });
  try {
    return (await (await jetstreamManager(nc)).streams.info(dmStream(space))).state.last_seq;
  } finally {
    await nc.close();
  }
}

/**
 * Despawn `name` and record it asleep (the sleep host then raises its stand-in). `cursorSeq` and
 * `snapshotActiveMs` come from BEFORE the decision; the agent is re-checked against them right before the
 * despawn (see {@link preDespawnCheck}). Refuses under PAW_AUTH: re-delivering the backlog re-publishes
 * each DM under its original sender, which only an open mesh permits.
 */
export async function sleepAgent(space: string, ctl: ManagerControl, name: string, reason: string, snap: { cursorSeq: number; snapshotActiveMs?: number; force?: boolean }): Promise<void> {
  if (process.env.PAW_AUTH === "1") throw new Error("paw: `paw sleep` is open-mesh only (v1) — waking re-delivers DMs under their original sender, which an authed mesh forbids");
  const rec = agentRecord(space, name);
  if (!rec) throw new Error(`paw: "${name}" is not a registered agent`);
  const ps = await ctl.ps();
  if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
  const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
  if (!row) throw new Error(`paw: "${name}" is not running`);
  const lastId = row.id ? wirePrincipal(row.id) : undefined;
  if (!snap.force) {
    const old = lastId ? parsePrincipalKey(lastId) : undefined;
    if (!old) throw new Error(`paw: not sleeping "${name}" — its ps row carries no principal, so its DMs can't be checked`);
    const pin = readResumeId(personaFilePath(space, name));
    const why = preDespawnCheck({
      snapshotActiveMs: snap.snapshotActiveMs,
      activeMsNow: pin ? transcriptMtime(pin) : undefined,
      meshNow: row.mesh,
      dmsSinceCursor: await dmsSince(space, [unicastRecvFilter(space, old.owner, old.actor)], snap.cursorSeq),
    });
    if (why) throw new Error(`paw: not sleeping "${name}" — ${why}`);
  }
  const d = await ctl.despawn(name);
  if (!d.ok) throw new Error(`paw: couldn't despawn "${name}" (${d.error ?? "no reply"})`);
  // A record already here (a seat that came up beside it and was never reconciled) still owes its backlog:
  // keep the EARLIER cursor and what was already forwarded, never overwrite them with this sleep's.
  const prior = (() => {
    try {
      return readSleepRecord(space, name) ?? readWakingRecord(space, name);
    } catch {
      return undefined;
    }
  })();
  writeSleepRecord(space, mergeSleepRecord(prior, { name, folder: rec.folder, since: Date.now(), cursorSeq: snap.cursorSeq, lastId, reason }));
  sleepLog(space, `slept ${name} — ${reason} (cursor ${Math.min(prior?.cursorSeq ?? snap.cursorSeq, snap.cursorSeq)})`);
}

/** Evaluate every opted-in agent once; put the eligible ones to sleep. Logs each decision for an
 *  opted-in agent so a "why didn't it sleep" question has an answer in the log. */
export async function sleepSweep(space: string, ctl: ManagerControl, now = Date.now()): Promise<{ slept: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const cursorSeq = await dmLastSeq(space); // FIRST: anything after this is news the decision didn't see
  const { rows } = await collectStatus(space, ctl, { git: false });
  const slept: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const row of rows) {
    let hibernateMs: number | undefined;
    try {
      hibernateMs = readHibernate(space, row.name);
    } catch (e) {
      skipped.push({ name: row.name, reason: (e as Error).message });
      continue;
    }
    if (hibernateMs === undefined || !row.live) continue;
    const file = personaFilePath(space, row.name);
    const activity = row.pin ? readActivity(row.pin, now) : { tasks: [], shells: [], unknown: "no resume pin" };
    const d = sleepDecision(row, hibernateMs, now, activity, extraChannels(personaValue(file, "subscribe")));
    if (!d.sleep) {
      skipped.push({ name: row.name, reason: d.reason });
      continue;
    }
    try {
      await sleepAgent(space, ctl, row.name, d.reason, { cursorSeq, snapshotActiveMs: row.activeMs });
      slept.push(row.name);
    } catch (e) {
      skipped.push({ name: row.name, reason: (e as Error).message });
    }
  }
  return { slept, skipped };
}

function parseArgs(argv: string[]): { space?: string; names: string[]; after?: string; off: boolean; now: boolean; sweep: boolean; force: boolean } {
  const out = { names: [] as string[], off: false, now: false, sweep: false, force: false } as ReturnType<typeof parseArgs>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("--space=")) out.space = a.slice(8);
    else if (a === "--after") out.after = argv[++i];
    else if (a === "--off") out.off = true;
    else if (a === "--now") out.now = true;
    else if (a === "--sweep") out.sweep = true;
    else if (a === "--force") out.force = true;
    else if (a.startsWith("-")) throw new Error(`paw sleep: unknown flag ${a}`);
    else out.names.push(a);
  }
  return out;
}

async function sleepCmd(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  const space = o.space ?? resolveSpace();
  if (o.after || o.off) {
    if (!o.names.length) throw new Error("paw sleep: name the agent(s) to opt in or out");
    const v = o.off ? "off" : parseHibernate(o.after!); // validate before writing anything
    for (const name of o.names) {
      if (NEVER_SLEEP.has(name)) throw new Error(`paw sleep: "${name}" never sleeps`);
      if (!agentRecord(space, name)) throw new Error(`paw sleep: "${name}" is not a registered agent`);
      setPersonaKeys(space, name, { hibernate: v === "off" ? undefined : o.after });
      sleepLog(space, v === "off" ? `opt-out ${name}` : `opt-in ${name} after ${o.after} idle`);
      console.log(v === "off" ? `${name}: will not sleep` : `${name}: sleeps after ${o.after} idle with nothing running; a DM wakes it`);
    }
    if (!o.now) return;
  }
  if (o.now || o.sweep) {
    const { server } = await ensure({ needMesh: true, needManager: true, space });
    await withManagerControl(space, server, async (ctl) => {
      if (o.sweep) {
        const r = await sleepSweep(space, ctl);
        for (const s of r.skipped) console.log(`  ${s.name}: awake — ${s.reason}`);
        console.log(r.slept.length ? `slept: ${r.slept.join(", ")}` : "nobody slept");
        return;
      }
      const cursorSeq = await dmLastSeq(space, server);
      const { rows } = await collectStatus(space, ctl, { git: false });
      for (const name of o.names) {
        const row = rows.find((r) => r.name === name);
        if (!row) throw new Error(`paw sleep: "${name}" is not a registered agent`);
        const file = personaFilePath(space, name);
        const activity = row.pin ? readActivity(row.pin) : { tasks: [], shells: [], unknown: "no resume pin" };
        // --now waives the idle threshold (the operator is asking), never the "nothing running" rule unless --force.
        const d = sleepDecision(row, 0, Date.now(), activity, extraChannels(personaValue(file, "subscribe")));
        if (!d.sleep && !o.force) throw new Error(`paw sleep: not sleeping "${name}" — ${d.reason} (--force to override)`);
        await sleepAgent(space, ctl, name, o.force && !d.sleep ? `forced by operator (${d.reason})` : "requested by operator", {
          cursorSeq,
          snapshotActiveMs: row.activeMs,
          force: o.force,
        });
        console.log(`${name}: asleep — a DM to it wakes it`);
      }
    });
    return;
  }
  // No action: list sleeping agents (and any named ones), plus unreadable records.
  const { bad } = scanRecords(space, ".json");
  const lines: string[] = [];
  for (const name of new Set([...listSleeping(space).map((r) => r.name), ...o.names])) {
    const r = readSleepRecord(space, name);
    const state = sleepState(space, name) ?? "awake";
    lines.push(r ? `${name}: ${state} since ${new Date(r.since).toLocaleString()} — ${r.reason}${r.lastError ? ` (last wake error: ${r.lastError})` : ""}` : `${name}: ${state}`);
  }
  for (const b of bad) lines.push(`⚠ unreadable sleep record ${b}`);
  console.log(lines.length ? lines.join("\n") : "no agent is asleep (opt in: paw sleep <name> --after 60m)");
  console.log("note: an asleep agent misses channel traffic older than the 1h replay window; DMs are queued and delivered on wake");
}

const sleepCommand: Command = {
  kind: "command",
  name: "sleep",
  group: "Lifecycle",
  summary: "opt-in hibernation: despawn an idle agent (≥60m, nothing running) — a DM wakes it",
  usage: "sleep [<name>…] [--after 60m | --off] [--now [--force]] [--sweep] [--space s]",
  run: (a) => sleepCmd([...a.raw]),
};

registry.register(sleepCommand);


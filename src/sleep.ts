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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registry, parsePrincipalKey, unicastRecvFilter, type Command } from "@cotal-ai/core";
import { agentRecord, humanEndpointAuth, listAgents, personaFilePath, setPersonaKeys, wirePrincipal, type PsRow } from "./addressing.ts";
import { withManagerControl, type ManagerControl } from "./control.ts";
import { groupProcs, parsePs, type Proc } from "./fleet.ts";
import { KIT_AGENT, kitAgentDir, kitBinPath, preflightKitArgs, readKitPersona } from "./kit.ts";
import { PS_ALL_ENV } from "./ps-env.ts";
import { containerBin, reapSandbox, SANDBOX_CLAUDE_BIN } from "./sandbox.ts";
import { liveSandboxContainer } from "./sandbox-exec.ts";
import { hostedElsewhereError, hosting } from "./hosted.ts";
import { presenceLive, readMeshRoster } from "./roster.ts";
import { dmLastSeqOn, openStreamInfo } from "./sleep-dial.ts";
import { managerProcs, pawHomeDir, resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { liveSessionProcs } from "./named.ts";
import { personaTranscriptRoots, personaValue, readAgentType, readResumeId, readSandbox, transcriptMtime, transcriptPath } from "./session.ts";
import { dmsSince } from "./sleep-host.ts";
import { clearWaking, listSleeping, mergeBacklog, readSleepRecord, readWakingRecord, scanRecords, sleepLog, sleepState, writeSleepRecord, type SleepRecord } from "./sleep-state.ts";
import { collectStatus, readManagerPs, type AgentStatus } from "./status.ts";
import { COTAL_RECLAIM_WATCHER, inProcess, markerLines, scanActivity, shellDescendants, type TaskKind } from "./background-scan.ts";
export { COTAL_RECLAIM_WATCHER, inProcess, markerLines, openBackgroundTasks, scanActivity, shellDescendants, type TaskKind } from "./background-scan.ts";
import { isRemoteSpace, pawServer } from "./server.ts";

/** The prompt cache TTL: below it a sleep would make the wake pay a cold cache. */
export const MIN_HIBERNATE_MS = 60 * 60_000;
/** Never put the always-on wake authority to sleep (and its 60s keeper tick would wake it anyway). */
const NEVER_SLEEP = new Set(["global"]);
/** Harnesses whose idleness paw can judge: claude (and cotal's default, which is claude) by its transcript +
 *  session index, kit by its Claude-Code-format transcript + its `kit run` seat in the process table. */
const SLEEPABLE_HARNESSES = new Set(["claude", "cotal", KIT_AGENT]);

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


export interface Activity {
  /** Open background task ids from the transcript that something live backs (or that run in-process). */
  tasks: string[];
  /** The kind of each of `tasks`, same order. */
  kinds?: TaskKind[];
  /** Shell processes under the agent's claude. */
  shells: string[];
  /** Processes the agent detached into its VM (children of the VM's init): they die with the container,
   *  so they block. On the host a detached process outlives the seat — it is only evidence for a task. */
  detached?: string[];
  /** Bash/Monitor task records with NO live process behind them — ignored, but reported. */
  stale?: string[];
  /** Non-general channels the agent joined at runtime (cotal_join) since its process started. */
  joined?: string[];
  /** Why activity could not be read — reported, and blocks the sleep (unknown is not "nothing"). */
  unknown?: string;
  /** kit's own armed schedules (`schedules.json`): they fire only while kit runs, so they block like a Monitor. */
  schedules?: string[];
  /** Why a wake could NOT resume this agent's session — blocks the sleep (a sleep must be undoable by a DM). */
  wake?: string;
}

/**
 * What the process table says runs in the agent's live claude — on this machine, or inside its VM for a
 * `sandbox: container` agent. `ok: false` = it could not be read, which keeps the agent awake.
 */
export type SessionProcs =
  | { ok: true; where: "host" | "vm"; startedAt: number; shells: string[]; detached: string[] }
  | { ok: false; unknown: string };

/** Reads {@link SessionProcs} for one agent. Injectable so the sweep can be exercised without real processes. */
export type ProcInspector = (o: { space: string; name: string; pin: string; sandboxed: boolean; harness?: string }) => SessionProcs;

const procLabel = (p: { pid: number; argv: string }) => `${p.pid} ${p.argv.trim().slice(0, 80)}`;
const psTable = (procs: Proc[]) => procs.map((p) => `${p.pid} ${p.ppid} ${p.argv}`).join("\n");

/** A host agent: its ONE live claude (Claude Code's session index), the shells under it, and the processes
 *  it detached since it started (`ps -axE` stamped COTAL_NAME/COTAL_SPACE, reparented to launchd — the
 *  same attribution `paw top`/`paw tidy` use; ones older than the claude are an earlier incarnation's). */
export function hostSessionProcs(space: string, name: string, pin: string, procs: Proc[], now = Date.now()): SessionProcs {
  const holders = liveSessionProcs(pin);
  if (holders.length !== 1) return { ok: false, unknown: `${holders.length} live processes hold the session` };
  const claude = holders[0];
  if (typeof claude.startedAt !== "number") return { ok: false, unknown: "the session's process start time is unknown" };
  const ageMs = now - claude.startedAt;
  const detached = groupProcs(procs, space)
    .orphans.filter((o) => o.agent === name && o.tree[0].ageMs <= ageMs)
    .map((o) => procLabel(o.tree[0]));
  return { ok: true, where: "host", startedAt: claude.startedAt, shells: shellDescendants(claude.pid, psTable(procs)), detached };
}

/** kit's ONE persistent shell (tools/bash.go: `/bin/bash --noprofile --norc`, a child of kit for its whole
 *  life): every shell-tool call is sourced INTO it, so the shell itself is idle plumbing, never work. */
const KIT_PERSISTENT_SHELL = /^\/bin\/bash --noprofile --norc\s*$/;

/**
 * Pure: a kit agent's seat in the host process table → {@link SessionProcs}. The seat is the ONE `kit run …
 * --name <name> --space <space>` root stamped with its COTAL_NAME (kit writes no Claude Code session index, so
 * {@link liveSessionProcs} never sees it). Running work = any process under kit except its persistent shell —
 * a command kit's shell tool started and backgrounded (`cmd &`) stays a child of that shell, and dies with the
 * seat. Detached ones (reparented to launchd, stamped, younger than kit) are reported like a claude agent's:
 * they outlive the seat, so they never block on their own.
 */
export function kitSessionProcs(space: string, name: string, procs: Proc[], now = Date.now()): SessionProcs {
  const g = groupProcs(procs, space);
  const isKitRun = (argv: string) => {
    const tok = argv.trim().split(/\s+/);
    return tok[1] === "run" && argv.includes(` --name ${name} `) && argv.includes(` --space ${space} `);
  };
  const seats = (g.agents.get(name)?.roots ?? []).filter((p) => isKitRun(p.argv + " "));
  if (seats.length !== 1) return { ok: false, unknown: `${seats.length} \`kit run\` processes run as "${name}" in ${space}` };
  const kit = seats[0];
  const kids = new Map<number, Proc[]>();
  for (const p of procs) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const running: string[] = [];
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) {
      const plumbing = (pid === kit.pid && KIT_PERSISTENT_SHELL.test(k.argv.trim())) || COTAL_RECLAIM_WATCHER.test(k.argv);
      if (!plumbing) running.push(procLabel(k));
      walk(k.pid);
    }
  };
  walk(kit.pid);
  const detached = g.orphans.filter((o) => o.agent === name && o.tree[0].ageMs <= kit.ageMs).map((o) => procLabel(o.tree[0]));
  return { ok: true, where: "host", startedAt: now - kit.ageMs, shells: running, detached };
}

/** `container exec <id> ps -eo pid=,ppid=,etimes=,args=` → rows (pure). */
export function parseVmPs(text: string): Array<{ pid: number; ppid: number; elapsedS: number; argv: string }> {
  return text
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), elapsedS: Number(m[3]), argv: m[4] }));
}

/**
 * Pure: a sandboxed agent's VM process table → {@link SessionProcs}. The seat is the image's claude
 * ({@link SANDBOX_CLAUDE_BIN}), a child of the VM's init; exactly one must be running. Its shells are the
 * same walk as on the host; anything else parented to init (pid 1) is work the agent detached, which dies
 * with the VM. Processes with ppid 0 are `container exec` sessions (the port forwarder's polls, an
 * operator `!cmd`, this very `ps`) — not the agent's.
 */
export function vmSessionProcs(psText: string, now = Date.now()): SessionProcs {
  const rows = parseVmPs(psText);
  if (!rows.length) return { ok: false, unknown: "its VM's ps printed nothing" };
  const seats = rows.filter((r) => r.argv === SANDBOX_CLAUDE_BIN || r.argv.startsWith(`${SANDBOX_CLAUDE_BIN} `));
  if (seats.length !== 1) return { ok: false, unknown: `${seats.length} claude processes in its VM` };
  const claude = seats[0];
  const detached = rows.filter((r) => r.ppid === 1 && r.pid !== claude.pid && !COTAL_RECLAIM_WATCHER.test(r.argv)).map(procLabel);
  return {
    ok: true,
    where: "vm",
    startedAt: now - claude.elapsedS * 1000,
    shells: shellDescendants(claude.pid, rows.map((r) => `${r.pid} ${r.ppid} ${r.argv}`).join("\n")),
    detached,
  };
}

/** The live inspector: one `ps -axE` per sweep for host agents (taken on first use), `container exec … ps`
 *  per sandboxed agent. A VM that can't be read is "unknown", never "nothing running". */
export function liveInspector(): ProcInspector {
  let table: Proc[] | undefined;
  const hostTable = () => (table ??= parsePs(execFileSync("ps", [...PS_ALL_ENV, "-o", "pid=,ppid=,pgid=,etime=,time=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })));
  return ({ space, name, pin, sandboxed, harness }) => {
    if (harness === KIT_AGENT) return sandboxed ? { ok: false, unknown: "a sandboxed kit seat (paw sandboxes claude only)" } : kitSessionProcs(space, name, hostTable());
    if (!sandboxed) return hostSessionProcs(space, name, pin, hostTable());
    try {
      const bin = containerBin();
      const id = liveSandboxContainer(space, name, bin);
      const out = execFileSync(bin, ["exec", id, "ps", "-eo", "pid=,ppid=,etimes=,args="], { encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
      return vmSessionProcs(out);
    } catch (e) {
      return { ok: false, unknown: `its VM can't be inspected: ${(e as Error).message.split("\n")[0]}` };
    }
  };
}

/** What is running inside `pin`'s live claude, from both the transcript and the process tree. A Bash or
 *  Monitor task the transcript still calls open is believed only while a live process backs it (a shell
 *  under claude or a process it detached); with none, it is a stale record — reported, never blocking.
 *  An async agent or Workflow runs in-process, so its record alone keeps blocking. */
export function readActivity(pin: string, procs: SessionProcs, now = Date.now(), roots?: string[]): Activity {
  if (!procs.ok) return { tasks: [], shells: [], unknown: procs.unknown };
  const file = transcriptPath(pin, roots);
  if (!file) return { tasks: [], shells: [], unknown: "no transcript" };
  const { lines, unknown } = markerLines(file, procs.startedAt);
  if (unknown) return { tasks: [], shells: [], unknown };
  const { open, joined } = scanActivity(lines, procs.startedAt, now);
  const live = procs.shells.length + procs.detached.length > 0;
  const backed = open.filter((t) => inProcess(t.kind) || live);
  const stale = open.filter((t) => !inProcess(t.kind) && !live).map((t) => t.id);
  return { tasks: backed.map((t) => t.id), kinds: backed.map((t) => t.kind), shells: procs.shells, detached: procs.where === "vm" ? procs.detached : [], stale, joined };
}

/** kit's armed schedules for `name` (kit `schedule` package: `<kit agent dir>/schedules.json`, the dir paw
 *  hands kit as its brief's). Absent = none; unreadable throws — an unknown schedule is not "no schedule". */
export function kitSchedules(space: string, name: string): string[] {
  const file = join(kitAgentDir(space, name), "schedules.json");
  if (!existsSync(file)) return [];
  const s = JSON.parse(readFileSync(file, "utf8")) as { jobs?: Array<{ id?: unknown; kind?: unknown }> };
  if (!Array.isArray(s.jobs)) throw new Error(`${file} has no jobs list`);
  return s.jobs.map((j) => `${String(j.id)} (${String(j.kind)})`);
}

/**
 * Why waking this kit agent could NOT resume its session, or undefined when it can. A wake is the ordinary
 * spawn (`ensureAgentSpawned` → the kit connector), so it needs exactly what that needs: a persona the
 * connector accepts (pin, provider, storage, kitArgs), a kit binary, the kitArgs kit's own parse accepts, and
 * a transcript in the persona's store so the launch is `--resume <pin>` — not a fresh `--session-id`.
 */
export function kitWakeBlocker(file: string, pin: string, roots: string[], deps: { bin?: string; preflight?: typeof preflightKitArgs } = {}): string | undefined {
  try {
    const persona = readKitPersona(file);
    if (persona.pin !== pin) return `its persona's resume pin (${persona.pin ?? "none"}) is not the session paw reads (${pin})`;
    if (!transcriptPath(pin, roots)) return `no transcript for ${pin} in ${roots.join(" or ")} — a wake would start a fresh session`;
    const bin = deps.bin ?? kitBinPath();
    if (!existsSync(bin)) return `no kit binary at ${bin} to relaunch it`;
    (deps.preflight ?? preflightKitArgs)(bin, persona.kitArgs, `kitArgs in ${file}`);
    return undefined;
  } catch (e) {
    return (e as Error).message.replace(/^paw: /, "");
  }
}

/** A kit agent's activity: kit has no background-task tool (no Monitor, no run_in_background), so the transcript
 *  carries no task records to scan — what runs is what the process table shows under its seat, plus kit's own
 *  armed schedules. The wake check rides along: a kit agent whose wake couldn't resume it never sleeps. */
export function kitActivity(space: string, name: string, file: string, pin: string, procs: SessionProcs, roots: string[], wakeDeps?: Parameters<typeof kitWakeBlocker>[3]): Activity {
  if (!procs.ok) return { tasks: [], shells: [], unknown: procs.unknown };
  let schedules: string[];
  try {
    schedules = kitSchedules(space, name);
  } catch (e) {
    return { tasks: [], shells: [], unknown: `kit's schedules can't be read (${(e as Error).message.split("\n")[0]})` };
  }
  return { tasks: [], shells: procs.shells, detached: [], schedules, wake: kitWakeBlocker(file, pin, roots, wakeDeps) };
}

/** {@link readActivity} for a status row, through `inspect`. */
export function rowActivity(space: string, row: Pick<AgentStatus, "name" | "pin">, inspect: ProcInspector, now = Date.now()): Activity {
  if (!row.pin) return { tasks: [], shells: [], unknown: "no resume pin" };
  const file = personaFilePath(space, row.name);
  const harness = readAgentType(file);
  const roots = personaTranscriptRoots(file);
  const procs = inspect({ space, name: row.name, pin: row.pin, sandboxed: !!readSandbox(file), harness });
  if (harness === KIT_AGENT) return kitActivity(space, row.name, file, row.pin, procs, roots);
  return readActivity(row.pin, procs, now, roots);
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
  if (row.harness && !SLEEPABLE_HARNESSES.has(row.harness)) return no(`harness ${row.harness} not supported yet (paw sleep reads claude and kit sessions)`);
  if (row.mesh !== "idle") return no(`mesh ${row.mesh}`);
  if (row.busy || row.tool) return no(`a turn is in flight${row.tool ? ` (${row.tool.name})` : ""}`);
  if (row.inbox.kind === "error") return no("inbox lag unknown");
  if (row.inbox.kind === "lag" && row.inbox.queued + row.inbox.unread > 0) return no(`inbox not drained (${row.inbox.queued} queued, ${row.inbox.unread} unread)`);
  if (row.conflictPids.length) return no(`session held by more than one process (${row.conflictPids.join(", ")})`);
  const allChannels = [...new Set([...channels, ...(activity.joined ?? [])])];
  if (allChannels.length) return no(`in ${allChannels.map((c) => "#" + c).join(", ")} — channel replay is 1h, traffic there would be lost asleep (v1)`);
  if (activity.unknown) return no(`can't tell what is running (${activity.unknown})`);
  if (activity.tasks.length) return no(`background task(s) running: ${activity.tasks.join(", ")}`);
  if (activity.schedules?.length) return no(`kit schedule(s) armed: ${activity.schedules.join(", ")} — they fire only while kit runs (\`paw cron\` wakes a sleeper instead)`);
  if (activity.shells.length) return no(row.harness === KIT_AGENT ? `process(es) running under kit: ${activity.shells.join("; ")}` : `shell process(es) running under claude: ${activity.shells.join("; ")}`);
  if (activity.detached?.length) return no(`process(es) running in its VM outside claude (they die with the container): ${activity.detached.join("; ")}`);
  if (activity.wake) return no(`a DM couldn't wake it back into its session: ${activity.wake}`);
  if (row.activeMs === undefined) return no("no transcript activity known");
  const idle = now - row.activeMs;
  if (idle < hibernateMs) return no(`idle ${Math.round(idle / 60_000)}m < ${Math.round(hibernateMs / 60_000)}m`);
  const stale = activity.stale?.length ? ` (stale task record(s), ignored — no live process: ${activity.stale.join(", ")})` : "";
  return { sleep: true, reason: `idle ${Math.round(idle / 60_000)}m ≥ ${Math.round(hibernateMs / 60_000)}m, nothing running${stale}` };
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
  return { ...next, cursorSeq: Math.min(prior.cursorSeq, next.cursorSeq), ...(prior.forwarded ? { forwarded: prior.forwarded } : {}) };
}

/** The DM stream's last sequence — the backlog cursor. */
export async function dmLastSeq(space: string, server = pawServer(space)): Promise<number> {
  const nc = await openStreamInfo(space, server);
  try {
    return await dmLastSeqOn(nc, space);
  } finally {
    await nc.close();
  }
}

/**
 * REMOTE space: refuse, loudly, an agent this machine does not host. The manager's ps here is pinned to
 * this machine's instance (src/control.ts), so another machine's seat is simply absent from it; what
 * says "it exists, elsewhere" is the presence roster. A name that is neither ours nor live anywhere
 * falls through to the ordinary "not registered / not running" errors. Local spaces: no-op.
 */
export async function assertNotHostedElsewhere(space: string, name: string, row: PsRow | undefined): Promise<void> {
  if (!isRemoteSpace(space)) return;
  const h = hosting(space, name, row);
  if (h.here) return;
  if (row) throw hostedElsewhereError(name, space, h.why); // listed by our manager but not ours by the row
  const roster = await readMeshRoster(space, pawServer(space), (await humanEndpointAuth(space, "operator")).creds, new Set([name]));
  const seen = roster.get(name);
  if (seen && presenceLive(seen, Date.now())) throw hostedElsewhereError(name, space, `it is live on the mesh as ${seen.id}, but this machine's manager does not run it`);
}

/** How long a despawned seat may stay in the manager's ps before `paw sleep` calls the despawn failed. */
export const SEAT_GONE_MS = 10_000;

/** The despawned seat's ps row if it is STILL listed after `timeoutMs` (same name and, when known, same
 *  id), else undefined. A ps that won't answer is no proof the seat went — it throws. */
export async function seatLingers(ctl: ManagerControl, name: string, id: string | undefined, timeoutMs = SEAT_GONE_MS): Promise<PsRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ps = await ctl.ps();
    if (!ps.ok) throw new Error(`paw: despawned "${name}" but the manager isn't answering ps (${ps.error ?? "no reply"}) — can't confirm the seat is gone`);
    const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name && (!id || !r.id || r.id === id));
    if (!row || Date.now() >= deadline) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Despawn `name` and record it asleep (the sleep host then raises its stand-in). `cursorSeq` and
 * `snapshotActiveMs` come from BEFORE the decision; the agent is re-checked against them right before the
 * despawn (see {@link preDespawnCheck}). On a REMOTE space only an agent this machine hosts
 * ({@link assertNotHostedElsewhere}); the record pins this machine's manager instance. A local PAW_AUTH mesh
 * is refused: re-delivery re-publishes each DM under its original sender, which only an open mesh or
 * paw's scoped remote-space creds allow.
 */
export async function sleepAgent(space: string, ctl: ManagerControl, name: string, reason: string, snap: { cursorSeq: number; snapshotActiveMs?: number; force?: boolean; reap?: (space: string, name: string) => Promise<string[]> }): Promise<void> {
  const remote = isRemoteSpace(space);
  if (process.env.PAW_AUTH === "1" && !remote)
    throw new Error("paw: `paw sleep` on a local PAW_AUTH mesh is not supported — waking re-delivers DMs under their original sender, which only paw's remote-space creds are scoped for");
  const ps = await ctl.ps();
  if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
  const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
  await assertNotHostedElsewhere(space, name, row);
  const rec = agentRecord(space, name);
  if (!rec) throw new Error(`paw: "${name}" is not a registered agent`);
  if (!row) throw new Error(`paw: "${name}" is not running`);
  const lastId = row.id ? wirePrincipal(row.id) : undefined;
  if (!snap.force) {
    const old = lastId ? parsePrincipalKey(lastId) : undefined;
    if (!old) throw new Error(`paw: not sleeping "${name}" — its ps row carries no principal, so its DMs can't be checked`);
    const pin = readResumeId(personaFilePath(space, name));
    const why = preDespawnCheck({
      snapshotActiveMs: snap.snapshotActiveMs,
      activeMsNow: pin ? transcriptMtime(pin, personaTranscriptRoots(personaFilePath(space, name))) : undefined,
      meshNow: row.mesh,
      dmsSinceCursor: await dmsSince(space, name, [unicastRecvFilter(space, old.owner, old.actor)], snap.cursorSeq),
    });
    if (why) throw new Error(`paw: not sleeping "${name}" — ${why}`);
  }
  const d = await ctl.despawn(name);
  if (!d.ok) throw new Error(`paw: couldn't despawn "${name}" (${d.error ?? "no reply"})`);
  // An accepted despawn is not a gone seat. A row left behind would sit beside the stand-in, read
  // through it by name, and get judged (and restarted) by the next wake — so prove it went first.
  const lingering = await seatLingers(ctl, name, row.id);
  if (lingering) {
    throw new Error(
      `paw: despawned "${name}" but the manager still lists its seat (status=${lingering.status ?? "?"} mesh=${lingering.mesh ?? "?"}) after ${SEAT_GONE_MS / 1000}s — NOT recording it asleep; check \`paw status\``,
    );
  }
  // A record already here (a seat that came up beside it and was never reconciled) still owes its backlog:
  // keep the EARLIER cursor and what was already forwarded, never overwrite them with this sleep's.
  // A `.waking` left by a wake the host never finished owes its backlog too — and must not outlive this
  // sleep: a `.waking` beside the new `.json` read as "waking" forever (team2027 fly/vercel, 2026-11-05).
  const prior = (() => {
    const read = (f: () => SleepRecord | undefined) => {
      try {
        return f();
      } catch {
        return undefined;
      }
    };
    const asleep = read(() => readSleepRecord(space, name));
    const waking = read(() => readWakingRecord(space, name));
    return asleep && waking ? mergeBacklog(waking, asleep) : (asleep ?? waking);
  })();
  writeSleepRecord(space, mergeSleepRecord(prior, { name, folder: rec.folder, since: Date.now(), cursorSeq: snap.cursorSeq, lastId, reason, ...(remote ? { instanceId: row.instanceId } : {}) }));
  clearWaking(space, name);
  sleepLog(space, `slept ${name} — ${reason} (cursor ${Math.min(prior?.cursorSeq ?? snap.cursorSeq, snap.cursorSeq)})`);
  // A sandboxed seat's VM goes down a beat after the despawn (the launcher's detached `container stop`), exactly
  // as on `paw stop`: wait for it, force-delete a leftover. AFTER the record — the seat is gone either way, and
  // a DM must still wake it (the next launch removes any leftover container of this agent first).
  if (readSandbox(personaFilePath(space, name))) {
    try {
      const forced = await (snap.reap ?? reapSandbox)(space, name);
      if (forced.length) sleepLog(space, `${name}: force-deleted container(s) that outlived the sleep: ${forced.join(" ")}`);
    } catch (e) {
      sleepLog(space, `${name}: asleep, but its container was not cleaned up — ${(e as Error).message}`);
      throw new Error(`paw: "${name}" is asleep, but its container was not cleaned up — ${(e as Error).message}`);
    }
  }
}

export interface SweepResult {
  slept: string[];
  /** Eligible, but `dryRun` — nothing was touched. */
  would: Array<{ name: string; reason: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

/** The sweep's seams, all real by default; check:sleep swaps them for fakes. */
export interface SweepDeps {
  now?: number;
  /** Print the verdicts, sleep nobody (and skip the DM-stream cursor read). */
  dryRun?: boolean;
  inspect?: ProcInspector;
  cursorSeq?: (space: string) => Promise<number>;
  /** The status rows + this machine's manager ps rows (hosting on a remote space). */
  status?: (space: string, ctl: ManagerControl) => Promise<{ rows: AgentStatus[]; ps: Map<string, PsRow> }>;
  sleep?: typeof sleepAgent;
}

/** Evaluate every opted-in agent once; put the eligible ones to sleep (or, `dryRun`, only say so). On a
 *  REMOTE space only agents this machine hosts are considered — another machine's are skipped, named. */
export async function sleepSweep(space: string, ctl: ManagerControl, deps: SweepDeps = {}): Promise<SweepResult> {
  const now = deps.now ?? Date.now();
  // FIRST: anything after this cursor is news the decision didn't see. A dry run never despawns, so needs none.
  const cursorSeq = deps.dryRun ? 0 : await (deps.cursorSeq ?? dmLastSeq)(space);
  const { rows, ps } = await (deps.status ?? sweepStatus)(space, ctl);
  const inspect = deps.inspect ?? liveInspector();
  const out: SweepResult = { slept: [], would: [], skipped: [] };
  for (const row of rows) {
    let hibernateMs: number | undefined;
    try {
      hibernateMs = readHibernate(space, row.name);
    } catch (e) {
      out.skipped.push({ name: row.name, reason: (e as Error).message });
      continue;
    }
    if (hibernateMs === undefined) continue;
    if (!row.live) {
      if (deps.dryRun) out.skipped.push({ name: row.name, reason: sleepState(space, row.name) ? `not live (${sleepState(space, row.name)})` : "not live" });
      continue;
    }
    const h = hosting(space, row.name, ps.get(row.name));
    if (!h.here) {
      out.skipped.push({ name: row.name, reason: `hosted on another machine (${h.why})` });
      continue;
    }
    const file = personaFilePath(space, row.name);
    const activity = rowActivity(space, row, inspect, now);
    const d = sleepDecision(row, hibernateMs, now, activity, extraChannels(personaValue(file, "subscribe")));
    if (!d.sleep) {
      out.skipped.push({ name: row.name, reason: d.reason + (activity.stale?.length ? ` · stale task record(s) ignored: ${activity.stale.join(", ")}` : "") });
      continue;
    }
    if (deps.dryRun) {
      out.would.push({ name: row.name, reason: d.reason });
      continue;
    }
    try {
      await (deps.sleep ?? sleepAgent)(space, ctl, row.name, d.reason, { cursorSeq, snapshotActiveMs: row.activeMs });
      out.slept.push(row.name);
    } catch (e) {
      out.skipped.push({ name: row.name, reason: (e as Error).message });
    }
  }
  return out;
}

async function sweepStatus(space: string, ctl: ManagerControl): Promise<{ rows: AgentStatus[]; ps: Map<string, PsRow> }> {
  const ps = await readManagerPs(ctl);
  const { rows } = await collectStatus(space, ctl, { git: false, ps });
  return { rows, ps };
}

/** Every space under $PAW_HOME/spaces with at least one opted-in agent. An unreadable space is reported. */
export function spacesWithOptIns(onError: (space: string, e: Error) => void = () => {}): string[] {
  const dir = join(pawHomeDir(), "spaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((space) => {
      try {
        return optedIn(space).length > 0;
      } catch (e) {
        onError(space, e as Error);
        return false;
      }
    });
}

export interface KeeperSleepDeps {
  spaces?: () => string[];
  /** Is THIS machine's manager for `space` running? The keeper never starts a mesh or manager to sweep. */
  managerUp?: (space: string) => boolean;
  withCtl?: <T>(space: string, fn: (ctl: ManagerControl) => Promise<T>) => Promise<T>;
  sweep?: (space: string, ctl: ManagerControl) => Promise<SweepResult>;
  log?: (line: string) => void;
}

/**
 * The keeper tick's sweep of every space OTHER than its own (`primary`, swept on the tick's ensured manager):
 * each space with opted-in agents whose manager runs on this machine, on its own control handle (pinned to
 * this machine's instance on a remote space, so only agents hosted here are ever listed). A space whose
 * manager isn't running here is skipped — no mesh or manager is started just to sweep it. One space failing
 * is logged and never stops the others.
 */
export async function sweepOtherSpaces(primary: string, deps: KeeperSleepDeps = {}): Promise<Array<{ space: string; slept?: string[]; skipped?: string; error?: string }>> {
  const log = deps.log ?? ((l: string) => console.error(l));
  const spaces = (deps.spaces ?? (() => spacesWithOptIns((s, e) => log(`paw keeper: sleep sweep can't read space ${s}: ${e.message}`))))();
  const managerUp = deps.managerUp ?? ((s: string) => managerProcs(s).length > 0);
  const withCtl = deps.withCtl ?? (<T>(s: string, fn: (ctl: ManagerControl) => Promise<T>) => withManagerControl(s, pawServer(s), fn));
  const sweep = deps.sweep ?? ((s: string, ctl: ManagerControl) => sleepSweep(s, ctl));
  const out: Array<{ space: string; slept?: string[]; skipped?: string; error?: string }> = [];
  for (const space of spaces) {
    if (space === primary) continue;
    if (!managerUp(space)) {
      out.push({ space, skipped: "no manager of this machine runs it" });
      continue;
    }
    try {
      const r = await withCtl(space, (ctl) => sweep(space, ctl));
      if (r.slept.length) log(`paw keeper: put to sleep in ${space}: ${r.slept.join(", ")}`);
      out.push({ space, slept: r.slept });
    } catch (e) {
      log(`paw keeper: sleep sweep of ${space} failed: ${(e as Error).message}`);
      out.push({ space, error: (e as Error).message });
    }
  }
  return out;
}

function parseArgs(argv: string[]): { space?: string; names: string[]; after?: string; off: boolean; now: boolean; sweep: boolean; force: boolean; dryRun: boolean } {
  const out = { names: [] as string[], off: false, now: false, sweep: false, force: false, dryRun: false } as ReturnType<typeof parseArgs>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("--space=")) out.space = a.slice(8);
    else if (a === "--after") out.after = argv[++i];
    else if (a === "--off") out.off = true;
    else if (a === "--now") out.now = true;
    else if (a === "--sweep") out.sweep = true;
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
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
      if (!agentRecord(space, name)) {
        await assertNotHostedElsewhere(space, name, undefined);
        throw new Error(`paw sleep: "${name}" is not a registered agent`);
      }
      setPersonaKeys(space, name, { hibernate: v === "off" ? undefined : o.after });
      sleepLog(space, v === "off" ? `opt-out ${name}` : `opt-in ${name} after ${o.after} idle`);
      console.log(v === "off" ? `${name}: will not sleep` : `${name}: sleeps after ${o.after} idle with nothing running; a DM wakes it`);
    }
    if (!o.now) return;
  }
  if (o.dryRun && !o.sweep) throw new Error("paw sleep: --dry-run goes with --sweep (it prints each opted-in agent's verdict without sleeping anyone)");
  if (o.sweep && o.dryRun) {
    // Read-only: never starts a mesh or manager (withEnsuredManager would) — a space not running here says so.
    if (!managerProcs(space).length) throw new Error(`paw sleep: no manager of this machine runs space "${space}" — nothing to sweep`);
    const r = await withManagerControl(space, pawServer(space), (ctl) => sleepSweep(space, ctl, { dryRun: true }));
    for (const s of r.would) console.log(`  ${s.name}: would sleep — ${s.reason}`);
    for (const s of r.skipped) console.log(`  ${s.name}: awake — ${s.reason}`);
    console.log(r.would.length ? `would sleep: ${r.would.map((w) => w.name).join(", ")} (dry run — nothing touched)` : "nobody would sleep (dry run — nothing touched)");
    return;
  }
  if (o.now || o.sweep) {
    await withEnsuredManager(space, async (ctl, server) => {
      if (o.sweep) {
        const r = await sleepSweep(space, ctl);
        for (const s of r.skipped) console.log(`  ${s.name}: awake — ${s.reason}`);
        console.log(r.slept.length ? `slept: ${r.slept.join(", ")}` : "nobody slept");
        return;
      }
      const cursorSeq = await dmLastSeq(space, server);
      const inspect = liveInspector();
      const ps = await readManagerPs(ctl);
      const { rows } = await collectStatus(space, ctl, { git: false, ps });
      for (const name of o.names) {
        await assertNotHostedElsewhere(space, name, ps.get(name));
        const row = rows.find((r) => r.name === name);
        if (!row) throw new Error(`paw sleep: "${name}" is not a registered agent`);
        const file = personaFilePath(space, name);
        const activity = rowActivity(space, row, inspect);
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
  usage: "sleep [<name>…] [--after 60m | --off] [--now [--force]] [--sweep [--dry-run]] [--space s]",
  run: (a) => sleepCmd([...a.raw]),
};

registry.register(sleepCommand);


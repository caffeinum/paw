/**
 * Background work in a claude session (pure scanning + one bounded read): what a transcript says is still
 * open (async Agents, Workflows, background Bash, Monitors) and which shells run under its claude. Shared by
 * `paw sleep` (src/sleep.ts) and, through {@link stopBackground}, by the claude connector's Stop hook — which
 * loads THIS file into every agent's cotal MCP process (PAW_BACKGROUND_PROBE), so it imports node builtins
 * and src/transcript.ts only. → docs/notes/office.md#background-work-shows-as-working-beads-y1eg-2026-11-05
 */
import { execFileSync } from "node:child_process";
import { tailRead } from "./transcript.ts";

/** The transcript lines that can open or close background work or change channel membership. */
const MARKERS = "backgroundTaskId|async_launched|Monitor started|task-notification|TaskStop|cotal_join|cotal_leave";
const MARKER_RE = new RegExp(MARKERS);
/** Fallback read when ripgrep is missing: the transcript's last 16MB. */
const TAIL_BYTES = 16 * 1024 * 1024;

/** What kind of background task a transcript record opened: a Bash `run_in_background` or a Monitor runs as
 *  a PROCESS (a shell under claude), so it is only believed while one is alive; an async agent or a Workflow
 *  runs inside claude itself and has no process to look for. */
export type TaskKind = "bash" | "monitor" | "agent" | "workflow";

/** Runs inside claude itself: its record alone is the evidence. */
export const inProcess = (kind: TaskKind): boolean => kind === "agent" || kind === "workflow";

/** `expires in 30m` / `timeout 600000ms` → ms. */
const monitorTtl = (n: string, unit: string) => Number(n) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[unit];

/**
 * Background work and runtime channel joins in a claude session, from its transcript lines (pure).
 *
 * Tasks open on: a Bash `run_in_background` result (`toolUseResult.backgroundTaskId`), an async
 * launch (`toolUseResult.status: "async_launched"`: a Workflow carries `taskId` + `taskType: "local_workflow"`,
 * a background Agent carries `agentId` — the id its `<task-notification>` closes it with), a Monitor (`Monitor started
 * (task X, timeout Nms)` or `(task X, expires in 30m …)` — one with a timeout ends by itself at start+timeout).
 * They close on a `<task-notification>` with a terminal `<status>` or a `TaskStop` call. Channels: every
 * `cotal_join` tool call minus `cotal_leave`, #general excluded. Lines before `sinceMs` (the running process's
 * start) are skipped: a task from a previous incarnation died with it, and its joins were not carried over.
 * A record with NO timestamp is skipped too: Claude Code's `api-request-blob`/`api-request` lines are copies
 * of whole request bodies (old tool results included) and carry none, so they replayed a long-closed task's
 * "Monitor started" after its TaskStop — or from a previous incarnation — and kept it open forever.
 */
export function scanActivity(lines: Iterable<string>, sinceMs: number, now: number): { tasks: string[]; open: Array<{ id: string; kind: TaskKind }>; joined: string[] } {
  const open = new Map<string, { deadline?: number; kind: TaskKind }>(); // deadline (ms) when the task ends by itself
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
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const tur = rec.toolUseResult as Record<string, unknown> | undefined;
    if (tur && typeof tur.backgroundTaskId === "string") open.set(tur.backgroundTaskId, { kind: "bash" });
    const asyncId = tur?.status === "async_launched" ? (typeof tur.taskId === "string" ? tur.taskId : typeof tur.agentId === "string" ? tur.agentId : undefined) : undefined;
    if (asyncId) open.set(asyncId, { kind: tur!.taskType === "local_workflow" || typeof tur!.workflowName === "string" ? "workflow" : "agent" });
    for (const m of line.matchAll(/Monitor started \(task (\w+)(?:, timeout (\d+)ms|, expires in (\d+)(ms|s|m|h)\b)?/g)) {
      const ttl = m[2] ? Number(m[2]) : m[3] ? monitorTtl(m[3], m[4]) : undefined;
      open.set(m[1], { kind: "monitor", deadline: ttl === undefined ? undefined : ts + ttl });
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
  const live = [...open].filter(([, t]) => t.deadline === undefined || t.deadline > now).map(([id, t]) => ({ id, kind: t.kind }));
  return { tasks: live.map((t) => t.id), open: live, joined: [...joined] };
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

/** cotal ≥0.59's launch-artifact reclaim watcher (core `launch-artifacts.js` RECLAIM_SCRIPT): the
 *  launch wrapper forks it, then `exec`s claude, so it sits as a `/bin/sh -c p=$$ n=$1…` CHILD of
 *  claude for the agent's whole life, polling the pid to delete the per-launch `cotal-*` temp dir.
 *  It is cotal's, not the agent's work, so it never counts as a running shell. ps renders the
 *  script's newlines as a literal `\012`. */
export const COTAL_RECLAIM_WATCHER = /^(\S*\/)?sh -c p=\$\$ n=\$1(\\012|\n)shift(\\012|\n)\((\\012|\n)\s*trap '' HUP INT QUIT TERM/;

/** Shell processes under `pid` — a background Bash or a Monitor's command runs as one. MCP servers
 *  (node), the claude binary itself and cotal's reclaim watcher are not counted. A hook that happens
 *  to be running counts too: that only delays a sleep by one tick, the safe direction. */
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
      if (COTAL_RECLAIM_WATCHER.test(k.cmd)) continue;
      if (/^(\S*\/)?(zsh|bash|sh|dash|fish)(\s|$)/.test(k.cmd)) out.push(`${k.pid} ${k.cmd.slice(0, 80)}`);
      walk(k.pid);
    }
  };
  walk(pid);
  return out;
}

/** `["workflow", "agent", "agent"]` → `workflow + 2 subagents`. Kinds only: a task's description or command can hold
 *  paths or secrets, and office chat is public. */
export function backgroundLabel(kinds: readonly string[]): string | undefined {
  const names: Record<string, [string, string]> = { workflow: ["workflow", "workflows"], agent: ["subagent", "subagents"], bash: ["shell", "shells"], monitor: ["monitor", "monitors"] };
  const parts = Object.entries(names).flatMap(([k, [one, many]]) => {
    const n = kinds.filter((x) => x === k).length;
    return n === 0 ? [] : [n === 1 ? one : `${n} ${many}`];
  });
  return parts.length ? parts.join(" + ") : undefined;
}

/** `[[dd-]hh:]mm:ss` (ps etime) → ms. */
export function etimeMs(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) throw new Error(`unparseable ps etime "${etime}"`);
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

/** Recheck an open background state at least this often: a shell can exit without writing the transcript. */
export const RECHECK_MAX_MS = 5 * 60_000;

/**
 * The Stop hook's question (loaded by the patched claude connector, dist/mcp.cjs): the turn just ended — is work
 * it launched still running? `claudePid` is the seat's claude (the MCP server's parent): tasks from before its start
 * died with a previous incarnation, and a Bash/Monitor task counts only while a shell under it backs it (sleep's
 * readActivity rule). Returns the office label (`workflow + 2 subagents`) or nothing, and when to look again while
 * something is open: every completion delivers a `<task-notification>` turn that ends in another Stop, so the
 * recheck ({@link RECHECK_MAX_MS}) only catches a backing shell that died silently.
 * Throws when it can't tell (no ps, unreadable transcript) — the hook then reports plain idle and logs why.
 */
export function stopBackground(transcriptPath: string, claudePid: number, now = Date.now(), ps?: string): { label?: string; recheckMs?: number } {
  const table = ps ?? execFileSync("ps", ["-A", "-o", "pid=,ppid=,etime=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  const self = table.split("\n").map((l) => /^\s*(\d+)\s+\d+\s+(\S+)\s+(\S+)/.exec(l)).find((m) => m && Number(m[1]) === claudePid);
  if (!self) throw new Error(`claude pid ${claudePid} not in the process table`);
  // A hosted MCP (one process serving several sessions) has no single claude parent: refuse rather than date
  // the wrong process.
  if (!/(^|\/)claude$/.test(self[3])) throw new Error(`parent ${claudePid} is not claude (${self[3]})`);
  const startedAt = now - etimeMs(self[2]) - 1000; // ps etime has whole-second precision
  const { lines, unknown } = markerLines(transcriptPath, startedAt);
  if (unknown) throw new Error(unknown);
  const { open } = scanActivity(lines, startedAt, now);
  if (!open.length) return {};
  const shells = shellDescendants(claudePid, table.split("\n").map((l) => l.replace(/^(\s*\d+\s+\d+)\s+\S+/, "$1")).join("\n"));
  const live = open.filter((t) => inProcess(t.kind) || shells.length > 0);
  const label = backgroundLabel(live.map((t) => t.kind));
  return label ? { label, recheckMs: RECHECK_MAX_MS } : {};
}

/**
 * Interrupting an agent that is stuck INSIDE a tool — the Esc a human would press.
 *
 * The case (queue-ea, 2026-09-15): one Bash call — a loop of `fly ssh console` — hung for 51 minutes.
 * Claude Code starts the next turn only when a tool returns, so every DM queued behind it and cotal
 * redelivered each one every minute, printing wake nudges into a session that could not take a turn.
 * The agent was not deaf; it was stuck. A restart would have "fixed" it by throwing the session's work
 * away. Pressing Esc in the pane interrupts the running tool, keeps the session, and lets the queued
 * DMs drain — you cannot trust agents never to run a long or stuck command, so paw needs that key.
 *
 * Only the tmux runtime has a pane paw can type into: pty seats have no terminal paw can reach (the
 * manager's attach rail is a signed session grant, see src/open.ts) and cmux tabs are a GUI app paw
 * does not drive. Those fail loud rather than pretend.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultTmuxEnv } from "./lifecycle.js";
import { tmuxSession } from "./native-attach.js";
import { transcriptPath } from "./session.js";
import { tailRead, toolResultFor, type PendingTool } from "./transcript.js";
import type { AgentStatus } from "./status.js";

/** Default keeper threshold: a single tool call running this long gets an Esc. */
export const UNSTICK_TOOL_DEFAULT_MIN = 30;
/** Minimum gap between two automatic tool-interrupts of the same agent. */
export const TOOL_UNSTICK_COOLDOWN_MS = 30 * 60_000;
/** How long `interruptTool` watches the transcript for the interrupted tool's result. */
export const VERIFY_MS = 20_000;

/**
 * `PAW_UNSTICK_TOOL_MIN` → the keeper's threshold in ms, or undefined when disabled. Unset ⇒ the
 * 30-minute default; `0` / `off` ⇒ disabled; a positive number of minutes ⇒ that. Anything else THROWS —
 * a typo must not silently turn a safety net off, or silently arm it at some value nobody chose.
 */
export function parseToolThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return UNSTICK_TOOL_DEFAULT_MIN * 60_000;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "0") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`paw: PAW_UNSTICK_TOOL_MIN must be a positive number of minutes, 0 or "off" (got "${raw}")`);
  }
  return n * 60_000;
}

export interface ToolUnstickDecision {
  interrupt: boolean;
  reason: string;
}

/**
 * Pure: should the keeper press Esc on this agent now? Only a LIVE tmux agent whose running turn has
 * sat inside ONE tool call for at least `thresholdMs` (measured from that call's own tool_use record —
 * the file's mtime keeps moving while DM nudges queue, so it can't say this), outside the cooldown.
 * Subagent calls (`Task`/`Agent`) are left alone: their progress is written to a separate transcript,
 * so a long one is indistinguishable from a busy one here, and Esc would kill real work.
 * `thresholdMs === undefined` is the disabled keeper. Never a restart — Esc only.
 */
export function toolUnstickDecision(
  row: Pick<AgentStatus, "live" | "runtime" | "tool">,
  now: number,
  lastMs: number | undefined,
  thresholdMs: number | undefined,
): ToolUnstickDecision {
  if (thresholdMs === undefined) return { interrupt: false, reason: "disabled (PAW_UNSTICK_TOOL_MIN)" };
  if (!row.live) return { interrupt: false, reason: "not live" };
  if (!row.tool) return { interrupt: false, reason: "no tool in flight" };
  if (row.runtime !== "tmux") return { interrupt: false, reason: `runtime ${row.runtime ?? "unknown"} has no pane to send Esc to` };
  if (row.tool.name === "Task" || row.tool.name === "Agent") return { interrupt: false, reason: "a subagent call — its progress isn't visible here" };
  if (row.tool.startedMs === undefined) return { interrupt: false, reason: "tool start time unknown" };
  const age = now - row.tool.startedMs;
  if (age < thresholdMs) return { interrupt: false, reason: `tool running ${Math.round(age / 60_000)}m (< ${Math.round(thresholdMs / 60_000)}m)` };
  if (lastMs !== undefined && now - lastMs < TOOL_UNSTICK_COOLDOWN_MS) {
    return { interrupt: false, reason: `interrupted ${Math.round((now - lastMs) / 60_000)}m ago (cooldown)` };
  }
  return { interrupt: true, reason: `inside ${row.tool.name} for ${Math.round(age / 60_000)}m` };
}

function markerDir(space: string): string {
  return join(process.env.PAW_HOME ?? join(homedir(), ".paw"), "spaces", space, "unstick-tool");
}

export function readLastToolUnstick(space: string, name: string): number | undefined {
  try {
    const v = Number(readFileSync(join(markerDir(space), name), "utf8").trim());
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastToolUnstick(space: string, name: string, ms: number): void {
  const dir = markerDir(space);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${ms}\n`);
}

/** The exact tmux target of an agent's window: `=` pins both parts to an EXACT match, so `web` can
 *  never land in `web-2`'s pane (a prefix match would type Esc into the wrong agent). */
export function tmuxTarget(space: string, name: string): string {
  return `=${tmuxSession(space)}:=${name}`;
}

/** Press Escape in the agent's tmux window, on the default socket the manager is pinned to. Throws
 *  with tmux's own words when the window isn't there. */
export function sendEscape(space: string, name: string): void {
  const res = spawnSync("tmux", ["send-keys", "-t", tmuxTarget(space, name), "Escape"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: defaultTmuxEnv(process.env),
    timeout: 5000,
  });
  if (res.error) throw new Error(`paw: tmux send-keys failed — ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`paw: can't reach "${name}"'s tmux window (${res.stderr?.toString().trim() || `exit ${res.status}`})`);
  }
}

export type InterruptOutcome =
  | { interrupted: true; afterMs: number; result: { isError: boolean; text: string; interrupted?: boolean } }
  | { interrupted: false; afterMs: number };

/**
 * Send Esc, then watch the pinned transcript for up to `verifyMs` until the interrupted call gets its
 * tool_result. The result record — not the keystroke — is the evidence: if none lands the tool is
 * still stuck and the caller must say so.
 */
export async function interruptTool(
  space: string,
  name: string,
  pin: string,
  tool: PendingTool,
  verifyMs = VERIFY_MS,
): Promise<InterruptOutcome> {
  const started = Date.now();
  sendEscape(space, name);
  while (Date.now() - started < verifyMs) {
    await new Promise((r) => setTimeout(r, 500));
    const file = transcriptPath(pin);
    if (!file) continue;
    const result = toolResultFor(tailRead(file, 2 * 1024 * 1024), tool.id);
    if (result) return { interrupted: true, afterMs: Date.now() - started, result };
  }
  return { interrupted: false, afterMs: Date.now() - started };
}

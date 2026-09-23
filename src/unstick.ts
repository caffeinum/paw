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
  row: Pick<AgentStatus, "live" | "runtime" | "tool" | "mesh">,
  now: number,
  lastMs: number | undefined,
  thresholdMs: number | undefined,
): ToolUnstickDecision {
  if (thresholdMs === undefined) return { interrupt: false, reason: "disabled (PAW_UNSTICK_TOOL_MIN)" };
  if (!row.live) return { interrupt: false, reason: "not live" };
  if (!row.tool) return { interrupt: false, reason: "no tool in flight" };
  if (row.runtime !== "tmux") return { interrupt: false, reason: `runtime ${row.runtime ?? "unknown"} has no pane to send Esc to` };
  if (row.tool.name === "Task" || row.tool.name === "Agent") return { interrupt: false, reason: "a subagent call — its progress isn't visible here" };
  // `waiting` = claude is asking the operator something (a permission prompt the connector's Notification
  // hook reported). The call isn't hung, it's blocked on a person — Esc there REJECTS the call and leaves
  // the session sitting in "what should Claude do instead?" (canary-env-52, 2026-09-16).
  if (row.mesh === "waiting") return { interrupt: false, reason: "waiting on a prompt — Esc would reject it" };
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

/** Pure: does this pane capture show Claude Code asking a question (permission / confirm dialog)?
 *  Presence can read offline mid-flap, so the pane is the second witness before an Esc. */
export function paneShowsPrompt(pane: string): boolean {
  return /Do you want to (proceed|make this edit|create|allow)/i.test(pane) || /Esc to cancel/.test(pane);
}

/**
 * Claude Code's input box as it appears in a pane capture: the `❯` line between two horizontal rules
 * (older builds draw `│ > …│`). `visible` false means the box isn't on screen — a menu, a picker or a
 * dialog has the keyboard, and typed keys would answer IT. `text` is what already sits in the box:
 * typing then would append to someone's half-written line. Read from the LAST such line, since the
 * scrollback above can hold quoted `❯` lines from the conversation.
 */
export function paneInput(pane: string): { visible: boolean; text: string } {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:│\s*)?[❯>](?: (.*?))?\s*│?\s*$/);
    if (!m) continue;
    // The box is fenced by rules; a bare `>` elsewhere (markdown quote, shell prompt) is not the box.
    const ruled = (j: number) => j >= 0 && j < lines.length && /^[\s─╭╮╰╯│]*─{8,}[\s─╭╮╰╯│]*$/.test(lines[j]);
    if (!(ruled(i - 1) || ruled(i + 1) || ruled(i + 2))) continue;
    return { visible: true, text: (m[1] ?? "").trim() };
  }
  return { visible: false, text: "" };
}

/** The visible text of the agent's tmux pane, or undefined when it can't be read. */
export function capturePane(space: string, name: string): string | undefined {
  const res = spawnSync("tmux", ["capture-pane", "-p", "-t", tmuxTarget(space, name)], {
    stdio: ["ignore", "pipe", "ignore"],
    env: defaultTmuxEnv(process.env),
    timeout: 5000,
  });
  return res.status === 0 ? res.stdout.toString() : undefined;
}

/** Text typed into the pane after an interrupt. An interrupted claude sits at "what should Claude do
 *  instead?" and does NOT take a turn for mesh wake-ups (three DMs to canary-env-52 produced none), so
 *  something has to hand it a turn or the interrupt only trades one stall for another. */
export function resumePrompt(toolName: string, minutes: number): string {
  return `paw keeper: your ${toolName} call ran ${minutes}m and looked hung, so it was interrupted (Esc). ` +
    `Check your cotal inbox, then continue — rerun it differently (shorter timeout, background) if it's still needed.`;
}

/** Type a line into the agent's pane and submit it. */
export async function sendPrompt(space: string, name: string, text: string): Promise<void> {
  const env = defaultTmuxEnv(process.env);
  const target = tmuxTarget(space, name);
  const typed = spawnSync("tmux", ["send-keys", "-t", target, "-l", text], { stdio: ["ignore", "ignore", "pipe"], env, timeout: 5000 });
  if (typed.status !== 0) throw new Error(`paw: can't type into "${name}"'s tmux window (${typed.stderr?.toString().trim() || `exit ${typed.status}`})`);
  await new Promise((r) => setTimeout(r, 400)); // an Enter in the same burst reads as part of a paste
  spawnSync("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore", env, timeout: 5000 });
}

/** One thing to press: literal text (typed as-is) or a tmux key name (Enter, Down, Escape, C-c…). */
export type KeyPart = { literal: string } | { key: string };

/**
 * Press a sequence of literal text and named keys in the agent's pane, in order. A key right after
 * literal text waits 400ms first — Claude Code reads a burst of text followed at once by Enter as a
 * PASTE, and a pasted newline is a newline in the box, not a submit (why sendPrompt waits too).
 */
export async function sendKeys(space: string, name: string, parts: KeyPart[]): Promise<void> {
  const env = defaultTmuxEnv(process.env);
  const target = tmuxTarget(space, name);
  let afterText = false;
  for (const p of parts) {
    if ("key" in p && afterText) await new Promise((r) => setTimeout(r, 400));
    const args = "literal" in p ? ["send-keys", "-t", target, "-l", p.literal] : ["send-keys", "-t", target, p.key];
    const res = spawnSync("tmux", args, { stdio: ["ignore", "ignore", "pipe"], env, timeout: 5000 });
    if (res.status !== 0) throw new Error(`paw: tmux refused ${"key" in p ? `key "${p.key}"` : "the text"} for "${name}" (${res.stderr?.toString().trim() || `exit ${res.status}`})`);
    afterText = "literal" in p;
    // Between keys: a short beat lets a menu redraw between arrow presses; after an ENTER, much
    // longer — Enter usually opens something (`/model x` asks to confirm the switch), and a second
    // key sent before that dialog has drawn lands on whatever was there before it.
    if ("key" in p) await new Promise((r) => setTimeout(r, p.key === "Enter" ? 900 : 150));
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

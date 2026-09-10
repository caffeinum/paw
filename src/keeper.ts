/**
 * The keeper's unstick rule: an agent that sits LIVE and IDLE with DMs it never drains gets restarted.
 *
 * The 2026-09-06 case: vibeos-landing held 6 delivered-but-unacked DMs for ~17 hours. Every ack-wait
 * cycle redelivered them, every redelivery printed a wake nudge in its TUI, and no turn ever drained the
 * inbox — the mesh read a healthy idle agent the whole time. `paw status` already said `⚠ inbox stuck`;
 * nothing acted on it, and the operator found out from the flood of "new dm" lines. A restart onto the
 * pin drained all six at once.
 *
 * The rule is deliberately narrow, because a restart costs a resume and must never hit a WORKING agent:
 *  - live and `idle` (its own word), never `working`/`waiting`/`starting`/`offline`;
 *  - inbox lag with something queued or unread (the zombie signature `inboxStuck` already renders);
 *  - the transcript QUIET for STUCK_MS — the same local truth `inferBusy` and the busy-guard use: an
 *    agent that wrote recently may be mid-turn and about to drain; one silent for ten minutes with mail
 *    waiting is not going to;
 *  - no `failure` — a refused turn (session limit, login expired) can't drain either, and a restart
 *    changes nothing until the cause clears, so bouncing it would only burn the resume;
 *  - a per-agent cooldown, so a restart that didn't help is not repeated every 60s tick.
 * `paw global` runs on the launchd keeper tick, so the sweep rides the same 60s heartbeat.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { restartAgent } from "./addressing.js";
import type { ManagerControl } from "./control.js";
import { collectStatus, inboxStuck, type AgentStatus } from "./status.js";

/** How long the transcript must be silent, with mail waiting, before the agent counts as stuck. */
export const STUCK_MS = 10 * 60_000;
/** Minimum gap between two unsticks of the same agent. */
export const UNSTICK_COOLDOWN_MS = 30 * 60_000;

export interface UnstickDecision {
  restart: boolean;
  reason: string;
}

/** Pure: should this row be restarted now? `lastUnstickMs` is the previous unstick of this agent. */
export function unstickDecision(row: AgentStatus, now: number, lastUnstickMs: number | undefined): UnstickDecision {
  if (!row.live) return { restart: false, reason: "not live" };
  if (row.mesh !== "idle") return { restart: false, reason: `mesh ${row.mesh}` };
  if (!inboxStuck(row)) return { restart: false, reason: "inbox not stuck" };
  if (row.failure) return { restart: false, reason: `last turn failed: ${row.failure.text}` };
  if (row.activeMs === undefined) return { restart: false, reason: "no transcript activity known" };
  const quietMs = now - row.activeMs;
  if (quietMs < STUCK_MS) return { restart: false, reason: `transcript written ${Math.round(quietMs / 1000)}s ago (may be mid-turn)` };
  if (lastUnstickMs !== undefined && now - lastUnstickMs < UNSTICK_COOLDOWN_MS) {
    return { restart: false, reason: `unstuck ${Math.round((now - lastUnstickMs) / 60_000)}m ago (cooldown)` };
  }
  const inbox = row.inbox.kind === "lag" ? `${row.inbox.queued} queued, ${row.inbox.unread} unread` : row.inbox.kind;
  return { restart: true, reason: `idle with ${inbox} for ${Math.round(quietMs / 60_000)}m of transcript silence` };
}

function markerDir(space: string): string {
  return join(process.env.PAW_HOME ?? join(homedir(), ".paw"), "spaces", space, "unstick");
}

export function readLastUnstick(space: string, name: string): number | undefined {
  try {
    const v = Number(readFileSync(join(markerDir(space), name), "utf8").trim());
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastUnstick(space: string, name: string, ms: number): void {
  const dir = markerDir(space);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${ms}\n`);
}

/** One sweep: restart every stuck agent, with its evidence on stderr. Returns what was restarted. */
export async function unstickSweep(space: string, ctl: ManagerControl, now = Date.now()): Promise<string[]> {
  const { rows } = await collectStatus(space, ctl);
  const restarted: string[] = [];
  for (const row of rows) {
    const d = unstickDecision(row, now, readLastUnstick(space, row.name));
    if (!d.restart) continue;
    console.error(`paw keeper: restarting "${row.name}" — ${d.reason} (ps mesh=${row.mesh}, activeMs=${row.activeMs})`);
    try {
      await restartAgent(ctl, { space, name: row.name, cwd: row.folder });
      writeLastUnstick(space, row.name, now);
      restarted.push(row.name);
    } catch (e) {
      console.error(`paw keeper: couldn't restart "${row.name}": ${(e as Error).message}`);
    }
  }
  return restarted;
}

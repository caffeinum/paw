/**
 * The webhook forwarder's health (src/github-forward.ts), as the mailbox that runs it last wrote it:
 * `<PAW_HOME>/github-forward.json`. The keeper's team poll reads it to pick its cadence; `paw github ls`
 * and `paw github forward status` show it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A forwarder that has not written a heartbeat for this long is not trusted, whatever it last said. */
export const STALE_MS = 90_000;

export type ForwardState = "starting" | "up" | "down" | "conflict" | "off";

export interface ForwardStatus {
  org: string;
  space: string;
  state: ForwardState;
  /** When `state` began. */
  since: number;
  /** Last heartbeat from the running supervisor. */
  beat: number;
  pid: number;
  /** Events received since the supervisor started, and when the last one came. */
  events: number;
  lastEvent?: number;
  /** Why it is down (gh's last words), when it is. */
  note?: string;
}

const pawHomeDir = (): string => process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
export const forwardStatusPath = (): string => join(pawHomeDir(), "github-forward.json");

export function readForwardStatus(): ForwardStatus | undefined {
  const p = forwardStatusPath();
  if (!existsSync(p)) return undefined;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<ForwardStatus>;
  if (typeof s.org !== "string" || typeof s.state !== "string" || typeof s.beat !== "number" || typeof s.since !== "number")
    throw new Error(`paw github: ${p} is not a forwarder status — remove it (the mailbox writes it again)`);
  return s as ForwardStatus;
}

export function writeForwardStatus(s: ForwardStatus): void {
  const p = forwardStatusPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, p);
}

/** Is a forwarder streaming `org`'s events right now? */
export function forwardHealthy(org: string, now: number, s: ForwardStatus | undefined = readForwardStatus()): boolean {
  return !!s && s.org === org && s.state === "up" && now - s.beat < STALE_MS;
}

export function describeForward(s: ForwardStatus | undefined, now: number): string {
  if (!s) return "webhook forwarder: never ran on this machine";
  const ago = (t: number) => `${Math.max(0, Math.round((now - t) / 1000))}s ago`;
  if (s.state !== "off" && now - s.beat >= STALE_MS) return `webhook forwarder for ${s.org}: NO heartbeat for ${ago(s.beat)} (its mailbox in space ${s.space} is gone?) — team tags are polled`;
  const ev = `${s.events} event(s)${s.lastEvent ? `, last ${ago(s.lastEvent)}` : ""}`;
  const head = `webhook forwarder for ${s.org} (mailbox of space ${s.space}, pid ${s.pid}): ${s.state} since ${ago(s.since)}`;
  return s.state === "up" ? `${head}, ${ev} — team tags by push, polling only to reconcile` : `${head}${s.note ? ` (${s.note})` : ""} — team tags are polled`;
}

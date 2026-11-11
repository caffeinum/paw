/**
 * `paw doctor`'s read of paw's pid-stamped lock files. The SOURCE OF TRUTH is src/lock.ts (its private
 * `holderPid` + `breakIfStale`): this mirrors them because lock.ts is in the manager fingerprint's file
 * graph (src/manager-fingerprint.ts) — touching it would turn the next `paw restart` into a full bounce
 * of every agent. check:doctor runs the same fixtures through lock.ts's `withFileLock` to keep the two
 * agreeing.
 *
 * One deliberate difference: lock.ts breaks ANY lock older than its stale age, live holder or not; doctor
 * keeps a live holder whose command is still paw's or cotal's (a long spawn is not abandoned) and calls
 * only a REUSED pid (alive, old, someone else's command) stale.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { pidAlive } from "./lock.ts";

export type LockKind = "held" | "dead" | "pidless-old" | "reused" | "fresh";

export interface LockInspection {
  kind: LockKind;
  pid?: number;
  ageMs: number;
  holderCmd?: string;
}

/** The command line of a live pid, or undefined when ps can't name it. */
export type CmdOf = (pid: number) => string | undefined;

const psCmd: CmdOf = (pid) => {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
};

/** Stale kinds: nobody will ever release these, and lock.ts would break each on its next use. */
export const STALE_KINDS: ReadonlySet<LockKind> = new Set(["dead", "pidless-old", "reused"]);

/** The pid stamped in a lock, or undefined when it's pidless (an older paw, or mid-write). Same parse as lock.ts. */
function stampedPid(path: string): number | undefined {
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** What one lock file is. Undefined when the file is gone; any other read failure throws. */
export function inspectLock(path: string, staleMs: number, now: number = Date.now(), cmdOf: CmdOf = psCmd): LockInspection | undefined {
  let mtimeMs: number;
  let pid: number | undefined;
  try {
    mtimeMs = statSync(path).mtimeMs;
    pid = stampedPid(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const ageMs = Math.max(0, now - mtimeMs);
  if (pid === undefined) return { kind: ageMs > staleMs ? "pidless-old" : "fresh", ageMs };
  if (!pidAlive(pid)) return { kind: "dead", pid, ageMs };
  const holderCmd = cmdOf(pid);
  const ours = holderCmd !== undefined && /paw|cotal/.test(holderCmd);
  if (ageMs > staleMs && holderCmd !== undefined && !ours) return { kind: "reused", pid, ageMs, holderCmd };
  return { kind: "held", pid, ageMs, ...(holderCmd !== undefined ? { holderCmd } : {}) };
}

/** Remove `path` only if it is STILL stale, re-inspected right before the rm. Returns what it found. */
export function removeStaleLock(path: string, staleMs: number, now: number = Date.now(), cmdOf: CmdOf = psCmd): { removed: boolean; found?: LockInspection } {
  const found = inspectLock(path, staleMs, now, cmdOf);
  if (!found || !STALE_KINDS.has(found.kind)) return { removed: false, ...(found ? { found } : {}) };
  rmSync(path, { force: true });
  return { removed: true, found };
}

/**
 * Dependency-free exclusive file locks, shared by the connector (folder pre-trust), addressing
 * (folder→name registry + spawn), so paw's read-modify-write of shared ~/.paw / ~/.claude.json state
 * is safe across concurrent paw processes. Protocol: exclusive-create a lock file (O_EXCL), retry
 * while it's held, and break a lock left by a crashed process once it's older than staleMs.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

const MAX_WAIT_MS = 30_000; // a cold mesh/agent boot can hold a lock for a few seconds — wait it out
const STALE_MS = 60_000; // a lock older than this is presumed abandoned by a crashed holder
const STEP_MS = 25;

/**
 * Is the process that wrote this lock still alive?
 *
 * Signal 0 probes without delivering — the same self-reap paw uses for foreground agents. EPERM means
 * alive but not ours, which still counts as HELD. An unreadable or pidless lock returns undefined so
 * the caller falls back to the age test rather than guessing.
 */
function holderAlive(lockPath: string): boolean | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath, "utf8").trim());
  } catch {
    return undefined; // vanished or unreadable — let the caller decide
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined; // written by an older paw, or mid-write
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // EPERM = alive, someone else's; ESRCH = gone
  }
}

/**
 * Break a lock nobody is holding.
 *
 * The PID check is what makes this recover promptly. Before it, a lock was an EMPTY file and the only
 * staleness signal was its age — and with MAX_WAIT (30s) below STALE_MS (60s), a waiter could NEVER
 * outlast a lock abandoned by a killed holder: it always timed out first. Ctrl-C-ing a `paw chat` that
 * was mid-spawn therefore blocked the next command for a full 30s and then failed it, which is exactly
 * what the operator hit (2026-08-20: `paw attach research` → "timed out acquiring lock").
 *
 * The age test stays as a backstop for locks with no pid in them (written by an older paw) and for the
 * pathological case of a pid reused by an unrelated process.
 */
function breakIfStale(lockPath: string, staleMs = STALE_MS): boolean {
  const alive = holderAlive(lockPath);
  if (alive === false) {
    rmSync(lockPath, { force: true });
    return true;
  }
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
      rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    return true; // vanished between open and stat — retry immediately
  }
  return false;
}

/** Stamp the lock with our pid so a later waiter can tell "held" from "abandoned". Best-effort: a
 *  failed write leaves an empty lock, which simply falls back to the age test. */
function stamp(fd: number): void {
  try {
    writeSync(fd, String(process.pid));
  } catch {
    /* an unstamped lock still works, it just recovers slower */
  }
}

/** Timeouts, injectable so tests can exercise the WAITING paths without actually waiting 30s. */
export interface LockOpts {
  maxWaitMs?: number;
  staleMs?: number;
}

/** Run `fn` while holding an exclusive lock at `lockPath` (synchronous body). */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOpts = {}): T {
  const maxWait = opts.maxWaitMs ?? MAX_WAIT_MS;
  const stale = opts.staleMs ?? STALE_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; ; waited += STEP_MS) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (breakIfStale(lockPath, stale)) continue;
      if (waited >= maxWait) throw new Error(`paw: timed out acquiring lock ${lockPath}`);
      Atomics.wait(sleeper, 0, 0, STEP_MS);
      continue;
    }
    stamp(fd);
    try {
      return fn();
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}

/** Async sibling of {@link withFileLock} for an awaiting body; the lock spans the await. Yields the
 *  event loop between retries (no Atomics.wait) so it never blocks other work while waiting. */
export async function withFileLockAsync<T>(lockPath: string, fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  const maxWait = opts.maxWaitMs ?? MAX_WAIT_MS;
  const stale = opts.staleMs ?? STALE_MS;
  for (let waited = 0; ; waited += STEP_MS) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (breakIfStale(lockPath, stale)) continue;
      if (waited >= maxWait) throw new Error(`paw: timed out acquiring lock ${lockPath}`);
      await new Promise((r) => setTimeout(r, STEP_MS));
      continue;
    }
    stamp(fd);
    try {
      return await fn();
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}

/**
 * Per-space FOREGROUND-agent registry — the visibility layer for `paw claude` (src/claude.ts).
 *
 * A `paw claude` agent is the REAL claude running in the operator's own terminal (stdio inherited),
 * mesh-wired via paw's connector. Unlike a manager-spawned agent it isn't in the manager's `ps`, so
 * the rest of paw would have no idea it exists — `paw open`/`dm`/`chat`/`status` would try to spawn a
 * duplicate. This registry makes it visible: one JSON file per agent under
 * `~/.paw/spaces/<space>/foreground/<name>.json` (ONE file per agent → concurrent `paw claude`
 * launches never contend on a shared file, so no lock is needed). Reads SELF-REAP dead pids (a
 * `paw claude` dies with its terminal, often without a clean unregister — a Ctrl-C, a closed tab),
 * mirroring named.ts's signal-0 liveness probe, so a stale entry never masquerades as a live agent.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A live foreground claude agent, keyed by paw agent name within a space. */
export interface ForegroundEntry {
  name: string;
  folder: string;
  pid: number;
  startedAt: number;
  /** The durable session id the launch resumed/continued, if known (a fresh session's id is unknown). */
  sessionId?: string;
  /** The claude passthrough argv (after paw peeled its own --space/--name) — for the record only. */
  argv: string[];
}

/** The per-space foreground dir under ~/.paw (PAW_HOME-aware — mirrors addressing.ts's spaceDir). */
function foregroundDir(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const dir = join(root, "spaces", space, "foreground");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function entryPath(space: string, name: string): string {
  return join(foregroundDir(space), `${name}.json`);
}

/** Does `pid` still exist? (signal 0 probes existence without delivering anything.) Mirrors named.ts. */
function isAlive(pid: number): boolean {
  if (pid <= 0) return false; // never process.kill(-1/0, …) — that signals the whole process group
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours — still alive
  }
}

/** Parse a foreground entry file, or undefined if it's missing/corrupt (a corrupt file is treated as
 *  absent, never thrown — a bad record must not brick a `paw claude`/`paw status`). */
function parseEntry(file: string): ForegroundEntry | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof rec.name === "string" && typeof rec.folder === "string" && typeof rec.pid === "number") {
      return {
        name: rec.name,
        folder: rec.folder,
        pid: rec.pid,
        startedAt: typeof rec.startedAt === "number" ? rec.startedAt : 0,
        sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
        argv: Array.isArray(rec.argv) ? rec.argv.filter((a): a is string => typeof a === "string") : [],
      };
    }
  } catch {
    // unreadable / partially-written — treat as absent
  }
  return undefined;
}

/** Record (or overwrite) a live foreground agent. Atomic (temp file + rename) so a concurrent reader
 *  never sees a half-written record. */
export function registerForeground(space: string, entry: ForegroundEntry): void {
  const file = entryPath(space, entry.name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** The live foreground agent named `name`, or undefined. SELF-REAPS a dead-pid (or corrupt) entry on
 *  read so a crashed/closed terminal never leaves a phantom live agent behind. */
export function readForeground(space: string, name: string): ForegroundEntry | undefined {
  const file = entryPath(space, name);
  const entry = parseEntry(file);
  if (!entry) {
    if (existsSync(file)) rmSync(file, { force: true }); // corrupt → reap
    return undefined;
  }
  if (!isAlive(entry.pid)) {
    rmSync(file, { force: true }); // dead pid → reap
    return undefined;
  }
  return entry;
}

/** Every LIVE foreground agent in the space, self-reaping dead/corrupt entries as it goes. */
export function listForeground(space: string): ForegroundEntry[] {
  const dir = foregroundDir(space);
  const out: ForegroundEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -".json".length);
    const entry = readForeground(space, name); // reaps in passing
    if (entry) out.push(entry);
  }
  return out;
}

/** Forget a foreground agent (called on its clean exit, and by stop/rm). Idempotent. */
export function unregisterForeground(space: string, name: string): void {
  rmSync(entryPath(space, name), { force: true });
}

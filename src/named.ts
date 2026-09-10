/**
 * Named claude sessions. `claude --session-name <n>` / `/rename <n>` write the human name into a
 * per-process index at `~/.claude/sessions/<pid>.json` — NOT into the transcript, whose file stays
 * named by session UUID. So resolving a name → session id (for `paw adopt --resume <name>`) means
 * scanning that index for an entry whose `name` matches AND whose `cwd` is the folder being adopted.
 * Read-only; tolerates partial/stale index files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sessionsIndexDir = (): string => join(homedir(), ".claude", "sessions");

interface SessionIndexEntry {
  sessionId: string;
  cwd: string;
  name?: string;
  updatedAt?: number;
  pid?: number;
}

/** All parseable entries in the named-session index (skips unreadable/partial files). */
function readIndex(): SessionIndexEntry[] {
  const dir = sessionsIndexDir();
  if (!existsSync(dir)) return [];
  const out: SessionIndexEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (typeof rec.sessionId === "string" && typeof rec.cwd === "string") {
        out.push({
          sessionId: rec.sessionId,
          cwd: rec.cwd,
          name: typeof rec.name === "string" ? rec.name : undefined,
          updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : undefined,
          pid: typeof rec.pid === "number" ? rec.pid : undefined,
        });
      }
    } catch {
      // skip unreadable / partially-written index files
    }
  }
  return out;
}

/** Canonical realpath of a recorded cwd (best effort — falls back to the raw string if it's gone). */
function canonCwd(cwd: string): string {
  return existsSync(cwd) ? realpathSync(cwd) : cwd;
}

/** Resolve a named claude session to its session id, scoped to `folder` (canonical realpath). Returns
 *  the most-recently-updated match, or undefined if no session by that name was recorded at `folder`. */
export function resolveNamedSession(folder: string, name: string): string | undefined {
  const matches = readIndex().filter((e) => e.name === name && canonCwd(e.cwd) === folder);
  if (!matches.length) return undefined;
  matches.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return matches[0].sessionId;
}

/** sessionId → name for all named sessions recorded at `folder` (decorates the `paw sessions` view). */
export function namesForFolder(folder: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of readIndex()) {
    if (e.name && canonCwd(e.cwd) === folder) m.set(e.sessionId, e.name);
  }
  return m;
}

/** A live (still-running) process holding a session open, per the index. */
export interface LiveSessionProc {
  pid: number;
  name?: string;
  /** true => a paw/cotal mesh agent (launched with the wake flag); false => a standalone `claude` TUI. */
  mesh: boolean;
}

/** Does `pid` still exist? (signal 0 probes existence without delivering anything.) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours — still alive
  }
}

/** Best-effort: is `pid` a paw/cotal mesh agent rather than a hand-run `claude` TUI? A mesh agent is
 *  always launched with the development-channels wake flag, which an interactive session never carries. */
function isMeshProc(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return cmd.includes("--dangerously-load-development-channels");
  } catch {
    return false; // can't read it — treat as a plain process so the caller surfaces it (fail safe)
  }
}

/** Live processes currently holding `sessionId` open (across the whole index). Lets adopt refuse to
 *  resume a session that's open in a standalone TUI — two writers on one transcript can corrupt it. */
export function liveSessionProcs(sessionId: string): LiveSessionProc[] {
  const out: LiveSessionProc[] = [];
  for (const e of readIndex()) {
    if (e.sessionId !== sessionId || e.pid === undefined || !isAlive(e.pid)) continue;
    out.push({ pid: e.pid, name: e.name, mesh: isMeshProc(e.pid) });
  }
  return out;
}

/** The human name (`claude --session-name` / `/rename`) recorded for a session id, if any. Lets
 *  `paw status` show "research" instead of a bare uuid so a session is recognizable at a glance. */
export function nameForSession(sessionId: string): string | undefined {
  for (const e of readIndex()) if (e.sessionId === sessionId && e.name) return e.name;
  return undefined;
}

/** Standalone (non-mesh) claude processes holding `sessionId` — the two-writer hazard. Resuming a
 *  session a hand-run TUI is editing puts two writers on one transcript and can corrupt it; both
 *  `adopt` and the spawn guard refuse on a non-empty result. (paw's own mesh agents are excluded.) */
export function foreignWriters(sessionId: string): LiveSessionProc[] {
  return liveSessionProcs(sessionId).filter((p) => !p.mesh);
}

/** Is `pid` an ancestor of the current process? Walks the parent-pid chain upward from process.pid via
 *  `ps -o ppid=`, bounded (<=40 hops, stops at pid <=1 or a cycle). Lets `paw adopt .` distinguish "the
 *  claude I'm running INSIDE" (an ancestor — killing it would kill this very command, so we must hand
 *  off to a detached child) from "another terminal's claude" (not an ancestor — safe to kill inline).
 *  Best-effort: any `ps` failure -> false (treat as not-self, the safe default). */
export function isSelfAncestor(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false; // pid 1 (launchd/init) is everyone's ancestor — never "self"
  let cur = process.pid;
  for (let hops = 0; hops < 40 && cur > 1; hops++) {
    let ppid: number;
    try {
      ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8" }).trim());
    } catch {
      return false;
    }
    if (!Number.isFinite(ppid) || ppid <= 0 || ppid === cur) return false;
    if (ppid === pid) return true;
    cur = ppid;
  }
  return false;
}

/** The claude session THIS process is running inside for `folder`: the ~/.claude/sessions index entry
 *  whose cwd is `folder` and whose (live) pid is an ANCESTOR of us. Returns {pid, sessionId} or
 *  undefined. Lets `paw adopt .` inside a claude pick ITS OWN session authoritatively (not a guessed
 *  "latest") and know it must detach before killing that ancestor. */
export function selfSessionProc(folder: string): { pid: number; sessionId: string } | undefined {
  for (const e of readIndex()) {
    if (e.pid === undefined || !isAlive(e.pid) || canonCwd(e.cwd) !== folder) continue;
    if (isSelfAncestor(e.pid)) return { pid: e.pid, sessionId: e.sessionId };
  }
  return undefined;
}

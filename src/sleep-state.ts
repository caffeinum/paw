/**
 * The on-disk state of `paw sleep` — a leaf module (node imports only) so addressing.ts can call
 * {@link prepareWake}/{@link clearSleep} without an import cycle.
 *
 * Layout under `$PAW_HOME/spaces/<space>/sleep/`:
 *  - `<name>.json`   the agent is ASLEEP: its seat was despawned, its persona/registry/pin are untouched,
 *                    and the sleep host (inside the mailbox daemon) holds a stand-in presence under its
 *                    name so `cotal_dm("<name>")` still resolves.
 *  - `<name>.waking` the agent is being woken: the stand-in stays up until the new seat is on the mesh,
 *                    then the host forwards the DMs that arrived while it slept.
 *  - `<name>.beacon` the pid of the process holding the stand-in presence (present ⇔ the stand-in is up).
 *
 * WHY a stand-in is needed at all (measured on cotal 0.48.1 and 0.58.0, scripts/probe-sleep-dm.ts):
 * every spawn mints a FRESH actor nkey, so a respawned agent listens on a different DM subject than the
 * one it had, and its new durable starts at the stream's activation frontier (SPEC §8). A DM published to
 * the old principal is stored — the DM stream is limits-retained — but nothing will ever read it.
 * Meanwhile a sender whose roster no longer holds the name fails at resolution ("no peer"). So paw must
 * own both the NAME (stand-in presence, stable per-agent actor) and the BACKLOG (re-publish on wake).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SleepRecord {
  name: string;
  folder: string;
  /** When the seat was despawned (ms). */
  since: number;
  /** DM stream last_seq captured BEFORE the sleep decision was read: everything after it on the agent's
   *  old subject or the stand-in's subject is backlog the woken agent is owed. */
  cursorSeq: number;
  /** The despawned incarnation's wire principal `<owner>.<actor>` — DMs from senders still holding its
   *  (offline) roster entry land on its subject, and are forwarded too. */
  lastId?: string;
  /** Why it was put to sleep (for the log and `paw sleep`). */
  reason: string;
  /** Consecutive failed wakes and the last error — after MAX_WAKE_FAILURES the record goes back to
   *  asleep (stand-in re-raised) instead of retrying forever in silence. */
  wakeFailures?: number;
  lastError?: string;
  /** Stream seqs already re-delivered to the woken agent (a retried forward never sends one twice). */
  forwarded?: number[];
}

/** Failed wakes in a row before the agent is put back to sleep and the failure surfaced. */
export const MAX_WAKE_FAILURES = 3;

export function sleepDir(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const dir = join(root, "spaces", space, "sleep");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const recordPath = (space: string, name: string) => join(sleepDir(space), `${name}.json`);
const wakingPath = (space: string, name: string) => join(sleepDir(space), `${name}.waking`);
const beaconPath = (space: string, name: string) => join(sleepDir(space), `${name}.beacon`);

/** The stand-in's actor token: stable per (space, name) so a re-raised stand-in (mailbox restart) keeps
 *  the same DM subject, NATS-safe (`[A-Za-z0-9_]`, no dashes). */
export function standInActor(space: string, name: string): string {
  return `pawsleep_${createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 24)}`;
}

function parse(file: string): SleepRecord {
  const rec = JSON.parse(readFileSync(file, "utf8")) as SleepRecord;
  if (typeof rec.name !== "string" || typeof rec.folder !== "string" || typeof rec.cursorSeq !== "number") {
    throw new Error(`corrupt sleep record ${file} — fix or delete it`);
  }
  return rec;
}

const parseOpt = (file: string) => (existsSync(file) ? parse(file) : undefined);

function atomicWrite(file: string, rec: SleepRecord): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function writeSleepRecord(space: string, rec: SleepRecord): void {
  atomicWrite(recordPath(space, rec.name), rec);
}

export function writeWakingRecord(space: string, rec: SleepRecord): void {
  atomicWrite(wakingPath(space, rec.name), rec);
}

export function readSleepRecord(space: string, name: string): SleepRecord | undefined {
  return parseOpt(recordPath(space, name));
}

export function readWakingRecord(space: string, name: string): SleepRecord | undefined {
  return parseOpt(wakingPath(space, name));
}

export function isAsleep(space: string, name: string): boolean {
  return existsSync(recordPath(space, name));
}

export type SleepState = "asleep" | "waking" | "wake failed" | "sleep record corrupt";

/** What `paw status` shows for an agent paw is holding offline on purpose. A record it cannot read says
 *  so rather than reading as a plain "offline". */
export function sleepState(space: string, name: string): SleepState | undefined {
  try {
    const waking = readWakingRecord(space, name);
    if (waking) return waking.lastError ? "wake failed" : "waking";
    const rec = readSleepRecord(space, name);
    if (rec) return rec.lastError ? "wake failed" : "asleep";
    return undefined;
  } catch {
    return "sleep record corrupt";
  }
}

/** Every readable record with `ext`, plus the files that would not parse — one bad file must never take
 *  the sleep host (and with it the mailbox's "you" beacon) down. */
export function scanRecords(space: string, ext: ".json" | ".waking"): { records: SleepRecord[]; bad: string[] } {
  const records: SleepRecord[] = [];
  const bad: string[] = [];
  for (const f of readdirSync(sleepDir(space)).filter((f) => f.endsWith(ext))) {
    try {
      records.push(parse(join(sleepDir(space), f)));
    } catch (e) {
      bad.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { records, bad };
}

export function listSleeping(space: string): SleepRecord[] {
  return scanRecords(space, ".json").records;
}

export function listWaking(space: string): SleepRecord[] {
  return scanRecords(space, ".waking").records;
}

export function clearWaking(space: string, name: string): void {
  rmSync(wakingPath(space, name), { force: true });
}

/** Forget any sleep state for `name` (stop/rm/rename): a DM must not resurrect an agent the operator
 *  stopped, removed or renamed. Returns whether there was any. */
export function clearSleep(space: string, name: string): boolean {
  const had = existsSync(recordPath(space, name)) || existsSync(wakingPath(space, name));
  rmSync(recordPath(space, name), { force: true });
  rmSync(wakingPath(space, name), { force: true });
  return had;
}

/** Record a failed wake. After MAX_WAKE_FAILURES the agent goes back to asleep — the host re-raises its
 *  stand-in so the name stays addressable — and the error stays on the record for `paw status`. */
export function failWake(space: string, name: string, error: string): { failures: number; backToSleep: boolean } {
  const rec = readWakingRecord(space, name);
  if (!rec) return { failures: 0, backToSleep: false };
  const failures = (rec.wakeFailures ?? 0) + 1;
  const next = { ...rec, wakeFailures: failures, lastError: error };
  if (failures >= MAX_WAKE_FAILURES) {
    writeSleepRecord(space, next);
    rmSync(wakingPath(space, name), { force: true });
    return { failures, backToSleep: true };
  }
  writeWakingRecord(space, next);
  return { failures, backToSleep: false };
}

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** pid holding `name`'s stand-in presence, or undefined (a dead holder's file is reaped). */
export function standInHolder(space: string, name: string): number | undefined {
  const file = beaconPath(space, name);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (Number.isInteger(pid) && alive(pid)) return pid;
  rmSync(file, { force: true });
  return undefined;
}

export function markStandIn(space: string, name: string, up: boolean): void {
  if (up) writeFileSync(beaconPath(space, name), `${process.pid}\n`);
  else rmSync(beaconPath(space, name), { force: true });
}

/**
 * Called by `ensureAgentSpawned` BEFORE it spawns: if `name` is asleep, flip it to waking. The stand-in
 * stays UP until the new seat reaches the mesh (the host lowers it then), so the name never goes dead
 * during the boot; DMs arriving meanwhile land on the stand-in and are forwarded. Returns whether a wake
 * is in progress.
 */
export function prepareWake(space: string, name: string): boolean {
  const rec = recordPath(space, name);
  if (existsSync(rec)) renameSync(rec, wakingPath(space, name));
  return existsSync(wakingPath(space, name));
}

/** Append one line to the space's sleep log — every sleep and wake is recorded with its reason. */
export function sleepLog(space: string, line: string): void {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const file = join(root, "spaces", space, "sleep.log");
  writeFileSync(file, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  console.error(`paw sleep: ${line}`);
}

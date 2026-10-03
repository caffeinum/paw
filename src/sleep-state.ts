/**
 * The on-disk state of `paw sleep` — a leaf module (node imports only) so addressing.ts can call
 * {@link prepareWake} from `ensureAgentSpawned` without an import cycle.
 *
 * Layout under `$PAW_HOME/spaces/<space>/sleep/`:
 *  - `<name>.json`   the agent is ASLEEP: its seat was despawned, its persona/registry/pin are untouched,
 *                    and the sleep host (inside the mailbox daemon) holds a stand-in presence under its
 *                    name so `cotal_dm("<name>")` still resolves.
 *  - `<name>.waking` the agent is being woken: the stand-in is coming down and the host owes it the DMs
 *                    that arrived while it slept (forwarded once the new seat is on the mesh).
 *  - `<name>.beacon` the pid of the process holding the stand-in presence (present ⇔ the stand-in is up).
 *
 * WHY a stand-in is needed at all (measured on cotal 0.48.1, scripts/probe-sleep-dm.ts): every spawn
 * mints a FRESH actor nkey, so a respawned agent listens on a different DM subject than the one it had,
 * and its new durable starts at the stream's activation frontier (SPEC §8). A DM published to the old
 * principal is stored — the DM stream is limits-retained — but nothing will ever read it. Meanwhile a
 * sender whose roster no longer holds the name fails at resolution ("no peer"). So paw must own both the
 * NAME (stand-in presence, stable per-agent actor) and the BACKLOG (re-publish on wake).
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
  /** DM stream last_seq captured just BEFORE the despawn: everything after it on the agent's old subject
   *  or the stand-in's subject is backlog the woken agent is owed. */
  cursorSeq: number;
  /** The despawned incarnation's wire principal `<owner>.<actor>` — DMs from senders still holding its
   *  (offline) roster entry land on its subject, and are forwarded too. */
  lastId?: string;
  /** Why it was put to sleep (for the log and `paw sleep`). */
  reason: string;
}

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

function parse(file: string): SleepRecord | undefined {
  if (!existsSync(file)) return undefined;
  const rec = JSON.parse(readFileSync(file, "utf8")) as SleepRecord;
  if (typeof rec.name !== "string" || typeof rec.folder !== "string" || typeof rec.cursorSeq !== "number") {
    throw new Error(`paw: corrupt sleep record ${file} — fix or delete it`);
  }
  return rec;
}

export function writeSleepRecord(space: string, rec: SleepRecord): void {
  const file = recordPath(space, rec.name);
  writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function readSleepRecord(space: string, name: string): SleepRecord | undefined {
  return parse(recordPath(space, name));
}

export function readWakingRecord(space: string, name: string): SleepRecord | undefined {
  return parse(wakingPath(space, name));
}

export function isAsleep(space: string, name: string): boolean {
  return existsSync(recordPath(space, name));
}

export function listSleeping(space: string): SleepRecord[] {
  return readdirSync(sleepDir(space))
    .filter((f) => f.endsWith(".json"))
    .map((f) => parse(join(sleepDir(space), f))!)
    .filter(Boolean);
}

export function listWaking(space: string): SleepRecord[] {
  return readdirSync(sleepDir(space))
    .filter((f) => f.endsWith(".waking"))
    .map((f) => parse(join(sleepDir(space), f))!)
    .filter(Boolean);
}

export function clearWaking(space: string, name: string): void {
  rmSync(wakingPath(space, name), { force: true });
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
 * Called by `ensureAgentSpawned` BEFORE it spawns: if `name` is asleep, flip it to waking and wait for
 * the stand-in presence to come down — a stand-in and the real agent live under one name at once would
 * make every `cotal_dm(name)` throw AmbiguousPeerError. Returns whether a wake is in progress.
 * Bounded: a host that never releases (mailbox dead) is reported, and the spawn proceeds — a dead host
 * holds no presence anyway, since its stand-in died with it.
 */
export async function prepareWake(space: string, name: string, timeoutMs = 15_000): Promise<boolean> {
  const rec = recordPath(space, name);
  if (existsSync(rec)) renameSync(rec, wakingPath(space, name));
  else if (!existsSync(wakingPath(space, name))) return false;
  const deadline = Date.now() + timeoutMs;
  while (standInHolder(space, name) !== undefined) {
    if (Date.now() >= deadline) {
      console.error(`paw: "${name}"'s stand-in presence is still up after ${timeoutMs / 1000}s — spawning anyway; a DM to it may be ambiguous until it drops`);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

/** Append one line to the space's sleep log — every sleep and wake is recorded with its reason. */
export function sleepLog(space: string, line: string): void {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const file = join(root, "spaces", space, "sleep.log");
  writeFileSync(file, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  console.error(`paw sleep: ${line}`);
}

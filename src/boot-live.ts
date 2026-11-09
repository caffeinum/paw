/**
 * "What was live before the reboot" — per space, so the login fleet job can bring back EVERY space this
 * machine hosts, not just the one baked into its plist.
 *
 * The incidents: the mini rebooted at 04:07 on 2026-11-07 and the mac on 2026-11-01. The fleet job
 * (`paw start <names> --space paw`) brought `paw` back; team2027 — a REMOTE space on the fly broker, never
 * in any plist — stayed down (lizard, paw, mcpc, evals-intern) until someone noticed.
 *
 * Nothing paw kept survived a reboot as a "was live" record: `restart-revive.json` exists only during a
 * failed `paw restart`, the manager's ps dies with the machine, and sleep records say who is ASLEEP, not who
 * was up. So the keeper (the 60s `paw global` tick) now writes one:
 *
 *   `$PAW_HOME/spaces/<s>/live.json` = `{ space, bootAt, at, names }`
 *
 * - `names`: this machine's manager's ps rows whose process is running (`psRowRunning`, the same rule
 *   `paw restart` revives by), with a persona HERE, not asleep. On a remote space the control rail is pinned
 *   to this machine's manager instance (src/control.ts), so another machine's seats never appear.
 * - written only for a space whose manager runs here and whose ps ANSWERED — a down manager, a stalled
 *   broker or a refused ps never overwrites the last good record with a guess.
 * - `bootAt` = when this machine booted. A record from an EARLIER boot is held (not overwritten) for
 *   {@link BOOT_HOLD_MS} after boot, until the fleet job has read it and re-stamped it ({@link restampLiveRecord}):
 *   after a reboot the keeper ticks while the fleet job is still bringing agents back, and a snapshot taken
 *   then would record a half-empty fleet as "what was live".
 *
 * A deliberate `paw stop` or a `paw sleep` drops out of the record within one keeper tick; the fleet job also
 * skips anything recorded asleep at boot. A space with no record is never started at boot — said in the log.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { personaFilePath, psRowRunning, type PsRow } from "./addressing.ts";
import type { ManagerControl } from "./control.ts";
import { withManagerControl } from "./control.ts";
import { managerProcs, pawHomeDir } from "./lifecycle.ts";
import { pawServer } from "./server.ts";
import { isAsleep } from "./sleep-state.ts";

export interface LiveRecord {
  space: string;
  /** When this machine booted (ms since epoch) at the time of the write. */
  bootAt: number;
  at: string;
  names: string[];
}

/** How long after boot a previous boot's record is held for the fleet job (when no fleet job re-stamps it). */
export const BOOT_HOLD_MS = 60 * 60_000;
/** Two boot times this close are the same boot (`Date.now() - uptime()` jitters by a few ms per call). */
const SAME_BOOT_MS = 2 * 60_000;
/** A keeper ps against another space's manager (a remote broker) never holds the tick longer than this. */
export const RECORD_PS_TIMEOUT_MS = 30_000;

export const currentBootAt = (now = Date.now()): number => now - uptime() * 1000;
export const sameBoot = (a: number, b: number): boolean => Math.abs(a - b) < SAME_BOOT_MS;

export function liveRecordPath(space: string): string {
  return join(pawHomeDir(), "spaces", space, "live.json");
}

/** The record, or undefined when there is none. A malformed one throws — paw wrote it. */
export function readLiveRecord(space: string): LiveRecord | undefined {
  const p = liveRecordPath(space);
  if (!existsSync(p)) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${p} is not valid JSON (${(e as Error).message}) — it records who was live in ${space} for the login fleet job; fix or remove it`);
  }
  const r = v as Partial<LiveRecord>;
  if (r?.space !== space || typeof r.bootAt !== "number" || typeof r.at !== "string" || !Array.isArray(r.names) || !r.names.every((n) => typeof n === "string"))
    throw new Error(`paw: ${p} is not a live record for space ${space} ({space, bootAt, at, names}) — fix or remove it`);
  return r as LiveRecord;
}

function writeRecord(rec: LiveRecord): void {
  const p = liveRecordPath(rec.space);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, p);
}

/** Pure: may the keeper replace `existing` now? Not while it is a previous boot's record still owed to the fleet job. */
export function mayRecord(existing: LiveRecord | undefined, bootAt: number, now: number): boolean {
  if (!existing || sameBoot(existing.bootAt, bootAt)) return true;
  return now - bootAt >= BOOT_HOLD_MS;
}

/** Pure: which ps rows go in the record — running, persona here, not asleep. Deduped, sorted. */
export function liveNamesOf(rows: Array<Pick<PsRow, "name" | "status" | "mesh">>, has: (name: string) => boolean, asleep: (name: string) => boolean): string[] {
  return [...new Set(rows.filter((r) => psRowRunning(r) && has(r.name) && !asleep(r.name)).map((r) => r.name))].sort();
}

export interface RecordDeps {
  now?: number;
  bootAt?: number;
  has?: (space: string, name: string) => boolean;
  asleep?: (space: string, name: string) => boolean;
}

/** Write `space`'s record from a ps answer. Returns the names written, or why nothing was. */
export function recordFromPs(space: string, ps: { ok: boolean; data?: unknown }, deps: RecordDeps = {}): { names?: string[]; held?: string } {
  if (!ps.ok) return { held: "ps did not answer — the last record stands" };
  const now = deps.now ?? Date.now();
  const bootAt = deps.bootAt ?? currentBootAt(now);
  const existing = readLiveRecord(space);
  if (!mayRecord(existing, bootAt, now)) return { held: `a record from before this boot (${existing!.at}) is held for the login fleet job` };
  const has = deps.has ?? ((s, n) => existsSync(personaFilePath(s, n)));
  const asleep = deps.asleep ?? isAsleep;
  const names = liveNamesOf((ps.data as PsRow[]) ?? [], (n) => has(space, n), (n) => asleep(space, n));
  writeRecord({ space, bootAt, at: new Date(now).toISOString(), names });
  return { names };
}

/** The keeper's write for a space it already holds a manager handle on. Never fails the tick. */
export async function recordLive(space: string, ctl: ManagerControl, deps: RecordDeps = {}): Promise<void> {
  try {
    recordFromPs(space, await ctl.ps(), deps);
  } catch (e) {
    console.error(`paw keeper: recording who is live in ${space} failed: ${(e as Error).message}`);
  }
}

/** Every space dir under `$PAW_HOME/spaces`. */
export function spaceDirs(): string[] {
  const dir = join(pawHomeDir(), "spaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** The keeper's write for every OTHER space whose manager runs on this machine (never starts one). */
export async function recordLiveElsewhere(
  primary: string,
  deps: { spaces?: () => string[]; managerUp?: (s: string) => boolean; ps?: (s: string) => Promise<{ ok: boolean; data?: unknown }>; record?: RecordDeps } = {},
): Promise<string[]> {
  const spaces = (deps.spaces ?? spaceDirs)();
  const managerUp = deps.managerUp ?? ((s: string) => managerProcs(s).length > 0);
  const ps =
    deps.ps ??
    ((s: string) =>
      withManagerControl(s, pawServer(s), (ctl) =>
        Promise.race([
          ctl.ps(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`ps timed out after ${RECORD_PS_TIMEOUT_MS / 1000}s`)), RECORD_PS_TIMEOUT_MS).unref()),
        ]),
      ));
  const done: string[] = [];
  for (const space of spaces) {
    if (space === primary || !managerUp(space)) continue;
    try {
      recordFromPs(space, await ps(space), deps.record);
      done.push(space);
    } catch (e) {
      console.error(`paw keeper: recording who is live in ${space} failed: ${(e as Error).message}`);
    }
  }
  return done;
}

/** The fleet job has read `space`'s record: stamp it with this boot so the keeper keeps it current again. Names unchanged. */
export function restampLiveRecord(space: string, now = Date.now(), bootAt = currentBootAt(now)): void {
  const r = readLiveRecord(space);
  if (r && !sameBoot(r.bootAt, bootAt)) writeRecord({ ...r, bootAt });
}

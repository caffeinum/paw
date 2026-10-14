/**
 * The wake gate's memory of its own AUTOMATIC restarts — a leaf module (node imports only) so both
 * addressing.ts and status.ts can read it.
 *
 * A seat whose process runs but never registers presence (a healthy fleet otherwise) used to be restarted
 * on every wake once its boot went quiet: the 60s launchd tick, the sleep host's retry, any `paw dm`. Each
 * restart killed whatever it was doing and cost a resume, forever. Now each automatic restart is recorded
 * under `$PAW_HOME/spaces/<space>/restarts/<name>.json`; the next one waits an exponential backoff, and
 * after {@link RESTART_CAP} restarts within {@link RESTART_WINDOW_MS} that never reached the mesh the seat
 * is marked STUCK: the gate stops restarting it and says "needs a human" on every wake and in `paw status`.
 * The record is deleted the moment the gate sees the seat live, or when an operator runs `paw restart`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RestartHistory {
  /** Automatic restarts (ms) since the seat was last seen live. */
  restarts: number[];
  /** When the gate gave up (ms): no more automatic restarts until the seat is live or a human restarts it. */
  stuck?: number;
}

/** Automatic restarts without the seat reaching the mesh before it is marked stuck. */
export const RESTART_CAP = 4;
/** Restarts older than this are forgotten: a seat that ran for hours and then died gets a fresh budget.
 *  Longer than the whole backoff schedule (75m), so a seat that never registers does reach the cap. */
export const RESTART_WINDOW_MS = 2 * 60 * 60_000;
/** The wait after the first restart; doubles per restart (5m, 10m, 20m, 40m — stuck ~75m after the first). */
export const RESTART_BACKOFF_MS = 5 * 60_000;

export type RestartVerdict =
  | { kind: "go" }
  | { kind: "wait"; restarts: number[]; nextAt: number }
  | { kind: "stuck"; restarts: number[]; since: number };

export function restartHistoryPath(space: string, name: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  return join(root, "spaces", space, "restarts", `${name}.json`);
}

/** The record, or undefined when there is none. A file that isn't a record throws — never guessed at. */
export function readRestartHistory(space: string, name: string): RestartHistory | undefined {
  const file = restartHistoryPath(space, name);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8");
  let h: unknown;
  try {
    h = JSON.parse(raw);
  } catch (e) {
    throw new Error(`paw: restart history ${file} is not JSON (${(e as Error).message}) — delete it to reset "${name}"'s restart budget`);
  }
  const r = h as RestartHistory;
  if (!Array.isArray(r?.restarts) || !r.restarts.every((t) => typeof t === "number") || (r.stuck !== undefined && typeof r.stuck !== "number")) {
    throw new Error(`paw: restart history ${file} is malformed (${raw.slice(0, 120)}) — delete it to reset "${name}"'s restart budget`);
  }
  return r;
}

function write(space: string, name: string, h: RestartHistory): void {
  const file = restartHistoryPath(space, name);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(h) + "\n");
  renameSync(tmp, file);
}

/** Pure: may the gate restart now, must it wait, or has it given up? */
export function restartVerdict(h: RestartHistory | undefined, now: number): RestartVerdict {
  if (h?.stuck !== undefined) return { kind: "stuck", restarts: h.restarts, since: h.stuck };
  const restarts = (h?.restarts ?? []).filter((t) => now - t < RESTART_WINDOW_MS).sort((a, b) => a - b);
  if (!restarts.length) return { kind: "go" };
  // Even the last allowed restart gets its full backoff to come up before the gate gives up on it.
  const nextAt = restarts[restarts.length - 1] + RESTART_BACKOFF_MS * 2 ** (restarts.length - 1);
  if (now < nextAt) return { kind: "wait", restarts, nextAt };
  return restarts.length >= RESTART_CAP ? { kind: "stuck", restarts, since: now } : { kind: "go" };
}

export function recordRestart(space: string, name: string, now: number): void {
  const restarts = (readRestartHistory(space, name)?.restarts ?? []).filter((t) => now - t < RESTART_WINDOW_MS);
  write(space, name, { restarts: [...restarts, now] });
}

export function markStuck(space: string, name: string, restarts: number[], since: number): void {
  write(space, name, { restarts, stuck: since });
}

/** The seat was seen live, or a human restarted it: forget the history. */
export function clearRestartHistory(space: string, name: string): void {
  rmSync(restartHistoryPath(space, name), { force: true });
}

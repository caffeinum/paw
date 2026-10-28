/**
 * `paw cron` core: scheduled wake-ups for agents, one JSON file per space
 * (`$PAW_HOME/spaces/<space>/cron.json`). Pure parsing + scheduling + the store; the CLI and the keeper
 * sweep live in src/commands/cron.ts.
 *
 * Semantics mirror Claude Code's CronCreate: a standard 5-field cron in LOCAL time, recurring by default,
 * or a one-shot (`--in`/`--at`/`--once`) that is deleted after it fires. Unlike Claude Code's session
 * crons, these are durable (survive agent restarts and reboots) and never expire.
 *
 * Catch-up: a recurring job is due when its next occurrence AFTER its last fire is in the past. Firing
 * sets `lastFiredAt = now`, so however many occurrences a sleeping machine missed, it fires ONCE.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";

const pawHomeDir = (): string => process.env.PAW_HOME?.trim() || join(homedir(), ".paw");

export interface CronJob {
  id: string;
  agent: string;
  prompt: string;
  /** Recurring: the 5-field expression. Absent on a one-shot. */
  cron?: string;
  /** One-shot: epoch ms it fires at. Absent on a recurring job. */
  at?: number;
  createdAt: number;
  /** Who scheduled it: the calling agent's name, or "operator" from a plain shell. */
  createdBy: string;
  lastFiredAt?: number;
  /** One-shot delivery failures so far; it is dropped after {@link ONE_SHOT_MAX_ATTEMPTS}. */
  attempts?: number;
  lastError?: string;
  /** `--run`: a shell command the KEEPER runs at fire time (cwd = the agent's folder). Silent on exit 0
   *  with empty stdout; otherwise its output (or failure) is DM'd. `prompt` is optional then. */
  run?: string;
  /** `--run` timeout, ms (default {@link RUN_TIMEOUT_MS}). */
  timeoutMs?: number;
}

export interface CronStore {
  jobs: CronJob[];
}

/** A failed one-shot is retried on later ticks, at most this many attempts in all. */
export const ONE_SHOT_MAX_ATTEMPTS = 3;
/** Gap between one-shot retries. */
export const ONE_SHOT_RETRY_MS = 5 * 60_000;

// ── cron expressions ────────────────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset of names[0] (months start at 1). */
  nameBase?: number;
}
const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Restricted (not `*`) — standard cron ORs day-of-month and day-of-week when BOTH are. */
  domStar: boolean;
  dowStar: boolean;
}

function fieldValue(f: Field, raw: string, expr: string): number {
  const lower = raw.toLowerCase();
  const named = f.names?.indexOf(lower) ?? -1;
  const n = named >= 0 ? named + (f.nameBase ?? 0) : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`paw cron: bad ${f.name} "${raw}" in "${expr}" (${f.min}-${f.max})`);
  return n;
}

function parseField(f: Field, src: string, expr: string): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined || range === "") throw new Error(`paw cron: bad ${f.name} "${part}" in "${expr}"`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`paw cron: bad step "${stepRaw}" in "${expr}"`);
    let lo: number, hi: number;
    if (range === "*") [lo, hi] = [f.min, f.max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [lo, hi] = [fieldValue(f, a, expr), fieldValue(f, b, expr)];
      if (lo > hi) throw new Error(`paw cron: backwards range "${range}" in "${expr}"`);
    } else {
      lo = fieldValue(f, range, expr);
      hi = stepRaw === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star: src === "*" };
}

/** Parse a standard 5-field cron (`m h dom mon dow`; `*`, lists, ranges, steps, 3-letter names). */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`paw cron: "${expr}" needs 5 fields — minute hour day-of-month month day-of-week (e.g. "30 3 * * *")`);
  const [mi, h, dom, mo, dow] = parts.map((p, i) => parseField(FIELDS[i], p, expr));
  if (dow.set.has(7)) dow.set.add(0); // 7 = Sunday too
  return { minute: mi.set, hour: h.set, dom: dom.set, month: mo.set, dow: dow.set, domStar: dom.star, dowStar: dow.star };
}

function dayMatches(s: CronSpec, d: Date): boolean {
  const domOk = s.dom.has(d.getDate());
  const dowOk = s.dow.has(d.getDay());
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dowOk;
  if (s.dowStar) return domOk;
  return domOk || dowOk;
}

/** The first matching minute strictly AFTER `after` (local time). Throws if none within 5 years. */
export function nextFire(expr: string | CronSpec, after: number): number {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!s.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  throw new Error(`paw cron: "${typeof expr === "string" ? expr : "expression"}" never fires within 5 years`);
}

// ── argv shape ──────────────────────────────────────────────────────────────────────────────────────

/** Flags of `paw cron` that take a value / take none. Shared by the CLI parser and the `#space` hoister. */
export const CRON_VALUE_FLAGS = ["--space", "--server", "--in", "--at", "--run", "--timeout"];
export const CRON_BOOL_FLAGS = ["--once", "--all"];

/** Is the first positional after `add` the AGENT (vs. the schedule/prompt, agent defaulting to the
 *  caller)? `add [<agent>] "<cron>" "<prompt>"` or `add [<agent>] --in|--at <t> "<prompt>"`. With
 *  `--run` the prompt is optional, so the count alone can't tell: a cron form's agent is whatever comes
 *  before the 5-field expression, and a timed form's lone word is the agent (a one-word prompt needs the
 *  agent named too). */
export function cronAddHasAgent(rest: string[], timed: boolean, run: boolean): boolean {
  if (!run) return rest.length === (timed ? 2 : 3);
  if (!timed) return rest.length > 0 && rest[0].trim().split(/\s+/).length !== 5;
  return rest.length === 2 || (rest.length === 1 && /^@?[A-Za-z0-9_.-]+$/.test(rest[0]));
}

// ── one-shot times ──────────────────────────────────────────────────────────────────────────────────

/** `--in 20m` / `--timeout 90s` → ms. Units s, m, h, d; combinations like `1h30m`. */
export function parseIn(s: string): number {
  const re = /(\d+)\s*(s|m|h|d)/gy;
  let total = 0;
  let matched = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    total += Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    matched = re.lastIndex;
  }
  if (!s || matched !== s.length || total <= 0) throw new Error(`paw cron: bad --in "${s}" — use e.g. 20m, 2h, 1h30m, 1d`);
  return total;
}

/** `--at` → epoch ms: `HH:MM` (today, else tomorrow if already past) or a date/time Date understands
 *  (`2026-11-10 09:00`, ISO). A time already in the past fails loud. */
export function parseAt(s: string, now: number): number {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (hm) {
    const [h, m] = [Number(hm[1]), Number(hm[2])];
    if (h > 23 || m > 59) throw new Error(`paw cron: bad --at "${s}"`);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = new Date(s.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2")).getTime();
  if (!Number.isFinite(t)) throw new Error(`paw cron: bad --at "${s}" — use HH:MM or "YYYY-MM-DD HH:MM"`);
  if (t <= now) throw new Error(`paw cron: --at "${s}" is in the past`);
  return t;
}

// ── due / fire bookkeeping (pure) ───────────────────────────────────────────────────────────────────

/** When the job next fires (epoch ms), from its last fire (or its creation). */
export function nextDue(job: CronJob): number {
  if (job.at !== undefined) return job.lastFiredAt === undefined ? job.at : job.lastFiredAt + ONE_SHOT_RETRY_MS;
  if (!job.cron) throw new Error(`paw cron: job ${job.id} has neither cron nor at`);
  return nextFire(job.cron, job.lastFiredAt ?? job.createdAt);
}

export const isDue = (job: CronJob, now: number): boolean => nextDue(job) <= now;

/** Claim the due jobs: stamp `lastFiredAt = now` on each (so a concurrent tick can't fire them again and
 *  a recurring job's missed occurrences collapse into this one fire). Returns the claimed copies. */
export function claimDue(store: CronStore, now: number, agentOk: (j: CronJob) => boolean = () => true): CronJob[] {
  const due: CronJob[] = [];
  for (const j of store.jobs) {
    if (!isDue(j, now) || !agentOk(j)) continue;
    j.lastFiredAt = now;
    due.push({ ...j });
  }
  return due;
}

/** Record how a claimed fire went. A delivered one-shot is removed; a failed one is retried later and
 *  dropped after {@link ONE_SHOT_MAX_ATTEMPTS}. A recurring job keeps going either way (its error is
 *  kept for `paw cron ls`). Returns what happened, for the log line. */
export function settle(store: CronStore, id: string, error: string | undefined): "removed" | "kept" | "dropped" | "gone" {
  const i = store.jobs.findIndex((j) => j.id === id);
  if (i < 0) return "gone"; // removed by `paw cron rm` while it fired
  const j = store.jobs[i];
  if (j.at !== undefined) {
    if (!error) return store.jobs.splice(i, 1), "removed";
    j.attempts = (j.attempts ?? 0) + 1;
    j.lastError = error;
    if (j.attempts >= ONE_SHOT_MAX_ATTEMPTS) return store.jobs.splice(i, 1), "dropped";
    return "kept";
  }
  if (error) j.lastError = error;
  else delete j.lastError;
  return "kept";
}

/** The DM text a fire delivers. */
export function fireText(job: CronJob): string {
  return `${fireHead(job)}: ${job.prompt}`;
}

function fireHead(job: CronJob): string {
  const when = job.cron ? `"${job.cron}"` : "one-shot";
  return `⏰ paw cron ${job.id} (${when}, set by ${job.createdBy}; scheduled wake-up, no reply needed)`;
}

/** Default `--run` timeout. */
export const RUN_TIMEOUT_MS = 10 * 60_000;
/** How much of a command's output a DM carries. */
export const RUN_OUTPUT_MAX = 8_000;

export interface RunResult {
  /** Exit code, or undefined when killed (timeout/signal). */
  code: number | undefined;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const clip = (s: string, max: number, keep: "head" | "tail"): string => {
  if (s.length <= max) return s;
  const cut = keep === "head" ? s.slice(0, max) : s.slice(-max);
  return keep === "head" ? `${cut}\n[… output truncated: ${s.length} chars, first ${max} shown]` : `[… output truncated: ${s.length} chars, last ${max} shown]\n${cut}`;
};

/** Pure: the DM a `--run` fire sends, or undefined for a silent success (exit 0, empty stdout). */
export function runText(job: CronJob, r: RunResult, timeoutMs: number): string | undefined {
  const ok = !r.timedOut && r.code === 0;
  if (ok && !r.stdout.trim()) return undefined;
  const head = job.prompt ? fireText(job) : fireHead(job);
  if (ok) {
    const err = r.stderr.trim() ? `\n[stderr]\n${clip(r.stderr.trim(), 2_000, "tail")}` : "";
    return `${head}\n\n\`${job.run}\` printed:\n${clip(r.stdout.trim(), RUN_OUTPUT_MAX, "head")}${err}`;
  }
  const why = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : r.code === undefined ? "was killed" : `exited ${r.code}`;
  const both = `${r.stdout}${r.stderr ? `${r.stdout && !r.stdout.endsWith("\n") ? "\n" : ""}${r.stderr}` : ""}`.trim();
  return `${head}\n\n\`${job.run}\` FAILED — ${why}.${both ? `\nlast output:\n${clip(both, 4_000, "tail")}` : " (no output)"}`;
}

/** Human description of a job's schedule. */
export function scheduleLabel(job: CronJob): string {
  return job.cron ? `cron "${job.cron}"` : `once at ${new Date(job.at!).toLocaleString()}`;
}

export const newJobId = (): string => randomBytes(4).toString("hex");

// ── store ───────────────────────────────────────────────────────────────────────────────────────────

export function cronPath(space: string): string {
  return join(pawHomeDir(), "spaces", space, "cron.json");
}

export function readStore(space: string): CronStore {
  const p = cronPath(space);
  if (!existsSync(p)) return { jobs: [] };
  const data = JSON.parse(readFileSync(p, "utf8")) as CronStore;
  if (!Array.isArray(data?.jobs)) throw new Error(`paw cron: ${p} has no "jobs" array — fix or remove it`);
  return data;
}

function writeStore(space: string, store: CronStore): void {
  const p = cronPath(space);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameSync(tmp, p);
}

/** Read-modify-write the space's store under its lock; the write is atomic (tmp + rename). */
export function updateStore<T>(space: string, fn: (store: CronStore) => T): T {
  mkdirSync(join(pawHomeDir(), "spaces", space), { recursive: true });
  return withFileLock(`${cronPath(space)}.lock`, () => {
    const store = readStore(space);
    const out = fn(store);
    writeStore(space, store);
    return out;
  });
}

/** Every space under $PAW_HOME that has a cron store. */
export function spacesWithCron(): string[] {
  const dir = join(pawHomeDir(), "spaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((s) => existsSync(cronPath(s)));
}

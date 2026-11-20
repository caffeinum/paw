/**
 * Where `paw archive` keeps a retired agent: `spaces/<s>/personas/archived/<name>.<stamp>.md` (its persona,
 * moved — the registry is the persona files, so this alone unregisters it) beside `<name>.<stamp>.json` (what
 * happened: when, by whom, folder, branch, session pin, the worktree verdict, and what came off the revival
 * paths — cron jobs and GitHub watches kept here, not restored). `paw unarchive` moves the persona back and the
 * record into `archived/restored/`. Every reader of the personas dir lists `*.md` at its top level only, so
 * nothing in `archived/` is ever an agent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CronJob } from "./cron.ts";
import type { Follow, Watch } from "./github-relay.ts";
import { pawHomeDir } from "./lifecycle.ts";
import type { WorktreeFacts } from "./archive-worktree.ts";

export type WorktreeOutcome = "removed" | "kept" | "skipped" | "none" | "pending";

export interface ArchiveRecord {
  name: string;
  space: string;
  /** ISO time the persona was archived. */
  at: string;
  /** "itself" (self-archive), the calling agent's name, or "operator". */
  by: string;
  folder?: string;
  extra: boolean;
  /** Persona `agent:` (absent = claude). */
  agent?: string;
  session?: string;
  transcript?: string;
  /** Whether a live seat was stopped. */
  stopped: boolean;
  worktree: { outcome: WorktreeOutcome; why: string[]; notes: string[]; facts?: WorktreeFacts };
  /** Taken off the revival paths. */
  revival: {
    liveRecord: boolean;
    reviveList: boolean;
    asleep: boolean;
    cron: CronJob[];
    github: { watches: Watch[]; mutes: Follow[]; queued: number; queuedLeft: number };
    fleetPlist?: string;
  };
}

export const archiveDir = (space: string): string => join(pawHomeDir(), "spaces", space, "personas", "archived");
const restoredDir = (space: string): string => join(archiveDir(space), "restored");

/** `2026-11-19T10:15:00.123Z` → `20261119T101500Z`. */
export const stampOf = (at: Date): string => at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** A free `<name>.<stamp>[-n]` base in the archive (neither its .md nor .json exists). */
export function reserveBase(space: string, name: string, at: Date): string {
  const dir = archiveDir(space);
  mkdirSync(dir, { recursive: true });
  const stamp = stampOf(at);
  for (let n = 1; ; n++) {
    const base = `${name}.${stamp}${n > 1 ? `-${n}` : ""}`;
    if (!existsSync(join(dir, `${base}.md`)) && !existsSync(join(dir, `${base}.json`))) return base;
  }
}

export const archivedPersonaPath = (space: string, base: string): string => join(archiveDir(space), `${base}.md`);
export const recordPath = (space: string, base: string): string => join(archiveDir(space), `${base}.json`);

export function writeArchiveRecord(space: string, base: string, rec: ArchiveRecord): void {
  const p = recordPath(space, base);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, p);
}

export function readArchiveRecord(file: string): ArchiveRecord {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${file} is not valid JSON (${(e as Error).message}) — an archive record paw wrote; fix or remove it`);
  }
  const r = v as Partial<ArchiveRecord>;
  if (typeof r?.name !== "string" || typeof r.space !== "string" || typeof r.at !== "string" || typeof r.worktree?.outcome !== "string")
    throw new Error(`paw: ${file} is not an archive record ({name, space, at, worktree, …}) — fix or remove it`);
  return r as ArchiveRecord;
}

export interface Archived {
  base: string;
  rec: ArchiveRecord;
}

/** Every archived agent of `space` (not restored ones), oldest first. */
export function listArchived(space: string): Archived[] {
  const dir = archiveDir(space);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ base: f.slice(0, -".json".length), rec: readArchiveRecord(join(dir, f)) }))
    .sort((a, b) => a.rec.at.localeCompare(b.rec.at) || a.base.localeCompare(b.base));
}

/** The newest archive of `name`, or undefined. */
export function newestArchived(space: string, name: string): Archived | undefined {
  return listArchived(space)
    .filter((a) => a.rec.name === name)
    .at(-1);
}

/** After an unarchive: the record moves to `archived/restored/` (kept, never deleted), stamped with when. */
export function markRestored(space: string, a: Archived, at: Date): string {
  mkdirSync(restoredDir(space), { recursive: true });
  const to = join(restoredDir(space), `${a.base}.json`);
  renameSync(recordPath(space, a.base), to);
  writeFileSync(to, JSON.stringify({ ...a.rec, restoredAt: at.toISOString() }, null, 2) + "\n");
  return to;
}

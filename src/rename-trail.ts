/**
 * Where a renamed agent went: `spaces/<s>/renamed.json` maps an old name to `{ to, at }`, written by
 * `paw rename` once the persona has moved. A chat filtered to the old name reads it and follows
 * (`paw hire` relies on it: the hired agent renames itself while the operator is already chatting).
 * Core-free and tiny: chat polls it every second.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spaceDir } from "./addressing.ts";

export type RenameTrail = Record<string, { to: string; at: number }>;

function trailPath(space: string): string {
  return join(spaceDir(space), "renamed.json");
}

export function readRenameTrail(space: string): RenameTrail {
  const file = trailPath(space);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${file} is unreadable (${(e as Error).message}) — fix or delete it; it only lets a chat follow a renamed agent`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`paw: ${file} is not a { from: { to, at } } map — fix or delete it`);
  for (const [from, hop] of Object.entries(parsed)) {
    const h = hop as { to?: unknown; at?: unknown } | null;
    if (!h || typeof h.to !== "string" || typeof h.at !== "number") throw new Error(`paw: ${file}: the entry for "${from}" is not { to, at } — fix or delete it`);
  }
  return parsed as RenameTrail;
}

/** Pure: `trail` with `from → to` recorded. */
export function withRename(trail: RenameTrail, from: string, to: string, at: number = Date.now()): RenameTrail {
  const next = { ...trail, [from]: { to, at } };
  delete next[to]; // the name is held again: an older trail out of it is stale
  return next;
}

/** Write the whole trail. Called under the registry lock (renameAgentOnDisk), so writes don't race. */
export function writeRenameTrail(space: string, trail: RenameTrail): void {
  const file = trailPath(space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(trail, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Record `from → to` (read, then write). */
export function recordRename(space: string, from: string, to: string, at: number = Date.now()): void {
  writeRenameTrail(space, withRename(readRenameTrail(space), from, to, at));
}

/** Pure: the name `name` ended up under, following every rename recorded at or after `since`
 *  (a → b → c gives c); undefined when it wasn't renamed since. Stops on a cycle. */
export function followTrail(trail: RenameTrail, name: string, since: number): string | undefined {
  let cur = name;
  const seen = new Set([cur]);
  for (;;) {
    const hop = trail[cur];
    if (!hop || hop.at < since || seen.has(hop.to)) break;
    cur = hop.to;
    seen.add(cur);
  }
  return cur === name ? undefined : cur;
}

export function renamedSince(space: string, name: string, since: number): string | undefined {
  return followTrail(readRenameTrail(space), name, since);
}

/** Pure: where a chat aimed at `name` should go now. A name that is still registered follows only renames
 *  since the chat began (`since`) — an old trail out of a name reused later must not pull it away. A name
 *  that is NOT registered (it was renamed before this chat started: a `paw chat @hire-…` printed by a
 *  non-tty `paw hire` and run later) follows the whole trail. */
export function followTarget(trail: RenameTrail, name: string, registered: boolean, since: number): string | undefined {
  return followTrail(trail, name, registered ? since : 0);
}

/**
 * A self-rename that is QUEUED but has not landed: `spaces/<s>/renaming.json` maps the old name to
 * `{ to, at }`. `renameSelf` writes it the moment the detached child is spawned; the child drops it in
 * its `finally`, after the agent is back under the new name and its wake DM went out (or the rename gave
 * up). While it is there, a chat aimed at the agent says `◌ renaming to <to>…` and HOLDS what you type,
 * then sends it to the new name once it is live (src/chat.ts, {@link RenameHold}) — a line sent to the
 * old name while its seat is being stopped was otherwise read by nobody (team2027, 2026-11-25).
 */
export type RenamePending = Record<string, { to: string; at: number }>;

/** A child waits ≤30m for the turn to end; a marker older than this outlived a child that died hard. */
export const RENAME_PENDING_MAX_MS = 35 * 60_000;

function pendingPath(space: string): string {
  return join(spaceDir(space), "renaming.json");
}

export function readRenamePending(space: string): RenamePending {
  const file = pendingPath(space);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${file} is unreadable (${(e as Error).message}) — fix or delete it; it only marks a self-rename in flight`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`paw: ${file} is not a { from: { to, at } } map — fix or delete it`);
  for (const [from, p] of Object.entries(parsed)) {
    const h = p as { to?: unknown; at?: unknown } | null;
    if (!h || typeof h.to !== "string" || typeof h.at !== "number") throw new Error(`paw: ${file}: the entry for "${from}" is not { to, at } — fix or delete it`);
  }
  return parsed as RenamePending;
}

function writeRenamePending(space: string, pending: RenamePending): void {
  const file = pendingPath(space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending, null, 2) + "\n");
  renameSync(tmp, file);
}

/** One rename per old name is in flight at a time (the child's pidfile is keyed by it), so no lock. */
export function markRenamePending(space: string, from: string, to: string, at: number = Date.now()): void {
  writeRenamePending(space, { ...readRenamePending(space), [from]: { to, at } });
}

export function clearRenamePending(space: string, from: string): void {
  const pending = readRenamePending(space);
  if (!(from in pending)) return;
  delete pending[from];
  writeRenamePending(space, pending);
}

/** Pure: the name `name` is being renamed to right now, if a fresh marker says so. */
export function pendingRenameOf(pending: RenamePending, name: string, now: number): string | undefined {
  const p = pending[name];
  return p && now - p.at <= RENAME_PENDING_MAX_MS ? p.to : undefined;
}

/** The footer cell while a chat's target is mid-rename — never a bare `offline`. */
export function renamingTag(from: string, to: string): string {
  return `${from} ◌ renaming to ${to}…`;
}

/** The transcript line under the first line held during a rename. */
export const renameHeldLine = (from: string, to: string): string => `◌ held — "${from}" is becoming "${to}"; sends to ${to} once it is back`;

/**
 * Pure: chat's lines to a target that is mid-rename. `begin` when the marker appears, `hold` each line typed
 * meanwhile, `settle` every tick: nothing while the marker is there; once it is gone, the rename landed (the
 * trail has `from → to`) → release to `to` when it is live; the rename gave up (no hop) → release to `from`,
 * which the child woke again. The marker goes only after the wake DM, so held lines land after it.
 */
export class RenameHold {
  private cur: { from: string; to: string; lines: string[] } | undefined;

  get active(): { from: string; to: string; held: number } | undefined {
    return this.cur && { from: this.cur.from, to: this.cur.to, held: this.cur.lines.length };
  }

  begin(from: string, to: string): void {
    if (!this.cur) this.cur = { from, to, lines: [] };
  }

  /** Hold a line; true for the first one (say {@link renameHeldLine} once). */
  hold(text: string): boolean {
    if (!this.cur) throw new Error("RenameHold.hold: no rename in flight");
    this.cur.lines.push(text);
    return this.cur.lines.length === 1;
  }

  /** `renamedTo`: where the rename trail says `from` went (undefined = it never moved). */
  settle(o: { stillPending: boolean; renamedTo: string | undefined; live: (name: string) => boolean }): { to: string; lines: string[]; landed: boolean } | undefined {
    if (!this.cur || o.stillPending) return undefined;
    const { from, to, lines } = this.cur;
    const landed = o.renamedTo === to;
    const target = landed ? to : from;
    if (!o.live(target)) return undefined;
    this.cur = undefined;
    return { to: target, lines, landed };
  }

  /** Everything still held (a quit prints it). */
  all(): { to: string; text: string }[] {
    return this.cur ? this.cur.lines.map((text) => ({ to: this.cur!.to, text })) : [];
  }
}

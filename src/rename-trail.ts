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

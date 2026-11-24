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
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`paw: ${file} is not a { from: { to, at } } map`);
  return parsed as RenameTrail;
}

/** Record `from → to`. Called under the registry lock (renameAgentOnDisk), so writes don't race. */
export function recordRename(space: string, from: string, to: string, at: number = Date.now()): void {
  const trail = readRenameTrail(space);
  trail[from] = { to, at };
  delete trail[to]; // the name is held again: an older trail out of it is stale
  const file = trailPath(space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(trail, null, 2) + "\n");
  renameSync(tmp, file);
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

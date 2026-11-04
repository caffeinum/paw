/**
 * Is the agent `paw chat` was pointed at really there — and if not, what did the operator mean?
 *
 * The pre-shell paints before any mesh code loads. For a bare name with no local registration it used
 * to paint an ordinary prompt anyway, then sat as "live-only focus" on a name that never showed up
 * (operator, 2026-11-04: "if the agent doesn't exist the prompt is real bad"). So the first frame now
 * asks the FILES first (~1ms: the space's persona registry): known here → the normal prompt; not known
 * here → an explicit "◌ looking for @name on <space>…" state, settled by the live roster in chat.ts —
 * found (a peer hosted on another machine) → the normal prompt; not found → the chooser below.
 *
 * CORE-FREE by contract (the pre-shell imports it): node built-ins and leaf modules only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readCwd } from "./session.ts";

export const AGENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function pawHome(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

const spaceDirOf = (home: string, space: string): string => join(home, "spaces", space);

function readJsonObject(path: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${path} is corrupt (${(e as Error).message}); fix or delete it`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`paw: ${path} is not a JSON object; fix or delete it`);
  return v as Record<string, unknown>;
}

/**
 * The folder `name` is registered at in `space`, from the files alone: its persona's `cwd:` — or, in a
 * space whose legacy registry (folders.json / agents.json) has not been migrated yet, that registry.
 * Mirrors addressing.ts `folderForName` without writing anything (the pre-shell must not migrate).
 */
export function localAgentFolder(home: string, space: string, name: string): string | undefined {
  if (!AGENT_NAME_RE.test(name)) return undefined;
  const dir = spaceDirOf(home, space);
  const cwd = readCwd(join(dir, "personas", `${name}.md`));
  if (cwd) return cwd;
  if (existsSync(join(dir, "registry.v2"))) return undefined;
  const folders = join(dir, "folders.json");
  if (existsSync(folders)) {
    const hit = Object.entries(readJsonObject(folders)).find(([, n]) => n === name);
    if (hit) return hit[0];
  }
  const extras = join(dir, "agents.json");
  if (existsSync(extras)) {
    const f = readJsonObject(extras)[name];
    if (typeof f === "string") return f;
  }
  return undefined;
}

/** Flags of `paw chat` that take a value — their value is never the target. */
export const CHAT_VALUE_FLAGS = new Set(["--space", "--server", "--model", "--agent", "--provider", "--name", "--personality"]);

/** One pass over `paw chat`'s argv: the target as typed, the space, and which flags were given. */
export function scanChatArgs(argv: string[]): { space?: string; positional?: string; flags: Set<string> } {
  let space: string | undefined;
  let positional: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0 && CHAT_VALUE_FLAGS.has(a.slice(0, eq))) {
      // `--space=team2027` is the same flag as `--space team2027` (expandEqFlags runs after this).
      flags.add(a.slice(0, eq));
      if (a.slice(0, eq) === "--space") space = a.slice(eq + 1);
      continue;
    }
    if (a === "--space") space = argv[i + 1];
    if (CHAT_VALUE_FLAGS.has(a)) {
      flags.add(a);
      i++;
      continue;
    }
    if (a.startsWith("-")) flags.add(a);
    else if (positional === undefined) positional = a;
  }
  return { ...(space !== undefined ? { space } : {}), ...(positional !== undefined ? { positional } : {}), flags };
}

/**
 * What the first frame may promise about the target, from argv and the files:
 *  - `known`: a name registered in this space (its folder exists) — the normal prompt;
 *  - `unknown`: a valid name nobody registered here — maybe a peer hosted on another machine, maybe a
 *    typo; only the live roster can say, so the frame shows it is looking;
 *  - `other`: anything chat.ts resolves on its own (a folder, `.`, a URL, a channel, --all, and every
 *    creating flag: --fresh/--name/--agent) — painted as before.
 */
export type TargetCheck = { kind: "known"; name: string } | { kind: "unknown"; name: string } | { kind: "other" };

export function checkChatTarget(argv: string[], cwd: string, home: string, space: string): TargetCheck {
  const { positional, flags } = scanChatArgs(argv);
  if (["--all", "--fresh", "--name", "--agent"].some((f) => flags.has(f))) return { kind: "other" };
  if (positional === undefined || positional === "." || positional.startsWith("#")) return { kind: "other" };
  const named = positional.startsWith("@");
  const name = named ? positional.slice(1) : positional;
  if (!AGENT_NAME_RE.test(name)) return { kind: "other" };
  if (!named) {
    // A bare word that is a folder here is a folder target (chat.ts: folder first, then name).
    try {
      if (statSync(resolve(cwd, name)).isDirectory()) return { kind: "other" };
    } catch {} // not a path → a name
  }
  const folder = localAgentFolder(home, space, name);
  return folder && existsSync(folder) ? { kind: "known", name } : { kind: "unknown", name };
}

/** Another space where `name` exists: a persona registered there, or a peer of that name on its mesh's
 *  ledger (peers.json — how a remote space's agents hosted elsewhere are known without dialling it). */
export type SpaceHit = { space: string; how: "registered" | "seen" };

export function otherSpaceHits(home: string, name: string, except: string): SpaceHit[] {
  if (!AGENT_NAME_RE.test(name)) return [];
  const root = join(home, "spaces");
  if (!existsSync(root)) return [];
  const hits: SpaceHit[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === except || !AGENT_NAME_RE.test(d.name)) continue;
    const dir = join(root, d.name);
    if (existsSync(join(dir, "personas", `${name}.md`))) hits.push({ space: d.name, how: "registered" });
    else if (ledgerHasName(join(dir, "peers.json"), name)) hits.push({ space: d.name, how: "seen" });
  }
  return hits.sort((a, b) => (a.how === b.how ? a.space.localeCompare(b.space) : a.how === "registered" ? -1 : 1));
}

function ledgerHasName(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  const ledger = readJsonObject(path);
  return Object.values(ledger).some((e) => typeof e === "object" && e !== null && (e as { name?: unknown }).name === name);
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Optimal-string-alignment distance (a transposition is one edit: `qeueu` → `queue`). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Does `name` start with something a typo or two away from `key`? */
const nearPrefix = (key: string, name: string, budget: number): boolean =>
  [key.length - 1, key.length, key.length + 1].some((l) => l >= 3 && l <= name.length && editDistance(key, name.slice(0, l)) <= budget);

/**
 * Registered or live names that look like what was typed, best first: the same name modulo case and
 * punctuation (`getslash.co` → `getslash-co`), then a name that starts with it, then one containing it
 * (or contained in it), then a near-miss by a typo or two (`harbr` → `harbor`), then a name whose START
 * is such a near-miss (`harbr` → `harbor-ea`). A token under 3
 * characters suggests nothing — it would match everything.
 */
export function suggestNames(typed: string, candidates: string[], max = 5): string[] {
  const key = norm(typed.replace(/^@/, ""));
  if (key.length < 3) return [];
  const budget = key.length <= 4 ? 1 : 2;
  const seen = new Set<string>();
  const ranked: Array<{ name: string; rank: number; dist: number }> = [];
  for (const name of candidates) {
    const n = norm(name);
    if (!n || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const dist = editDistance(key, n);
    const rank = n === key ? 0 : n.startsWith(key) ? 1 : n.includes(key) || (n.length >= 3 && key.includes(n)) ? 2 : dist <= budget ? 3 : nearPrefix(key, n, budget) ? 4 : -1;
    if (rank >= 0) ranked.push({ name, rank, dist });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((r) => r.name);
}

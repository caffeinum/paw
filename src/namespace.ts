/**
 * THE NAMESPACE OWNER: one answer to "which agent is this, in which space, and does it run HERE?".
 *
 * paw keeps an agent's identity in several stores (personas per space, the `teleported:` marker, a remote
 * space's peer ledger, claude's own transcripts) and every verb used to re-derive the answer from its own
 * subset. The 2026-11-11 tracepaper incident is what that costs: `PAW_SPACE=team2027` (a shell rc) routed
 * `paw adopt .` into team2027, whose TELEPORTED persona still named the folder; adopt re-pinned that
 * frozen copy to an 18-day-old local session and printed "already live" for the mini's seat.
 *
 * This module reads the files (read-only — never `personaFilePath`, which mkdirs) and returns:
 *  - an {@link Identity} per match, with a {@link Where} state derived from files alone (sync, ~1ms);
 *  - a {@link Resolution} over EVERY local space, split into the chosen space and the others;
 *  - {@link assertMutableHere}: the guard every writing verb calls BEFORE it writes anything;
 *  - one-line renderings so every verb says the same thing about the same state.
 * Liveness (ps / roster) stays with callers that already hold it. Core-free: node built-ins + leaf modules.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { personaValue, readCwd, readResumeId } from "./session.ts";
import { ORIGIN, readTeleported } from "./teleport-plan.ts";
import { readRemoteMesh } from "./remote-mesh.ts";
import { machineName } from "./host-stamp.ts";
import { spaceProvenance, type SpaceChoice } from "./space.ts";

const NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Where an identity lives, from the files alone. */
export type Where =
  | { kind: "local" } // persona here, no marker, folder exists: this machine's agent
  | { kind: "teleported"; to: string; at?: string; cwd?: string } // persona here carries `teleported:` — a frozen copy
  | { kind: "folder-gone"; folder: string } // persona here, its folder is gone
  | { kind: "seen" }; // remote space, no persona here, the name is on the mesh's peer ledger: another machine's

export type Identity = { space: string; name: string; folder?: string; extra: boolean; pin?: string; where: Where };

/** What one persona file says (the pure input). */
export type PersonaFact = {
  name: string;
  cwd?: string;
  extra: boolean;
  pin?: string;
  teleported?: { to: string; at?: string; cwd?: string };
  folderExists: boolean;
};
export type SpaceFacts = { space: string; remote: boolean; personas: PersonaFact[]; ledger: string[] };

export type Target = { name: string } | { folder: string };
export type Resolution = { chosen: SpaceChoice; inChosen: Identity[]; elsewhere: Identity[] };

export const pawHomeRoot = (): string => process.env.PAW_HOME?.trim() || join(homedir(), ".paw");

/** Pure: a persona's state. */
export function classify(p: PersonaFact): Where {
  if (p.teleported) return { kind: "teleported", to: p.teleported.to, ...(p.teleported.at ? { at: p.teleported.at } : {}), ...(p.teleported.cwd ? { cwd: p.teleported.cwd } : {}) };
  if (p.cwd && !p.folderExists) return { kind: "folder-gone", folder: p.cwd };
  return { kind: "local" };
}

/** Pure: a persona counts as an identity when it names a folder or carries the teleport marker
 *  (the origin copy teleport leaves has no `cwd:`). An orphan persona is nobody. */
const counts = (p: PersonaFact): boolean => p.cwd !== undefined || p.teleported !== undefined;

const identity = (space: string, p: PersonaFact): Identity => ({
  space,
  name: p.name,
  ...(p.cwd ? { folder: p.cwd } : {}),
  extra: p.extra,
  ...(p.pin ? { pin: p.pin } : {}),
  where: classify(p),
});

/** Default first, then this machine's before a frozen copy, then by name — the order every folder lookup uses. */
const rank = (id: Identity): number => (id.extra ? 2 : 0) + (id.where.kind === "teleported" || id.where.kind === "seen" ? 1 : 0);

/** Pure: every identity `target` names, in every space; the chosen space's split from the rest. */
export function resolvePure(target: Target, chosen: SpaceChoice, facts: SpaceFacts[]): Resolution {
  const all: Identity[] = [];
  for (const s of facts) {
    if ("name" in target) {
      const p = s.personas.find((x) => x.name === target.name);
      if (p && counts(p)) all.push(identity(s.space, p));
      else if (!p && s.remote && s.ledger.includes(target.name)) all.push({ space: s.space, name: target.name, extra: false, where: { kind: "seen" } });
    } else {
      for (const p of s.personas) if (p.cwd === target.folder) all.push(identity(s.space, p));
    }
  }
  all.sort((a, b) => rank(a) - rank(b) || a.space.localeCompare(b.space) || a.name.localeCompare(b.name));
  return { chosen, inChosen: all.filter((i) => i.space === chosen.space), elsewhere: all.filter((i) => i.space !== chosen.space) };
}

/** Read one persona's facts, read-only. */
export function readPersonaFact(file: string, name: string): PersonaFact | undefined {
  if (!existsSync(file)) return undefined;
  const cwd = readCwd(file);
  const pin = readResumeId(file);
  const teleported = readTeleported(file);
  return {
    name,
    ...(cwd ? { cwd } : {}),
    extra: personaValue(file, "paw-extra")?.replace(/^["']|["']$/g, "") === "true",
    ...(pin ? { pin } : {}),
    ...(teleported ? { teleported: { to: teleported.to, ...(teleported.at ? { at: teleported.at } : {}), ...(teleported.cwd ? { cwd: teleported.cwd } : {}) } } : {}),
    folderExists: cwd ? existsSync(cwd) : false,
  };
}

/** The names a remote space's peer ledger (peers.json) has ever seen. Corrupt → loud. */
export function readLedgerNames(spaceDirPath: string): string[] {
  const path = join(spaceDirPath, "peers.json");
  if (!existsSync(path)) return [];
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${path} is corrupt (${(e as Error).message}); fix or delete it`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`paw: ${path} is not a JSON object; fix or delete it`);
  return [...new Set(Object.values(v as Record<string, unknown>).flatMap((e) => (typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string" ? [(e as { name: string }).name] : [])))];
}

/** Every local space dir under `$PAW_HOME/spaces`, read-only. */
export function localSpaces(home: string = pawHomeRoot()): string[] {
  const root = join(home, "spaces");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

/** The files a lookup of `target` needs, from every local space — read-only, only what it must read. */
export function loadFacts(target: Target, home: string = pawHomeRoot()): SpaceFacts[] {
  return localSpaces(home).map((space) => {
    const dir = join(home, "spaces", space);
    const personasDir = join(dir, "personas");
    const remote = readRemoteMesh(space) !== undefined;
    let personas: PersonaFact[] = [];
    if ("name" in target) {
      const p = NAME_RE.test(target.name) ? readPersonaFact(join(personasDir, `${target.name}.md`), target.name) : undefined;
      personas = p ? [p] : [];
    } else if (existsSync(personasDir)) {
      personas = readdirSync(personasDir)
        .filter((f) => f.endsWith(".md"))
        .flatMap((f) => readPersonaFact(join(personasDir, f), f.slice(0, -".md".length)) ?? []);
    }
    return { space, remote, personas, ledger: "name" in target && remote ? readLedgerNames(dir) : [] };
  });
}

/** {@link resolvePure} over this machine's files. */
export function resolve(target: Target, chosen: SpaceChoice, home: string = pawHomeRoot()): Resolution {
  return resolvePure(target, chosen, loadFacts(target, home));
}

/** One identity's facts by (space, name), or undefined when there is no such persona. */
export function identityIn(space: string, name: string, home: string = pawHomeRoot()): Identity | undefined {
  if (!NAME_RE.test(name)) return undefined;
  const p = readPersonaFact(join(home, "spaces", space, "personas", `${name}.md`), name);
  return p && counts(p) ? identity(space, p) : undefined;
}

/** Is this identity this machine's to act on? (`local`, or `folder-gone` — still this machine's record.) */
export const ownedHere = (id: Identity): boolean => id.where.kind === "local" || id.where.kind === "folder-gone";

const day = (iso?: string): string => (iso ? iso.slice(0, 10) : "");

/** `runs on ssh:mini (teleported 2026-10-23)` — what an identity's state means, in a few words. */
export function stateWords(id: Identity): string {
  switch (id.where.kind) {
    case "teleported": {
      const to = id.where.to === ORIGIN ? "the machine it came from" : id.where.to;
      return `runs on ${to}${id.where.at ? ` (teleported ${day(id.where.at)})` : " (teleported)"}`;
    }
    case "seen":
      return `another machine's agent on the ${id.space} mesh`;
    case "folder-gone":
      return `its folder ${id.where.folder} is gone`;
    case "local":
      return "registered on this machine";
  }
}

/** The line a "not in this space" refusal ends with: where it IS, in which state, and the one command
 *  that makes sense for that state. Never suggests acting on a record that isn't this machine's. */
export function elsewhereClause(name: string, chosen: SpaceChoice, elsewhere: Identity[], verb: string): string {
  if (!elsewhere.length) return "";
  const prov = spaceProvenance(chosen.how);
  const from = chosen.how === "env" ? ` (${chosen.space} is ${prov})` : "";
  const parts = elsewhere.map((id) => `"${id.space}", ${stateWords(id)}`);
  const first = elsewhere[0]!;
  const what = `${from} — it's in ${parts.join("; ")}`;
  if (!ownedHere(first)) return `${what} — not this machine's to change; \`paw chat @${name}#${first.space}\` messages it`;
  return `${what}: \`paw ${verb} ${name}#${first.space}\``;
}

/** The refusal for acting on `id` from this machine, or undefined when it may. One line, before any write. */
export function mutableHereRefusal(id: Identity, verb: string): string | undefined {
  const at = `"${id.name}" (space ${id.space})`;
  if (id.where.kind === "teleported") {
    const back = id.where.to === ORIGIN ? "" : `, or bring it back: \`paw teleport ${id.name}#${id.space} --back\``;
    return `paw: ${at} ${stateWords(id)} — this machine holds only its frozen copy; ${verb} it there${back}`;
  }
  if (id.where.kind === "seen") return `paw: ${at} is ${stateWords(id)} — only the machine that runs it may ${verb} it`;
  return undefined;
}

/** THE guard every writing verb calls before it writes: a teleported or another machine's identity is
 *  refused, naming where it runs. `teleport` itself never calls it (it acts on its own marker). */
export function assertMutableHere(id: Identity, verb: string): void {
  const why = mutableHereRefusal(id, verb);
  if (why) throw new Error(why);
}

/** {@link assertMutableHere} by (space, name); a name with no persona here passes (callers handle "none"). */
export function assertMutableByName(space: string, name: string, verb: string, home: string = pawHomeRoot()): void {
  const id = identityIn(space, name, home);
  if (id) assertMutableHere(id, verb);
}

/** A remote space's name another machine holds: no persona here, but the mesh's ledger has seen it. A
 *  CREATE of that name here would put two agents of one name on one mesh. */
export function heldOnMesh(space: string, name: string, home: string = pawHomeRoot()): boolean {
  if (!NAME_RE.test(name) || readRemoteMesh(space) === undefined) return false;
  if (existsSync(join(home, "spaces", space, "personas", `${name}.md`))) return false;
  return readLedgerNames(join(home, "spaces", space)).includes(name);
}

/** A name to suggest for a NEW agent of this folder on this machine when `taken` belongs to another
 *  machine: on a remote space the mesh is shared, so the machine's name qualifies it. Only suggested. */
export function localNameFor(space: string, taken: string): string {
  return `${taken}-${machineName(space)}`;
}

/** `18d ago` / `3h ago` / `5m ago` / `just now`. */
export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** claude stores a folder's sessions under `~/.claude/projects/<encoded-cwd>/`, where the cwd is encoded
 *  by replacing every non-`[A-Za-z0-9_]` char with `-` (underscores kept). */
export function claudeProjectDir(canonical: string): string {
  return join(homedir(), ".claude", "projects", canonical.replace(/[^A-Za-z0-9_]/g, "-"));
}

export type FolderSession = { id: string; mtimeMs: number };

/** The folder's claude sessions, newest first (read-only). */
export function folderSessions(canonical: string): FolderSession[] {
  const dir = claudeProjectDir(canonical);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.slice(0, -".jsonl".length), mtimeMs: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Pure: the one line `paw chat .` adds when the folder's agent is not this machine's (teleported / another
 * machine's) — the session the operator sees in this folder is NOT that agent. Undefined when a local
 * agent owns the folder, or when nothing here needs saying.
 */
export function folderNotHereLine(o: { ids: Identity[]; newest?: FolderSession; now?: number; suggest: string }): string | undefined {
  if (!o.ids.length || o.ids.some(ownedHere)) return undefined;
  const pinnedHere = o.newest && o.ids.some((i) => i.pin === o.newest!.id && i.where.kind !== "teleported");
  const session = o.newest && !pinnedHere ? ` — session ${o.newest.id.slice(0, 8)} here (${ago(o.newest.mtimeMs, o.now)}) isn't running as an agent` : "";
  return `this folder has no agent on this machine${session} · \`paw adopt . --name ${o.suggest}\` makes one`;
}

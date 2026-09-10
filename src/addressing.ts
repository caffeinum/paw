/**
 * Folder → agent addressing for paw. The cotal mesh carries an agent's NAME (in presence) but not
 * its working directory — neither presence/roster nor manager `ps` expose cwd. So paw owns the
 * folder↔name mapping itself: a per-space registry under ~/.paw that turns a canonical folder path
 * into a stable, collision-safe agent name. Spawning + presence still go through cotal (the manager
 * control plane and the endpoint roster); this module only adds the folder-addressing layer.
 *
 * Built on cotal, never forking it: spawns invoke the manager's own `spawn` command on its v0.4
 * service endpoint (`src/control.ts`) exactly as cotal's own `spawn` does, and the human peer is a
 * plain CotalEndpoint.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  CotalEndpoint,
  DEV_OWNER,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
} from "@cotal-ai/core";
// auth-path helpers moved to @cotal-ai/workspace in cotal v0.8 (#120).
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { pawCotalRoot } from "./cotal-root.js";
import { confineAndTrustCwd } from "./cwd.js";
import { readForeground } from "./foreground.js";
import { withFileLock, withFileLockAsync } from "./lock.js";
import { foreignWriters } from "./named.js";
import { readResumeId, readAgentType, readShareTools, transcriptMtime } from "./session.js";
import { defaultTmuxEnv, readRuntimeMarker } from "./lifecycle.js";
import { nudgeTmuxConfirm } from "./native-attach.js";
import { HOST_RE } from "./url.js";
import type { ManagerControl, ManagerReply } from "./control.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How an agent's folder was addressed — stored in persona frontmatter (absent ⇒ "folder"). Defined
 *  here (not in address.ts) so ensurePersonaFile can consume it without an import cycle; re-exported
 *  from address.ts as the public surface. */
export type Kind = "folder" | "worktree" | "repo" | "pr" | "web";

/** paw's per-space state dir under ~/.paw (mirrors lifecycle.ts so chat/open and the daemon
 *  lifecycle agree on where paw keeps its bookkeeping). PAW_HOME overrides the root. */
function spaceDir(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const dir = join(root, "spaces", space);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The per-(space,name) spawn lock path. Exported so `paw claude` (a foreground spawn) serializes on the
 *  SAME lock `ensureAgentSpawned` uses — a concurrent `paw dm <folder>` and `paw claude` for one folder
 *  can't both create an agent under the same mesh name. */
export function spawnLockPath(space: string, name: string): string {
  return join(spaceDir(space), `spawn.${name}.lock`);
}

/** Canonicalise a user-supplied target into an absolute, symlink-resolved directory path.
 *  Throws (fail loud) if it doesn't exist or isn't a directory — paw chat addresses folders. */
export function canonicalDir(target: string): string {
  // Reject a blank target up front: resolve("") returns the cwd, which would silently address the
  // current directory instead of failing loud on a missing/empty argument (e.g. `paw chat "$DIR"`
  // with $DIR unset). The no-arg default of "." is applied by the caller, not via an empty string.
  if (target.trim() === "") {
    throw new Error(`paw: empty target — pass a folder path or an agent name`);
  }
  const real = realpathSync(resolve(target)); // throws ENOENT for a missing path
  if (!statSync(real).isDirectory()) {
    throw new Error(`paw: "${target}" is not a directory — paw chat addresses a folder`);
  }
  return real;
}

/** A folder's basename reduced to the manager's safe name charset (`[A-Za-z0-9_-]`). Anything else
 *  collapses to a single dash; leading/trailing dashes are trimmed. Empty (e.g. filesystem root)
 *  falls back to "root" so the name is always a valid bare token. */
export function sanitizeAgentName(canonical: string): string {
  const cleaned = basename(canonical)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "root";
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 6);
}

function registryFile(space: string): string {
  return join(spaceDir(space), "folders.json");
}

function readFolderMap(space: string): Record<string, string> {
  const file = registryFile(space);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: folder registry ${file} is corrupt (${(e as Error).message}); fix or delete it`);
  }
  // typeof [] === "object", so an array would slip past a bare object check and then be silently
  // re-stringified by writeFolderMap (mappings never persist → folders share agents). Reject it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`paw: folder registry ${file} is not a JSON object; fix or delete it`);
  }
  return parsed as Record<string, string>;
}

function writeFolderMap(space: string, map: Record<string, string>): void {
  const file = registryFile(space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, file);
}

/**
 * The EXTRA-instance side-table: `~/.paw/spaces/<space>/agents.json`, `Record<extraName, folder>`.
 * `folders.json` still maps folder → its ONE default agent; agents.json holds only 2nd+ agents at a
 * folder (minted via `paw chat/dm/open --name <n>`). An agent lives in EXACTLY one file — default in
 * folders.json, extra in agents.json, never both — so the two can't desync. Absent file ⇒ {} (a
 * plain 1:1 install has no agents.json and behaves byte-identically to before the side-table).
 */
function agentIndexFile(space: string): string {
  return join(spaceDir(space), "agents.json");
}

/** Read the extra-instance side-table (fail loud on corrupt / non-object JSON, exactly like
 *  readFolderMap). Exported so `paw rm`/`paw rename` can tell an EXTRA from a DEFAULT before deciding
 *  which registry mutator to call. */
export function readAgentIndex(space: string): Record<string, string> {
  const file = agentIndexFile(space);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: agent index ${file} is corrupt (${(e as Error).message}); fix or delete it`);
  }
  // typeof [] === "object": an array would slip a bare object check and get silently re-stringified,
  // dropping the name→folder map. Reject it, same as readFolderMap.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`paw: agent index ${file} is not a JSON object; fix or delete it`);
  }
  return parsed as Record<string, string>;
}

function writeAgentIndex(space: string, map: Record<string, string>): void {
  const file = agentIndexFile(space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, file);
}

/**
 * Resolve a canonical folder to its stable paw agent name, persisting the mapping. The common case
 * is the folder's basename ("web"); on a collision with a *different* folder already mapped to that
 * name, the name is qualified with a short path hash ("web-1a2b3c") so two folders never silently
 * share one agent. Deterministic and idempotent: the same folder always resolves to the same name.
 */
/** Read-only: the registered agent name for a canonical folder, or undefined if not yet mapped. Used
 *  by list-style commands (e.g. `paw sessions`) that must not register a folder just to inspect it. */
export function lookupFolderName(space: string, canonical: string): string | undefined {
  return readFolderMap(space)[canonical];
}

/** Read-only: every registered (folder, name) pair for the space. Backs list-style views like
 *  `paw status` that report on all known agents, live or not. */
export function listAgents(space: string): Array<{ folder: string; name: string }> {
  return [
    ...Object.entries(readFolderMap(space)).map(([folder, name]) => ({ folder, name })),
    // Extras (agents.json is name→folder, the inverse of folders.json) so multi-instance agents show
    // up in `paw status` and every listing view alongside the folder's default.
    ...Object.entries(readAgentIndex(space)).map(([name, folder]) => ({ folder, name })),
  ];
}

export function folderToName(space: string, canonical: string): string {
  // Lock the whole read-modify-write: without it two concurrent paw processes can each read an empty
  // map, both pick the same name, and clobber each other's write — mapping two folders to one agent
  // (and losing entries). Re-read INSIDE the lock so each writer sees the prior one's commit.
  return withFileLock(`${registryFile(space)}.lock`, () => {
    const map = readFolderMap(space);
    const existing = map[canonical];
    if (existing) return existing;

    const base = sanitizeAgentName(canonical);
    // Include agents.json keys so a minted DEFAULT can't collide with an existing EXTRA instance
    // (readAgentIndex reads a DIFFERENT file, so it's safe inside the folders.json lock).
    const taken = new Set([...Object.values(map), ...Object.keys(readAgentIndex(space))]);
    let name = base;
    if (taken.has(name)) {
      name = `${base}-${shortHash(canonical)}`;
      if (taken.has(name)) {
        throw new Error(`paw: could not derive a unique agent name for ${canonical} ("${name}" already in use)`);
      }
    }
    map[canonical] = name;
    writeFolderMap(space, map);
    return name;
  });
}

/** Force this folder's agent name to `desired` (cleaned to the safe charset), creating OR renaming the
 *  mapping; qualifies with a path hash if another folder already holds that name. Returns
 *  `{ name, previous }` so the caller can retire an agent that was running under the old name. Used by
 *  adopt to name an agent after its (possibly just-renamed) session. */
export function setFolderName(space: string, canonical: string, desired: string): { name: string; previous?: string } {
  return withFileLock(`${registryFile(space)}.lock`, () => {
    const map = readFolderMap(space);
    const previous = map[canonical];
    const cleaned = desired.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || sanitizeAgentName(canonical);
    if (previous === cleaned) return { name: cleaned, previous };
    // Exclude this folder's own current default, but include every OTHER default and every EXTRA
    // (agents.json keys) so a forced default name can't collide with an extra instance.
    const taken = new Set([
      ...Object.entries(map).filter(([f]) => f !== canonical).map(([, n]) => n),
      ...Object.keys(readAgentIndex(space)),
    ]);
    let name = cleaned;
    if (taken.has(name)) {
      name = `${cleaned}-${shortHash(canonical)}`;
      if (taken.has(name)) throw new Error(`paw: could not assign name "${cleaned}" to ${canonical} ("${name}" already in use)`);
    }
    map[canonical] = name;
    writeFolderMap(space, map);
    return { name, previous };
  });
}

/** Remove the (folder → name) mapping for `canonical`, returning the removed agent name (or undefined
 *  if the folder wasn't registered). Locked RMW, mirroring folderToName/setFolderName so a concurrent
 *  registration can't clobber the delete. Used by `paw rm` to forget an agent. */
export function removeFolder(space: string, canonical: string): string | undefined {
  return withFileLock(`${registryFile(space)}.lock`, () => {
    const map = readFolderMap(space);
    const name = map[canonical];
    if (name === undefined) return undefined;
    delete map[canonical];
    writeFolderMap(space, map);
    return name;
  });
}

/**
 * Register an EXTRA agent instance `name` at `canonical` (a 2nd+ agent in a folder, opt-in via
 * `--name`). Writes agents.json, NOT folders.json — the folder's default is left untouched. Under the
 * SAME lock as the folder mutators so folders.json + agents.json writes serialize together (the global
 * name-uniqueness invariant spans both files). Idempotent (re-registering the same name→folder is a
 * no-op that returns the cleaned name). Fails loud if the cleaned name is empty or already taken by
 * anything else — a DIFFERENT folder's default, another extra, or (edge) this folder's OWN default —
 * naming the holder so the operator can pick a different `--name`. Never fabricates a fallback name.
 */
export function registerInstance(space: string, canonical: string, name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new Error(`paw: --name "${name}" is empty after cleaning to the safe charset; pick a name with letters/digits`);
  }
  return withFileLock(`${registryFile(space)}.lock`, () => {
    const extras = readAgentIndex(space);
    if (extras[cleaned] === canonical) return cleaned; // idempotent re-register
    // Global uniqueness across folders.json values ∪ agents.json keys.
    const defaultHolder = Object.entries(readFolderMap(space)).find(([, n]) => n === cleaned)?.[0];
    if (defaultHolder !== undefined) {
      const self = defaultHolder === canonical ? " (this folder's own default agent)" : "";
      throw new Error(
        `paw: agent name "${cleaned}" is already the default agent for ${defaultHolder}${self}; pick a different --name`,
      );
    }
    const extraHolder = extras[cleaned];
    if (extraHolder !== undefined) {
      throw new Error(`paw: agent name "${cleaned}" is already an extra agent for ${extraHolder}; pick a different --name`);
    }
    extras[cleaned] = canonical;
    writeAgentIndex(space, extras);
    return cleaned;
  });
}

/** Every agent NAME registered for `canonical`: the folder's default (if mapped) plus every extra
 *  instance in agents.json whose value is that folder. Named `agentNamesForFolder` (NOT `namesForFolder`,
 *  which named.ts already uses for SESSIONS) to avoid a collision. */
export function agentNamesForFolder(space: string, canonical: string): string[] {
  const names: string[] = [];
  const def = readFolderMap(space)[canonical];
  if (def !== undefined) names.push(def);
  for (const [name, folder] of Object.entries(readAgentIndex(space))) if (folder === canonical) names.push(name);
  return names;
}

/**
 * The agent `paw chat .` / `paw attach .` / `paw dm .` talks to when `--name` is absent.
 *
 * Default (folders.json) wins — extras stay opt-in via `--name`. If there is NO default, the sole
 * extra in agents.json IS the folder's agent: `cd ~/paw-opencode && paw chat .` must reach
 * `opencode1`, not mint a sibling claude default. Several extras and no default → fail loud
 * (never invent which extra, never spawn a claude beside them). An unregistered folder still
 * mints a default via {@link folderToName}.
 */
export function resolveFolderAgent(space: string, canonical: string): string {
  const def = lookupFolderName(space, canonical);
  if (def) return def;
  const extras = agentNamesForFolder(space, canonical); // no default → extras only
  if (extras.length === 1) return extras[0];
  if (extras.length > 1) {
    throw new Error(
      `paw: ${canonical} has extra agents ${extras.map((n) => `"${n}"`).join(", ")} and no default — ` +
        `pick one with --name (e.g. \`paw chat . --name ${extras[0]}\`)`,
    );
  }
  return folderToName(space, canonical);
}

/** Remove an EXTRA agent from the side-table, returning its folder (or undefined if `name` wasn't an
 *  extra — a folder's DEFAULT is removed by removeFolder instead). Locked RMW, mirroring removeFolder
 *  so a concurrent registerInstance can't clobber the delete. Used by `paw rm` of an extra. */
export function removeAgentName(space: string, name: string): string | undefined {
  return withFileLock(`${registryFile(space)}.lock`, () => {
    const extras = readAgentIndex(space);
    const folder = extras[name];
    if (folder === undefined) return undefined;
    delete extras[name];
    writeAgentIndex(space, extras);
    return folder;
  });
}

/** Reverse lookup: the folder currently mapped to agent `name`, or undefined. Lets chat resurrect a
 *  known-but-offline agent by `@name` (it needs the cwd to respawn, which only the registry holds). */
export function folderForName(space: string, name: string): string | undefined {
  for (const [folder, n] of Object.entries(readFolderMap(space))) if (n === name) return folder;
  // Fall back to the extra-instance side-table so an EXTRA agent (created via --name) also resolves
  // to its folder — chat/dm/open/rm/rename all reach extras through this one reverse lookup.
  return readAgentIndex(space)[name];
}

/**
 * Fail loud when a BARE positional is genuinely ambiguous: it's BOTH a registered agent NAME and the
 * basename of a DIFFERENT existing folder in the cwd. Without this, the folder-then-name (or
 * name-then-folder) resolution in chat/dm/open/log/rm/rename/adopt/sessions silently picks one — the
 * `paw log .`/`paw log <name>` wrong-session class of bug. Targets that already carry an effective sigil
 * are unambiguous and exempt: an explicit path (`.`, `./x`, `/x`, `~…`), a `github:` handle, or a
 * `<repo>@<branch>` worktree. No-op when only one interpretation is valid (the common case).
 */
export function assertUnambiguousTarget(space: string, target: string | undefined): void {
  if (target === undefined || target === ".") return;
  if (
    target.startsWith("./") ||
    target.startsWith("/") ||
    target.startsWith("~") ||
    target.startsWith("github:") ||
    target.startsWith("gh:") ||
    target.startsWith("web:") ||
    /^https?:\/\//.test(target) ||
    target.includes("@")
  ) {
    return; // an explicit path / URL / scheme handle is never ambiguous
  }
  // A bare HOST (has a dot: react.dev) is website-shaped. It's ambiguous only if it's ALSO a local
  // folder here or a registered agent name — then fail loud toward the explicit forms; otherwise it's a
  // clean website route. (This catches a local ./react.dev folder that the name clause below wouldn't,
  // since that clause only fires for a REGISTERED name.)
  if (HOST_RE.test(target)) {
    const asFolder = resolve(process.cwd(), target);
    let isFolder = false;
    try {
      isFolder = statSync(asFolder).isDirectory();
    } catch {
      /* not a path */
    }
    if (isFolder || folderForName(space, target)) {
      throw new Error(
        `paw: "${target}" is ambiguous — it looks like a website host, but is also a local folder / ` +
          `registered agent here. Use \`web:${target}\` for the website, or \`./${target}\` for the folder.`,
      );
    }
    return; // host-shaped, neither a folder nor a known name → clean website route
  }
  const namedFolder = folderForName(space, target); // a registered agent NAME → its folder
  if (!namedFolder) return; // not a known name → only one interpretation
  const asFolder = resolve(process.cwd(), target);
  if (asFolder === namedFolder) return; // the folder here IS that agent's folder — same thing, no clash
  let asFolderStat;
  try {
    asFolderStat = statSync(asFolder);
  } catch {
    return; // doesn't exist → not also a folder → unambiguous
  }
  if (!asFolderStat.isDirectory()) return; // exists but not a dir → unambiguous
  throw new Error(
    `paw: "${target}" is ambiguous — it's both a registered agent (its folder is ${namedFolder}) and a ` +
      `folder here (${asFolder}). Use \`./${target}\` to mean the folder; the agent "${target}" is ` +
      `addressable by name from any other directory.`,
  );
}

/**
 * Ensure an ephemeral persona file exists for `name` and return its absolute path. cotal's manager
 * now REQUIRES a persona file to spawn (a bare name → `.cotal/agents/<name>.md` that must exist —
 * "no silent default-ACL fallback"), so paw, which addresses by folder, auto-generates a minimal one
 * under ~/.paw and spawns via `--config <abs>`. The persona's `name:` IS the agent's mesh identity,
 * so it's set to paw's folder-derived name (keeping reuse-by-name + folder addressing intact).
 * Write-if-absent so a hand-customized persona is never clobbered.
 */
export function personaFilePath(space: string, name: string): string {
  const dir = join(spaceDir(space), "personas");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.md`);
}

/**
 * The channel grants every paw agent is minted with.
 *
 * cotal's defaults are deliberately tight: an omitted `allowSubscribe` means "read exactly what you
 * subscribe to" (which itself defaults to `[general]`), and an omitted `allowPublish` is a hard DENY
 * — publishing is the dangerous capability, so it must be declared. paw never declared either, so
 * EVERY paw agent was locked to reading #general and could post to no channel at all: a `cotal_join`
 * of any other channel failed with "not within this agent's read ACL", which is exactly what an agent
 * reported when asked to join #team2027 (2026-08-06).
 *
 * `>` (one-or-more trailing tokens — a bare `>` matches every channel) is the honest grant for paw
 * specifically, because a channel ACL is not a boundary here: paw agents already run with
 * `bypassPermissions` and full machine access, and can read any channel's history through the `paw`
 * CLI regardless of what their mesh cred allows. A narrower list is also not knowable — channels are
 * created at runtime, so paw would have to predict names that don't exist yet.
 *
 * Quoting is load-bearing: the frontmatter is parsed as real YAML, where a bare `>` opens a folded
 * block scalar. `[">"]` is a flow sequence of one string; `[>]` is a parse error.
 *
 * `subscribe: [general]` is the ACTIVE read set, stated explicitly since cotal 0.33: an omitted
 * `subscribe` used to mean `[general]` and now means NO channel (and `saveAgentFile` refuses a
 * persona without one). #general is where `paw chat`'s plain lines and the fleet's broadcasts land,
 * so an agent on no channel would silently stop hearing the operator. Still ONLY general — the ACL
 * says what an agent MAY read; joining another channel stays its own runtime act (`cotal_join`).
 * That split is what makes an invite meaningful rather than automatic.
 */
const GRANT_LINES = ['subscribe: [general]', 'allowSubscribe: [">"]', 'allowPublish: [">"]'] as const;

/**
 * Add paw's channel grants to an existing persona's frontmatter, or undefined when there is nothing
 * to do. Write-if-absent per key: a persona that already declares a scope keeps it verbatim, so an
 * operator who deliberately narrowed one agent is never widened by a later spawn.
 *
 * Returns undefined (rather than throwing) for a file with no frontmatter block: that persona is
 * already unloadable by cotal, and failing here would turn a missing-grant upgrade into a spawn
 * failure with an unrelated error.
 */
export function withChannelGrants(raw: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return undefined;
  const frontmatter = m[1];
  const missing = GRANT_LINES.filter((line) => {
    const key = line.slice(0, line.indexOf(":"));
    return !new RegExp(`^\\s*${key}\\s*:`, "m").test(frontmatter);
  });
  if (missing.length === 0) return undefined;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return raw.replace(
    /^(---\r?\n[\s\S]*?\r?\n)(---)/,
    (_all, head: string, close: string) => `${head}${missing.join(eol)}${eol}${close}`,
  );
}

export function ensurePersonaFile(space: string, name: string, opts?: { brief?: string; kind?: Kind }): string {
  const file = personaFilePath(space, name);
  if (existsSync(file)) {
    // Self-heal a persona minted before paw granted channel scope (see GRANT_LINES). Every spawn
    // passes through here, so the fleet upgrades as its agents restart rather than needing a
    // migration pass — and a persona that already declares its scope is left untouched.
    const upgraded = withChannelGrants(readFileSync(file, "utf8"));
    if (upgraded !== undefined) writeFileSync(file, upgraded);
  }
  if (!existsSync(file)) {
    // Mint a stable `resume:` id at birth so the agent is DURABLE from its first boot: the connector
    // creates the session at this id (--session-id), then resumes it (--resume) on every restart. A
    // pinless persona makes claude cold-start a fresh, amnesiac session each launch — the agent silently
    // loses all history on any mesh bounce / reboot (the paw-reset bug of 2026-06-26). `adopt` overwrites
    // this pin with a real past session id; a hand-customized persona is never clobbered (write-if-absent).
    // A URL-sourced agent (web/pr/…) carries a `paw-kind:` marker (absent ⇒ folder) and a per-kind
    // brief. NOT `kind:` — cotal's own AgentDef reserves that key and hard-validates it to
    // "agent"/"endpoint" (agent-file.js), so paw's unrelated folder/worktree/repo/pr/web marker needs
    // its own namespaced key or a URL-sourced spawn fails loud on load ("kind" must be "agent" or
    // "endpoint" — the eve.md incident, 2026-07-22). An unmodelled key is kept verbatim in AgentDef.meta.
    const kindLine = opts?.kind && opts.kind !== "folder" ? `paw-kind: ${opts.kind}\n` : "";
    const body =
      opts?.brief ??
      `You are the paw agent for the "${name}" folder — a peer on the cotal mesh, acting unattended on this repository.`;
    writeFileSync(
      file,
      `---\nname: ${name}\nresume: ${randomUUID()}\n${GRANT_LINES.join("\n")}\n${kindLine}---\n${body}\n`,
    );
  }
  return file;
}

/**
 * Resolve the model override for a spawn: an explicit `--model` wins, else the PAW_MODEL env default,
 * else undefined (the agent file's `model:` / the harness default). A set-but-blank value counts as
 * unset (not a fabricated default) — mirrors resolveSpace's empty-handling.
 */
export function resolveModel(explicit?: string): string | undefined {
  return explicit?.trim() || process.env.PAW_MODEL?.trim() || undefined;
}

/** A one-shot "control-caller-privileged" cred from the space's trust material, or undefined on an
 *  open mesh (which connects bare). `space` is required as of cotal 0.14 — auth material is scoped
 *  per-space (`loadSpaceAuth(dir, space)`), not just per-dir.
 *
 *  This is NO LONGER the control rail's credential: manager control moved to the v0.4 service
 *  endpoint and mints its own per-TIER instrument in `src/control.ts` (which is what finally retired
 *  the under-privileged-stop caveat this comment used to carry — a cross-agent stop now mints the
 *  admin tier because the command says so). What is left here is `paw status`'s own short-lived
 *  JetStream connection for the per-agent inbox-lag read, which needs a cred and no ep rows. */
export async function controlCreds(space: string): Promise<string | undefined> {
  const auth = loadSpaceAuth(authDir(pawCotalRoot(space)), space);
  // Lifecycle-keyed since 0.25 — see the note in lifecycle.ts's probeCreds. Minting without it throws.
  return auth ? await mintCreds(auth, newIdentity(), "control-caller-privileged", { lifecycleUid: mintLifecycleUid() }) : undefined;
}

/**
 * A stable identity for the human peer on an OPEN mesh, persisted per space so replies an agent
 * sends while you're briefly away queue to the same DM inbox and redeliver when you reconnect.
 * (Under auth the id comes from the minted creds instead, so this is only used on the open mesh.)
 */
export function stableHumanId(space: string): string {
  const file = join(spaceDir(space), "human.id");
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) {
      // cotal 0.11 forbids '-' in a principal owner/actor token; migrate a legacy dashed UUID in place
      // so the same human inbox carries over (stripping dashes is deterministic, keeps replies flowing).
      const safe = humanIdToken(raw);
      if (safe !== raw) writeFileSync(file, safe);
      return safe;
    }
  }
  const id = humanIdToken(randomUUID());
  writeFileSync(file, id);
  return id;
}

/** A NATS-safe principal token (cotal 0.11 grammar `[A-Za-z0-9_]`, no dashes) from any id. */
function humanIdToken(raw: string): string {
  return raw.replace(/-/g, "");
}

/**
 * The addressable WIRE principal for a manager-surfaced `id`. As of cotal 0.11 the manager's ps/start
 * reply `id` is the RAW nkey (open mesh — a durable/teardown key) or a full user principal (auth mesh),
 * while every wire op (unicast/DM) and `presence.card.id` use the `<owner>.<actor>` principal dot-form.
 * A raw nkey has no `.`, so derive it under the open-mesh owner (`DEV_OWNER` = "local"); an already-dotted
 * user principal passes through unchanged. Mirrors the manager's own `managedPrincipal` — the contract is
 * "never address a raw `a.id`". Idempotent, so wrapping a presence card.id (already dotted) is a no-op.
 */
export function wirePrincipal(id: string): string {
  return id.includes(".") ? id : principalKey(DEV_OWNER, id).key;
}

/** One row of the manager's `ps` reply: `status` is the process state ("running"/"exited"),
 *  `mesh` the mesh presence ("idle"/"working"/"waiting"/"offline"/"absent"=mid-start). `id` is the
 *  agent's mesh card.id — a `<owner>.<actor>` PRINCIPAL dot-form as of cotal 0.11 (was a bare nkey). Its
 *  durable DM consumer is `dm_<owner>-<actor>` (`dmDurable(owner, actor)`), which `paw status` re-derives
 *  by re-splitting the id with `parsePrincipalKey` to find each agent's inbox lag. */
export type PsRow = { name: string; status?: string; mesh?: string; id?: string; agent?: string };

/** Is this ps row a REACHABLE agent (vs a zombie the manager still lists)? An exited process or a
 *  mesh-offline agent is dead; "absent" (mid-start) counts as alive so a legitimate boot isn't killed. */
export function psRowAlive(row: PsRow): boolean {
  return row.status !== "exited" && row.mesh !== "offline";
}

/** Decide how to bring `name` up given the manager's ps rows: "start" (unmanaged → spawn), "reuse"
 *  (managed + reachable → no-op), or "restart" (managed but DEAD → stop the zombie, then spawn). The old
 *  gate reused ANY listed name, so a listed-but-offline agent could never be woken by `paw dm`/`paw chat`
 *  after a crash/bounce — the bug this fixes. Pure → unit-tested in check:addressing. */
/** How long an agent may sit at `starting…` (`mesh: "absent"`) before it counts as a failed boot
 *  rather than a slow one. Generous on purpose: the cost of being wrong low is killing a live boot,
 *  which merely costs a resume; the cost of being wrong high is what happened — an agent unreachable
 *  for 13 hours with no way to clear it. */
export const STARTING_GRACE_MS = 15_000;

/** How long a JUST-ACCEPTED spawn may take to reach the mesh. Longer than {@link STARTING_GRACE_MS},
 *  which bounds an agent paw found ALREADY sitting at `starting…` (unknown age, quite possibly stuck):
 *  here paw watched the spawn happen, so the clock starts at zero and a cold claude on a loaded machine
 *  genuinely needs the room. 60s is what the old blocking `start` call was given for the same wait. */
export const SPAWN_READY_MS = 60_000;

/** How recently an agent's transcript must have been written for an "offline" ps row to be read as
 *  BUSY rather than dead. A claude mid-command (a deploy, a long test run) can lag its mesh presence —
 *  the same fact `paw status`'s `inferBusy` exists for — and the wake gate then saw a "zombie" and
 *  despawned a working agent mid-flight. Two agents reported deploys/watchers "killed externally
 *  right after an inbound DM" (research + queue-ea, 2026-08-27); this is the guard. */
export const BUSY_GUARD_MS = 180_000;

/** Should an offline-on-the-mesh but still-listed agent be restarted? Not if it has written its
 *  transcript recently — that is a live claude with a lagging presence, and restarting it kills
 *  whatever it is running. A missing mtime is no evidence either way, so the restart proceeds. Pure. */
export function restartDespiteOffline(activeMs: number | undefined, now: number, windowMs = BUSY_GUARD_MS): boolean {
  if (activeMs === undefined) return true;
  const age = now - activeMs;
  return !(age >= 0 && age < windowMs);
}

export function spawnAction(rows: PsRow[], name: string): "start" | "reuse" | "restart" {
  const row = rows.find((r) => r.name === name);
  if (!row) return "start";
  return psRowAlive(row) ? "reuse" : "restart";
}

/**
 * Ensure the agent for `name` is running under the manager, spawning it at `cwd` if absent. Returns
 * whether we spawned and, when we did, the agent's WIRE PRINCIPAL from the spawn reply (so the
 * caller can address it immediately, before its presence heartbeat lands).
 *
 * The ps-check-then-start is serialized per (space,name) under a lock: cotal's manager now AUTO-NUMBERS
 * a duplicate name instead of rejecting it, so two concurrent `paw chat`/`open <folder>` would each
 * pass the ps check and spawn a second, auto-numbered agent paw can neither find nor reuse. The lock
 * makes the second caller re-check ps after the first commits and return {spawned:false}.
 */
export async function ensureAgentSpawned(
  ctl: ManagerControl,
  opts: { space: string; name: string; cwd: string; model?: string; brief?: string; kind?: Kind; allowForeignWriter?: boolean },
): Promise<{ spawned: boolean; id?: string }> {
  // A FOREGROUND `paw claude` agent already owns this name in the operator's own terminal (its process
  // isn't in the manager's ps). Never spawn a manager duplicate: dm/chat/open/adopt/rename/revival all
  // funnel through here, so this ONE guard keeps them from racing a second agent onto the same name.
  // The caller addresses the live foreground agent through the roster instead (readyId/waitForPeerId).
  if (readForeground(opts.space, opts.name)) return { spawned: false };
  return withFileLockAsync(spawnLockPath(opts.space, opts.name), async () => {
    const ps = await ctl.ps();
    if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
    const rows = (ps.data as PsRow[]) ?? [];
    let action = spawnAction(rows, opts.name);
    if (action === "reuse" && rows.find((r) => r.name === opts.name)?.mesh === "absent") {
      // "absent" means MID-START, and the gate calls that alive so a legitimate boot isn't killed. But
      // a boot that FAILED sits at `starting…` forever, and every wake path then reuses it and times
      // out: `paw chat research` said "isn't reachable on the mesh" against an agent the manager had
      // been listing as starting for THIRTEEN HOURS, and no amount of retrying could clear it (the
      // suggested `paw down` wouldn't either — the manager relists it on the way back up).
      //
      // So mid-start is now BOUNDED. Wait the window a real boot needs; if it still hasn't reached the
      // mesh, it isn't booting, it's stuck — treat it as the dead entry it is and restart. Restarting a
      // merely-slow boot is cheap (it resumes its pinned session); leaving an agent unreachable until a
      // human notices is not.
      if (await waitForMeshLive(ctl, opts.name, STARTING_GRACE_MS, () => nudgeStartupPrompt(opts.space, opts.name))) return { spawned: false };
      action = "restart";
    }
    if (action === "reuse") return { spawned: false };
    if (action === "restart") {
      // The manager still LISTS this agent but it's dead on the mesh (process exited, or mesh offline —
      // a zombie left by a crash/bounce). The old gate reused ANY listed name, so `paw dm`/`paw chat`
      // could neither wake it (skipped as "already running") nor reach it (it isn't consuming) → it just
      // timed out. Clear the stale entry so the spawn below starts a fresh, resumed process.
      //
      // BUT a merely BUSY agent also reads offline: presence lags while claude is deep in a command.
      // Restarting that one kills the command (the "my deploy got killed right after a DM" reports).
      // The transcript mtime is the local truth — written in the last few minutes ⇒ alive ⇒ leave it;
      // its DMs wait in the durable consumer and land when it next drains. And say WHY, either way:
      // this branch used to despawn silently, which is how the kills went unattributed for a week.
      const row = rows.find((r) => r.name === opts.name);
      const earlyPin = readResumeId(personaFilePath(opts.space, opts.name));
      const activeMs = earlyPin ? transcriptMtime(earlyPin) : undefined;
      if (row?.status !== "exited" && !restartDespiteOffline(activeMs, Date.now())) {
        console.error(
          `paw: "${opts.name}" reads ${row?.mesh ?? "?"} on the mesh but wrote its transcript ${Math.round((Date.now() - (activeMs as number)) / 1000)}s ago — busy, not a zombie; NOT restarting (the message waits in its inbox)`,
        );
        return { spawned: false };
      }
      console.error(
        `paw: restarting "${opts.name}" — ps row status=${row?.status ?? "?"} mesh=${row?.mesh ?? "?"}, transcript last written ${activeMs ? Math.round((Date.now() - activeMs) / 1000) + "s ago" : "never/unknown"}; its in-flight command (if any) will die`,
      );
      await ctl.despawn(opts.name).catch(() => {});
    }

    // The manager requires a persona file; paw auto-generates one and spawns via --config. `model`
    // (cotal's per-agent model override) is forwarded when set. Confine the cwd to PAW_ROOT and
    // pre-trust the folder HERE (the connector no longer sees the cwd — the manager owns it as of
    // cotal #43), passing the canonical path so the dir claude runs in matches the trust key.
    const config = ensurePersonaFile(opts.space, opts.name, { brief: opts.brief, kind: opts.kind });
    // Two-writer guard: if the agent's pinned session is open in a standalone claude (a hand-run
    // TUI, not a mesh agent), resuming it would put two writers on one transcript and can corrupt
    // it. Refuse loud. (A mesh agent already holding the name is caught by the ps check above; a
    // freshly-minted pin with no live writer passes through.) This is the guard `adopt` already has.
    const pin = readResumeId(config);
    if (pin && !opts.allowForeignWriter) {
      // allowForeignWriter: the caller (adopt's make-before-break takeover) will kill the holder right after we confirm this agent is live
      const foreign = foreignWriters(pin);
      if (foreign.length) {
        const pids = foreign.map((p) => p.pid).join(", ");
        throw new Error(
          `paw: won't start "${opts.name}" — its session ${pin} is open in another process (pid ${pids}); ` +
            `resuming it would put two writers on one transcript and can corrupt it.\n` +
            `  close it first:  kill ${pids}\n` +
            `  or re-pin it to its own session:  paw adopt "${opts.cwd}" --resume <id> --no-start`,
        );
      }
    }
    const cwd = confineAndTrustCwd(opts.cwd);
    const args: Record<string, unknown> = { name: opts.name, config, cwd };
    const model = resolveModel(opts.model); // explicit --model wins, else PAW_MODEL env default
    if (model) args.model = model;
    // Which of the operator's MCP servers this agent gets (`paw mcp share`). Absent ⇒ the flag isn't
    // sent ⇒ cotal shares every declared server, which is what `paw mcp add` promises. Sent as the
    // string the manager's `parseShareSelection` already understands, so paw invents no second grammar.
    const share = readShareTools(config);
    if (share) args.shareTools = share;
    // Which CONNECTOR runs this agent (`agent:` in the persona; absent = the default claude). Sent as
    // the spawn op's `agent` so a codex/opencode agent respawns as ITSELF on every wake/revival path.
    const agentType = readAgentType(config);
    if (agentType) args.agent = agentType;
    const reply = await ctl.spawn(args, 60_000); // a claude cold-start can take a while
    if (!reply.ok) {
      const err = reply.error ?? "no reply";
      // The cmux runtime reports "couldn't reach the app" not only when cmux is closed, but also when
      // cmux's `automation.socketControlMode` is the default `cmuxOnly` — that gate authorizes socket
      // control by cmux PROCESS LINEAGE, and paw's manager is a DETACHED daemon (setsid, reparented to
      // init) with no cmux-surface ancestry, so every spawn is rejected ("broken pipe"). No paw-side
      // env fix beats it. Point the operator at the real lever. (2026-07-08 debugging, hard-won.)
      const cmuxGate = /cmux/i.test(err) && /reach the app|socket|broken pipe/i.test(err)
        ? `\n  if cmux IS running, this is almost certainly cmux's automation gate: paw's manager is a\n` +
          `  detached daemon, but cmux's automation.socketControlMode defaults to "cmuxOnly" (only\n` +
          `  cmux-launched processes may drive the socket). Set it to "password" (+ automation.socketPassword)\n` +
          `  or "automation" in ~/.config/cmux/cmux.json, then \`cmux reload-config\`. Or use \`paw runtime tmux\`.`
        : "";
      throw new Error(`paw: failed to start agent "${opts.name}" (${err})${cmuxGate}`);
    }

    // The v0.4 spawn reply STATES the allocated principal (`owner`+`actor`) instead of handing back a
    // raw nkey for paw to re-derive with `wirePrincipal`. Callers unicast this id straight away, before
    // presence lands, and the wire wants the `<owner>.<actor>` dot-form — so build it from the two
    // tokens the manager actually allocated rather than guessing an owner for a bare key. A reply
    // missing either yields NO id (the caller then waits for presence) — never a half-formed principal,
    // which would be a recipient that resolves to nobody.
    const allocated = reply.data as { owner?: string; actor?: string } | undefined;
    const id = allocated?.owner && allocated.actor ? principalKey(allocated.owner, allocated.actor).key : undefined;

    // The reply is the ACCEPTANCE, not the outcome (see ManagerControl.spawn): the agent is allocated,
    // not yet alive. Under the old blocking `start` a claude that never came up surfaced HERE as a
    // failed reply; now it would surface as a caller timing out somewhere later with no idea why. So
    // paw does the readiness wait itself — which it must anyway, because this is the window where the
    // tmux dev-channels prompt appears and paw's Enter nudge is the only thing that clears it.
    if (!(await waitForMeshLive(ctl, opts.name, SPAWN_READY_MS, () => nudgeStartupPrompt(opts.space, opts.name)))) {
      throw new Error(
        `paw: the manager accepted "${opts.name}" but it never reached the mesh within ${Math.round(SPAWN_READY_MS / 1000)}s — ` +
          `it is probably still booting or stuck at a prompt. \`paw status\` to see its row, \`paw log ${opts.name}\` for what it did.`,
      );
    }
    return { spawned: true, id };
  });
}

/**
 * (Re)start the agent for `name` so a freshly-written persona (e.g. an adopted `resume:`) takes
 * effect: if one is already live, stop it first (the manager keys uniqueName off its agents map, which
 * `opStop` clears synchronously, so the respawn keeps the same name — no auto-numbering), then spawn.
 * The stop is the manager's `despawn` (a targeted, cross-agent terminal).
 */
export async function restartAgent(
  ctl: ManagerControl,
  opts: { space: string; name: string; cwd: string; model?: string; allowForeignWriter?: boolean },
): Promise<{ spawned: boolean; id?: string; restarted: boolean }> {
  const ps = await ctl.ps();
  if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
  const live = ((ps.data as Array<{ name: string }>) ?? []).some((a) => a.name === opts.name);
  if (live) {
    const stopped = await ctl.despawn(opts.name);
    if (!stopped.ok) throw new Error(`paw: couldn't stop the running "${opts.name}" to re-adopt it (${stopped.error ?? "no reply"})`);
  }
  const r = await ensureAgentSpawned(ctl, opts);
  return { ...r, restarted: live };
}

/** Stop the agent named `name` if it's live (the manager's `despawn`). No-op if it isn't running.
 *  Returns whether a live agent was stopped. Used to retire an agent under an old name when adopt
 *  renames it. */
export async function stopAgent(ctl: ManagerControl, name: string): Promise<boolean> {
  const ps = await ctl.ps();
  if (!ps.ok) return false;
  const live = ((ps.data as Array<{ name: string }>) ?? []).some((a) => a.name === name);
  if (!live) return false;
  return (await ctl.despawn(name)).ok;
}

/** Poll the endpoint's roster until a present peer named `name` appears, returning its mesh id, or
 *  undefined on timeout. Used to address an already-running agent (its id isn't in `ps`, only the
 *  roster). Case-insensitive, mirroring cotal's own name resolution. */
export async function waitForPeerId(ep: CotalEndpoint, name: string, timeoutMs: number): Promise<string | undefined> {
  const want = name.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const peer = ep.getRoster().find((p) => p.card.name.toLowerCase() === want && p.status !== "offline");
    if (peer) return peer.card.id;
    if (Date.now() >= deadline) return undefined;
    await sleep(200);
  }
}

/** Poll the MANAGER's ps until `name`'s row reports a CONNECTED mesh link (idle/working/waiting), or
 *  false on timeout. Unlike {@link waitForPeerId} (which reads the endpoint's presence roster), this
 *  asks the MANAGER instead of a roster, which is what makes it usable from a control-only caller (a
 *  {@link ManagerControl} has no roster at all). adopt's make-before-break takeover confirms the new
 *  agent is actually on the mesh THIS way before killing the old claude — "absent" (mid-start) does
 *  NOT count as connected. */
export async function waitForMeshLive(
  ctl: ManagerControl,
  name: string,
  timeoutMs: number,
  onPoll?: () => void,
): Promise<boolean> {
  const connected = new Set(["idle", "working", "waiting"]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    onPoll?.();
    const ps: ManagerReply = await ctl.ps().catch(() => ({ ok: false }) as ManagerReply);
    if (ps.ok) {
      const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
      if (row && row.mesh !== undefined && connected.has(row.mesh)) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/**
 * Clear claude's one-time dev-channels prompt for an agent that hasn't reached the mesh yet.
 *
 * cotal's tmux runtime already sends Enter, but only at 1s…5s after the window opens — and a cold
 * claude on a loaded machine reaches the prompt well after that, so every keypress lands before the
 * question exists and the agent then waits at it forever. That is indistinguishable from a failed
 * spawn: `cotal-endpoint-telegram` sat ~90s with no presence until a human pressed Enter, and it is
 * the likeliest explanation for an agent stuck at `starting…` (2026-08-17).
 *
 * Only tmux: the pty runtime clears its own prompt, and cmux windows are not paw's to type into.
 * Best-effort — a missing window must never turn a spawn into an error.
 */
function nudgeStartupPrompt(space: string, name: string): void {
  if (readRuntimeMarker(space) !== "tmux") return;
  nudgeTmuxConfirm(space, name, defaultTmuxEnv(process.env));
}

/**
 * Retry `ep.start()` on a transient JetStream boot race — a fresh/just-reconnected space's DM
 * durable can briefly 404 between create and bind (a `consumers.get` racing the `consumers.add`
 * cotal's own open-mode self-create does under the hood), surfacing as `paw chat`/`paw bind` dying
 * right at startup with "consumer not found" on an otherwise-healthy mesh. Mirrors dm.ts's
 * `unicastResilient` (same transient-match + bounded-backoff shape). Retrying on the SAME endpoint
 * instance is safe: `connectAndBind()` (what `start()` calls) opens with `clearConnectionScoped()`,
 * so a re-call tears down and rebuilds cleanly — the identical mechanism `superviseConnection`'s
 * own auto-rebuild-on-drop already relies on. A non-transient failure (bad creds, unreachable
 * server) still throws immediately — never masked behind a retry loop.
 */
export async function startResilient(ep: CotalEndpoint): Promise<void> {
  const transient = (m: string) => /consumer not found|no stream|stream not found|jetstream is not enabled|no responders|timeout|503/i.test(m);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await ep.start();
      return;
    } catch (e) {
      lastErr = e;
      if (!transient((e as Error).message)) throw e;
      await sleep(800);
    }
  }
  throw lastErr;
}

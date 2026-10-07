/**
 * Session helpers shared by the connector (launch), the spawn site (two-writer guard), and `paw
 * status` (pin health) — kept in a leaf module so addressing.ts needn't pull in the connector.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The raw value of one frontmatter `key:` line in an agent file, or undefined when the key (or the
 * frontmatter) is absent. The persona is paw's whole per-agent record — name, folder (`cwd:`), pin,
 * harness, flags — so every reader goes through this one parse. Throws if the file is unreadable.
 */
export function personaValue(configPath: string, key: string): string | undefined {
  const frontmatter = readFileSync(resolve(configPath), "utf8").match(/^---\n([\s\S]*?)\n---/);
  const line = frontmatter?.[1].split("\n").find((l) => l.trimStart().startsWith(`${key}:`));
  return line?.slice(line.indexOf(`${key}:`) + key.length + 1).trim();
}

/** A scalar frontmatter value with quotes stripped. A missing file is "no value", not an error: listings
 *  read every registered agent, and one absent file must not take the whole view down. */
function scalar(configPath: string | undefined, key: string): string | undefined {
  if (!configPath || !existsSync(resolve(configPath))) return undefined;
  return personaValue(configPath, key)?.replace(/^["']|["']$/g, "") || undefined;
}

/**
 * Read a paw `resume:` session id from an agent file's YAML frontmatter, if present. paw writes this
 * at birth (a minted uuid) and when adopting an existing claude session; a config with no resume key
 * cold-starts. Returns undefined when the key is absent. Throws (fail-loud) if a declared config file
 * is unreadable, rather than silently cold-starting an intended resume.
 */
export function readResumeId(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  // Drop a YAML inline comment (requires whitespace before '#'), then quotes/whitespace.
  const value = personaValue(configPath, "resume")?.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  if (value?.startsWith("|") || value?.startsWith(">")) {
    throw new Error(`paw: resume id in ${configPath} looks like a YAML block scalar ("${value}"); a session id must be a single-line value`);
  }
  return value || undefined;
}

/**
 * Read the `claudeArgs:` line from an agent file's frontmatter — extra claude flags the operator
 * asked for when the agent was created (`paw claude --model opus --add-dir /x`), which the connector
 * replays on EVERY launch so a restart is the same claude they started.
 *
 * Stored as a JSON array, not a shell string: an arg can contain spaces (`--append-system-prompt "be
 * terse"`), and re-splitting a flattened string is the quoting bug this whole path exists to avoid.
 * A malformed value throws rather than silently launching without the operator's flags.
 */
export function readClaudeArgs(configPath: string | undefined): string[] {
  const value = configPath ? personaValue(configPath, "claudeArgs") : undefined;
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`paw: claudeArgs in ${configPath} is not valid JSON (${value}) — expected an array like ["--model","opus"]`);
  }
  if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== "string"))
    throw new Error(`paw: claudeArgs in ${configPath} must be an array of strings, got ${value}`);
  return parsed as string[];
}

/** The persona's `agent:` frontmatter — which CONNECTOR runs this agent (codex, opencode, …).
 *  Absent ⇒ the manager's default ("claude", paw's opinionated connector). Durable in the persona so a
 *  restart/revival/wake respawns the SAME harness, not a claude with someone else's transcript. */
export function readAgentType(configPath: string | undefined): string | undefined {
  return scalar(configPath, "agent");
}

/** The persona's `headless:` flag — run this claude agent as `claude -p` (stream-json) with no TUI
 *  (docs/notes/headless.md). Absent ⇒ false (the TUI). Anything but `true`/`false` throws: a typo must
 *  not silently boot the other mode. */
export function readHeadless(configPath: string | undefined): boolean {
  const v = scalar(configPath, "headless");
  if (v === undefined || v === "false") return false;
  if (v === "true") return true;
  throw new Error(`paw: headless: in ${configPath} is "${v}" — expected true or false`);
}

/** True when this agent writes a claude jsonl that `paw log` / the web trace can tail.
 *  Absent `agent:` is paw's default claude connector. `cotal`/`paw` are aliases of the same harness. */
export function isClaudeHarness(agentType: string | undefined): boolean {
  if (!agentType) return true;
  return agentType === "claude" || agentType === "cotal" || agentType === "paw";
}

/** True when this agent's conversation is a Claude Code jsonl at its `resume:` pin — the claude harness
 *  itself (~/.claude/projects), or kit (src/kit.ts), which writes the same format in the store its
 *  `storage:` names (see {@link transcriptRoots}). paw log, the web trace and the pin-health column
 *  read it the same way for both. */
export function writesClaudeTranscript(agentType: string | undefined): boolean {
  return isClaudeHarness(agentType) || agentType === "kit";
}

/**
 * Read the `shareTools:` line from an agent file's frontmatter — which of the operator's MCP servers
 * this agent gets, forwarded to the manager as `--share-tools` at spawn.
 *
 * Absent ⇒ undefined ⇒ EVERY server declared for the connector, which is cotal's own default and the
 * behaviour `paw mcp add` promises ("adds to all agents"). `none` is a real value meaning share
 * nothing, and is deliberately distinct from absent — "I chose none" must not read as "I said nothing".
 */
export function readShareTools(configPath: string | undefined): string | undefined {
  return scalar(configPath, "shareTools");
}

/** The folder a registered agent runs in (`cwd:`) — undefined for an orphaned persona (no folder). */
export function readCwd(configPath: string | undefined): string | undefined {
  return scalar(configPath, "cwd");
}
/** Claude Code's own transcript store: `~/.claude/projects/<slug of cwd>/<id>.jsonl`. */
export function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** kit's own transcript store: `<KIT_HOME|~/.kit>/sessions/<slug of cwd>/<id>.jsonl` — the same slug and
 *  the same Claude Code JSONL format, but a different file: kit forks a claude session here on its first
 *  resume and appends only to its copy (kit's default storage mode). */
export function kitSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.KIT_HOME?.trim() || join(homedir(), ".kit"), "sessions");
}

/** Where a kit agent's session lives — the persona's `storage:` key. `kit` (absent ⇒ this) is kit's own
 *  store, forking a claude session on resume; `claude` is `kit run --overwrite`: read and append the
 *  claude transcript itself, so an agent that was a claude agent keeps ONE transcript. Anything else
 *  throws — a typo must not silently fork an agent off its claude session. */
export type KitStorage = "kit" | "claude";
export function readKitStorage(configPath: string | undefined): KitStorage {
  const v = scalar(configPath, "storage");
  if (v === undefined || v === "kit") return "kit";
  if (v === "claude") return "claude";
  throw new Error(`paw: storage: in ${configPath} is "${v}" — expected kit (kit's own store, the default) or claude (kit --overwrite)`);
}

/**
 * The transcript stores to search for an agent's sessions, in lookup order. A kit agent on kit's own
 * store looks there FIRST, then claude's (an id found there is the claude original kit forks on its
 * first resume); every other agent — claude, and kit with `storage: claude` — is claude-only. Never
 * search kit's store for a claude agent: the same id can exist in both with DIFFERENT continuations.
 */
export function transcriptRoots(agentType: string | undefined, storage: KitStorage = "kit"): string[] {
  return agentType === "kit" && storage === "kit" ? [kitSessionsRoot(), claudeProjectsRoot()] : [claudeProjectsRoot()];
}

/** {@link transcriptRoots} for a persona file (its `agent:` + `storage:`). No file ⇒ claude-only. */
export function personaTranscriptRoots(configPath: string | undefined): string[] {
  if (!configPath || !existsSync(resolve(configPath))) return [claudeProjectsRoot()];
  const agent = readAgentType(configPath);
  return transcriptRoots(agent, agent === "kit" ? readKitStorage(configPath) : undefined);
}

/**
 * True if a transcript for `sessionId` exists in one of `roots` (default: claude's projects), under any
 * cwd slug. Callers don't know the agent's cwd (the manager owns it since cotal #43), so we scan every
 * project dir. Decides resume-vs-create: a pinned id whose transcript exists is RESUMED (--resume); a
 * pin with no transcript yet is the agent's FIRST boot, so the session is CREATED at that exact id
 * (--session-id) — making the very first session durable, so the next restart can resume it.
 */
export function transcriptExists(sessionId: string, roots: string[] = [claudeProjectsRoot()]): boolean {
  return transcriptPath(sessionId, roots) !== undefined;
}

/** The path to `sessionId`'s transcript in the FIRST of `roots` that holds it, or undefined if none does.
 *  `slug` (a cwd's project-dir name) is tried first within each root — a shortcut inside a root, never a
 *  reason to prefer a later root over an earlier one. */
export function transcriptPath(sessionId: string, roots: string[] = [claudeProjectsRoot()], slug?: string): string | undefined {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (slug && existsSync(join(root, slug, `${sessionId}.jsonl`))) return join(root, slug, `${sessionId}.jsonl`);
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

/** {@link transcriptPath} for many sessions at once — the same answer per id (first root, then first
 *  project dir in readdir order, whose `<id>.jsonl` exists), from ONE listing of each project dir. Asked
 *  one id at a time, `paw status` probed every project dir per agent per column: ~100k existsSync. */
export function transcriptPaths(sessionIds: Iterable<string>, roots: string[] = [claudeProjectsRoot()]): Map<string, string> {
  const want = new Set(sessionIds);
  const out = new Map<string, string>();
  if (want.size === 0) return out;
  if (want.size <= 4) {
    for (const id of want) {
      const file = transcriptPath(id, roots);
      if (file) out.set(id, file);
    }
    return out;
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      let names: string[];
      try {
        names = readdirSync(join(root, dir));
      } catch {
        continue; // not a directory (or vanished) — transcriptPath's existsSync finds nothing there either
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const id = n.slice(0, -".jsonl".length);
        if (!want.has(id) || out.has(id)) continue;
        const file = join(root, dir, n);
        if (existsSync(file)) out.set(id, file);
      }
    }
  }
  return out;
}

/** The last-modified time (ms) of `sessionId`'s transcript — a proxy for the agent's "last active"
 *  — or undefined if it has no transcript yet. Same scan as {@link transcriptExists}. */
export function transcriptMtime(sessionId: string, roots: string[] = [claudeProjectsRoot()]): number | undefined {
  const file = transcriptPath(sessionId, roots);
  return file ? statSync(file).mtimeMs : undefined;
}

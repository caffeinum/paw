/**
 * Session helpers shared by the connector (launch), the spawn site (two-writer guard), and `paw
 * status` (pin health) — kept in a leaf module so addressing.ts needn't pull in the connector.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Read a paw `resume:` session id from an agent file's YAML frontmatter, if present. paw writes this
 * at birth (a minted uuid) and when adopting an existing claude session; a config with no resume key
 * cold-starts. Returns undefined when the key is absent. Throws (fail-loud) if a declared config file
 * is unreadable, rather than silently cold-starting an intended resume.
 */
export function readResumeId(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  const raw = readFileSync(resolve(configPath), "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const line = frontmatter[1].split("\n").find((l) => l.trimStart().startsWith("resume:"));
  if (!line) return undefined;
  const afterKey = line.slice(line.indexOf("resume:") + "resume:".length);
  // Drop a YAML inline comment (requires whitespace before '#'), then quotes/whitespace.
  const value = afterKey.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  if (value.startsWith("|") || value.startsWith(">")) {
    throw new Error(`paw: resume id in ${configPath} looks like a YAML block scalar ("${value}"); a session id must be a single-line value`);
  }
  return value.length > 0 ? value : undefined;
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
  if (!configPath) return [];
  const raw = readFileSync(resolve(configPath), "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return [];
  const line = frontmatter[1].split("\n").find((l) => l.trimStart().startsWith("claudeArgs:"));
  if (!line) return [];
  const value = line.slice(line.indexOf("claudeArgs:") + "claudeArgs:".length).trim();
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

/**
 * Read the `shareTools:` line from an agent file's frontmatter — which of the operator's MCP servers
 * this agent gets, forwarded to the manager as `--share-tools` at spawn.
 *
 * Absent ⇒ undefined ⇒ EVERY server declared for the connector, which is cotal's own default and the
 * behaviour `paw mcp add` promises ("adds to all agents"). `none` is a real value meaning share
 * nothing, and is deliberately distinct from absent — "I chose none" must not read as "I said nothing".
 */
/** The persona's `agent:` frontmatter — which CONNECTOR runs this agent (codex, opencode, …).
 *  Absent ⇒ the manager's default ("claude", paw's opinionated connector). Durable in the persona so a
 *  restart/revival/wake respawns the SAME harness, not a claude with someone else's transcript. */
export function readAgentType(configPath: string | undefined): string | undefined {
  if (!configPath || !existsSync(resolve(configPath))) return undefined;
  const raw = readFileSync(resolve(configPath), "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const line = frontmatter[1].split("\n").find((l) => l.trimStart().startsWith("agent:"));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("agent:") + "agent:".length).trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : undefined;
}

/** True when this agent writes a claude jsonl that `paw log` / the web trace can tail.
 *  Absent `agent:` is paw's default claude connector. `cotal`/`paw` are aliases of the same harness. */
export function isClaudeHarness(agentType: string | undefined): boolean {
  if (!agentType) return true;
  return agentType === "claude" || agentType === "cotal" || agentType === "paw";
}

export function readShareTools(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  // A registered agent whose persona file is gone has no selection recorded — that is an answer, not an
  // error. Unlike `readResumeId`, which fails loud because a missing pin at SPAWN time would silently
  // cold-start an amnesiac session, this is read by listings across every registered agent, and one
  // absent file must not take the whole view down.
  if (!existsSync(resolve(configPath))) return undefined;
  const raw = readFileSync(resolve(configPath), "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const line = frontmatter[1].split("\n").find((l) => l.trimStart().startsWith("shareTools:"));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("shareTools:") + "shareTools:".length).trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : undefined;
}

/**
 * True if claude already has a transcript for `sessionId` under ~/.claude/projects/<any-cwd-slug>/.
 * Callers don't know the agent's cwd (the manager owns it since cotal #43), so we scan every project
 * dir. Decides resume-vs-create: a pinned id whose transcript exists is RESUMED (--resume); a pin
 * with no transcript yet is the agent's FIRST boot, so the session is CREATED at that exact id
 * (--session-id) — making the very first session durable, so the next restart can resume it.
 */
export function transcriptExists(sessionId: string): boolean {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return false;
  for (const dir of readdirSync(projects)) {
    if (existsSync(join(projects, dir, `${sessionId}.jsonl`))) return true;
  }
  return false;
}

/** The path to `sessionId`'s transcript, or undefined if claude has none yet. Same cwd-agnostic scan as
 *  {@link transcriptExists} — callers don't know the agent's cwd, since the manager owns it. */
export function transcriptPath(sessionId: string): string | undefined {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** The last-modified time (ms) of `sessionId`'s transcript — a proxy for the agent's "last active"
 *  — or undefined if it has no transcript yet. Same cwd-agnostic scan as {@link transcriptExists}. */
export function transcriptMtime(sessionId: string): number | undefined {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const f = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(f)) return statSync(f).mtimeMs;
  }
  return undefined;
}

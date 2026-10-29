/**
 * The operator's Claude Code skills, READ-ONLY, inside a sandboxed agent's VM (docs/notes/sandbox.md#skills).
 *
 *  - user skills: every `~/.claude/skills/<name>` (most are symlinks — relative or absolute — that would dangle in
 *    the VM) is resolved on the host and its real dir bind-mounted read-only at `/paw/claude/skills/<name>`, one
 *    mount per skill, so a host edit shows up live. `/paw/claude/skills` itself stays the agent's own (rw): it
 *    may write skills of other names there.
 *  - plugin skills: each user-scope plugin installed AND enabled on the host whose plugin is pure
 *    skills/commands/agents is mounted read-only at `/paw/plugins/<plugin>` and loaded with `--plugin-dir` (no
 *    marketplace state, no installed_plugins.json, nothing claude would try to update in a read-only mount). A
 *    plugin that ships hooks, MCP/LSP servers or channels would run host-oriented commands or want host secrets
 *    in the VM — it is excluded, and said so in launcher.log, skills.json (`paw sandbox ls`).
 *
 * Nothing else of the host's ~/.claude is ever mounted (credentials, other agents' transcripts, settings).
 * Persona `sandboxSkills: false` turns it off; `sandboxSkills: [a, b]` mounts only those skill / plugin names.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export const SANDBOX_SKILLS_MOUNT = "/paw/claude/skills";
export const SANDBOX_PLUGINS_MOUNT = "/paw/plugins";

export type SkillSelection = true | false | string[];

/** Persona `sandboxSkills:` — absent/true = all, false = none, `[a, b]` = only those names. Anything else throws. */
export function readSandboxSkills(configPath: string | undefined): SkillSelection {
  if (!configPath || !existsSync(configPath)) return true;
  const front = readFileSync(configPath, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const line = front.split("\n").find((l) => l.startsWith("sandboxSkills:"));
  if (line === undefined) return true;
  const v = line.slice("sandboxSkills:".length).trim();
  if (v === "true") return true;
  if (v === "false") return false;
  const list = v.match(/^\[(.*)\]$/)?.[1];
  if (list === undefined) throw new Error(`paw: sandboxSkills: in ${configPath} is "${v}" — expected true, false or an inline list like [now, team2027-skills]`);
  const names = list.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  for (const n of names) if (!SAFE_NAME.test(n)) throw new Error(`paw: sandboxSkills: in ${configPath} names "${n}" — not a skill or plugin name`);
  return names;
}

export interface SkillMount {
  kind: "skill" | "plugin";
  name: string;
  host: string;
  vm: string;
}
export interface SandboxSkillSet {
  mounts: SkillMount[];
  /** in-VM plugin dirs, each passed to claude as `--plugin-dir` */
  pluginDirs: string[];
  /** what was not mounted, and why — logged in launcher.log, listed by `paw sandbox ls` */
  skipped: Array<{ kind: "skill" | "plugin"; name: string; reason: string }>;
}

/** The host claude's config dir: what a host agent reads its skills/plugins from. */
export function hostClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
}

/** Names and paths go into `-v host:vm:ro` — a `:` or `,` would split it. */
const SAFE_NAME = /^[A-Za-z0-9._@-]+$/;
const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** A resolved dir may be mounted only if it is not the host's ~/.claude (or an ancestor), nor $HOME (or an
 *  ancestor), and — when it lives inside ~/.claude — only under its skills/ or plugins/. */
function unsafeTarget(real: string, claude: string, home: string): string | undefined {
  if (real.includes(":") || real.includes(",")) return `its path ${real} has a ':' or ','`;
  if (within(claude, real)) return `it resolves to ${real}, which contains the host's claude config dir`;
  if (within(home, real)) return `it resolves to ${real}, which contains $HOME`;
  if (within(real, claude) && !within(real, join(claude, "skills")) && !within(real, join(claude, "plugins"))) return `it resolves to ${real}, inside the host's claude config dir but not its skills/ or plugins/`;
  return undefined;
}

function realDir(p: string): string | undefined {
  try {
    const r = realpathSync(p);
    return statSync(r).isDirectory() ? r : undefined;
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: can't read ${file} to pick the sandbox's plugins (${(e as Error).message}) — fix it, or set \`sandboxSkills: false\``);
  }
}

/** Why a plugin is not pure skills/commands/agents, or undefined when it is. */
export function pluginHostReach(dir: string): string | undefined {
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  const m = (existsSync(manifest) ? readJson(manifest) : {}) as Record<string, unknown>;
  const why: string[] = [];
  if (m.hooks !== undefined || existsSync(join(dir, "hooks"))) why.push("hooks");
  if (m.mcpServers !== undefined || existsSync(join(dir, ".mcp.json"))) why.push("MCP servers");
  if (m.lspServers !== undefined || existsSync(join(dir, ".lsp.json"))) why.push("LSP servers");
  if (m.channels !== undefined) why.push("channels");
  return why.length ? `ships ${why.join(", ")} (host-oriented commands / host secrets)` : undefined;
}

type Installed = { plugins?: Record<string, Array<{ scope?: string; installPath?: string }>> };

/**
 * What the VM gets from the host's claude config dir. Pure reads; a skill/plugin whose target is missing or
 * unsafe is skipped (never fails the launch). An allow-list name that matches nothing installed throws.
 */
export function collectSandboxSkills(select: SkillSelection, env: NodeJS.ProcessEnv = process.env): SandboxSkillSet {
  const out: SandboxSkillSet = { mounts: [], pluginDirs: [], skipped: [] };
  if (select === false) return out;
  const claude = hostClaudeDir(env);
  const home = env.HOME?.trim() || homedir();
  const wanted = (names: string[]) => select === true || names.some((n) => select.includes(n));
  const seen = new Set<string>();

  const skillsDir = join(claude, "skills");
  const entries = existsSync(skillsDir) ? readdirSync(skillsDir).sort() : [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    seen.add(name);
    if (!wanted([name])) continue;
    const skip = (reason: string) => out.skipped.push({ kind: "skill", name, reason });
    if (!SAFE_NAME.test(name)) { skip("its name can't be a mount path"); continue; }
    const real = realDir(join(skillsDir, name));
    if (!real) { skip("its target is missing (dangling symlink?)"); continue; }
    if (!existsSync(join(real, "SKILL.md"))) { skip("no SKILL.md (not a skill dir)"); continue; }
    const unsafe = unsafeTarget(real, claude, home);
    if (unsafe) { skip(unsafe); continue; }
    out.mounts.push({ kind: "skill", name, host: real, vm: `${SANDBOX_SKILLS_MOUNT}/${name}` });
  }

  const installedFile = join(claude, "plugins", "installed_plugins.json");
  const settingsFile = join(claude, "settings.json");
  const installed = existsSync(installedFile) ? (readJson(installedFile) as Installed) : {};
  const enabled = existsSync(settingsFile) ? ((readJson(settingsFile) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}) : {};
  for (const [key, versions] of Object.entries(installed.plugins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const name = key.split("@")[0];
    seen.add(name).add(key);
    if (!wanted([name, key])) continue;
    const skip = (reason: string) => out.skipped.push({ kind: "plugin", name: key, reason });
    if (enabled[key] !== true) {
      if (select !== true) skip("not enabled in the host's settings.json enabledPlugins");
      continue;
    }
    const user = (versions ?? []).find((v) => v.scope === "user");
    if (!user?.installPath) { skip("not installed at user scope"); continue; }
    if (!SAFE_NAME.test(name)) { skip("its name can't be a mount path"); continue; }
    if (out.pluginDirs.includes(`${SANDBOX_PLUGINS_MOUNT}/${name}`)) { skip(`another enabled plugin is also named "${name}"`); continue; }
    const real = realDir(user.installPath);
    if (!real) { skip(`its installPath ${user.installPath} is missing`); continue; }
    const unsafe = unsafeTarget(real, claude, home);
    if (unsafe) { skip(unsafe); continue; }
    const reach = pluginHostReach(real);
    if (reach) { skip(reach); continue; }
    const vm = `${SANDBOX_PLUGINS_MOUNT}/${name}`;
    out.mounts.push({ kind: "plugin", name: key, host: real, vm });
    out.pluginDirs.push(vm);
  }

  if (select !== true) {
    const unknown = select.filter((n) => !seen.has(n));
    if (unknown.length) throw new Error(`paw: sandboxSkills: names ${unknown.join(", ")} — no such skill in ${skillsDir} nor plugin in ${installedFile}`);
  }
  return out;
}

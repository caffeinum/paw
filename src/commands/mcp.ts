/**
 * `paw mcp` — which of YOUR MCP servers paw's agents get.
 *
 * A paw agent launches with cotal's MCP server and nothing else: the connector always emits
 * `--strict-mcp-config`, which drops every ambient server, because several agents each booting a heavy
 * helper would eat the machine. Sharing one is therefore a deliberate act, and until now it had no
 * surface at all — you had to hand-write cotal's config file and know that paw spawns under the
 * connector name `claude`.
 *
 * WHERE THINGS LIVE, and why they live apart:
 *   - the server DEFINITIONS go in cotal's own config (`~/.config/cotal/config.json`,
 *     `connectors.claude.mcpServers`). That file already exists and cotal already reads it; a second
 *     paw-owned format for the same thing would be one more place for the truth to disagree with itself.
 *   - the per-agent SELECTION goes in paw's persona (`shareTools:`), because the agent file is paw's
 *     and is already what a spawn is built from.
 *   - an OPT-IN server (`add --only`, `only`) is marked beside its definition (`connectors.claude.pawOptIn`)
 *     and granted per agent in the persona (`mcpOptIn:`). The math, and why the mark lives in cotal's
 *     file rather than a paw-side one, are in src/mcp-select.ts.
 *
 * NOTHING HERE RESTARTS AN AGENT — except `--to <agent>`. An MCP server is read by claude at startup, so a
 * running agent keeps the set it launched with — and restarting someone's agents as a side effect of
 * editing config is not a decision a config command gets to make. Every command that changes what an agent
 * WOULD get names the agents whose set changed and prints the command to restart them. `--to` names ONE
 * sandboxed agent and installs into its own VM config (src/mcp-sandbox.ts); naming it is the operator's go
 * to restart it, said in the output, `--no-restart` to skip, and a busy one is left alone without `--now`.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigPath, registry, type Command, type CotalConfig, type McpServerSpec } from "@cotal-ai/core";
import { listAgents, personaFilePath } from "../addressing.ts";
import { pawHomeDir, resolveSpace } from "../lifecycle.ts";
import { personaValue, readShareTools } from "../session.ts";
import { effectiveServers, GRANT_KEY, OPT_IN_KEY, readOptIn, splitList } from "../mcp-select.ts";
import {
  RESERVED_SANDBOX_SERVERS,
  checkCommandInVm,
  claudeUserSpec,
  describeServer,
  enableInAgent,
  listedServers,
  readClaudeJson,
  realEnableDeps,
  sandboxTarget,
  withUserServer,
  withoutUserServer,
  writeClaudeJson,
  type EnableDeps,
} from "../mcp-sandbox.ts";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), green: wrap("32"), yellow: wrap("33") };

/** The connector paw's agents actually spawn under. NOT "paw": bin/cotald.ts registers paw's connector
 *  under the manager's default agent type, replacing the vanilla one, so cotal looks up shared servers
 *  under `claude`. Writing them under any other key configures nothing, silently. */
export const PAW_CONNECTOR = "claude";

/** How many names a listing line prints before it says "+N more" (`--verbose` prints them all). */
const NAMES_SHOWN = 8;

/** Read cotal's operator-level config, or an empty one. Fails loud on malformed JSON rather than
 *  overwriting a file we couldn't understand — that file is the operator's, and half of it may be
 *  configuration this command knows nothing about. */
export function readConfig(path: string): CotalConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`paw: cotal config ${path} is not valid JSON (${(e as Error).message}) — fix it before adding a server`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`paw: cotal config ${path} must be a JSON object`);
  return parsed as CotalConfig;
}

/** Merge a server into the config WITHOUT disturbing anything else in it — other connectors, other
 *  servers, and any key cotal supports that paw doesn't know about. Pure, so the merge is testable
 *  without touching the operator's real file. */
export function withServer(config: CotalConfig, name: string, spec: McpServerSpec): CotalConfig {
  const connectors = { ...(config.connectors ?? {}) };
  const connector = { ...(connectors[PAW_CONNECTOR] ?? {}) };
  connector.mcpServers = { ...(connector.mcpServers ?? {}), [name]: spec };
  connectors[PAW_CONNECTOR] = connector;
  return { ...config, connectors };
}

/** Drop a server, leaving the rest of the file alone — its opt-in mark goes in the SAME write, so a
 *  server later re-added under that name starts shared, as `add` says. Returns undefined when it wasn't
 *  there, so the caller can fail loud instead of reporting a removal that didn't happen. */
export function withoutServer(config: CotalConfig, name: string): CotalConfig | undefined {
  const existing = config.connectors?.[PAW_CONNECTOR]?.mcpServers;
  if (!existing || !(name in existing)) return undefined;
  const servers = { ...existing };
  delete servers[name];
  const connectors = { ...(config.connectors ?? {}) };
  connectors[PAW_CONNECTOR] = { ...connectors[PAW_CONNECTOR], mcpServers: servers };
  return withOptInMark({ ...config, connectors }, name, false);
}

/** The opt-in servers cotal's config marks for paw's connector. */
export function optInServers(config: CotalConfig, where: string): string[] {
  return readOptIn(config.connectors?.[PAW_CONNECTOR], `cotal config ${where} connectors.${PAW_CONNECTOR}.`);
}

/** Mark (on) or unmark `name` as opt-in, keeping the rest of the file. An emptied mark list is removed
 *  rather than left as `[]`, so a file that stopped using opt-in looks like one that never did. */
export function withOptInMark(config: CotalConfig, name: string, on: boolean): CotalConfig {
  const connectors = { ...(config.connectors ?? {}) };
  const connector = { ...(connectors[PAW_CONNECTOR] ?? {}) } as Record<string, unknown>;
  const current = readOptIn(connector, `connectors.${PAW_CONNECTOR}.`);
  const next = on ? (current.includes(name) ? current : [...current, name]) : current.filter((x) => x !== name);
  if (next.length) connector[OPT_IN_KEY] = next;
  else delete connector[OPT_IN_KEY];
  connectors[PAW_CONNECTOR] = connector;
  return { ...config, connectors };
}

/** A server name is a bare token: it becomes a key in a `.mcp.json` and is matched by `--share-tools`,
 *  so anything needing quoting would be a name you could never select. `:` and `.` ARE allowed (2026-09-14):
 *  claude keys an MCP server's stored OAuth by `<name>|sha256({type,url,headers})`, so a remote server
 *  the operator already authorized as a PLUGIN (`plugin:slack:slack`) only reuses that token under its
 *  exact name — under any other name the agent would have to run a browser OAuth flow it cannot run.
 *  What must stay out is a comma or whitespace, which `shareTools:` splits on. */
export function isValidServerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(name);
}

/**
 * Build a server spec from the flags. `--json` takes a whole `.mcp.json` entry (copy one straight out
 * of your Claude config); the long form builds the common stdio case, and a lone URL a remote one.
 *
 * A spec with neither `command` nor `url` is refused: it would write a config entry that can never
 * launch, and the failure would surface much later as a broken agent rather than here.
 */
export function buildSpec(opts: { json?: string; cmd: string[]; env: string[]; headers?: string[]; transport?: string }): McpServerSpec {
  const headers = opts.headers ?? [];
  const transport = opts.transport;
  if (transport !== undefined && !["stdio", "http", "sse"].includes(transport))
    throw new Error(`paw: --transport is stdio, http or sse (got "${transport}")`);
  if (opts.json !== undefined) {
    if (opts.cmd.length || opts.env.length || headers.length || transport !== undefined)
      throw new Error(`paw: --json is the whole entry — put env/headers/type inside it, not beside it`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.json);
    } catch (e) {
      throw new Error(`paw: --json is not valid JSON (${(e as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`paw: --json must be a .mcp.json server object, e.g. '{"command":"npx","args":["-y","pkg"]}'`);
    const spec = parsed as McpServerSpec;
    if (!spec.command && !spec.url) throw new Error(`paw: --json needs a "command" (stdio) or a "url" (remote)`);
    return spec;
  }
  if (!opts.cmd.length) throw new Error(`paw: give the server's command after \`--\`, e.g. \`paw mcp add github -- npx -y pkg\` (or --json '<.mcp.json entry>')`);
  const env: Record<string, string> = {};
  for (const pair of opts.env) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`paw: --env expects KEY=VALUE (got "${pair}") — use \${VAR} to reference a secret by name`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const [command, ...args] = opts.cmd;
  // A lone URL is a remote server: streamable HTTP by default (what `claude mcp add --transport http`
  // writes), `--transport sse` for the older one; `--header 'K: V'` repeatable.
  if (/^https?:\/\//.test(command)) {
    if (transport === "stdio") throw new Error(`paw: --transport stdio runs a command, not a URL`);
    if (args.length || Object.keys(env).length)
      throw new Error(`paw: a URL server takes nothing after the URL and no --env — headers go in --header 'K: V' (or paste the entry with --json)`);
    const spec: McpServerSpec = { type: transport ?? "http", url: command };
    if (headers.length) spec.headers = parseHeaders(headers);
    return spec;
  }
  if (transport === "http" || transport === "sse") throw new Error(`paw: --transport ${transport} needs a URL (https://…), not a command`);
  if (headers.length) throw new Error(`paw: --header is for http/sse servers — a stdio server takes --env`);
  const spec: McpServerSpec = { command };
  if (args.length) spec.args = args;
  if (Object.keys(env).length) spec.env = env;
  return spec;
}

/** `--header 'Authorization: Bearer x'` → `{Authorization: "Bearer x"}` (split at the FIRST colon, as
 *  `claude mcp add -H` does). A header with no name, or given twice, fails loud. */
export function parseHeaders(list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list) {
    const colon = h.indexOf(":");
    const key = colon === -1 ? "" : h.slice(0, colon).trim();
    if (!key) throw new Error(`paw: --header expects 'Name: value' (got "${h}")`);
    if (Object.hasOwn(out, key)) throw new Error(`paw: --header "${key}" given twice`);
    out[key] = h.slice(colon + 1).trim();
  }
  return out;
}

/** One agent as the selection math sees it: its `shareTools:` and its `mcpOptIn:` grants. */
export type AgentShare = { name: string; share: string | undefined; grants?: string | undefined };

/** The servers each agent launches with, by name. A grant naming an undeclared server is reported
 *  (`error`) rather than thrown, so one stale persona can't take down a listing — the spawn still fails
 *  loud on it. */
export function serversByAgent(declared: string[], optIn: string[], agents: AgentShare[]): Map<string, { servers: string[]; error?: string }> {
  const out = new Map<string, { servers: string[]; error?: string }>();
  for (const a of agents) {
    try {
      out.set(a.name, { servers: effectiveServers({ declared, optIn, share: a.share, grants: a.grants, agent: a.name }) });
    } catch (e) {
      out.set(a.name, { servers: [], error: (e as Error).message });
    }
  }
  return out;
}

/** Which agents get `server`. With no opt-in servers and no grants this is the old rule — absent
 *  selection ⇒ everything, which is why an add reaches every agent without touching a single persona. */
export function agentsSharing(server: string, agents: AgentShare[], declared?: string[], optIn: string[] = []): { name: string; shares: boolean }[] {
  const all = declared ?? [server];
  const by = serversByAgent(all.includes(server) ? all : [...all, server], optIn, agents);
  return agents.map((a) => ({ name: a.name, shares: by.get(a.name)!.servers.includes(server) }));
}

/** The agents whose server set differs between two states — the ones a change needs restarted. */
export function changedAgents(before: Map<string, { servers: string[] }>, after: Map<string, { servers: string[] }>): string[] {
  return [...after.keys()].filter((n) => (before.get(n)?.servers ?? []).join(",") !== after.get(n)!.servers.join(","));
}

/** `a, b, c +N more` — the whole list only under --verbose, so a 150-agent fleet stays one line. */
export function nameList(names: string[], verbose: boolean): string {
  if (verbose || names.length <= NAMES_SHOWN) return names.join(", ");
  return `${names.slice(0, NAMES_SHOWN).join(", ")} ${c.dim(`+${names.length - NAMES_SHOWN} more (--verbose)`)}`;
}

/** Who gets a server, in a few words: "all agents (152)", "all agents (152) except a, b", or the names. */
export function whoLine(yes: string[], all: string[], optIn: boolean, verbose: boolean): string {
  if (!yes.length) return optIn ? c.dim("no agents yet — paw mcp only <server> <agent>") : c.dim("no agents");
  if (!optIn && yes.length === all.length) return c.green(`all agents (${all.length})`);
  const no = all.filter((n) => !yes.includes(n));
  // A handful left out reads better than the long list of who's in.
  if (!optIn && no.length <= NAMES_SHOWN && no.length < yes.length) return `${c.green(`all agents (${all.length})`)} except ${no.join(", ")}`;
  return `${yes.length}/${all.length}: ${nameList(yes, verbose)}`;
}

function writeConfig(path: string, config: CotalConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** The persona's frontmatter with `key:` set (or removed with undefined), the rest of the file kept. */
export function withPersonaKey(raw: string, key: string, value: string | undefined): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) throw new Error(`paw: that persona has no frontmatter block to write ${key} into`);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const kept = m[1].split(/\r?\n/).filter((l) => !l.trimStart().startsWith(`${key}:`));
  if (value !== undefined) kept.push(`${key}: ${value}`);
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---${eol}${kept.join(eol)}${eol}---`);
}

/** The persona's frontmatter with `shareTools:` set (or removed for the default "everything"). */
export function withShareTools(raw: string, value: string | undefined): string {
  return withPersonaKey(raw, "shareTools", value);
}

/** The persona with `server` added to (or removed from) its `mcpOptIn:` grants; the line goes when empty. */
export function withGrant(raw: string, server: string, on: boolean): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
  const line = fm.split(/\r?\n/).find((l) => l.trimStart().startsWith(`${GRANT_KEY}:`));
  const current = splitList(line?.slice(line.indexOf(":") + 1).replace(/["']/g, ""));
  const next = on ? (current.includes(server) ? current : [...current, server]) : current.filter((x) => x !== server);
  return withPersonaKey(raw, GRANT_KEY, next.length ? next.join(",") : undefined);
}

function readGrants(file: string): string | undefined {
  return existsSync(file) ? personaValue(file, GRANT_KEY)?.replace(/^["']|["']$/g, "") || undefined : undefined;
}

function setGrant(space: string, agent: string, server: string, on: boolean): void {
  const file = personaFilePath(space, agent);
  const raw = readFileSync(file, "utf8");
  const next = withGrant(raw, server, on);
  if (next !== raw) writeFileSync(file, next);
}

/** Drop `server` from every persona's grants in EVERY local space — run when the server stops being
 *  opt-in or is removed, so a stale grant can't fail some other space's next spawn. Returns the
 *  `space/agent` pairs touched. */
function dropGrantsEverywhere(server: string): string[] {
  const spaces = join(pawHomeDir(), "spaces");
  if (!existsSync(spaces)) return [];
  const touched: string[] = [];
  for (const s of readdirSync(spaces, { withFileTypes: true })) {
    const dir = join(spaces, s.name, "personas");
    if (!s.isDirectory() || !existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const file = join(dir, f);
      if (!splitList(readGrants(file)).includes(server)) continue;
      writeFileSync(file, withGrant(readFileSync(file, "utf8"), server, false));
      touched.push(`${s.name}/${f.slice(0, -3)}`);
    }
  }
  return touched;
}

/** Print the agents whose server set a change altered, each with its restart command. */
function printRestarts(names: string[], verbose: boolean, spaceFlag: string): void {
  if (!names.length) {
    console.log(c.dim(`  no agent's server set changed — nothing to restart`));
    return;
  }
  console.log(`\n${names.length} agent(s) pick this up at their next start — not restarted:`);
  const shown = verbose || names.length <= NAMES_SHOWN ? names : names.slice(0, NAMES_SHOWN);
  for (const n of shown) console.log(`  paw restart ${n}${spaceFlag}`);
  if (shown.length < names.length) console.log(c.dim(`  +${names.length - shown.length} more (--verbose lists every one)`));
}

export type McpArgs = {
  sub: string;
  rest: string[];
  space?: string;
  json?: string;
  cmd: string[];
  env: string[];
  headers: string[];
  transport?: string;
  only?: string;
  all: boolean;
  verbose: boolean;
  /** `--to <agent>`: a sandboxed agent's OWN servers (src/mcp-sandbox.ts), not the shared config. */
  to?: string;
  force: boolean;
  noRestart: boolean;
  now: boolean;
};

export function parseArgs(argv: string[]): McpArgs {
  const out: McpArgs = { sub: "", rest: [], cmd: [], env: [], headers: [], all: false, verbose: false, force: false, noRestart: false, now: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || (v.startsWith("-") && v !== "-")) throw new Error(`paw: ${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--` ends paw's own flags: everything after it is the server's command line, taken VERBATIM.
    // That is the shape `claude mcp add` uses and the shape the server's own docs are written in, so a
    // command can be pasted rather than translated — and its flags (`-y`, `--port`) can never be
    // mistaken for paw's, which is the whole reason the terminator exists.
    if (a === "--") {
      out.cmd = argv.slice(i + 1);
      break;
    }
    if (a === "--space") out.space = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--env" || a === "-e") out.env.push(value(++i, a));
    else if (a === "--header" || a === "-H") out.headers.push(value(++i, a));
    else if (a === "--transport" || a === "-t") out.transport = value(++i, a);
    else if (a === "--to") out.to = value(++i, "--to");
    else if (a.startsWith("--to=")) out.to = a.slice(5);
    else if (a === "--force") out.force = true;
    else if (a === "--no-restart") out.noRestart = true;
    else if (a === "--now") out.now = true;
    else if (a === "--only") {
      out.only = argv[++i];
      if (!out.only || out.only.startsWith("-")) throw new Error(`paw: --only takes agent names, e.g. \`--only evals,tracepaper\``);
    } else if (a === "--all") out.all = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — see \`paw mcp\` for usage`);
    else if (!out.sub) out.sub = a;
    else out.rest.push(a);
  }
  // `paw mcp add <name> <https-url>` — a URL can't be mistaken for a paw flag, so it needs no `--`.
  if (out.sub === "add" && !out.cmd.length && out.rest.length === 2 && /^https?:\/\//.test(out.rest[1])) out.cmd = [out.rest.pop()!];
  if (out.to !== undefined) {
    if (out.only !== undefined || out.all) throw new Error(`paw: --to installs into ONE sandboxed agent; --only/--all select shared servers — use one or the other`);
    if (!["", "add", "rm", "ls", "list"].includes(out.sub)) throw new Error(`paw: --to works with \`paw mcp add|ls|rm\`, not "${out.sub || "(none)"}"`);
  } else if (out.force || out.noRestart || out.now) throw new Error(`paw: --force/--no-restart/--now go with --to <agent> (a sandboxed agent's own servers)`);
  if (out.noRestart && out.now) throw new Error(`paw: --no-restart and --now contradict each other`);
  return out;
}

const USAGE = `paw mcp — which of your MCP servers paw's agents get

  paw mcp list [--verbose]                     what's configured, and who gets it
  paw mcp add <name> -- <cmd> [args…]          add a server (ALL agents get it)
  paw mcp add <name> <https://url>             …a remote server (http; --transport sse,
                                               --header 'K: V' repeatable)
  paw mcp add <name> --json '<entry>'          …or paste a .mcp.json entry
  paw mcp add <name> --only <a,b> -- …         add an OPT-IN server: only those agents get it
      e.g. paw mcp add github [--env TOKEN=\${GITHUB_TOKEN}] -- npx -y @mcp/server-github
  paw mcp only <server> <a,b>                  make a server opt-in, for exactly those agents
  paw mcp only <server> --all                  share it with every agent again
  paw mcp rm <name>                            remove a server
  paw mcp share <server> <agent>               give ONE agent this server
  paw mcp unshare <server> <agent>             take it away from that agent
  paw mcp share <agent> <a,b|all|none>         set an agent's whole selection

A SANDBOXED agent's own servers (its VM's claude user scope — the shared ones never reach a VM):
  paw mcp add <name> --to <agent>[#space] [--env K=V] -- <cmd> [args…]   (cmd must exist IN the VM)
  paw mcp add <name> --to <agent>[#space] <https://url> [--transport sse] [--header 'K: V']
  paw mcp ls --to <agent>[#space]              its servers
  paw mcp rm <name> --to <agent>[#space]       remove one
      add/rm RESTART a live agent so the change loads (that's your go for it);
      --no-restart skips, a busy agent is left alone unless --now; --force replaces a same-named server

Servers are defined in cotal's own config (${globalConfigPath()}); the per-agent
selection lives in the agent's persona (shareTools:, and mcpOptIn: for opt-in servers —
an agent named for one gets it even with shareTools: none). Nothing here restarts an
agent — claude reads MCP config at startup, so restart the ones named to pick a change up.
\`--to\` is the exception: it restarts the one agent you named.`;

async function run(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const space = a.space?.trim() || resolveSpace();
  if (a.to !== undefined) return runTo(a, space, realEnableDeps());
  const path = globalConfigPath();
  const config = readConfig(path);
  const declared = config.connectors?.[PAW_CONNECTOR]?.mcpServers ?? {};
  const names = Object.keys(declared);
  const optIn = optInServers(config, path);
  const loadAgents = (): AgentShare[] =>
    listAgents(space).map((r) => {
      const file = personaFilePath(space, r.name);
      return { name: r.name, share: readShareTools(file), grants: readGrants(file) };
    });
  const agents = loadAgents();
  const before = serversByAgent(names, optIn, agents);
  const requireAgents = (list: string): string[] => {
    const wanted = splitList(list);
    if (!wanted.length) throw new Error(`paw: name at least one agent, e.g. \`evals\` or \`evals,tracepaper\``);
    const unknown = wanted.filter((w) => !agents.some((x) => x.name === w));
    if (unknown.length) throw new Error(`paw: no agent named ${unknown.map((u) => `"${u}"`).join(", ")} in space "${space}" (see \`paw status\`)`);
    return wanted;
  };
  /** Restart hints for the agents whose set changed, re-reading the state just written. */
  const reportChange = () => {
    const cfg = readConfig(path);
    const after = serversByAgent(Object.keys(cfg.connectors?.[PAW_CONNECTOR]?.mcpServers ?? {}), optInServers(cfg, path), loadAgents());
    printRestarts(changedAgents(before, after), a.verbose, a.space ? ` --space ${space}` : "");
  };

  if (!a.sub || a.sub === "list" || a.sub === "ls") {
    console.log(c.dim(path));
    if (!names.length) {
      console.log(`\nno MCP servers shared with paw agents — every agent gets cotal's server only`);
      console.log(c.dim(`\nadd one:  paw mcp add github -- npx -y @modelcontextprotocol/server-github`));
      return;
    }
    for (const name of names) {
      const spec = declared[name];
      const how = spec.command ? `${spec.command} ${(spec.args ?? []).join(" ")}`.trim() : (spec.url ?? "");
      const opt = optIn.includes(name);
      console.log(`\n${c.bold(name)}${opt ? ` ${c.yellow("[opt-in]")}` : ""}  ${c.dim(how)}`);
      const yes = agents.filter((x) => before.get(x.name)!.servers.includes(name)).map((x) => x.name);
      console.log(`  ${whoLine(yes, agents.map((x) => x.name), opt, a.verbose)}`);
    }
    // Agents with an explicit selection are worth naming: "all agents" answers "who gets this server",
    // but not "who is now limited", and a limited agent is the thing an operator forgets they set.
    // Grouped by selection so 40 `none` agents are one line, not 40 entries.
    const limited = agents.filter((x) => x.share !== undefined);
    if (limited.length) {
      const bySel = new Map<string, string[]>();
      for (const x of limited) bySel.set(x.share!, [...(bySel.get(x.share!) ?? []), x.name]);
      console.log(`\n${c.dim(`limited to a selection (${limited.length}):`)}`);
      for (const [sel, who] of bySel) console.log(`  ${sel} ${c.dim("←")} ${nameList(who, a.verbose)}`);
    }
    // A selection naming a server that isn't declared makes the spawn FAIL (cotal refuses rather than
    // silently dropping it; a dangling grant is refused by paw), so it is surfaced here rather than at
    // the next restart.
    for (const ag of agents) {
      const sel = ag.share?.trim().toLowerCase();
      const missing = sel && sel !== "none" ? splitList(ag.share).filter((s) => !(s in declared)) : [];
      if (missing.length) console.log(c.yellow(`\n⚠ ${ag.name} selects ${missing.join(", ")}, which isn't declared — its next spawn will fail`));
      const err = before.get(ag.name)!.error;
      if (err) console.log(c.yellow(`\n⚠ ${err.replace(/^paw: /, "")} — its next spawn will fail`));
    }
    for (const s of optIn.filter((x) => !(x in declared))) console.log(c.dim(`\n(${OPT_IN_KEY} names "${s}", which isn't declared — harmless; \`paw mcp only ${s} --all\` drops it)`));
    return;
  }

  if (a.sub === "add") {
    const name = a.rest[0];
    if (!name) throw new Error(`paw: name the server — \`paw mcp add <name> -- <cmd> [args…]\``);
    if (!isValidServerName(name)) throw new Error(`paw: "${name}" isn't a valid server name (letters, digits, dash, underscore)`);
    const spec = buildSpec(a);
    // Validate EVERY named agent before writing anything: a half-applied --only (server written, some
    // grants missing) would leave a server nobody meant to get.
    const only = a.only !== undefined ? requireAgents(a.only) : undefined;
    // Re-adding an opt-in server under its name without --only keeps it opt-in: an `add` that silently
    // widened a private server to the whole fleet is exactly the leak opt-in exists to prevent.
    const keepsOptIn = only === undefined && optIn.includes(name);
    // The mark is written in the SAME write as the definition: no window where it is shared.
    writeConfig(path, only !== undefined ? withOptInMark(withServer(config, name, spec), name, true) : withServer(config, name, spec));
    for (const ag of only ?? []) setGrant(space, ag, name, true);
    console.log(`✓ added ${c.bold(name)} to ${c.dim(path)}${only ? ` — opt-in, for ${only.join(", ")}` : keepsOptIn ? ` — still opt-in (\`paw mcp only ${name} --all\` shares it)` : ""}`);
    reportChange();
    return;
  }

  if (a.sub === "only") {
    const [server, list] = a.rest;
    if (!server || (!list && !a.all) || (list && a.all))
      throw new Error(`paw: \`paw mcp only <server> <agent>[,<agent>…]\` or \`paw mcp only <server> --all\``);
    if (a.all) {
      if (!optIn.includes(server)) {
        console.log(`${c.bold(server)} is already shared with every agent (that hasn't limited its selection)`);
        return;
      }
      writeConfig(path, withOptInMark(config, server, false));
      const dropped = dropGrantsEverywhere(server);
      console.log(`✓ ${c.bold(server)} is shared again — every agent without a selection gets it`);
      if (dropped.length) console.log(c.dim(`  dropped its now-redundant ${GRANT_KEY} from ${nameList(dropped, a.verbose)}`));
      reportChange();
      return;
    }
    if (!(server in declared)) throw new Error(`paw: no MCP server named "${server}" is configured — \`paw mcp list\` shows what is`);
    const wanted = requireAgents(list);
    writeConfig(path, withOptInMark(config, server, true));
    for (const ag of agents) setGrant(space, ag.name, server, wanted.includes(ag.name));
    console.log(`✓ ${c.bold(server)} is opt-in — only ${wanted.join(", ")} get it in space "${space}"`);
    reportChange();
    return;
  }

  if (a.sub === "rm") {
    const name = a.rest[0];
    if (!name) throw new Error(`paw: name the server to remove — \`paw mcp rm <name>\``);
    const next = withoutServer(config, name);
    if (!next) throw new Error(`paw: no MCP server named "${name}" is configured (see \`paw mcp list\`)`);
    writeConfig(path, next);
    const dropped = dropGrantsEverywhere(name);
    console.log(`✓ removed ${c.bold(name)} — agents keep it until they restart`);
    if (dropped.length) console.log(c.dim(`  dropped its ${GRANT_KEY} grant from ${nameList(dropped, a.verbose)}`));
    reportChange();
    return;
  }

  if (a.sub === "share" || a.sub === "unshare") {
    const [first, second] = a.rest;
    if (!first || !second) throw new Error(`paw: \`paw mcp ${a.sub} <server> <agent>\` (or \`paw mcp share <agent> <a,b|all|none>\`)`);
    // Both orders read naturally — "share tracepaper with evals" and "give evals these servers" — so the
    // ARGUMENTS say which was meant rather than the operator having to remember an order.
    //
    // Resolved by looking at BOTH tokens, not just the first: a name is very often both a server and an
    // agent (a folder called `tracepaper` running the `tracepaper` server is the normal case, not a
    // clash), so judging the first alone rejects the most ordinary command there is. The pair is what
    // disambiguates — `<server> <agent>` is meant when the SECOND names an agent.
    const known0 = agents.find((x) => x.name === second);
    // A dangling grant (its server since removed by hand) must still be removable by name.
    const firstIsServer = first in declared || (a.sub === "unshare" && !!known0 && splitList(known0.grants).includes(first));
    const firstIsAgent = agents.some((x) => x.name === first);
    const secondIsAgent = !!known0;
    const serverFirst = firstIsServer && secondIsAgent;
    if (!serverFirst && !firstIsAgent)
      throw new Error(
        `paw: can't tell what to share — \`paw mcp ${a.sub} <server> <agent>\`.\n` +
          `       "${first}" is ${firstIsServer ? "a server, but " : "not a configured server"}` +
          `${firstIsServer ? `"${second}" isn't an agent` : ` and not a registered agent`}.\n` +
          `       \`paw mcp list\` shows the servers; \`paw status\` shows the agents.`,
      );
    const [server, agent] = serverFirst ? [first, second] : [second, first];
    const known = agents.find((x) => x.name === agent);

    // The agent-first SETTER: `share <agent> all|none|a,b` replaces the whole selection.
    if (!serverFirst && known && (["all", "none"].includes(second.trim().toLowerCase()) || second.includes(",") || second in declared)) {
      const sel = second.trim().toLowerCase();
      // "all" is the ABSENCE of a selection, not a literal — cotal reads an omitted --share-tools as
      // "every declared server", so writing the word would make a name it must then find.
      const value = sel === "all" ? undefined : second.trim();
      if (value && sel !== "none")
        for (const x of splitList(value))
          if (!(x in declared)) throw new Error(`paw: no MCP server named "${x}" is configured — \`paw mcp list\` shows what is`);
      const file = personaFilePath(space, agent);
      writeFileSync(file, withShareTools(readFileSync(file, "utf8"), value));
      const grants = splitList(known.grants);
      console.log(
        `✓ ${c.bold(agent)} now gets ${value === undefined ? c.green(optIn.length ? "every shared server" : "every server") : sel === "none" ? "no shared servers" : value}` +
          `${grants.length ? ` + opt-in ${grants.join(", ")}` : ""}`,
      );
      reportChange();
      return;
    }

    if (!known) throw new Error(`paw: no agent named "${agent}" (see \`paw status\`)`);
    const dangling = a.sub === "unshare" && !(server in declared) && splitList(known.grants).includes(server);
    if (!(server in declared) && !dangling) throw new Error(`paw: no MCP server named "${server}" is configured — \`paw mcp list\` shows what is`);

    // An OPT-IN server is granted by name in `mcpOptIn:`, independent of `shareTools:` — so sharing it
    // never narrows the agent's other servers, and a `none` agent can still be named for one.
    if (optIn.includes(server) || dangling) {
      const has = splitList(known.grants).includes(server);
      if (a.sub === "share" && has) return void console.log(`${c.bold(agent)} already gets ${server}`);
      if (a.sub === "unshare" && !has) return void console.log(`${c.bold(agent)} doesn't get ${server} anyway (it's opt-in)`);
      setGrant(space, agent, server, a.sub === "share");
      console.log(`✓ ${c.bold(agent)} ${a.sub === "share" ? "now gets" : "no longer gets"} the opt-in server ${server}`);
      reportChange();
      return;
    }

    const current = known.share?.trim();
    const list = current && current.toLowerCase() !== "none" ? splitList(current) : [];
    if (a.sub === "share") {
      // An agent with NO selection already gets every shared server, so "share" is already true of it.
      // Saying so beats writing a selection — that would silently RESTRICT it to this one server, the
      // opposite of what the word means.
      if (current === undefined) {
        console.log(`${c.bold(agent)} already gets ${c.green("every shared server")}, including ${server} — nothing to change`);
        console.log(c.dim(`  to give it ONLY some:  paw mcp share ${agent} ${server}`));
        return;
      }
      if (list.includes(server)) {
        console.log(`${c.bold(agent)} already gets ${server}`);
        return;
      }
      list.push(server);
    } else {
      if (current === undefined) {
        // Removing one from "everything" means naming the rest — there is no "all but this" to write.
        // The rest is the SHARED servers only: an opt-in server written into shareTools would be a grant.
        const rest = names.filter((x) => x !== server && !optIn.includes(x));
        const file = personaFilePath(space, agent);
        writeFileSync(file, withShareTools(readFileSync(file, "utf8"), rest.length ? rest.join(",") : "none"));
        console.log(`✓ ${c.bold(agent)} no longer gets ${server} ${c.dim(`(now limited to ${rest.length ? rest.join(",") : "no shared servers"})`)}`);
        reportChange();
        return;
      }
      if (!list.includes(server)) {
        console.log(`${c.bold(agent)} doesn't get ${server} anyway`);
        return;
      }
      list.splice(list.indexOf(server), 1);
    }
    const file = personaFilePath(space, agent);
    writeFileSync(file, withShareTools(readFileSync(file, "utf8"), list.length ? list.join(",") : "none"));
    console.log(`✓ ${c.bold(agent)} now gets ${list.length ? list.join(",") : "no shared servers"}`);
    reportChange();
    return;
  }

  throw new Error(`paw: unknown \`paw mcp\` command "${a.sub}"\n\n${USAGE}`);
}

/** `paw mcp add|ls|rm … --to <agent>`: a sandboxed agent's OWN servers, in its VM's claude user scope.
 *  Exported with its deps injected so check:mcp-sandbox runs it against a fake agent. */
export async function runTo(a: McpArgs, space: string, deps: EnableDeps): Promise<void> {
  const t = sandboxTarget(space, a.to!);
  const addr = `${t.name}#${t.space}`;
  if (a.sub === "" || a.sub === "ls" || a.sub === "list") {
    const listed = listedServers(readClaudeJson(t.claudeJson), t.cwd);
    deps.log(c.dim(`${t.claudeJson}  (in the VM: /paw/claude/.claude.json)`));
    if (!listed.length) return deps.log(`\n${t.name} has no MCP servers of its own — add one: paw mcp add <name> --to ${addr} <https://url>`);
    for (const x of listed) deps.log(`${c.bold(x.name)}${x.scope === "local" ? c.dim(" [local scope: this folder]") : ""}  ${c.dim(describeServer(x.spec))}`);
    return;
  }
  const name = a.rest[0];
  if (!name) throw new Error(`paw: name the server — \`paw mcp ${a.sub} <name> --to ${addr}${a.sub === "add" ? " <https://url>|-- <cmd>" : ""}\``);
  if (a.sub === "rm") {
    const doc = readClaudeJson(t.claudeJson);
    const next = withoutUserServer(doc, name);
    if (!next) {
      const local = listedServers(doc, t.cwd).some((x) => x.scope === "local" && x.name === name);
      throw new Error(
        `paw: ${t.name} has no user-scope server "${name}"${local ? ` — it is in LOCAL scope (added inside the VM); remove it there: \`paw sandbox shell ${addr}\` → \`claude mcp remove ${name} -s local\`` : ` (\`paw mcp ls --to ${addr}\`)`}`,
      );
    }
    writeClaudeJson(t.claudeJson, next);
    deps.log(`✓ removed ${c.bold(name)} from ${t.name}'s servers ${c.dim(`(${t.claudeJson})`)}`);
    await enableInAgent(t, { server: name, verb: "rm", noRestart: a.noRestart, now: a.now }, deps);
    return;
  }
  if (!isValidServerName(name)) throw new Error(`paw: "${name}" isn't a valid server name (letters, digits, dash, underscore, dot, colon)`);
  if (RESERVED_SANDBOX_SERVERS.includes(name)) throw new Error(`paw: "${name}" is the mesh server every agent launches with — pick another name`);
  const spec = claudeUserSpec(buildSpec(a));
  const { doc, replaced } = withUserServer(readClaudeJson(t.claudeJson), name, spec, a.force);
  if (spec.type === "stdio") checkCommandInVm(t, spec.command!, deps);
  writeClaudeJson(t.claudeJson, doc);
  deps.log(`✓ ${replaced ? "replaced" : "added"} ${c.bold(name)} in ${t.name}'s VM ${c.dim(`(${describeServer(spec)}; user scope, ${t.claudeJson})`)}`);
  const secrets = [...Object.keys(spec.env ?? {}), ...Object.keys(spec.headers ?? {})];
  if (secrets.length)
    deps.log(c.dim(`  ${secrets.join(", ")} stored in plain text in ${t.name}'s claude dir (0600) — same trust as its home: the agent can read it, and so can any host process of this user`));
  await enableInAgent(t, { server: name, verb: "add", noRestart: a.noRestart, now: a.now }, deps);
}

const mcpCommand: Command = {
  kind: "command",
  name: "mcp",
  group: "Agents",
  summary: "which of your MCP servers paw's agents get",
  usage: "mcp [list|add|only|rm|share|unshare] … [--to <agent>] (see `paw mcp`)",
  run: (a) => run([...a.raw]),
};

registry.register(mcpCommand);

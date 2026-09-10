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
 *
 * NOTHING HERE RESTARTS AN AGENT. An MCP server is read by claude at startup, so a running agent keeps
 * the set it launched with — and restarting someone's agents as a side effect of editing config is not
 * a decision a config command gets to make. Every command that changes what an agent WOULD get says
 * which live agents are now stale and prints the command to restart them.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath, registry, type Command, type CotalConfig, type McpServerSpec } from "@cotal-ai/core";
import { listAgents, personaFilePath } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { readShareTools } from "../session.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), green: wrap("32"), yellow: wrap("33") };

/** The connector paw's agents actually spawn under. NOT "paw": bin/cotald.ts registers paw's connector
 *  under the manager's default agent type, replacing the vanilla one, so cotal looks up shared servers
 *  under `claude`. Writing them under any other key configures nothing, silently. */
export const PAW_CONNECTOR = "claude";

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

/** Drop a server, leaving the rest of the file alone. Returns undefined when it wasn't there, so the
 *  caller can fail loud instead of reporting a removal that didn't happen. */
export function withoutServer(config: CotalConfig, name: string): CotalConfig | undefined {
  const existing = config.connectors?.[PAW_CONNECTOR]?.mcpServers;
  if (!existing || !(name in existing)) return undefined;
  const servers = { ...existing };
  delete servers[name];
  const connectors = { ...(config.connectors ?? {}) };
  connectors[PAW_CONNECTOR] = { ...connectors[PAW_CONNECTOR], mcpServers: servers };
  return { ...config, connectors };
}

/** A server name is a bare token: it becomes a key in a `.mcp.json` and is matched by `--share-tools`,
 *  so anything needing quoting would be a name you could never select. */
export function isValidServerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

/**
 * Build a server spec from the flags. `--json` takes a whole `.mcp.json` entry (copy one straight out
 * of your Claude config); the long form builds the common stdio case.
 *
 * A spec with neither `command` nor `url` is refused: it would write a config entry that can never
 * launch, and the failure would surface much later as a broken agent rather than here.
 */
export function buildSpec(opts: { json?: string; cmd: string[]; env: string[] }): McpServerSpec {
  if (opts.json !== undefined) {
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
  const spec: McpServerSpec = { command };
  if (args.length) spec.args = args;
  if (Object.keys(env).length) spec.env = env;
  return spec;
}

/** Which agents currently get `server`, given each one's `shareTools:` selection. Absent selection ⇒
 *  everything, which is why an add reaches every agent without touching a single persona. */
export function agentsSharing(
  server: string,
  agents: { name: string; share: string | undefined }[],
): { name: string; shares: boolean }[] {
  return agents.map((a) => {
    if (a.share === undefined) return { name: a.name, shares: true };
    const sel = a.share.trim().toLowerCase();
    if (sel === "none" || sel === "") return { name: a.name, shares: false };
    return { name: a.name, shares: sel.split(",").map((s) => s.trim()).includes(server.toLowerCase()) };
  });
}

function writeConfig(path: string, config: CotalConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** The persona's frontmatter with `shareTools:` set (or removed for the default "everything"). */
export function withShareTools(raw: string, value: string | undefined): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) throw new Error(`paw: that persona has no frontmatter block to write shareTools into`);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const kept = m[1].split(/\r?\n/).filter((l) => !l.trimStart().startsWith("shareTools:"));
  if (value !== undefined) kept.push(`shareTools: ${value}`);
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---${eol}${kept.join(eol)}${eol}---`);
}

function parseArgs(argv: string[]): { sub: string; rest: string[]; space?: string; json?: string; cmd: string[]; env: string[] } {
  const out = { sub: "", rest: [] as string[], space: undefined as string | undefined, json: undefined as string | undefined, cmd: [] as string[], env: [] as string[] };
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
    else if (a === "--env") out.env.push(argv[++i]);
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — see \`paw mcp\` for usage`);
    else if (!out.sub) out.sub = a;
    else out.rest.push(a);
  }
  return out;
}

const USAGE = `paw mcp — which of your MCP servers paw's agents get

  paw mcp list                                 what's configured, and who gets it
  paw mcp add <name> -- <cmd> [args…]          add a server (ALL agents get it)
  paw mcp add <name> --json '<entry>'          …or paste a .mcp.json entry
      e.g. paw mcp add github [--env TOKEN=\${GITHUB_TOKEN}] -- npx -y @mcp/server-github
  paw mcp rm <name>                            remove a server
  paw mcp share <server> <agent>               give ONE agent this server
  paw mcp unshare <server> <agent>             take it away from that agent
  paw mcp share <agent> <a,b|all|none>         set an agent's whole selection

Servers are defined in cotal's own config (${globalConfigPath()}); the per-agent
selection lives in the agent's persona. Nothing here restarts an agent — claude reads
MCP config at startup, so restart the ones named to pick a change up.`;

async function run(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const space = a.space?.trim() || resolveSpace();
  const path = globalConfigPath();
  const config = readConfig(path);
  const declared = config.connectors?.[PAW_CONNECTOR]?.mcpServers ?? {};
  const agents = listAgents(space).map((r) => ({ name: r.name, share: readShareTools(personaFilePath(space, r.name)) }));

  if (!a.sub || a.sub === "list") {
    console.log(c.dim(path));
    const names = Object.keys(declared);
    if (!names.length) {
      console.log(`\nno MCP servers shared with paw agents — every agent gets cotal's server only`);
      console.log(c.dim(`\nadd one:  paw mcp add github -- npx -y @modelcontextprotocol/server-github`));
      return;
    }
    for (const name of names) {
      const spec = declared[name];
      const how = spec.command ? `${spec.command} ${(spec.args ?? []).join(" ")}`.trim() : (spec.url ?? "");
      console.log(`\n${c.bold(name)}  ${c.dim(how)}`);
      const who = agentsSharing(name, agents);
      const yes = who.filter((w) => w.shares).map((w) => w.name);
      console.log(`  ${yes.length === agents.length ? c.green("all agents") : yes.length ? yes.join(", ") : c.dim("no agents")}`);
    }
    // Agents with an explicit selection are worth naming: "all agents" answers "who gets this server",
    // but not "who is now limited", and a limited agent is the thing an operator forgets they set.
    const limited = agents.filter((x) => x.share !== undefined);
    if (limited.length)
      console.log(`\n${c.dim("limited to a selection:")} ${limited.map((x) => `${x.name} → ${x.share}`).join(", ")}`);
    // A selection naming a server that isn't declared makes the spawn FAIL (cotal refuses rather than
    // silently dropping it), so it is worth surfacing here rather than at the next restart.
    for (const ag of agents) {
      const sel = ag.share?.trim().toLowerCase();
      if (!sel || sel === "none") continue;
      const missing = sel.split(",").map((s) => s.trim()).filter((s) => s && !(s in declared));
      if (missing.length) console.log(c.yellow(`\n⚠ ${ag.name} selects ${missing.join(", ")}, which isn't declared — its next spawn will fail`));
    }
    return;
  }

  if (a.sub === "add") {
    const name = a.rest[0];
    if (!name) throw new Error(`paw: name the server — \`paw mcp add <name> -- <cmd> [args…]\``);
    if (!isValidServerName(name)) throw new Error(`paw: "${name}" isn't a valid server name (letters, digits, dash, underscore)`);
    const spec = buildSpec(a);
    writeConfig(path, withServer(config, name, spec));
    console.log(`✓ added ${c.bold(name)} to ${c.dim(path)}`);
    // Everyone whose selection would include it. Deliberately NOT restarted here.
    const stale = agentsSharing(name, agents).filter((w) => w.shares).map((w) => w.name);
    if (stale.length) {
      console.log(`\n${stale.length} agent(s) will get it on their next start: ${stale.join(", ")}`);
      console.log(c.dim(`  restart one now:  paw restart <name>`));
    }
    return;
  }

  if (a.sub === "rm") {
    const name = a.rest[0];
    if (!name) throw new Error(`paw: name the server to remove — \`paw mcp rm <name>\``);
    const next = withoutServer(config, name);
    if (!next) throw new Error(`paw: no MCP server named "${name}" is configured (see \`paw mcp list\`)`);
    writeConfig(path, next);
    console.log(`✓ removed ${c.bold(name)} — agents keep it until they restart`);
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
    const firstIsServer = first in declared;
    const firstIsAgent = agents.some((x) => x.name === first);
    const secondIsAgent = agents.some((x) => x.name === second);
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
        for (const x of value.split(",").map((y) => y.trim()))
          if (!(x in declared)) throw new Error(`paw: no MCP server named "${x}" is configured — \`paw mcp list\` shows what is`);
      const file = personaFilePath(space, agent);
      writeFileSync(file, withShareTools(readFileSync(file, "utf8"), value));
      console.log(`✓ ${c.bold(agent)} now gets ${value === undefined ? c.green("every server") : sel === "none" ? "no servers" : value}`);
      console.log(c.dim(`  it keeps its current set until restarted:  paw restart ${agent}`));
      return;
    }

    if (!known) throw new Error(`paw: no agent named "${agent}" (see \`paw status\`)`);
    if (!(server in declared)) throw new Error(`paw: no MCP server named "${server}" is configured — \`paw mcp list\` shows what is`);

    const current = known.share?.trim();
    const list = current && current.toLowerCase() !== "none" ? current.split(",").map((x) => x.trim()).filter(Boolean) : [];
    if (a.sub === "share") {
      // An agent with NO selection already gets every server, so "share" is already true of it. Saying
      // so beats writing a selection — that would silently RESTRICT it to this one server, the opposite
      // of what the word means.
      if (current === undefined) {
        console.log(`${c.bold(agent)} already gets ${c.green("every server")}, including ${server} — nothing to change`);
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
        const rest = Object.keys(declared).filter((x) => x !== server);
        const file = personaFilePath(space, agent);
        writeFileSync(file, withShareTools(readFileSync(file, "utf8"), rest.length ? rest.join(",") : "none"));
        console.log(`✓ ${c.bold(agent)} no longer gets ${server} ${c.dim(`(now limited to ${rest.length ? rest.join(",") : "no servers"})`)}`);
        console.log(c.dim(`  it keeps its current set until restarted:  paw restart ${agent}`));
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
    console.log(`✓ ${c.bold(agent)} now gets ${list.length ? list.join(",") : "no servers"}`);
    console.log(c.dim(`  it keeps its current set until restarted:  paw restart ${agent}`));
    return;
  }

  throw new Error(`paw: unknown \`paw mcp\` command "${a.sub}"\n\n${USAGE}`);
}

const mcpCommand: Command = {
  kind: "command",
  name: "mcp",
  group: "Agents",
  summary: "which of your MCP servers paw's agents get",
  usage: "mcp [list|add|rm|share|unshare] … (see `paw mcp`)",
  run: (a) => run([...a.raw]),
};

registry.register(mcpCommand);

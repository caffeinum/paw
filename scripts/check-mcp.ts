/**
 * `paw mcp` (src/commands/mcp.ts) — which of the operator's MCP servers each agent gets.
 *
 * Hermetic: every function under test is pure, so no config file is written and no agent is spawned.
 *
 * What these defend, in order of what it costs to get wrong:
 *  1. **The connector key.** Servers are looked up under the connector an agent SPAWNS as, which for
 *     paw is `claude` (bin/cotald.ts replaces the vanilla one). Under any other key the config parses
 *     fine, cotal reads it, and shares nothing — a silent no-op is the worst possible failure here.
 *  2. **Merging, not replacing.** That file is the operator's; other connectors, other servers and keys
 *     paw knows nothing about must survive an add and a remove.
 *  3. **Absent ≠ none.** No `shareTools:` means "every declared server" (cotal's own default, and what
 *     `paw mcp add` promises); `none` means the operator chose nothing. Collapsing them would either
 *     silently un-share everything or make "none" unexpressible.
 *
 * Run: pnpm check:mcp
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-mcp-home-"));

const { PAW_CONNECTOR, withServer, withoutServer, buildSpec, isValidServerName, agentsSharing, withShareTools, readConfig, withOptInMark, optInServers, withGrant, serversByAgent, changedAgents, whoLine } =
  await import("../src/commands/mcp.ts");
const { shareSelection, effectiveServers, readOptIn, OPT_IN_KEY, GRANT_KEY } = await import("../src/mcp-select.ts");
const { readCotalConfigFile, loadCotalConfig, connectorServers } = await import("@cotal-ai/core");
const { readShareTools, readAgentType } = await import("../src/session.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// 1. The connector key. paw spawns under the manager's default agent type, which bin/cotald.ts binds to
// paw's own connector — writing servers anywhere else configures nothing at all.
assert(PAW_CONNECTOR === "claude", "servers are written under `claude` — the connector paw's agents actually spawn as");

// 2. Merge, never clobber.
const existing = {
  connectors: {
    claude: { mcpServers: { keepme: { command: "old" } } },
    opencode: { mcpServers: { theirs: { command: "x" } } },
  },
} as never;
const added = withServer(existing, "github", { command: "npx", args: ["-y", "pkg"] });
assert(added.connectors?.claude?.mcpServers?.github?.command === "npx", "add writes the new server");
assert(added.connectors?.claude?.mcpServers?.keepme !== undefined, "add keeps other servers under the same connector");
assert(added.connectors?.opencode?.mcpServers?.theirs !== undefined, "add keeps OTHER connectors untouched");
assert((existing as { connectors: object }).connectors !== added.connectors, "add is pure — the input config is not mutated");

const removed = withoutServer(added, "github");
assert(removed?.connectors?.claude?.mcpServers?.github === undefined, "remove drops the named server");
assert(removed?.connectors?.claude?.mcpServers?.keepme !== undefined, "remove keeps the rest");
assert(withoutServer(added, "nope") === undefined, "removing something absent reports nothing rather than a silent success");

// 3. Server names must be selectable by --share-tools, so they are bare tokens.
for (const ok of ["github", "tavily-2", "a_b"]) assert(isValidServerName(ok), `valid name: ${ok}`);
// A plugin-style name must be allowed: claude keys stored MCP OAuth by `<name>|hash(config)`, so
// `plugin:slack:slack` under any other name would need a browser login the agent can't do.
assert(isValidServerName("plugin:slack:slack"), "a plugin-style name (colons) is a valid server name");
assert(isValidServerName("my.server"), "a dotted name is valid");
assert(!isValidServerName("a,b"), "a comma is refused — shareTools: splits on it");
assert(!isValidServerName("a b"), "whitespace is refused");

for (const bad of ["", "a b", "--flag", "-x", "a;b", "a/b", "x".repeat(65)]) assert(!isValidServerName(bad), `rejected name: ${JSON.stringify(bad)}`);

// 4. Specs. A spec that can never launch is refused HERE, not discovered later as a broken agent.
// Everything after `--` is the server's command line, verbatim — including its own flags, which is
// the point of the terminator: `-y` belongs to npx, not to paw.
const npx = buildSpec({ cmd: ["npx", "-y", "@mcp/server-github"], env: ["T=${TOK}"] });
assert(npx.command === "npx", "the first word after `--` is the command");
assert(npx.args?.join(" ") === "-y @mcp/server-github", "the rest are its args, flags included");
assert(npx.env?.T === "${TOK}", "env keeps ${VAR} refs verbatim — secrets go by NAME, never as literals");
assert(buildSpec({ cmd: ["server"], env: [] }).args === undefined, "a bare command carries no empty args array");
assert(buildSpec({ json: '{"command":"x"}', cmd: [], env: [] }).command === "x", "--json takes a whole .mcp.json entry");
assert(buildSpec({ json: '{"url":"https://x","type":"http"}', cmd: [], env: [] }).url === "https://x", "a remote server (url) is accepted too");
assert(throws(() => buildSpec({ json: "{", cmd: [], env: [] })), "malformed --json fails loud");
assert(throws(() => buildSpec({ json: '{"args":[]}', cmd: [], env: [] })), "a spec with neither command nor url is refused");
assert(throws(() => buildSpec({ cmd: [], env: [] })), "nothing after `--` and no --json is refused");
assert(throws(() => buildSpec({ cmd: ["x"], env: ["NOPE"] })), "--env without = fails loud");

// 5. Absent ≠ none. This is the rule that makes `paw mcp add` reach every agent without editing a
// single persona, while still letting one agent opt out entirely.
const agents = [
  { name: "default", share: undefined },
  { name: "picky", share: "github" },
  { name: "other", share: "tavily" },
  { name: "opted-out", share: "none" },
];
const who = agentsSharing("github", agents);
assert(who.find((w) => w.name === "default")?.shares === true, "no selection ⇒ gets every server (cotal's default; what `add` promises)");
assert(who.find((w) => w.name === "picky")?.shares === true, "a selection naming it ⇒ gets it");
assert(who.find((w) => w.name === "other")?.shares === false, "a selection NOT naming it ⇒ doesn't get it");
assert(who.find((w) => w.name === "opted-out")?.shares === false, "`none` is a real choice, distinct from absent");
assert(agentsSharing("github", [{ name: "x", share: "tavily , github" }])[0].shares, "selections tolerate spaces around names");
// cotal looks a selected name up EXACTLY (connectorServers: Object.hasOwn), so the listing must not claim
// a case-mismatched selection shares — that spawn fails, it doesn't get the server.
assert(!agentsSharing("github", [{ name: "x", share: "GitHub" }])[0].shares, "a case-mismatched selection does NOT share (cotal matches names exactly)");

// 6. The persona round-trip: written, read back, and removable without disturbing the rest.
const persona = "---\nname: evals\nresume: 1234\nallowPublish: [\">\"]\n---\nbody text\n";
const withSel = withShareTools(persona, "github,tavily");
assert(/^shareTools: github,tavily$/m.test(withSel), "share writes the selection into the frontmatter");
assert(withSel.includes("resume: 1234") && withSel.includes("body text"), "the pin and the body survive");
const file = join(process.env.PAW_HOME!, "p.md");
writeFileSync(file, withSel);
assert(readShareTools(file) === "github,tavily", "what `share` writes is what the spawn reads back");
const cleared = withShareTools(withSel, undefined);
assert(!/shareTools:/.test(cleared), "clearing removes the line entirely");
writeFileSync(file, cleared);
assert(readShareTools(file) === undefined, "a cleared selection reads back as the default (every server)");
assert(cleared.includes("resume: 1234") && cleared.includes("body text"), "clearing keeps the pin and the body");
assert(withShareTools(withSel, "none").match(/shareTools:/g)?.length === 1, "re-setting replaces rather than appending a second line");
assert(throws(() => withShareTools("no frontmatter", "x")), "a persona with no frontmatter fails loud rather than writing a broken file");
assert(readShareTools(join(process.env.PAW_HOME!, "gone.md")) === undefined, "a MISSING persona reads as no selection — one absent file can't take down a listing");

// 6b. `share <server> <agent>` vs `share <agent> <selection>` — resolved by BOTH tokens.
// A name is very often both a server and an agent (a folder `tracepaper` running the `tracepaper`
// server is the normal case, not a clash), so judging the FIRST token alone rejected the most ordinary
// command there is — caught by running it, on the operator's own setup.
{
  const declared = { tracepaper: {}, github: {} };
  const known = ["evals", "tracepaper"];
  const resolve = (first: string, second: string) => {
    const firstIsServer = first in declared;
    const firstIsAgent = known.includes(first);
    const secondIsAgent = known.includes(second);
    const serverFirst = firstIsServer && secondIsAgent;
    if (!serverFirst && !firstIsAgent) return "error";
    return serverFirst ? `server=${first} agent=${second}` : `agent=${first} sel=${second}`;
  };
  assert(resolve("tracepaper", "evals") === "server=tracepaper agent=evals", "a name that is BOTH resolves by the second token, not rejected");
  assert(resolve("github", "evals") === "server=github agent=evals", "plain server-first");
  assert(resolve("evals", "all") === "agent=evals sel=all", "agent-first setter still reads as one");
  assert(resolve("evals", "github") === "agent=evals sel=github", "agent-first with a server name is a selection");
  assert(resolve("nope", "alsonope") === "error", "two unknown tokens fail loud rather than guessing");
  assert(resolve("github", "nope") === "error", "a server with a non-agent second fails loud");
}

// 6c. OPT-IN servers (`add --only`, `only`): the selection math shared by the listing and the spawn.
{
  const declared = ["github", "tavily", "secret"];
  const optIn = ["secret"];
  const sel = (share: string | undefined, grants?: string) => shareSelection({ declared, optIn, share, grants, agent: "a" });
  // With no opt-in server and no grant the persona passes through UNCHANGED — a fleet that never used
  // --only launches exactly as before (absent stays absent ⇒ cotal's own "every declared server").
  assert(shareSelection({ declared, optIn: [], share: undefined, grants: undefined, agent: "a" }) === undefined, "no opt-in anywhere ⇒ absent selection still sends nothing");
  assert(JSON.stringify(shareSelection({ declared, optIn: [], share: "none", grants: undefined, agent: "a" })) === "[]", "no opt-in ⇒ `none` still parses to []");
  assert(JSON.stringify(shareSelection({ declared, optIn: [], share: "tavily", grants: undefined, agent: "a" })) === '["tavily"]', "no opt-in ⇒ a list passes through");
  // The core rule: absent ⇒ every declared server EXCEPT opt-in, as an explicit list (cotal knows no opt-in).
  assert(JSON.stringify(sel(undefined)) === '["github","tavily"]', "absent selection ⇒ explicit list of every NON-opt-in server");
  assert(JSON.stringify(sel(undefined, "secret")) === '["github","tavily","secret"]', "absent + granted ⇒ shared servers + the opt-in one");
  assert(JSON.stringify(sel("none")) === "[]", "`none` ⇒ nothing");
  assert(JSON.stringify(sel("none", "secret")) === '["secret"]', "`none` + granted ⇒ just the opt-in one (--only names the agent explicitly)");
  assert(JSON.stringify(sel("tavily", "secret")) === '["tavily","secret"]', "a list + granted ⇒ the list plus the grant");
  assert(JSON.stringify(sel("secret")) === '["secret"]', "a shareTools list naming an opt-in server is an explicit grant too");
  assert(JSON.stringify(sel("tavily", "tavily")) === '["tavily"]', "a grant of a shared server never duplicates it");
  assert(throws(() => sel(undefined, "gone")), "a grant naming an undeclared server fails the spawn LOUD, never launches without it silently");
  // A mark naming a server that is no longer declared is inert — nothing to hide.
  assert(shareSelection({ declared, optIn: ["gone"], share: undefined, grants: undefined, agent: "a" }) === undefined, "a dangling opt-in mark changes nothing");
  // Every selection paw computes must be one cotal ACCEPTS and resolves to what paw lists: run it through
  // cotal's own resolver.
  const cfg = { connectors: { claude: { mcpServers: { github: { command: "g" }, tavily: { command: "t" }, secret: { command: "s" } }, [OPT_IN_KEY]: optIn } } } as never;
  for (const [share, grants] of [[undefined, undefined], [undefined, "secret"], ["none", "secret"], ["tavily", "secret"]] as const) {
    const got = Object.keys(connectorServers(cfg, "claude", sel(share, grants))).join(",");
    assert(got === effectiveServers({ declared, optIn, share, grants, agent: "a" }).join(","), `cotal resolves ${share ?? "absent"}+${grants ?? "-"} to exactly what paw lists (${got || "nothing"})`);
  }

  // The mark: written beside the definitions, removed with the server, and tolerated by cotal's reader.
  const base = withServer(withServer({} as never, "github", { command: "g" }), "secret", { command: "s" });
  const marked = withOptInMark(base, "secret", true);
  assert(JSON.stringify(optInServers(marked, "x")) === '["secret"]', "only / add --only marks the server opt-in");
  assert(JSON.stringify(withOptInMark(marked, "secret", true).connectors?.claude) === JSON.stringify(marked.connectors?.claude), "marking twice is idempotent");
  assert(!(OPT_IN_KEY in (withOptInMark(marked, "secret", false).connectors!.claude as object)), "unmarking the last one removes the key — a file that stopped using opt-in looks untouched");
  const gone = withoutServer(marked, "secret")!;
  assert(optInServers(gone, "x").length === 0, "rm drops the opt-in mark in the SAME write — a re-add under that name starts shared, as add says");
  assert(gone.connectors?.claude?.mcpServers?.github !== undefined, "rm keeps the other servers");
  const cfgFile = join(process.env.PAW_HOME!, "cotal.json");
  writeFileSync(cfgFile, JSON.stringify(marked));
  assert(!throws(() => readCotalConfigFile(cfgFile)), "cotal's own config reader accepts a connector carrying the mark (no unknown-key refusal)");
  process.env.XDG_CONFIG_HOME = join(process.env.PAW_HOME!, "xdg");
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "cotal"), { recursive: true });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "cotal", "config.json"), JSON.stringify(marked));
  const root = join(process.env.PAW_HOME!, "root");
  assert(JSON.stringify(readOptIn(loadCotalConfig(root).connectors?.claude, "merged")) === '["secret"]', "the mark survives cotal's merge of operator + space config (what the spawn site reads)");
  assert(Object.keys(connectorServers(loadCotalConfig(root), "claude", undefined)).includes("secret"), "…and cotal itself still shares it with an ABSENT selection — which is why paw must always send a list");
  delete process.env.XDG_CONFIG_HOME;
  assert(throws(() => readOptIn({ [OPT_IN_KEY]: "secret" }, "x")), "a malformed mark (a string, not a list) fails loud — reading it as none would share it with everyone");
  assert(throws(() => readOptIn({ [OPT_IN_KEY]: [""] }, "x")), "an empty name in the mark fails loud");

  // Grants in the persona: added, de-duplicated, removed, the line gone when empty, the rest kept.
  const p0 = "---\nname: evals\nshareTools: none\n---\nbody\n";
  const p1 = withGrant(p0, "secret", true);
  assert(new RegExp(`^${GRANT_KEY}: secret$`, "m").test(p1), "share/only writes the grant into the frontmatter");
  assert(withGrant(p1, "secret", true) === p1, "granting twice changes nothing");
  const p2 = withGrant(p1, "other", true);
  assert(new RegExp(`^${GRANT_KEY}: secret,other$`, "m").test(p2), "a second grant appends");
  assert(!new RegExp(`${GRANT_KEY}:`).test(withGrant(withGrant(p2, "secret", false), "other", false)), "removing the last grant removes the line");
  assert(withGrant(p1, "secret", false).includes("shareTools: none") && withGrant(p1, "secret", false).includes("body"), "grant edits keep shareTools and the body");

  // The listing and the restart hints use the same math.
  const fleet = [
    { name: "alice", share: undefined, grants: "secret" },
    { name: "bob", share: undefined, grants: undefined },
    { name: "carol", share: "none", grants: undefined },
  ];
  const by = serversByAgent(declared, optIn, fleet);
  assert(by.get("alice")!.servers.join(",") === "github,tavily,secret", "listing: the named agent gets the opt-in server");
  assert(by.get("bob")!.servers.join(",") === "github,tavily", "listing: an unnamed default agent does not — and keeps every shared one");
  assert(agentsSharing("secret", fleet, declared, optIn).filter((w) => w.shares).map((w) => w.name).join(",") === "alice", "agentsSharing names only the opted-in agent");
  assert(!!serversByAgent(declared, optIn, [{ name: "x", share: undefined, grants: "gone" }]).get("x")!.error, "a dangling grant is REPORTED by the listing instead of crashing it");
  // Flipping secret back to shared changes bob (gains it), not alice (had it) or carol (none).
  assert(changedAgents(by, serversByAgent(declared, [], fleet)).join(",") === "bob", "only the agents whose set changed are told to restart");

  // The listing stays short on a big fleet (stdout is not a tty here, so no colour codes).
  const fleetNames = Array.from({ length: 152 }, (_, i) => `a${i}`);
  assert(whoLine(fleetNames, fleetNames, false, false) === "all agents (152)", "a shared server on every agent is one count, not 152 names");
  assert(whoLine(fleetNames.slice(2), fleetNames, false, false) === "all agents (152) except a0, a1", "a few left out are named as the exceptions");
  assert(whoLine(["a3"], fleetNames, true, false) === "1/152: a3", "an opt-in server names who has it");
  assert(/^20\/152: a0, .* \+12 more \(--verbose\)$/.test(whoLine(fleetNames.slice(0, 20), fleetNames, true, false)), "a long name list is capped with +N more");
  assert(whoLine(fleetNames.slice(0, 20), fleetNames, true, true).split(", ").length === 20, "--verbose prints every name");
}

// 7. A config we can't parse is never overwritten: half of it may be settings paw knows nothing about.
const bad = join(process.env.PAW_HOME!, "bad.json");
writeFileSync(bad, "{not json");
assert(throws(() => readConfig(bad)), "malformed cotal config fails loud instead of being replaced");
writeFileSync(bad, "[]");
assert(throws(() => readConfig(bad)), "a JSON array is not a config object");
assert(Object.keys(readConfig(join(process.env.PAW_HOME!, "absent.json"))).length === 0, "an absent config is empty, not an error");

rmSync(process.env.PAW_HOME!, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw mcp check(s) failed`);
  process.exit(1);
}
console.log("\nall paw mcp checks passed 🐾");


// ── readAgentType: the persona's `agent:` pin decides which CONNECTOR a wake/revival respawns ──
{
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const d = mkdtempSync(join(tmpdir(), "paw-agenttype-"));
  const p = join(d, "codex1.md");
  writeFileSync(p, "---\nname: codex1\nagent: codex\nsubscribe: [general]\n---\n\nbody\n");
  assert(readAgentType(p) === "codex", "agent: codex reads back as the connector to respawn with");
  writeFileSync(p, "---\nname: x\nagent: \"opencode\"\n---\nbody");
  assert(readAgentType(p) === "opencode", "a quoted value is unquoted");
  writeFileSync(p, "---\nname: x\nsubscribe: [general]\n---\nbody mentions agent: nothing");
  assert(readAgentType(p) === undefined, "no agent: in the FRONTMATTER → undefined (the default connector), body text ignored");
  writeFileSync(p, "---\nname: x\nagent:\n---\n");
  assert(readAgentType(p) === undefined, "an empty agent: is absent, never an empty string");
  assert(readAgentType(join(d, "missing.md")) === undefined, "a missing persona → undefined");
  assert(readAgentType(undefined) === undefined, "no config path → undefined");
  console.log("✓ readAgentType");
}

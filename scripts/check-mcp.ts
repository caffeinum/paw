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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-mcp-home-"));

const { PAW_CONNECTOR, withServer, withoutServer, buildSpec, isValidServerName, agentsSharing, withShareTools, readConfig } =
  await import("../src/commands/mcp.js");
const { readShareTools, readAgentType } = await import("../src/session.js");

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
assert(agentsSharing("github", [{ name: "x", share: "GitHub, tavily" }])[0].shares, "selections match case-insensitively and tolerate spaces");

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

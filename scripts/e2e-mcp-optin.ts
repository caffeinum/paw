/**
 * END-TO-END opt-in MCP servers (`paw mcp add --only`, `paw mcp only`) against REAL claude agents, in an
 * ISOLATED space with a THROWAWAY cotal config (refuses anything else — never the operator's file):
 *  1. register alice + bob; `paw mcp add common -- node probe.js common` (shared) and
 *     `paw mcp add secret --only alice -- node probe.js secret` (opt-in);
 *  2. spawn both (haiku); read the MCP config each claude ACTUALLY launched with (`--mcp-config`, found
 *     by its COTAL_NAME): alice has cotal+common+secret, bob has cotal+common only;
 *  3. each probe server records the agent that listed its tools — alice listed secret's, bob never did,
 *     and bob still listed common's;
 *  4. `paw mcp only secret --all` restarts nothing and names bob; respawn bob → now he has secret.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-mcp-optin.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT) {
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
}
// The cotal config under test is a throwaway: set BEFORE any import resolves globalConfigPath() and before
// ensure() starts the manager (which inherits it), so neither ever reads or writes ~/.config/cotal.
const work = realpathSync(mkdtempSync(join(tmpdir(), "pawmcp-optin-")));
process.env.XDG_CONFIG_HOME = join(work, "xdg");
process.env.PAW_RUNTIME ??= "pty";
process.env.PAW_MODEL ??= "haiku";
const tokenFile = join(homedir(), ".paw", "secrets", "claude-oauth-token");
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(tokenFile)) process.env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(tokenFile, "utf8").trim();

const { globalConfigPath } = await import("@cotal-ai/core");
if (!globalConfigPath().startsWith(work)) throw new Error(`refusing: cotal config resolves to ${globalConfigPath()}, not the throwaway`);
const { ensureAgentSpawned, setFolderName } = await import("../src/addressing.ts");
const { ManagerControl } = await import("../src/control.ts");
const { ensure, stop } = await import("../src/lifecycle.ts");
const { purgeTestSpace } = await import("../src/prune.ts");
const { pawServer } = await import("../src/server.ts");
const { collectStatus } = await import("../src/status.ts");
const { meshIdentity } = await import("../src/named.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paw.ts");
const paw = (args: string[], timeout = 300_000) => {
  const r = spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: "utf8", timeout, cwd: tmpdir() });
  const out = `${r.stdout}${r.stderr}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "").trim();
  console.log(`  $ paw ${args.join(" ")} → ${r.status}\n${out.replace(/^/gm, "    ")}`);
  return { status: r.status, out };
};
const waitFor = async (pred: () => boolean | Promise<boolean>, ms: number, step = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await pred()) return true;
  return pred();
};

// A minimal stdio MCP server: one tool named after the server; on tools/list it drops a marker naming the
// agent (COTAL_NAME, inherited from the claude that launched it) — proof that claude connected and saw it.
const marks = join(work, "marks");
mkdirSync(marks);
const probe = join(work, "probe.mjs");
writeFileSync(
  probe,
  `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const server = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
  else if (m.method === "tools/list") {
    writeFileSync(${JSON.stringify(marks)} + "/" + server + "." + process.pid, (process.env.COTAL_NAME ?? "") + "|" + process.cwd());
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: server + "_probe", description: "probe", inputSchema: { type: "object", properties: {} } }] } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
);

/** The servers in the MCP config the live claude for `name` was launched with (`--mcp-config` arg). */
function launchedServers(name: string): string[] | undefined {
  const ps = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !/\bclaude\b/.test(m[2]) || !m[2].includes("--mcp-config")) continue;
    const id = meshIdentity(Number(m[1]));
    if (id.name !== name || id.space !== space) continue;
    const after = m[2].slice(m[2].indexOf("--mcp-config") + "--mcp-config".length).trim();
    const raw = after.startsWith("{") ? after.slice(0, after.lastIndexOf("}") + 1) : readFileSync(after.split(/\s+/)[0], "utf8");
    return Object.keys((JSON.parse(raw) as { mcpServers: object }).mcpServers).sort();
  }
  return undefined;
}
/** Did a probe for `server` list its tools to `agent`'s claude? Matched by the COTAL_NAME it inherited
 *  or, if claude doesn't pass its env through, by the agent's folder (its cwd). */
const listed = (server: string, agent: string) =>
  readdirSync(marks)
    .filter((f) => f.startsWith(`${server}.`))
    .some((f) => {
      const [name, cwd] = readFileSync(join(marks, f), "utf8").split("|");
      return name === agent || cwd.includes(`pawmcp-${agent}-`);
    });

const ctl = new ManagerControl(space, pawServer());
const rowOf = async (name: string) => (await collectStatus(space, ctl)).rows.find((r) => r.name === name);
try {
  await ensure({ needMesh: true, needManager: true, space });
  const folder = (n: string) => realpathSync(mkdtempSync(join(tmpdir(), `pawmcp-${n}-`)));
  const dirs = { alice: folder("alice"), bob: folder("bob") };
  for (const [n, d] of Object.entries(dirs)) setFolderName(space, d, n);

  // ── 1. one shared server, one opt-in ───────────────────────────────────────────────────────────
  ok("mcp add common (shared)", paw(["mcp", "add", "common", "--space", space, "--", process.execPath, probe, "common"]).status === 0);
  const add = paw(["mcp", "add", "secret", "--only", "alice", "--space", space, "--", process.execPath, probe, "secret"]);
  ok("mcp add secret --only alice", add.status === 0 && /opt-in, for alice/.test(add.out));
  const cfg = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
  ok("the mark sits beside the definitions in the throwaway cotal config", JSON.stringify(cfg.connectors.claude.pawOptIn) === '["secret"]');
  const list = paw(["mcp", "list", "--space", space]);
  ok("list: common → all agents, secret → [opt-in] 1/2: alice", /common[^\n]*\n\s+all agents \(2\)/.test(list.out) && /secret \[opt-in\][^\n]*\n\s+1\/2: alice/.test(list.out));

  // ── 2. spawn both; read the config each claude ACTUALLY launched with ─────────────────────────
  for (const [n, d] of Object.entries(dirs)) await ensureAgentSpawned(ctl, { space, name: n, cwd: d });
  for (const n of Object.keys(dirs)) ok(`${n} is idle on the mesh`, await waitFor(async () => (await rowOf(n))?.mesh === "idle", 180_000, 3000), (await rowOf(n))?.mesh);
  const a = launchedServers("alice");
  const b = launchedServers("bob");
  ok("alice launched with cotal + common + secret", a?.join(",") === "common,cotal,secret", a?.join(","));
  ok("bob launched with cotal + common, NOT secret", b?.join(",") === "common,cotal", b?.join(","));

  // ── 3. which tools each claude actually listed ────────────────────────────────────────────────
  ok("alice's claude listed secret's tools", await waitFor(() => listed("secret", "alice"), 60_000));
  ok("bob's claude listed common's tools (shared still reaches him)", await waitFor(() => listed("common", "bob"), 60_000));
  ok("alice's claude listed common's tools too", listed("common", "alice"));
  ok("bob's claude NEVER listed secret's tools", !listed("secret", "bob"), readdirSync(marks).map((f) => `${f}=${readFileSync(join(marks, f), "utf8")}`).join(" "));

  // ── 4. flip back to shared: nothing restarts, bob is named, a respawn picks it up ─────────────
  const flip = paw(["mcp", "only", "secret", "--all", "--space", space]);
  ok("only secret --all names bob's restart (and not alice's)", flip.status === 0 && /paw restart bob/.test(flip.out) && !/paw restart alice/.test(flip.out));
  ok("…and restarted nobody: bob still runs without secret", launchedServers("bob")?.join(",") === "common,cotal");
  await ctl.despawn("bob");
  await waitFor(async () => !(await rowOf("bob"))?.live, 60_000);
  await ensureAgentSpawned(ctl, { space, name: "bob", cwd: dirs.bob });
  ok("bob back idle", await waitFor(async () => (await rowOf("bob"))?.mesh === "idle", 180_000, 3000));
  ok("respawned bob launched WITH secret", launchedServers("bob")?.join(",") === "common,cotal,secret", launchedServers("bob")?.join(","));
} finally {
  for (const n of ["alice", "bob"]) await ctl.despawn(n).catch(() => {});
  await ctl.close();
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await purgeTestSpace(space, pawServer()).catch((e) => {
    console.error("purge:", (e as Error).message);
    fails++;
  });
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

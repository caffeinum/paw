/**
 * Hermetic check for `paw mcp add|ls|rm … --to <agent>` (src/mcp-sandbox.ts + src/commands/mcp.ts): a sandboxed
 * agent's OWN servers, written into its VM's claude user scope (`spaces/<s>/sandbox/<n>/claude/.claude.json`).
 *
 * Defends: the exact shape `claude mcp add -s user` writes (fixtures captured from claude 2.1.304), every other
 * key of that file surviving, the clash refusal / --force, ls/rm, the refusal for a host agent (with the right
 * command), the restart decision (live/idle → restart, busy → refuse unless --now, stopped → none, --no-restart),
 * the post-restart verification, and `<agent>#<space>` through the real CLI. No mesh, no VM: a fake `container`
 * and injected restart/state deps. Run: pnpm check:mcp-sandbox
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-mcpsbx-")));
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_RELEASE = "dev";
process.env.PAW_SERVER = "nats://127.0.0.1:1";
const SPACE = `test-mcpsbx-${process.pid}`;
const OTHER = `test-mcpsbx-${process.pid}-b`;
process.env.PAW_SPACE = SPACE;
for (const k of ["COTAL_NAME", "COTAL_SPACE"]) delete process.env[k];

// A fake `container`: `ls` prints $FAKE_LS (default: no containers), `exec` exits $FAKE_EXEC_CODE.
const fake = join(home, "container");
writeFileSync(fake, `#!/bin/sh\nif [ "$1" = ls ]; then printf '%s' "\${FAKE_LS:-[]}"; exit 0; fi\nexit "\${FAKE_EXEC_CODE:-0}"\n`);
chmodSync(fake, 0o755);
process.env.PAW_CONTAINER = fake;

let failures = 0;
const assert = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const throwsLike = async (fn: () => unknown, re: RegExp): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (e) {
    const ok = re.test((e as Error).message);
    if (!ok) console.log(`        got: ${(e as Error).message}`);
    return ok;
  }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function persona(space: string, name: string, cwd: string, sandboxed: boolean): void {
  const dir = join(process.env.PAW_HOME!, "spaces", space, "personas");
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ncwd: ${cwd}\n${sandboxed ? "sandbox: container\n" : ""}---\n`);
}
const folder = join(home, "work", "neon");
persona(SPACE, "neon", folder, true);
persona(SPACE, "hosty", join(home, "work", "hosty"), false);
persona(OTHER, "remo", join(home, "work", "remo"), true);
const claudeJson = (space: string, name: string) => join(process.env.PAW_HOME!, "spaces", space, "sandbox", name, "claude", ".claude.json");

const { buildSpec, parseArgs, runTo } = await import("../src/commands/mcp.ts");
const { withDefaultSpace } = await import("../src/dispatch.ts");
const m = await import("../src/mcp-sandbox.ts");
type Deps = import("../src/mcp-sandbox.ts").EnableDeps;

// ── 1. the shape claude 2.1.304's `claude mcp add -s user` writes ─────────────────────────────────────────
console.log("shape");
// Captured: `claude mcp add -s user st -e K=V -- mycmd a b`, `… st2 -- mycmd`, `… h --transport http <url> -H 'X-A: b'`,
// `… s --transport sse <url>` against a throwaway CLAUDE_CONFIG_DIR (2.1.304).
const CLAUDE = {
  st: { type: "stdio", command: "mycmd", args: ["a", "b"], env: { K: "V" } },
  st2: { type: "stdio", command: "mycmd", args: [], env: {} },
  h: { type: "http", url: "https://e.com/mcp", headers: { "X-A": "b" } },
  s: { type: "sse", url: "https://e.com/sse" },
};
const spec = (o: Parameters<typeof buildSpec>[0]) => m.claudeUserSpec(buildSpec(o));
assert(eq(spec({ cmd: ["mycmd", "a", "b"], env: ["K=V"] }), CLAUDE.st), "stdio + env = claude's shape (type, args, env)");
assert(eq(spec({ cmd: ["mycmd"], env: [] }), CLAUDE.st2), "bare stdio carries empty args and env, as claude writes");
assert(eq(spec({ cmd: ["https://e.com/mcp"], env: [], headers: ["X-A: b"] }), CLAUDE.h), "a lone https URL = http (streamable), --header kept");
assert(eq(spec({ cmd: ["https://e.com/sse"], env: [], transport: "sse" }), CLAUDE.s), "--transport sse");
assert(eq(spec({ cmd: ["https://e.com/mcp"], env: [], headers: ["Authorization: Bearer a:b"] }).headers, { Authorization: "Bearer a:b" }), "a header splits at its FIRST colon");
assert(eq(spec({ json: '{"url":"https://x","oauth":{"clientId":"c","callbackPort":8765}}', cmd: [], env: [] }), { type: "http", url: "https://x", oauth: { clientId: "c", callbackPort: 8765 } }), "--json keeps extra keys (oauth) and defaults type http");
assert(await throwsLike(() => buildSpec({ cmd: ["npx"], env: [], headers: ["X: y"] }), /--header is for http/), "--header on a stdio server is refused");
assert(await throwsLike(() => buildSpec({ cmd: ["npx"], env: [], transport: "sse" }), /needs a URL/), "--transport sse with a command is refused");
assert(await throwsLike(() => buildSpec({ cmd: ["https://x"], env: [], transport: "ws" }), /stdio, http or sse/), "an unknown --transport is refused");
assert(await throwsLike(() => buildSpec({ cmd: ["https://x"], env: ["A=b"] }), /no --env/), "--env on a URL server is refused");
assert(await throwsLike(() => buildSpec({ cmd: ["https://x"], env: [], headers: ["nocolon"] }), /Name: value/), "a header without a colon is refused");
assert(await throwsLike(() => buildSpec({ json: '{"url":"https://x"}', cmd: [], env: [], headers: ["X: y"] }), /whole entry/), "--json plus --header is refused");

// ── 2. argv ─────────────────────────────────────────────────────────────────────────────────────────
console.log("argv");
const pa = parseArgs(["add", "lin", "https://mcp.linear.app/mcp", "--to", "neon", "-H", "A: b", "--transport", "http"]);
assert(eq(pa.cmd, ["https://mcp.linear.app/mcp"]) && eq(pa.rest, ["lin"]) && pa.to === "neon" && eq(pa.headers, ["A: b"]), "add <name> <url> needs no `--`; -H / --transport parsed");
assert(parseArgs(["add", "x", "--to=neon", "--", "npx", "--to", "y"]).to === "neon", "--to=; anything after -- is the server's own argv");
assert(await throwsLike(() => parseArgs(["add", "x", "--to", "neon", "--only", "a"]), /one or the other/), "--to with --only is refused");
assert(await throwsLike(() => parseArgs(["add", "x", "--force", "--", "y"]), /go with --to/), "--force without --to is refused");
assert(await throwsLike(() => parseArgs(["add", "x", "--to", "neon", "--now", "--no-restart"]), /contradict/), "--now with --no-restart is refused");
assert(await throwsLike(() => parseArgs(["share", "x", "y", "--to", "neon"]), /add\|ls\|rm/), "--to only with add/ls/rm");

// ── 3. writes into the fake sandbox claude dir ───────────────────────────────────────────────────────
console.log("write");
type Call = string;
function deps(o: { live?: boolean; busy?: boolean; container?: string; exec?: (cmd: string) => { code: number; out: string }; onRestart?: () => void } = {}): Deps & { calls: Call[]; lines: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    async agentState() {
      calls.push("state");
      return { live: o.live ?? false, busy: o.busy ?? false };
    },
    async restart() {
      calls.push("restart");
      o.onRestart?.();
    },
    liveContainer() {
      return o.container;
    },
    exec(_id, _cwd, cmd) {
      calls.push(`exec:${cmd}`);
      return o.exec ? o.exec(cmd) : { code: 0, out: "" };
    },
    async sleep() {},
    log(l) {
      lines.push(l);
    },
  };
}
const file = claudeJson(SPACE, "neon");
mkdirSync(dirname(file), { recursive: true });
const existing = { hasCompletedOnboarding: true, projects: { [folder]: { hasTrustDialogAccepted: true, mcpServers: { mine: { type: "stdio", command: "x", args: [], env: {} } } } }, userID: "u", mcpServers: { keep: CLAUDE.s } };
writeFileSync(file, JSON.stringify(existing));
// As dispatch hands it over: `--space` injected BEFORE a `--` (withDefaultSpace), never into the server's argv.
const to = (argv: string[], d: Deps) => runTo(parseArgs(withDefaultSpace(argv, SPACE)), SPACE, d);

let d = deps();
await to(["add", "st", "--to", "neon", "--env", "K=V", "--", "mycmd", "a", "b"], d);
let doc = JSON.parse(readFileSync(file, "utf8"));
assert(eq(doc.mcpServers.st, CLAUDE.st), "stdio server written in claude's shape");
assert(eq(doc.mcpServers.keep, CLAUDE.s) && doc.userID === "u" && doc.hasCompletedOnboarding === true && doc.projects[folder].hasTrustDialogAccepted === true, "every other key survives (other servers, projects, ids)");
assert((statSync(file).mode & 0o777) === 0o600, "the file is 0600");
assert(!readdirSync(dirname(file)).some((f) => f.endsWith(".tmp")), "atomic: no temp file left behind");
assert(d.lines.some((l) => l.includes("isn't running") && l.includes("mycmd")), "VM not running: a note that the command must exist IN the VM");
assert(d.lines.some((l) => /K stored in plain text/.test(l)), "--env values: warned they are stored in the agent's claude dir");
assert(d.lines.some((l) => l.includes("isn't running") && l.includes(`paw start neon#${SPACE}`)) && !d.calls.includes("restart"), "a stopped agent is not started — it loads the server at its next start");

d = deps();
await to(["add", "h", "--to", "neon", "https://e.com/mcp", "--header", "X-A: b"], d);
await to(["add", "s", "--to", "neon", "--transport", "sse", "https://e.com/sse"], d);
doc = JSON.parse(readFileSync(file, "utf8"));
assert(eq(doc.mcpServers.h, CLAUDE.h) && eq(doc.mcpServers.s, CLAUDE.s), "http (+headers) and sse written in claude's shape");
assert(!d.lines.some((l) => l.includes("b\"")) && d.lines.some((l) => l.includes("headers: X-A")), "header VALUES are never printed, only names");

assert(await throwsLike(() => to(["add", "h", "--to", "neon", "https://other/mcp"], deps()), /already exists.*--force/), "a name clash is refused");
await to(["add", "h", "--to", "neon", "https://other/mcp", "--force"], deps());
assert(JSON.parse(readFileSync(file, "utf8")).mcpServers.h.url === "https://other/mcp", "--force replaces it");
assert(await throwsLike(() => to(["add", "cotal", "--to", "neon", "https://x"], deps()), /mesh server/), "the name `cotal` is reserved");
const beforeBad = readFileSync(file, "utf8");
assert(await throwsLike(() => to(["add", "bad", "--to", "neon", "--header", "X: y", "--", "npx"], deps()), /--header is for http/), "a bad spec fails before writing");
assert(readFileSync(file, "utf8") === beforeBad, "…and the file is untouched");

// ls / rm
d = deps();
await to(["ls", "--to", "neon"], d);
assert(["st", "h", "s", "keep"].every((n) => d.lines.some((l) => l.includes(n))) && d.lines.some((l) => l.includes("mine") && l.includes("local scope")), "ls lists user-scope servers and the folder's local-scope ones");
d = deps();
await to(["rm", "h", "--to", "neon", "--no-restart"], d);
assert(!("h" in JSON.parse(readFileSync(file, "utf8")).mcpServers) && !d.calls.includes("state"), "rm removes it; --no-restart doesn't even ask the manager");
assert(d.lines.some((l) => l.includes("--no-restart") && l.includes(`paw restart neon#${SPACE}`)), "--no-restart prints the restart command");
assert(await throwsLike(() => to(["rm", "h", "--to", "neon"], deps()), /no user-scope server "h"/), "rm of a missing server fails loud");
assert(await throwsLike(() => to(["rm", "mine", "--to", "neon"], deps()), /LOCAL scope.*claude mcp remove mine -s local/), "rm of a local-scope server says where it lives");

// a malformed .claude.json is never rewritten
const corrupt = claudeJson(SPACE, "neon");
const saved = readFileSync(corrupt, "utf8");
writeFileSync(corrupt, "{nope");
assert(await throwsLike(() => to(["add", "z", "--to", "neon", "https://z"], deps()), /not valid JSON/), "a malformed .claude.json fails loud");
assert(readFileSync(corrupt, "utf8") === "{nope", "…and is left as it was");
writeFileSync(corrupt, saved);

// first launch never happened: the claude dir is created
{
  const r = parseArgs(["add", "lin", "--to", "remo", "https://mcp.linear.app/mcp", "--no-restart", "--space", OTHER]);
  await runTo(r, OTHER, deps());
  assert(eq(JSON.parse(readFileSync(claudeJson(OTHER, "remo"), "utf8")), { mcpServers: { lin: { type: "http", url: "https://mcp.linear.app/mcp" } } }), "no .claude.json yet (never launched): created with just the server (launch seeding merges into it)");
}

// ── 4. refusals ─────────────────────────────────────────────────────────────────────────────────────
console.log("refusals");
assert(await throwsLike(() => to(["add", "x", "--to", "hosty", "https://x"], deps()), /not sandboxed.*--only hosty.*paw mcp share <server> hosty/), "a host agent is refused, naming --only / share");
assert(await throwsLike(() => to(["ls", "--to", "nobody"], deps()), /no agent "nobody"/), "an unknown agent fails loud");

// ── 5. restart decision + verification ───────────────────────────────────────────────────────────────
console.log("restart");
assert(m.restartDecision({ live: true, busy: false, noRestart: false, now: false }) === "restart", "live + idle → restart");
assert(m.restartDecision({ live: true, busy: true, noRestart: false, now: false }) === "busy", "live + busy → refuse");
assert(m.restartDecision({ live: true, busy: true, noRestart: false, now: true }) === "restart", "live + busy + --now → restart");
assert(m.restartDecision({ live: false, busy: false, noRestart: false, now: true }) === "not-running", "stopped → never started");
assert(m.restartDecision({ live: true, busy: false, noRestart: true, now: false }) === "skipped", "--no-restart → skipped");

d = deps({ live: true, busy: true });
await to(["add", "b1", "--to", "neon", "https://b1"], d);
assert(!d.calls.includes("restart") && d.lines.some((l) => /busy.*NOT restarted.*--now/.test(l)), "busy agent: config written, restart refused with a clear message");
assert("b1" in JSON.parse(readFileSync(file, "utf8")).mcpServers, "…the server is still installed");

const connected = (cmd: string) => (cmd.includes("mcp get") ? { code: 0, out: "b2:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n" } : { code: 0, out: "/usr/local/bin/claude --resume x --mcp-config {}\n" });
d = deps({ live: true, busy: true, container: "paw-c1", exec: connected });
await to(["add", "b2", "--to", "neon", "https://b2", "--now"], d);
assert(d.calls.includes("restart") && d.lines.some((l) => l.includes("restarting neon") && l.includes("--no-restart skips")), "--now restarts a busy agent, and the output says it restarts");
assert(d.calls.some((c) => c.includes("claude mcp get 'b2'")) && d.lines.some((l) => l.includes("b2: connected")), "after the restart: `claude mcp get` in the VM → connected");
assert(!d.lines.some((l) => l.includes("strict-mcp-config")), "no strict warning when the VM's claude runs without it");

d = deps({ live: true, container: "paw-c1", exec: (cmd) => (cmd.includes("mcp get") ? { code: 0, out: "  Status: ! Needs authentication\n" } : { code: 0, out: "/usr/local/bin/claude --strict-mcp-config --mcp-config {}\n" }) });
await to(["add", "b3", "--to", "neon", "https://b3"], d);
assert(d.lines.some((l) => l.includes("strict-mcp-config") && l.includes("IGNORES")), "a VM claude still launched with --strict-mcp-config is called out");
assert(d.lines.some((l) => l.includes("needs authentication") && l.includes("claude mcp login b3") && l.includes("paw sandbox shell")), "needs-auth → how to finish OAuth");

d = deps({ live: true, container: "paw-c1", exec: (cmd) => (cmd.includes("mcp get") ? { code: 1, out: "  Status: ✘ Failed to connect\n  Issue: ENOENT: mycmd\n" } : { code: 0, out: "" }) });
await to(["add", "b4", "--to", "neon", "https://b4"], d);
assert(d.lines.some((l) => l.includes("b4: failed to connect — ENOENT")), "failed → reported with claude's issue line");

d = deps({ live: true, container: "paw-c1", onRestart: () => writeFileSync(file, JSON.stringify({ ...existing })) });
assert(await throwsLike(() => to(["add", "b5", "--to", "neon", "https://b5"], d), /no longer in .* after the restart/), "an entry lost across the restart fails loud");
writeFileSync(file, saved);

d = deps({ live: true, exec: () => ({ code: 0, out: "" }) });
await m.enableInAgent(m.sandboxTarget(SPACE, "neon"), { server: "keep", verb: "add", noRestart: false, now: false, bootWaitMs: 0 }, d);
assert(d.lines.some((l) => l.includes("didn't come up")), "VM not back in time → says it couldn't check, never claims connected");

// stdio command present / missing in a running VM
d = deps({ container: "paw-c1", exec: () => ({ code: 1, out: "" }) });
await to(["add", "st9", "--to", "neon", "--no-restart", "--", "nosuchcmd"], d);
assert(d.lines.some((l) => l.includes('"nosuchcmd" is NOT on the VM\'s PATH')) && d.calls.includes("exec:command -v 'nosuchcmd'"), "running VM: a missing stdio command is warned about (read-only `command -v`)");

assert(m.parseMcpGet("Status: ✓ Connected").state === "connected" && m.parseMcpGet("garbage").state === "unknown", "parseMcpGet");

// ── 6. the real CLI: `<agent>#<space>`, no mesh needed ──────────────────────────────────────────────
console.log("cli");
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paw.ts");
const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: "utf8", timeout: 60_000 });
{
  const r = run(["mcp", "add", "cli1", "--to", `remo#${OTHER}`, "https://cli1/mcp", "-H", "A: b", "--no-restart"]);
  assert(r.status === 0, `paw mcp add … --to remo#<space> exits 0${r.status === 0 ? "" : ` (${r.stderr.trim().slice(0, 300)})`}`);
  const j = JSON.parse(readFileSync(claudeJson(OTHER, "remo"), "utf8"));
  assert(eq(j.mcpServers.cli1, { type: "http", url: "https://cli1/mcp", headers: { A: "b" } }), "…written into THAT space's agent (the #space hoist reached the command)");
  const ls = run(["mcp", "ls", "--to", `remo#${OTHER}`]);
  assert(ls.status === 0 && ls.stdout.includes("cli1") && ls.stdout.includes("lin"), "paw mcp ls --to remo#<space>");
  const host = run(["mcp", "add", "x", "--to", "hosty", "https://x"]);
  assert(host.status === 1 && host.stderr.includes("not sandboxed"), "paw mcp add --to <host agent> → exit 1, not sandboxed");
  const clash = run(["mcp", "add", "cli1", "--to", `remo#${OTHER}`, "https://cli1/mcp"]);
  assert(clash.status === 1 && clash.stderr.includes("--force"), "clash through the CLI → exit 1");
}

console.log(failures ? `\n${failures} mcp-sandbox check(s) failed` : "\nall mcp-sandbox checks passed 🐾");
process.exit(failures ? 1 : 0);

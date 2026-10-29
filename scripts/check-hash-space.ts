/**
 * `<agent>#<space>` addressing (src/dispatch.ts: splitAddressSpace, hoistAddressSpace,
 * sameSpaceAddress). Three layers:
 *   1. the parser's precedence (URLs, github handles, channels, existing `#` folders, worktrees, `@`)
 *      against fake deps — pure;
 *   2. each command family's hoisted argv fed to that command's OWN parser where it is exported, so a
 *      wrong slot table shows up as a wrong target/space, not a passing string compare;
 *   3. the real CLI (bin/paw.ts) for every address verb: an unknown space and a disagreeing --space fail
 *      loud BEFORE any mesh is touched.
 * Hermetic: temp PAW_HOME, PAW_SPACE=test-<pid>, PAW_RELEASE=dev, PAW_SERVER on a dead port.
 * Run: pnpm check:hash-space
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "paw-hash-space-"));
const SPACE = `test-${process.pid}`;
process.env.PAW_HOME = home;
process.env.PAW_SPACE = SPACE;
process.env.PAW_RELEASE = "dev";
process.env.PAW_SERVER = "nats://127.0.0.1:1";
const OTHER = `test-${process.pid}-other`;
mkdirSync(join(home, "spaces", OTHER), { recursive: true });

const { ADDRESS_ARGS, addressDeps, hoistAddressSpace, sameSpaceAddress, splitAddressSpace } = await import("../src/dispatch.ts");
type Deps = ReturnType<typeof addressDeps>;

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function throws(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    const m = (e as Error).message;
    assert(re.test(m), `${msg}${re.test(m) ? "" : ` — got: ${m}`}`);
  }
}

const fake = (paths: string[] = []): Deps => ({
  isKnownSpace: (s) => ["paw", "team2027", "lab"].includes(s),
  knownSpaces: () => ["lab", "paw", "team2027"],
  pathExists: (p) => paths.includes(p),
});
const d = fake();

// ── 1. the parser ───────────────────────────────────────────────────────────────────────────────
console.log("parser");
assert(eq(splitAddressSpace("2027-intern#team2027", d), { target: "2027-intern", space: "team2027" }), "name#space splits");
assert(eq(splitAddressSpace("@2027-intern#team2027", d), { target: "@2027-intern", space: "team2027" }), "@name#space keeps the @ for the command");
assert(eq(splitAddressSpace("intern", d), { target: "intern" }), "no # → untouched");
assert(eq(splitAddressSpace("paw@feat#team2027", d), { target: "paw@feat", space: "team2027" }), "<repo>@<branch>#space → worktree on that space");
assert(eq(splitAddressSpace("~/code/x#lab", d), { target: "~/code/x", space: "lab" }), "a folder path#space splits (path not on disk)");
assert(eq(splitAddressSpace("#general", d), { target: "#general" }), "bare #channel stays a channel");
assert(eq(splitAddressSpace("#general#team2027", d), { target: "#general", space: "team2027" }), "#channel#space → channel on that space");
assert(eq(splitAddressSpace("github:o/r#main", d), { target: "github:o/r#main" }), "github:o/r#branch: the # is the BRANCH");
assert(eq(splitAddressSpace("github:o/r#team2027", d), { target: "github:o/r#team2027" }), "github:o/r#<a space name> is still a branch (first # = branch)");
assert(eq(splitAddressSpace("github:o/r#fix#12", d), { target: "github:o/r#fix#12" }), "a branch containing # (unknown suffix) passes through");
throws(() => splitAddressSpace("github:o/r#main#team2027", d), /ambiguous.*--space team2027/, "github:o/r#branch#<known space> fails loud (branch may contain #)");
throws(() => splitAddressSpace("gh:o/r@main#team2027", d), /ambiguous/, "gh:o/r@branch#<known space> fails loud too");
assert(eq(splitAddressSpace("gh:o/r#main", d), { target: "gh:o/r#main" }), "gh:o/r#branch untouched");
assert(eq(splitAddressSpace("https://github.com/o/r#readme", d), { target: "https://github.com/o/r#readme" }), "a URL's # is its fragment");
assert(eq(splitAddressSpace("web:example.com/a#team2027", d), { target: "web:example.com/a#team2027" }), "web: keeps its fragment");
throws(() => splitAddressSpace("intern#nosuch", d), /unknown space "nosuch".*known: lab, paw, team2027/, "unknown space fails loud, listing the known ones");
throws(() => splitAddressSpace("intern#", d), /empty space/, "empty space fails loud");
assert(eq(splitAddressSpace("#", d), { target: "#" }), "a lone # is left to the command");
throws(() => splitAddressSpace("@#team2027", d), /names nothing/, "@#space names nothing");
throws(() => splitAddressSpace("a#b#team2027", d), /more than one "#"/, "two #s on a name fail loud (names never contain #)");
throws(() => splitAddressSpace("intern#te.am", d), /letters, digits/, "a space with a bad charset fails loud");
assert(eq(splitAddressSpace("./notes#draft", fake(["./notes#draft"])), { target: "./notes#draft" }), "an EXISTING folder with # (suffix not a space) is that folder");
throws(() => splitAddressSpace("./x#lab", fake(["./x#lab"])), /ambiguous.*existing folder/, "an existing folder whose suffix IS a space fails loud");

// name validators: no agent or space name can contain '#'
{
  const { sanitizeAgentName } = await import("../src/addressing.ts");
  const { checkSpaceName } = await import("../src/remote-mesh.ts");
  assert(!sanitizeAgentName("/tmp/a#b").includes("#"), "sanitizeAgentName never yields a '#'");
  throws(() => checkSpaceName("a#b"), /letters, digits/, "checkSpaceName rejects '#'");
}

// sameSpaceAddress (chat REPL / paw web)
assert(sameSpaceAddress("intern#paw", "paw", "chat", d) === "intern", "same space → bare name");
assert(sameSpaceAddress("intern", "paw", "chat", d) === "intern", "no suffix → untouched");
assert(sameSpaceAddress("#ops#paw", "paw", "chat", d) === "#ops", "#chan#same-space → #chan");
throws(() => sameSpaceAddress("intern#team2027", "paw", "chat", d), /on space "team2027", but this chat is on "paw"/, "another space fails loud (no silent re-route)");
throws(() => sameSpaceAddress("intern#nosuch", "paw", "paw web", d), /unknown space/, "unknown space fails loud in-process too");

// real deps: current space, default space, a space dir, a remote record
{
  const real = addressDeps();
  assert(real.isKnownSpace(SPACE) && real.isKnownSpace("paw") && real.isKnownSpace(OTHER), "real deps: current, default and on-disk spaces are known");
  assert(!real.isKnownSpace("nosuch-space") && !real.isKnownSpace("a/b"), "real deps: absent / malformed spaces are not");
  const { writeRemoteMesh } = await import("../src/remote-mesh.ts");
  writeRemoteMesh({ space: `${OTHER}-remote`, server: "tls://example.invalid:4222", root: home, ts: new Date().toISOString() });
  assert(addressDeps().isKnownSpace(`${OTHER}-remote`), "real deps: a `paw mesh add` record makes a space known");
}

// ── 2. hoisting, per command family, through the command's own parser ─────────────────────────────
console.log("hoist");
const h = (cmd: string, args: string[]) => hoistAddressSpace(cmd, args, d);
assert(eq(h("dm", ["intern#team2027", "hi #12"]), ["intern", "hi #12", "--space", "team2027"]), "dm: target hoisted, body's # untouched");
assert(eq(h("dm", ["intern", "see a#team2027"]), ["intern", "see a#team2027"]), "dm: a body word is never read as an address");
assert(eq(h("dm", ["--model", "x#team2027", "intern", "hi"]), ["--model", "x#team2027", "intern", "hi"]), "dm: a flag VALUE is skipped, not an address");
assert(eq(h("dm", ["--name", "two#team2027", ".", "hi"]), ["--name", "two", ".", "hi", "--space", "team2027"]), "dm --name n#space hoists");
assert(eq(h("dm", ["intern#team2027", "hi", "--space", "team2027"]), ["intern", "hi", "--space", "team2027"]), "agreeing explicit --space is fine");
throws(() => h("dm", ["intern#team2027", "hi", "--space", "paw"]), /says space "team2027" but --space says "paw"/, "disagreeing --space fails loud");
throws(() => h("dm", ["intern#team2027", "hi", "--space=lab"]), /--space says "lab"/, "disagreeing --space=… fails loud");
throws(() => h("rename", ["a#team2027", "b#lab"]), /different spaces/, "two addresses on two spaces fail loud");
assert(eq(h("who", ["x#team2027"]), ["x#team2027"]), "a command with no agent slot passes through");
assert(eq(h("mcp", ["add", "a#team2027"]), ["add", "a#team2027"]), "an unlisted command is untouched");
assert(eq(h("stop", ["x", "--", "y#team2027"]), ["x", "--", "y#team2027"]), "nothing after `--` is read");

{
  const { parseArgs: chatArgs } = await import("../src/chat.ts");
  const a = chatArgs(h("chat", ["@2027-intern#team2027"]));
  assert(a.target === "@2027-intern" && a.space === "team2027", "chat @name#space → target @name, --space");
  const b = chatArgs(h("chat", ["#general#team2027"]));
  assert(b.target === "#general" && b.space === "team2027", "chat #chan#space → channel on that space");
  const c = chatArgs(h("chat", ["#general"]));
  assert(c.target === "#general" && c.space === undefined, "chat #chan stays a channel");
  const e = chatArgs(h("chat", ["--agent", "kit", "paw@feat#lab"]));
  assert(e.target === "paw@feat" && e.space === "lab" && e.agent === "kit", "chat --agent kit repo@branch#space");
}
{
  const { parseArgs: inboxArgs } = await import("../src/inbox.ts");
  const a = inboxArgs(h("inbox", ["@a#team2027", "b#team2027", "--limit", "5"]));
  assert(eq(a.agents, ["a", "b"]) && a.space === "team2027" && a.limit === 5, "inbox: several agents on one space");
}
{
  const { statusTargets } = await import("../src/status.ts");
  const argv = h("status", ["a#team2027", "live", "--json"]);
  assert(eq(statusTargets(argv), ["a", "live"]) && argv.includes("team2027"), "status: names + state words, space hoisted");
}
{
  const { parseNiceArgs } = await import("../src/commands/nice.ts");
  const a = parseNiceArgs(h("nice", ["a#team2027", "5"]));
  assert(a.name === "a" && a.value === 5 && a.space === "team2027", "nice <name#space> <n>");
  const { parseUnstickArgs } = await import("../src/commands/unstick.ts");
  const u = parseUnstickArgs(h("unstick", ["a#lab", "--force"]));
  assert(u.target === "a" && u.space === "lab" && u.force, "unstick name#space");
  const { parsePersonaArgs } = await import("../src/persona.ts");
  const p = parsePersonaArgs(h("persona", ["a#lab", "--reroll", "seed#x"]));
  assert(p.name === "a" && p.space === "lab" && p.seed === "seed#x", "persona name#space (the reroll seed is not an address)");
  const { parseTypeArgs } = await import("../src/commands/type.ts");
  const t = parseTypeArgs(h("type", ["@a#lab", "hello", "#world"]));
  assert(t.target === "a" && t.space === "lab" && eq(t.words, ["hello", "#world"]), "type @name#space <text…> (text's # untouched)");
  throws(() => h("type", ["a#lab", "hello"]), /`@`-prefixed/, "type: a bare name#space first word fails loud (did you mean @)");
  const t2 = parseTypeArgs(h("type", ["issue#12"]));
  assert(eq(t2.words, ["issue#12"]), "type: lone text containing # is just text");
  const { parseTopArgs } = await import("../src/commands/top.ts");
  const tp = parseTopArgs(h("top", ["--sort", "cpu", "a#lab", "b"]));
  assert(eq(tp.names, ["a", "b"]) && tp.space === "lab" && tp.sort === "cpu", "top names");
  const { parseTidyArgs } = await import("../src/commands/tidy.ts");
  const td = parseTidyArgs(h("tidy", ["--older", "2h", "a#lab"]));
  assert(eq(td.names, ["a"]) && td.space === "lab", "tidy names");
  const { parseOptimizeArgs } = await import("../src/commands/optimize.ts");
  const o = parseOptimizeArgs(h("optimize", ["--since", "1d", "a#lab"]));
  assert(eq(o.names, ["a"]) && o.space === "lab", "optimize names");
  const { parseLaunchdArgs } = await import("../src/commands/launchd.ts");
  const l = parseLaunchdArgs(h("launchd", ["install", "a#lab", "b#lab"]));
  assert(l.action === "install" && eq(l.names, ["a", "b"]) && l.space === "lab", "launchd install names#space");
  const { parseArgs: adoptArgs } = await import("../src/adopt.ts");
  const ad = adoptArgs(h("adopt", ["--resume", "abc", "./x#lab", "--name", "n#lab"]));
  assert(ad.target === "./x" && ad.name === "n" && ad.space === "lab" && ad.session === "abc", "adopt folder#space + --name n#space");
  const { peelArgs } = await import("../src/claude.ts");
  const cl = peelArgs(h("claude", ["--name", "n#lab", "--model", "opus", "fix #3"]));
  assert(cl.name === "n" && cl.space === "lab" && eq(cl.claudeArgs, ["--model", "opus", "fix #3"]), "claude --name n#space: --space goes FIRST, claude's args untouched");
  const cl3 = peelArgs(h("claude", ["--fg", "--name", "n#lab", "-c"]));
  assert(cl3.name === "n" && cl3.space === "lab" && cl3.fg === true && eq(cl3.claudeArgs, ["-c"]), "claude --fg --name n#space -c");
  const cl2 = peelArgs(h("claude", ["--name=n#lab"]));
  assert(cl2.name === "n" && cl2.space === "lab", "claude --name=n#space");
  const { parseCronArgs } = await import("../src/commands/cron.ts");
  const cr = parseCronArgs(h("cron", ["add", "a#lab", "0 9 * * *", "check #general"]));
  assert(eq(cr.positionals, ["a", "0 9 * * *", "check #general"]) && cr.space === "lab", "cron add a#space <cron> <prompt> (the prompt's # untouched)");
  const cr2 = parseCronArgs(h("cron", ["add", "--in", "5m", "ping #lab"]));
  assert(eq(cr2.positionals, ["ping #lab"]) && cr2.space === undefined, "cron add --in <t> <prompt>: no agent → the prompt is never an address");
  const cr3 = parseCronArgs(h("cron", ["add", "a#lab", "--at", "09:00", "x"]));
  assert(eq(cr3.positionals, ["a", "x"]) && cr3.space === "lab" && cr3.at === "09:00", "cron add a#space --at <t> <prompt>");
  const cr4 = parseCronArgs(h("cron", ["add", "a#lab", "0 * * * *", "--run", "grep -c '#x' log"]));
  assert(eq(cr4.positionals, ["a", "0 * * * *"]) && cr4.space === "lab" && cr4.run === "grep -c '#x' log", "cron add a#space <cron> --run <cmd> (the command's # untouched)");
  const cr5 = parseCronArgs(h("cron", ["add", "0 * * * *", "--run", "x"]));
  assert(eq(cr5.positionals, ["0 * * * *"]) && cr5.space === undefined, "cron add <cron> --run: no agent → nothing hoisted");
}

// a leading @ on a plain-name verb is chat's sigil, dropped (`paw start @evals-intern`, `paw restart @x`)
{
  assert(eq(hoistAddressSpace("start", ["@evals-intern", "--space", "team2027"], d), ["evals-intern", "--space", "team2027"]), "start @name → name");
  assert(eq(hoistAddressSpace("restart", ["@evals-intern"], d), ["evals-intern"]), "restart @name → name");
  assert(eq(hoistAddressSpace("start", ["@a", "@b"], d), ["a", "b"]), "start @a @b → every name slot");
  assert(eq(hoistAddressSpace("restart", ["@evals-intern#team2027"], d), ["evals-intern", "--space", "team2027"]), "restart @name#space → name + --space");
  assert(eq(hoistAddressSpace("stop", ["--name", "@x"], d), ["--name", "x"]), "stop --name @x → x");
  assert(eq(hoistAddressSpace("restart", ["paw@feat"], d), ["paw@feat"]), "repo@branch is not a sigil");
  assert(eq(hoistAddressSpace("chat", ["@x"], d), ["@x"]), "chat keeps its own @ (it reads it itself)");
  assert(eq(hoistAddressSpace("type", ["@x", "hi"], d), ["@x", "hi"]), "type keeps its @ (atOnly)");
}

// paw mcp: only --to names an agent — a server name, URL fragment or the server's own argv never does
{
  assert(eq(hoistAddressSpace("mcp", ["add", "srv", "--to", `x#lab`, "https://h/mcp#frag"], d), ["add", "srv", "--to", "x", "https://h/mcp#frag", "--space", "lab"]), "mcp add --to x#space → --to x + --space (the URL's # untouched)");
  assert(eq(hoistAddressSpace("mcp", ["add", "srv", `--to=x#lab`], d), ["add", "srv", "--to=x", "--space", "lab"]), "mcp --to=x#space");
  assert(eq(hoistAddressSpace("mcp", ["add", "a#b", "--to", "x", "--", "cmd", `y#lab`], d), ["add", "a#b", "--to", "x", "--", "cmd", `y#lab`]), "mcp: positionals and the server argv after -- are never addresses");
  assert(eq(hoistAddressSpace("mcp", ["add", "s", "--header", `X: a#lab`, "--to", `x#lab`], d), ["add", "s", "--header", `X: a#lab`, "--to", "x", "--space", "lab"]), "mcp: a --header value is skipped, not hoisted");
}

// every listed command's slot table is exercised by the CLI pass below
const CLI_ADDRESS: Record<string, string[]> = {
  chat: ["@x#nosuch"], dm: ["x#nosuch", "hi"], open: ["x#nosuch"], attach: ["x#nosuch"], log: ["x#nosuch"],
  sessions: ["x#nosuch"], stop: ["x#nosuch"], rm: ["x#nosuch"], rename: ["x#nosuch", "y"], adopt: ["./x#nosuch"],
  status: ["x#nosuch"], start: ["x#nosuch"], sleep: ["x#nosuch"], inbox: ["x#nosuch"], restart: ["x#nosuch"],
  unstick: ["x#nosuch"], type: ["@x#nosuch", "hi"], nice: ["x#nosuch", "5"], persona: ["x#nosuch"], optimize: ["x#nosuch"],
  top: ["x#nosuch"], tidy: ["x#nosuch"], launchd: ["install", "x#nosuch"], ask: ["role#nosuch", "q"],
  msg: ["#ops#nosuch", "hi"], history: ["#ops#nosuch"], claude: ["--name", "x#nosuch"],
  teleport: ["x#nosuch", "--to", "ssh:box", "--dry-run"],
  move: ["x#nosuch", "--to-space", "other", "--dry-run"],
  relocate: ["x#nosuch", "/tmp/elsewhere", "--dry-run"],
  cron: ["add", "x#nosuch", "--in", "5m", "hi"],
  sandbox: ["shell", "x#nosuch"],
  mcp: ["ls", "--to", "x#nosuch"],
};
assert(eq(Object.keys(CLI_ADDRESS).sort(), Object.keys(ADDRESS_ARGS).sort()), "the CLI pass covers every address-aware command");

// ── 3. the real CLI: fail loud before any mesh ─────────────────────────────────────────────────────
console.log("cli");
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paw.ts");
const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: "utf8", timeout: 30_000 });
for (const [cmd, args] of Object.entries(CLI_ADDRESS)) {
  const r = run([cmd, ...args]);
  assert(r.status === 1 && /unknown space "nosuch"/.test(r.stderr), `paw ${cmd} ${args.join(" ")} → unknown space, exit 1${r.status === 1 ? "" : ` (status ${r.status}: ${r.stderr.slice(0, 200)})`}`);
}
{
  const r = run(["dm", `x#${OTHER}`, "hi", "--space", SPACE]);
  assert(r.status === 1 && /--space says/.test(r.stderr), "paw dm x#a --space b → disagreement, exit 1");
  const s = run(["c", `@x#${OTHER}`, "--space", SPACE]);
  assert(s.status === 1 && /--space says/.test(s.stderr), "short form `paw c` is hoisted too");
  const g = run(["rm", "github:o/r#main#paw"]);
  assert(g.status === 1 && /ambiguous/.test(g.stderr), "paw rm github:o/r#branch#space → ambiguity, exit 1");
  const at = run(["persona", `@nobody#${OTHER}`]);
  assert(at.status === 1 && at.stderr.includes(`no agent "nobody" in space "${OTHER}"`), `paw persona @nobody#<space>: the @ never reaches the command (got: ${at.stderr.trim().slice(0, 160)})`);
  const p = run(["persona", `nobody#${OTHER}`]);
  assert(p.status === 1 && p.stderr.includes(`in space "${OTHER}"`), `paw persona nobody#<space> reaches the command ON that space (got: ${p.stderr.trim().slice(0, 160)})`);
}

rmSync(home, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} hash-space check(s) failed`);
  process.exit(1);
}
console.log("\nall hash-space checks passed 🐾");

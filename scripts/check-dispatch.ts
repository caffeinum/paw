/**
 * Smoke check for paw's CLI dispatch (src/dispatch.ts) + command self-registration: the
 * endpoint-native surface is paw-owned commands resolved from core's registry, so the two pure
 * helpers left are default-space injection and the `paw cotal` namespace strip. Unknown-command
 * handling lives in bin/paw.ts (not unit-testable here). Pure; no daemons. Run: pnpm check:dispatch
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { registry, type Command } from "@cotal-ai/core";
import { downSpace, expandEqFlags, failureLine, helpRequested, oneShotReplyNote, stripCotalNamespace, verbHelp, withDefaultSpace } from "../src/dispatch.ts";
import { CALLER_SPACE_VERBS, defaultSpaceFor } from "../src/space.ts";
import { assertRuntimeUsable, resolveRuntime, runtimePreferencePath, writeRuntimePreference } from "../src/lifecycle.ts";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// withDefaultSpace: append a trailing --space, never shadowing a positional subcommand.
assert(eq(withDefaultSpace(["ps"], "paw"), ["ps", "--space", "paw"]), "injects --space when absent");
assert(
  eq(withDefaultSpace(["history", "clear", "--force"], "paw"), ["history", "clear", "--force", "--space", "paw"]),
  "appends at END (a passthrough subcommand like `history clear` stays first)",
);

// A command's parseArgs must still read the first positional as the subcommand after injection.
const wired = withDefaultSpace(["clear", "--force"], "paw");
const { values, positionals } = parseArgs({
  args: wired,
  allowPositionals: true,
  options: { space: { type: "string" }, force: { type: "boolean" } },
});
assert(positionals[0] === "clear", "subcommand stays the first positional after injection");
assert(values.space === "paw", "the injected --space is parsed as a flag");

// Operator's own --space (a real flag) is respected, not double-injected.
assert(eq(withDefaultSpace(["ps", "--space", "main"], "paw"), ["ps", "--space", "main"]), "operator --space flag is respected (no double-inject)");
assert(eq(withDefaultSpace(["console", "--space=main"], "paw"), ["console", "--space=main"]), "--space=… form is respected");
// A bare '--space' as the final token (a message body word) is NOT mistaken for a flag → still inject.
const bodyWord = withDefaultSpace(["msg", "general", "--space"], "paw");
assert(bodyWord[bodyWord.length - 2] === "--space" && bodyWord[bodyWord.length - 1] === "paw", "trailing '--space' body word still gets the default injected");

// stripCotalNamespace: `paw cotal <cmd>` strips the namespace word; everything else is untouched.
// The stripped remainder is what bin spawns against bin/cotald.ts (with --space injected).
assert(eq(stripCotalNamespace(["cotal", "ps"]), ["ps"]), "cotal ps → ps (namespace stripped)");
assert(eq(stripCotalNamespace(["cotal"]), []), "bare `cotal` strips to [] (passthrough-hint branch)");
assert(eq(stripCotalNamespace(["ps"]), ["ps"]), "a non-cotal verb is untouched");
assert(eq(stripCotalNamespace([]), []), "empty argv is safe");
const passthrough = withDefaultSpace(stripCotalNamespace(["cotal", "console", "--plain"]), "paw");
assert(eq(passthrough, ["console", "--plain", "--space", "paw"]), "cotal console --plain → console --plain --space paw (strip + inject compose)");

// expandEqFlags: `--space=x`/`--server=x` expand to the two-token form every command parser reads;
// positionals (even ones containing `=` or starting with other `--` flags) are untouched.
assert(eq(expandEqFlags(["ps", "--space=main"]), ["ps", "--space", "main"]), "--space=main expands to two tokens");

// downSpace: `paw down --space x` must tear down x, never the default space (it once stopped the live one)
const live = () => "paw";
assert(downSpace(["--space", "test-x"], live) === "test-x", "paw down --space test-x targets test-x");
assert(downSpace(["--space=test-y"], live) === "test-y", "paw down --space=test-y targets test-y");
assert(downSpace([], live) === "paw", "bare paw down uses the resolved space");
for (const bad of [["--space"], ["test-x"], ["--space", "a", "--space", "b"], ["--space", "--force"]]) {
  let threw = false;
  try {
    downSpace(bad, live);
  } catch {
    threw = true;
  }
  assert(threw, `paw down ${bad.join(" ")} is refused, never guessed`);
}
assert(eq(expandEqFlags(["watch", "--server=nats://x:4222"]), ["watch", "--server", "nats://x:4222"]), "--server=… expands");
assert(eq(expandEqFlags(["msg", "general", "a=b"]), ["msg", "general", "a=b"]), "a positional containing '=' is untouched");
assert(eq(expandEqFlags(["history", "--limit=5"]), ["history", "--limit=5"]), "other --flag= forms are untouched (only space/server)");
const eqComposed = expandEqFlags(withDefaultSpace(["ps", "--space=main"], "paw"));
assert(eq(eqComposed, ["ps", "--space", "main"]), "--space= passes injection-skip AND lands parseable (the two compose)");

// resolveRuntime (lifecycle): PAW_RUNTIME → validated manager runtime, fail-loud on garbage.
const savedRT = process.env.PAW_RUNTIME;
delete process.env.PAW_RUNTIME;
assert(resolveRuntime() === "pty", "default runtime is pty (no PAW_RUNTIME)");
process.env.PAW_RUNTIME = "cmux";
assert(resolveRuntime() === "cmux", "PAW_RUNTIME=cmux resolves");
process.env.PAW_RUNTIME = "  tmux  ";
assert(resolveRuntime() === "tmux", "PAW_RUNTIME is trimmed");
process.env.PAW_RUNTIME = "bogus";
let rtThrew = false;
try {
  resolveRuntime();
} catch {
  rtThrew = true;
}
assert(rtThrew, "an unknown PAW_RUNTIME fails loud (no silent pty fallback)");
if (savedRT === undefined) delete process.env.PAW_RUNTIME;
else process.env.PAW_RUNTIME = savedRT;

// resolveRuntime(space) precedence: env > per-space preference file > pty. Under a temp PAW_HOME so
// the real ~/.paw is untouched; env must be unset for the file/default legs to show.
{
  const savedHome = process.env.PAW_HOME;
  const savedEnv = process.env.PAW_RUNTIME;
  const home = mkdtempSync(join(tmpdir(), "paw-runtime-pref-"));
  process.env.PAW_HOME = home;
  delete process.env.PAW_RUNTIME;
  const space = "prefspace";

  assert(resolveRuntime(space) === "pty", "no env + no preference file → pty default");

  writeRuntimePreference(space, "tmux");
  assert(resolveRuntime(space) === "tmux", "preference file wins over pty default");

  process.env.PAW_RUNTIME = "cmux";
  assert(resolveRuntime(space) === "cmux", "PAW_RUNTIME env wins over the preference file");
  delete process.env.PAW_RUNTIME;

  writeFileSync(runtimePreferencePath(space), "garbage");
  assert(resolveRuntime(space) === "pty", "a garbage preference file is ignored → pty default");

  process.env.PAW_RUNTIME = "nonsense";
  let prefEnvThrew = false;
  try {
    resolveRuntime(space);
  } catch {
    prefEnvThrew = true;
  }
  assert(prefEnvThrew, "a garbage PAW_RUNTIME still fails loud even with a preference file present");

  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PAW_HOME;
  else process.env.PAW_HOME = savedHome;
  if (savedEnv === undefined) delete process.env.PAW_RUNTIME;
  else process.env.PAW_RUNTIME = savedEnv;
}

// assertRuntimeUsable: pty/tmux always ok; cmux is gated on `cmux ping` reachability (the app is a
// singleton reachable over its DEFAULT socket — no cmux surface / same-tab needed). Stub the cmux
// CLI via CMUX_BUNDLED_CLI_PATH with tiny exit-0 / exit-1 scripts to make this hermetic.
{
  const savedBin = process.env.CMUX_BUNDLED_CLI_PATH;
  assertRuntimeUsable("pty"); // no throw
  assertRuntimeUsable("tmux"); // no throw

  const stubDir = mkdtempSync(join(tmpdir(), "paw-cmux-stub-"));
  const okBin = join(stubDir, "cmux-ok");
  const badBin = join(stubDir, "cmux-bad");
  writeFileSync(okBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(badBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  process.env.CMUX_BUNDLED_CLI_PATH = okBin; // ping exits 0 → app reachable
  let cmuxReachableOk = true;
  try {
    assertRuntimeUsable("cmux");
  } catch {
    cmuxReachableOk = false;
  }
  assert(cmuxReachableOk, "cmux reachable (`cmux ping` ok) → allowed, no surface needed");

  process.env.CMUX_BUNDLED_CLI_PATH = badBin; // ping exits 1 → app unreachable
  let cmuxUnreachableThrew = false;
  try {
    assertRuntimeUsable("cmux");
  } catch {
    cmuxUnreachableThrew = true;
  }
  assert(cmuxUnreachableThrew, "cmux unreachable (`cmux ping` fails) → fails loud");

  rmSync(stubDir, { recursive: true, force: true });
  if (savedBin === undefined) delete process.env.CMUX_BUNDLED_CLI_PATH;
  else process.env.CMUX_BUNDLED_CLI_PATH = savedBin;
}

// The endpoint-native commands self-register into core's registry on import. (`ps` was merged into
// `status`; the raw manager ps stays at `paw cotal ps`.)
await import("../src/commands/stop.ts");
await import("../src/commands/msg.ts");
await import("../src/commands/ask.ts");
await import("../src/commands/who.ts");
await import("../src/commands/history.ts");
await import("../src/commands/watch.ts");
await import("../src/commands/runtime.ts");
for (const name of ["stop", "msg", "ask", "who", "history", "watch", "runtime", "restart"]) {
  let found: Command | undefined;
  try {
    found = registry.resolve<Command>("command", name);
  } catch {
    found = undefined;
  }
  assert(found !== undefined && found.kind === "command", `"${name}" self-registers as a command`);
}

// A `--` terminator ends PAW's args. Appending `--space` past it configured an MCP server to run
// `npx -y pkg --space paw` — caught by running the real command, not by review.
{
  const out = withDefaultSpace(["mcp", "add", "x", "--", "npx", "-y", "pkg"], "paw");
  assert(out.join(" ") === "mcp add x --space paw -- npx -y pkg", "--space is injected BEFORE a `--` terminator, never into the passthrough");
  assert(withDefaultSpace(["mcp", "add", "x", "--space", "other", "--", "npx"], "paw").join(" ") === "mcp add x --space other -- npx", "an operator --space before `--` still suppresses the injection");
  // A `--space` AFTER the terminator is the CHILD's argument and says nothing about paw's space.
  assert(
    withDefaultSpace(["mcp", "add", "x", "--", "srv", "--space", "theirs"], "paw").join(" ") === "mcp add x --space paw -- srv --space theirs",
    "a --space after `--` belongs to the child and does not suppress paw's own",
  );
  assert(withDefaultSpace(["who"], "paw").join(" ") === "who --space paw", "with no terminator it still appends, as before");
}

// ── short forms: `paw a` = `paw attach` (2026-09-23) ─────────────────────────────────────────────
{
  const { SHORT_FORMS, expandShortForm } = await import("../src/dispatch.ts");
  // Load every module that registers a verb a short form points at, so the check is against the REAL
  // registry, not a list typed out here that could drift from it.
  for (const m of ["chat", "open", "status", "log", "dm", "inbox", "web"]) await import(`../src/${m}.ts`);
  const verbs = new Set(registry.all<Command>("command").map((c) => c.name));
  for (const [k, v] of Object.entries(SHORT_FORMS)) {
    assert(verbs.has(v), `short: ${k} → ${v} is a registered command (a typo here would be a dead alias)`);
    assert(!verbs.has(k), `short: "${k}" doesn't shadow a real command`);
  }
  for (const v of ["rm", "stop", "restart", "down", "rename"]) assert(!Object.values(SHORT_FORMS).includes(v), `short: destructive "${v}" gets no letter`);
  assert(expandShortForm("a") === "attach" && expandShortForm("s") === "status", "short: a/s expand");
  assert(expandShortForm("attach") === "attach" && expandShortForm("ab") === "ab" && expandShortForm(undefined) === undefined, "short: anything else passes through untouched (no prefix guessing)");
  assert(expandShortForm("constructor") === "constructor" && expandShortForm("toString") === "toString", "short: Object prototype names are not aliases");
}

// oneShotReplyNote: a one-shot `cotal send dm|ask` has no inbox, so a reply to it reaches nobody.
assert(oneShotReplyNote(["send", "dm", "intern", "ping"])?.includes("paw dm") === true, "reply note: send dm without --creds is flagged");
assert(oneShotReplyNote(["send", "ask", "reviewer", "look"]) !== undefined, "reply note: send ask is flagged");
assert(oneShotReplyNote(["send", "msg", "general", "hi"]) === undefined, "reply note: send msg is not (replies go to the channel)");
assert(oneShotReplyNote(["send", "dm", "intern", "ping", "--creds", "/x.creds"]) === undefined, "reply note: --creds silences it");
assert(oneShotReplyNote(["send", "dm", "intern", "ping", "--creds=/x.creds"]) === undefined, "reply note: --creds= silences it");
assert(oneShotReplyNote(["send", "dm", "intern", "--", "--creds"]) !== undefined, "reply note: a --creds after -- is message text, not a flag");
assert(oneShotReplyNote(["join", "--name", "mini"]) === undefined && oneShotReplyNote([]) === undefined, "reply note: other verbs untouched");

// failureLine: what bin/paw.ts prints before exit(1) — never blank (a launchd log showed a failed run with no reason).
{
  const at = new Date("2026-10-20T02:39:21.000Z");
  assert(failureLine("start", new Error("paw: mesh failed"), false) === "paw: mesh failed", "failure line: a real message prints as-is on a terminal");
  const blank = failureLine("start", new Error(""), false);
  assert(blank.trim().length > 0 && blank.includes("paw start") && blank.includes("no message"), "failure line: an Error with an EMPTY message still names a failure");
  for (const thrown of [undefined, null, "", {}])
    assert(failureLine("start", thrown, false).trim().length > 0, `failure line: a thrown ${JSON.stringify(thrown) ?? "undefined"} is never blank`);
  assert(failureLine("start", "boom", false) === "boom", "failure line: a thrown string prints as-is");
  const stamped = failureLine("start", new Error("paw: mesh failed"), true, at);
  assert(
    stamped === "paw: mesh failed\n[2026-10-20T02:39:21.000Z] paw start failed (exit 1)",
    "failure line: off a terminal (launchd log) it closes with a timestamped `paw <cmd> failed` line",
  );
}

// helpRequested: `--help`/`-h` is a help request only where it is a FLAG (#78).
assert(helpRequested("open", ["--help"]) && helpRequested("open", ["-h"]) && helpRequested("open", [".", "--help"]), "help flag: --help / -h anywhere among the verb's flags");
assert(helpRequested("dm", ["x", "--help"]), "help flag: `paw dm x --help` is a request");
assert(!helpRequested("dm", ["x", "--", "--help"]), "help flag: after `--` it's the message (`paw dm x -- --help`)");
assert(!helpRequested("open", ["--name", "--help"]) && !helpRequested("chat", ["--model", "-h"]), "help flag: a flag's VALUE is not a request");
assert(!helpRequested("mcp", ["add", "x", "--", "npx", "--help"]), "help flag: a passthrough command's --help stays its own");
assert(!helpRequested("cotal", ["attach", "--help"]) && !helpRequested("__complete", ["open", "--help"]), "help flag: cotal's own help and completion's half-typed line are untouched");
assert(!helpRequested("dm", ["x", "please see --help-ish"]) && !helpRequested("open", []), "help flag: a word merely containing it is not a request");
assert(verbHelp({ name: "x", summary: "does x", usage: "paw x <y>\n  x --z" }, "q") === "usage: paw x <y>\n       paw x --z\n\n  does x\n  short form: paw q", "help text: usage lines (paw prefix normalised), summary, short form");
assert(
  verbHelp({ name: "y", summary: "does y", positionals: "<a>", flags: [{ name: "n", short: "n", type: "string", value: "<N>" }, { name: "v", type: "boolean" }] }).startsWith("usage: paw y <a> [-n|--n <N>] [--v]"),
  "help text: a verb with no usage gets one built from its registry declaration",
);

// defaultSpaceFor: a spawning verb run inside an agent (COTAL_SPACE, no PAW_SPACE) defaults to THAT space.
{
  const saved = { p: process.env.PAW_SPACE, c: process.env.COTAL_SPACE };
  delete process.env.PAW_SPACE;
  process.env.COTAL_SPACE = "team-x";
  for (const v of ["open", "attach", "chat", "start", "dm", "claude", "cron"]) assert(CALLER_SPACE_VERBS.has(v) && defaultSpaceFor(v) === "team-x", `caller space: \`paw ${v}\` inside an agent of team-x → team-x`);
  assert(defaultSpaceFor("status") === "paw" && defaultSpaceFor("inbox") === "paw", "caller space: other verbs keep the current space");
  process.env.PAW_SPACE = "test-env";
  assert(defaultSpaceFor("open") === "test-env", "caller space: PAW_SPACE wins");
  delete process.env.PAW_SPACE;
  delete process.env.COTAL_SPACE;
  assert(defaultSpaceFor("open") === "paw", "caller space: a human shell (no COTAL_SPACE) is unchanged");
  if (saved.p === undefined) delete process.env.PAW_SPACE;
  else process.env.PAW_SPACE = saved.p;
  if (saved.c === undefined) delete process.env.COTAL_SPACE;
  else process.env.COTAL_SPACE = saved.c;
}

// Lazy command loading (src/command-modules.ts): bin/paw.ts evaluates ONLY the verb's mapped module,
// so each entry must register its verb ALONE, in a fresh process (no sibling already loaded it), and the
// map must name every verb the full module set registers.
{
  const root = join(import.meta.dirname, "..");
  const modules = pathToFileURL(join(root, "src", "command-modules.ts")).href;
  const names = (body: string): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const script = `const { registry } = await import("@cotal-ai/core"); const m = await import(${JSON.stringify(modules)}); ${body}; process.stdout.write(JSON.stringify(registry.all("command").map((c) => c.name)));`;
      execFile(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...process.env, NODE_OPTIONS: "" } }, (err, out, errOut) =>
        err ? reject(new Error(`${body}: ${errOut || err.message}`)) : resolve(JSON.parse(out) as string[]),
      );
    });
  const { COMMAND_LOADERS } = await import("../src/command-modules.ts");
  const all = await names("await m.loadAllCommands()");
  const mapped = Object.keys(COMMAND_LOADERS);
  const unmapped = all.filter((n) => !mapped.includes(n));
  const phantom = mapped.filter((n) => !all.includes(n));
  assert(unmapped.length === 0, `command-modules: every registered verb has a loader${unmapped.length ? ` (missing: ${unmapped.join(", ")})` : ""}`);
  assert(phantom.length === 0, `command-modules: every loader names a registered verb${phantom.length ? ` (unknown: ${phantom.join(", ")})` : ""}`);
  const wrong: string[] = [];
  const queue = [...mapped];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let verb = queue.shift(); verb !== undefined; verb = queue.shift())
        if (!(await names(`await m.COMMAND_LOADERS[${JSON.stringify(verb)}]()`)).includes(verb)) wrong.push(verb);
    }),
  );
  assert(wrong.length === 0, `command-modules: each verb's loader registers it on its own${wrong.length ? ` (not: ${wrong.join(", ")})` : ""}`);
  const lone = await names(`await m.loadCommandsFor("who")`);
  assert(lone.includes("who") && lone.length < all.length, `command-modules: \`paw who\` loads ${lone.length} of ${all.length} commands, not all`);
  const full = await names(`await m.loadCommandsFor("__complete")`);
  assert(full.length === all.length, "command-modules: completion loads every command (it lists the whole registry)");
  const unknown = await names(`await m.loadCommandsFor("no-such-verb")`);
  assert(unknown.length === all.length, "command-modules: an unknown verb loads every command before failing loud");

  // ── `paw <verb> --help` never touches the mesh (#78: `paw open --help` spawned an agent) ─────────────
  // Every registered verb, run for real through bin/paw.ts off a tty, in a fresh PAW_HOME whose broker
  // (PAW_SERVER) is unreachable. The spy is the home itself: ensure() takes a lock file under it, spawning
  // writes personas and the mesh registry under it — so it must still be EMPTY afterwards. And with the
  // broker unreachable, any ensure() would also have failed the run, not exited 0.
  const pawBin = join(root, "bin", "paw.ts");
  const runPaw = (argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string; home: string }> => {
    const home = mkdtempSync(join(tmpdir(), "paw-help-home-"));
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [pawBin, ...argv],
        { cwd: env.CWD ?? root, env: { ...process.env, NODE_OPTIONS: "", PAW_HOME: home, PAW_SPACE: "test-help", PAW_RELEASE: "dev", PAW_SERVER: "nats://127.0.0.1:1", COTAL_NAME: undefined, COTAL_SPACE: undefined, ...env, CWD: undefined } },
        (err, out, errOut) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out, err: errOut, home }),
      );
      child.stdin?.end();
    });
  };
  const emptyHome = (home: string): boolean => {
    const left = readdirSync(home);
    rmSync(home, { recursive: true, force: true });
    return left.length === 0;
  };
  const verbs = [...all.filter((v) => v !== "__complete"), "down"];
  const helpRuns: string[] = [];
  const helpQueue = verbs.flatMap((v) => [[v, "--help"], [v, "-h"]]);
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let argv = helpQueue.shift(); argv !== undefined; argv = helpQueue.shift()) {
        const r = await runPaw(argv);
        const clean = emptyHome(r.home);
        if (r.code !== 0 || !r.out.startsWith(`usage: paw ${argv[0]}`) || !clean)
          helpRuns.push(`${argv.join(" ")} (exit ${r.code}, home ${clean ? "empty" : "WRITTEN"}: ${(r.err || r.out).trim().split("\n")[0]})`);
      }
    }),
  );
  assert(helpRuns.length === 0, `help: all ${verbs.length} verbs answer --help and -h with their usage, exit 0, nothing written${helpRuns.length ? ` — ${helpRuns.join("; ")}` : ""}`);
  {
    const r = await runPaw(["help", "a"]);
    assert(r.code === 0 && r.out.startsWith("usage: paw attach") && emptyHome(r.home), "help: `paw help a` shows attach's usage (short form expanded)");
    const bad = await runPaw(["help", "no-such-verb"]);
    assert(bad.code === 1 && bad.err.includes("no-such-verb") && emptyHome(bad.home), "help: `paw help <unknown>` fails loud");
    const top = await runPaw(["--help"]);
    assert(top.code === 0 && top.out.includes("usage: paw <command>") && emptyHome(top.home), "help: `paw --help` still lists every command");
    const word = await runPaw(["help"]);
    assert(word.code === 0 && word.out.includes("usage: paw <command>") && emptyHome(word.home), "help: `paw help` still lists every command");
  }

  // ── `paw open`/`attach` off a tty never CREATES an agent (#78) — refused before the mesh is touched ─
  // And inside an agent (COTAL_SPACE, no PAW_SPACE) the verb defaults to THAT agent's space.
  {
    const folder = mkdtempSync(join(tmpdir(), "paw-open-notty-"));
    for (const argv of [["open"], ["attach", "."], ["open", folder, "--name", "extra1"]]) {
      const r = await runPaw(argv, { CWD: folder });
      const personas = join(r.home, "spaces", "test-help", "personas");
      const born = existsSync(personas) ? readdirSync(personas) : [];
      rmSync(r.home, { recursive: true, force: true });
      assert(
        r.code === 1 && r.err.includes("won't create one without a tty") && r.err.includes("creates one") && born.length === 0,
        `no-tty: \`paw ${argv.join(" ")}\` in a folder with no agent refuses, registers nothing${born.length ? ` (born: ${born.join(", ")})` : ""}`,
      );
    }
    const inAgent = await runPaw(["open"], { CWD: folder, PAW_SPACE: undefined, COTAL_SPACE: "test-caller", COTAL_NAME: "caller" });
    rmSync(inAgent.home, { recursive: true, force: true });
    assert(inAgent.code === 1 && inAgent.err.includes("in space test-caller"), "in-agent: `paw open` from an agent of test-caller acts on test-caller, not the default space");
    const pinned = await runPaw(["open"], { CWD: folder, PAW_SPACE: "test-env", COTAL_SPACE: "test-caller", COTAL_NAME: "caller" });
    rmSync(pinned.home, { recursive: true, force: true });
    assert(pinned.code === 1 && pinned.err.includes("in space test-env"), "in-agent: PAW_SPACE still wins over the calling agent's space");
    const flag = await runPaw(["open", "--space", "test-flag"], { CWD: folder, PAW_SPACE: undefined, COTAL_SPACE: "test-caller", COTAL_NAME: "caller" });
    rmSync(flag.home, { recursive: true, force: true });
    assert(flag.code === 1 && flag.err.includes("in space test-flag"), "in-agent: an explicit --space still wins");

    // `--no-attach` is the scripted way to create one (#88): off a tty it is NOT refused — it goes on to
    // the mesh (unreachable here, so it fails THERE, after the tty gate it used to stop at).
    const scripted = await runPaw(["open", folder, "--no-attach"], { CWD: folder });
    rmSync(scripted.home, { recursive: true, force: true });
    assert(
      scripted.code === 1 && !scripted.err.includes("without a tty") && scripted.err.includes("unreachable"),
      `no-attach: \`paw open <folder> --no-attach\` off a tty passes the tty gate and reaches the mesh (${scripted.err.trim().split("\n")[0]})`,
    );
    const refusal = await runPaw(["open"], { CWD: folder });
    rmSync(refusal.home, { recursive: true, force: true });
    assert(refusal.code === 1 && refusal.err.includes("--no-attach` creates one without attaching"), "no-attach: the no-tty refusal names `paw open … --no-attach`");
    rmSync(folder, { recursive: true, force: true });
  }

  // ── `paw open <owner>/<repo>@<branch>` (#88): a branch that isn't on origin fails loud BEFORE any agent ─
  // A local bare repo stands in for GitHub; the paw clone is pre-made under the run's PAW_HOME.
  {
    const home = mkdtempSync(join(tmpdir(), "paw-open-gh-home-"));
    const origin = join(home, "origin.git");
    const seed = join(home, "seed");
    const sh = (args: string[], cwd?: string) => execFileSync("git", ["-c", "user.email=t@paw", "-c", "user.name=paw", ...args], { cwd, stdio: "ignore" });
    sh(["init", "-q", "--bare", "-b", "main", origin]);
    sh(["clone", "-q", origin, seed]);
    sh(["commit", "-q", "--allow-empty", "-m", "init"], seed);
    sh(["push", "-q", "origin", "HEAD:main"], seed);
    mkdirSync(join(home, "repos", "acme"), { recursive: true });
    sh(["clone", "-q", origin, join(home, "repos", "acme", "widget")]);
    const cwd = mkdtempSync(join(tmpdir(), "paw-open-gh-cwd-"));
    const r = await runPaw(["open", "acme/widget@no-such-branch", "--no-attach"], { CWD: cwd, PAW_HOME: home });
    const personas = join(home, "spaces", "test-help", "personas");
    assert(
      r.code === 1 && r.err.includes('no branch "no-such-branch" on origin for acme/widget') &&
        !existsSync(join(home, "repos", "acme", "widget.worktrees")) && !(existsSync(personas) && readdirSync(personas).length),
      `gh-branch: \`paw open acme/widget@no-such-branch\` fails loud naming the branch, no worktree, no agent (${r.err.trim().split("\n")[0]})`,
    );
    const local = await runPaw(["open", "nosuchfolder@main"], { CWD: cwd, PAW_HOME: home });
    assert(local.code === 1 && local.err.includes("<owner>/<repo>@<branch>"), "gh-branch: `paw open <missing folder>@<branch>` names the GitHub form that works");
    for (const d of [home, cwd, r.home, local.home]) rmSync(d, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} paw dispatch check(s) failed`);
  process.exit(1);
}
console.log("\nall paw dispatch checks passed 🐾");

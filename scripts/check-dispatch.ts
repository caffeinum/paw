/**
 * Smoke check for paw's CLI dispatch (src/dispatch.ts) + command self-registration: the
 * endpoint-native surface is paw-owned commands resolved from core's registry, so the two pure
 * helpers left are default-space injection and the `paw cotal` namespace strip. Unknown-command
 * handling lives in bin/paw.ts (not unit-testable here). Pure; no daemons. Run: pnpm check:dispatch
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { registry, type Command } from "@cotal-ai/core";
import { expandEqFlags, stripCotalNamespace, withDefaultSpace } from "../src/dispatch.js";
import { assertRuntimeUsable, resolveRuntime, runtimePreferencePath, writeRuntimePreference } from "../src/lifecycle.js";

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
await import("../src/commands/stop.js");
await import("../src/commands/msg.js");
await import("../src/commands/ask.js");
await import("../src/commands/who.js");
await import("../src/commands/history.js");
await import("../src/commands/watch.js");
await import("../src/commands/runtime.js");
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

if (failures > 0) {
  console.error(`\n${failures} paw dispatch check(s) failed`);
  process.exit(1);
}
console.log("\nall paw dispatch checks passed 🐾");

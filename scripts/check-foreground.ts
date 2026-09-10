/**
 * Smoke check for `paw claude` (src/claude.ts) + the foreground registry (src/foreground.ts): the
 * per-space registry (register/read/list + stale-pid self-reap), the ensureAgentSpawned reuse-guard
 * (a live foreground agent → {spawned:false}, never a manager duplicate), and the pure arg helpers
 * (peelArgs / deriveSessionIntent / stripSessionFlags). Hermetic — isolated PAW_HOME, no daemons.
 * The interactive tty spawn itself isn't unit-testable; this covers everything around it. Run:
 * pnpm check:foreground
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-fg-home-"));
process.env.PAW_SPACE = "fgtest";
const space = "fgtest";

const { registerForeground, readForeground, listForeground, unregisterForeground } = await import("../src/foreground.js");
const { peelArgs, deriveSessionIntent, stripSessionFlags, finalLaunchArgs } = await import("../src/claude.js");
const { ensureAgentSpawned } = await import("../src/addressing.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- registry: register / read / list, keyed by name, one file per agent ----
const folder = realpathSync(mkdtempSync(join(tmpdir(), "paw-fg-proj-")));
registerForeground(space, { name: "web", folder, pid: process.pid, startedAt: Date.now(), sessionId: "sess-1", argv: ["-c"] });
const read = readForeground(space, "web");
assert(read !== undefined && read.name === "web" && read.pid === process.pid, "readForeground returns the live entry");
assert(read?.sessionId === "sess-1" && eq(read?.argv, ["-c"]), "sessionId + argv round-trip");
assert(listForeground(space).some((e) => e.name === "web"), "listForeground includes the live entry");

// A second agent in the same space is an independent file (no shared-file contention).
registerForeground(space, { name: "api", folder, pid: process.pid, startedAt: Date.now(), argv: [] });
assert(listForeground(space).length === 2, "two agents → two independent entries");

// ---- self-reap: a dead pid is reaped on read (a `paw claude` dies with its terminal) ----
const DEAD = 2147480000; // a pid that cannot be alive
registerForeground(space, { name: "ghost", folder, pid: DEAD, startedAt: Date.now(), argv: [] });
assert(readForeground(space, "ghost") === undefined, "readForeground reaps a dead-pid entry (returns undefined)");
assert(!listForeground(space).some((e) => e.name === "ghost"), "listForeground drops the reaped entry");

// ---- unregister is idempotent ----
unregisterForeground(space, "api");
assert(readForeground(space, "api") === undefined, "unregisterForeground removes the entry");
unregisterForeground(space, "api"); // no throw on a second call
assert(true, "unregisterForeground is idempotent");

// ---- ensureAgentSpawned reuse-guard: a live foreground agent short-circuits to {spawned:false} ----
// The guard runs BEFORE any control call, so a stub endpoint that throws on use proves it never spawns.
const throwingCtl = {
  ps() {
    throw new Error("ensureAgentSpawned must NOT touch the manager when a foreground agent owns the name");
  },
  spawn() {
    throw new Error("ensureAgentSpawned must NOT spawn when a foreground agent owns the name");
  },
} as unknown as Parameters<typeof ensureAgentSpawned>[0];
const guarded = await ensureAgentSpawned(throwingCtl, { space, name: "web", cwd: folder });
assert(eq(guarded, { spawned: false }), "ensureAgentSpawned returns {spawned:false} for a live foreground name (no manager duplicate)");

// ---- peelArgs: two-zone parse (paw opts vs claude passthrough) ----
assert(eq(peelArgs(["-c"]), { space: undefined, name: undefined, fg: false, noAttach: false, claudeArgs: ["-c"] }), "no paw opts → all tokens passthrough");
assert(eq(peelArgs(["--space", "s", "--name", "n", "-c", "-p", "hi"]), { space: "s", name: "n", fg: false, noAttach: false, claudeArgs: ["-c", "-p", "hi"] }), "leading --space/--name peel; rest passthrough");
assert(eq(peelArgs(["--name=n", "--resume", "x"]), { space: undefined, name: "n", fg: false, noAttach: false, claudeArgs: ["--resume", "x"] }), "--name= form peels; --resume is claude's");
assert(eq(peelArgs(["--", "--space", "foo"]), { space: undefined, name: undefined, fg: false, noAttach: false, claudeArgs: ["--space", "foo"] }), "-- terminator: following --space is claude's, not paw's");
assert(eq(peelArgs(["-p", "--name", "n"]), { space: undefined, name: undefined, fg: false, noAttach: false, claudeArgs: ["-p", "--name", "n"] }), "a claude flag first stops the peel (later --name is claude's)");
assert(eq(peelArgs([]), { space: undefined, name: undefined, fg: false, noAttach: false, claudeArgs: [] }), "empty argv is safe");

assert(
  eq(peelArgs(["--fg", "-c"]), { space: undefined, name: undefined, fg: true, noAttach: false, claudeArgs: ["-c"] }),
  "--fg peels (foreground opt-in), rest passthrough",
);
assert(
  eq(peelArgs(["--foreground", "--no-attach"]), { space: undefined, name: undefined, fg: true, noAttach: true, claudeArgs: [] }),
  "--foreground alias + --no-attach both peel",
);
assert(
  eq(peelArgs(["-p", "--fg"]), { space: undefined, name: undefined, fg: false, noAttach: false, claudeArgs: ["-p", "--fg"] }),
  "--fg AFTER the passthrough begins belongs to claude, not paw",
);

// ---- deriveSessionIntent: what the operator's claude args target (for the durable pin) ----
assert(deriveSessionIntent(["-c"]).mode === "continue", "-c → continue");
assert(deriveSessionIntent(["--continue"]).mode === "continue", "--continue → continue");
const resumeId = deriveSessionIntent(["--resume", "abc123"]);
assert(resumeId.mode === "resume" && resumeId.token === "abc123", "--resume <id> → resume + token");
assert(deriveSessionIntent(["-r", "sid"]).token === "sid", "-r <id> → resume token");
assert(deriveSessionIntent(["--resume"]).mode === "resume" && deriveSessionIntent(["--resume"]).token === undefined, "bare --resume (picker) → resume, no token");
assert(deriveSessionIntent(["--resume", "-p"]).token === undefined, "--resume followed by a flag → no token (bare picker)");
assert(deriveSessionIntent(["-p", "hi"]).mode === "fresh", "no session flag → fresh");

// ---- stripSessionFlags: drop paw's connector-injected session control so the operator's wins ----
assert(eq(stripSessionFlags(["--append-system-prompt", "x", "--session-id", "u"]), ["--append-system-prompt", "x"]), "strips --session-id <id> pair");
assert(eq(stripSessionFlags(["--resume", "u", "--fork-session", "--model", "opus"]), ["--model", "opus"]), "strips --resume <id> pair + bare --fork-session");
assert(eq(stripSessionFlags(["--permission-mode", "bypassPermissions"]), ["--permission-mode", "bypassPermissions"]), "keeps non-session flags untouched");

// ---- finalLaunchArgs: FRESH keeps the connector's durable session pin; explicit --continue/--resume strips it ----
const specArgs = ["--session-id", "PIN", "--permission-mode", "bypassPermissions"];
assert(
  eq(finalLaunchArgs("fresh", specArgs, []), ["--session-id", "PIN", "--permission-mode", "bypassPermissions"]),
  "fresh (bare paw claude): KEEPS the connector's --session-id pin so the folder's durable session is used",
);
assert(
  eq(finalLaunchArgs("continue", specArgs, ["--continue"]), ["--permission-mode", "bypassPermissions", "--continue"]),
  "continue: strips the connector pin so the operator's --continue wins",
);
assert(
  eq(finalLaunchArgs("resume", specArgs, ["--resume", "abc"]), ["--permission-mode", "bypassPermissions", "--resume", "abc"]),
  "resume: strips the connector pin so the operator's --resume wins",
);

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });
rmSync(folder, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw foreground check(s) failed`);
  process.exit(1);
}
console.log("\nall paw foreground checks passed 🐾");

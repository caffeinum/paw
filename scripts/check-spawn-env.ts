/**
 * The daemon spawn must survive a STRIPPED PATH.
 *
 * paw's daemons inherit the env of whoever ran `paw`, and that caller is not always a login shell:
 * Raycast runs extensions with a minimal PATH (no shell rc, no nvm, no /opt/homebrew/bin), and a
 * launchd job is no better. On a normal macOS box that makes node, tmux, cmux, gh and claude ALL
 * unreachable, which surfaced as two errors that named the wrong thing —
 * `tsx: line 20: exec: node: not found` buried in mesh.log under a generic "mesh failed to start",
 * and "manager started but did not answer ps within 8s (is tmux running and reachable?)", which reads
 * like a tmux problem and is not one.
 *
 * These assertions are the guarantee: the spawn command is absolute, and the env paw hands a child
 * can find paw's toolchain even when the inherited PATH contains none of it. The last check actually
 * RUNS the resolved command with that env under a stripped PATH — the only proof that matters, since
 * both bugs type-checked fine.
 *
 * Run: pnpm check:spawn-env
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

// This check is about PATH and exec resolution, not about which TREE the daemon runs from, so it
// pins the checkout explicitly (src/release.ts). Without it `cotaldViaTsx` fails loud here for a
// reason that has nothing to do with what's being asserted — release resolution is check:release's job.
process.env.PAW_RELEASE = "dev";

const { resolveNvmDefault, cotaldViaTsx, daemonEnv } = await import("../src/lifecycle.js");

/** What Raycast (and a launchd job) actually hands paw. */
const STRIPPED = "/usr/bin:/bin:/usr/sbin:/sbin";
const realPath = process.env.PATH;

// --- the spawn command carries no PATH dependency -------------------------------------------------
process.env.PATH = STRIPPED;
const [exec, args] = cotaldViaTsx(["up"]);
assert(isAbsolute(exec), `daemon exec is an ABSOLUTE path, not a bare name resolved from PATH (${exec})`);
assert(existsSync(exec), "daemon exec exists on disk");
assert(!exec.endsWith("/.bin/tsx"), "daemon exec is NOT the .bin/tsx shell shim, whose last line is a bare `exec node`");
assert(args[0].endsWith("cli.mjs") && existsSync(args[0]), "it runs tsx's cli.mjs directly");

// --- the env backfills paw's toolchain ------------------------------------------------------------
const env = daemonEnv();
const dirs = (env.PATH ?? "").split(":").filter(Boolean);
assert(dirs.includes(dirname(exec)), "daemonEnv PATH contains the resolved node's own directory");
for (const tool of ["tmux", "cmux", "gh"]) {
  // Only assert for tools this machine actually has — the point is that a PRESENT tool stays reachable.
  const real = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
  if (!real) {
    console.log(`  --  ${tool} is not installed here; skipping`);
    continue;
  }
  assert(dirs.includes(dirname(real)), `a daemon started from a stripped PATH can still find ${tool}`);
}
const launcher = join(homedir(), ".local", "bin");
if (existsSync(launcher)) assert(dirs.includes(launcher), "~/.local/bin (the paw and claude launchers) is on the daemon PATH");

// --- the operator's own PATH is never reordered ---------------------------------------------------
process.env.PATH = `/zzz-operator-choice:${STRIPPED}`;
const ordered = (daemonEnv().PATH ?? "").split(":").filter(Boolean);
assert(ordered[0] === "/zzz-operator-choice", "missing dirs are APPENDED — the operator's own ordering still wins");
assert(ordered.filter((d) => d === "/usr/bin").length === 1, "an already-present dir is not duplicated");
assert(!ordered.includes("/zzz-does-not-exist"), "non-existent dirs are skipped rather than padding PATH with noise");

// --- and it actually runs ------------------------------------------------------------------------
process.env.PATH = STRIPPED;
const [runExec, runArgs] = cotaldViaTsx([]);
try {
  // `tsx --version` exercises the whole chain (absolute node → tsx cli) with zero side effects: no
  // mesh, no manager, no state touched.
  const out = execFileSync(runExec, [runArgs[0], "--version"], { env: daemonEnv(), encoding: "utf8", timeout: 30_000 });
  assert(/tsx v/.test(out), `the resolved daemon command RUNS under a stripped PATH (${out.split("\n")[0]})`);
} catch (e) {
  assert(false, `the resolved daemon command runs under a stripped PATH — ${(e as Error).message.split("\n")[0]}`);
}

process.env.PATH = realPath;


// ---- reexecUnderNode: the bun→node hand-off for `paw web` ----
{
  const { reexecUnderNode } = await import("../src/lifecycle.js");
  // This suite runs under node+tsx, which is the case that must NOT fork: a re-exec here would spawn a
  // second server for every invocation. (The bun branch can't be exercised from node, and is verified
  // live — bun answers a WebSocket upgrade with nothing at all, node with 101.)
  assert(reexecUnderNode(["web"]) === false, "spawn-env: under node, `paw web` runs in THIS process — no fork");
}

if (failures > 0) {
  console.error(`\n${failures} spawn-env check(s) failed`);
  process.exit(1);
}
console.log("\nall spawn-env checks passed 🐾");


// ── nvm resolution: node comes from nvm on this machine, never brew (2026-09-01). Follow the alias chain
//    the way nvm does, against a FAKE tree so the assertions don't depend on what's installed here. ──
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const nvm = mkdtempSync(join(tmpdir(), "paw-nvm-"));
  const mk = (v: string) => { mkdirSync(join(nvm, "versions", "node", v, "bin"), { recursive: true }); writeFileSync(join(nvm, "versions", "node", v, "bin", "node"), ""); };
  mkdirSync(join(nvm, "alias", "lts"), { recursive: true });
  for (const v of ["v20.18.1", "v24.13.0", "v24.7.0", "v25.8.2"]) mk(v);
  const alias = (name: string, v: string) => writeFileSync(join(nvm, "alias", name), v + "\n");
  const bin = (v: string) => join(nvm, "versions", "node", v, "bin", "node");
  alias("default", "stable");
  assert(resolveNvmDefault(nvm) === bin("v25.8.2"), "default→stable resolves to the highest installed (the real ~/.nvm shape)");
  alias("default", "24");
  assert(resolveNvmDefault(nvm) === bin("v24.13.0"), "a partial major picks the highest matching install");
  alias("default", "v24.7.0");
  assert(resolveNvmDefault(nvm) === bin("v24.7.0"), "an exact version resolves to itself");
  alias("default", "lts/*"); alias("lts/*", "v24.13.0");
  assert(resolveNvmDefault(nvm) === bin("v24.13.0"), "lts/* follows its alias file");
  alias("default", "mine"); alias("mine", "v20.18.1");
  assert(resolveNvmDefault(nvm) === bin("v20.18.1"), "a named alias chains to a version");
  alias("default", "v99.0.0");
  assert(resolveNvmDefault(nvm) === undefined, "a default naming an UNINSTALLED version is undefined, never a fabricated path");
  assert(resolveNvmDefault(join(nvm, "nope")) === undefined, "no nvm dir → undefined");
  console.log("✓ resolveNvmDefault follows nvm's alias chain and never fabricates");
}


// ── harness session markers never cross a daemon boundary (the transcript-off leak, 2026-09-08) ──
{
  const { daemonEnv, stripHarnessMarkers, HARNESS_SESSION_MARKERS } = await import("../src/lifecycle.js");
  const saved: Record<string, string | undefined> = {};
  for (const k of [...HARNESS_SESSION_MARKERS, "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k];
  for (const k of HARNESS_SESSION_MARKERS) process.env[k] = "leaked";
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.CLAUDE_CONFIG_DIR = "/x";
  const env = daemonEnv();
  for (const k of HARNESS_SESSION_MARKERS) assert(!(k in env), `daemonEnv drops ${k}`);
  assert(env.CLAUDE_CODE_USE_BEDROCK === "1" && env.CLAUDE_CONFIG_DIR === "/x", "operator config under the same prefix is kept — a marker list, not a prefix wipe");
  assert(!("CLAUDE_CODE_CHILD_SESSION" in stripHarnessMarkers({ CLAUDE_CODE_CHILD_SESSION: "1", PATH: "/bin" })) , "stripHarnessMarkers is pure and keeps the rest");
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  console.log("✓ harness session markers stripped at the daemon boundary");
}

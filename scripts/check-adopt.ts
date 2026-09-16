/**
 * Smoke check for `paw adopt` (src/adopt.ts): session discovery, the lossy-encoding cwd VERIFY
 * (never resume the wrong project), and the persona write with `resume:`. Runs against an isolated
 * HOME + PAW_HOME so real claude/paw state is untouched. Run: pnpm check:adopt
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-adopt-home-"));
process.env.HOME = home; // claudeProjectDir() resolves under here (homedir honours $HOME on posix)
process.env.PAW_HOME = home; // persona + registry under here too
process.env.PAW_SPACE = "adopt";

import type { Command } from "@cotal-ai/core";
const { claudeProjectDir, latestSession, transcriptCwd, sanitizeAdoptName, parseArgs, pinSession, pinClaudeArgs, planAdoptName, assertSafeRepin } = await import("../src/adopt.js");
const { registry } = await import("@cotal-ai/core");
const { personaFilePath } = await import("../src/addressing.js");
const adoptCmd = registry.resolve<Command>("command", "adopt");
// paw drives commands with a raw argv; wrap it as the ParsedArgs the dispatcher now passes.
const runAdopt = (argv: string[]) => adoptCmd.run({ values: {}, positionals: [], raw: argv });

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
async function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
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

// A real folder + its claude project dir with two sessions (older + newer, mtime-forced).
const work = mkdtempSync(join(tmpdir(), "paw-adopt-work-"));
const folder = join(work, "myproj");
mkdirSync(folder);
const canonical = realpathSync(folder);
const pdir = claudeProjectDir(canonical);
mkdirSync(pdir, { recursive: true });
writeFileSync(join(pdir, "old-sess.jsonl"), JSON.stringify({ cwd: canonical, type: "x" }) + "\n");
writeFileSync(join(pdir, "new-sess.jsonl"), JSON.stringify({ foo: 1 }) + "\n" + JSON.stringify({ cwd: canonical }) + "\n");
writeFileSync(join(pdir, "wrong.jsonl"), JSON.stringify({ cwd: "/some/other/project" }) + "\n");
// Force deterministic mtimes so "new-sess" is unambiguously the latest (write order is irrelevant).
const t = Date.now() / 1000;
utimesSync(join(pdir, "old-sess.jsonl"), t - 3000, t - 3000);
utimesSync(join(pdir, "wrong.jsonl"), t - 2000, t - 2000);
utimesSync(join(pdir, "new-sess.jsonl"), t - 1000, t - 1000);

assert(latestSession(pdir) === "new-sess", "latestSession picks the most recent jsonl");
assert(transcriptCwd(pdir, "new-sess") === canonical, "transcriptCwd reads the recorded cwd");
assert(latestSession(join(home, "nope")) === undefined, "latestSession returns undefined for a missing dir");

// adopt --no-start (latest) writes a persona with name: + resume: pointing at the newest session.
// (--no-start keeps adopt fully local — no mesh/spawn — so this suite needs no daemons. The one-step
// spawn path is verified separately against an in-process manager.)
await runAdopt([folder, "--no-start"]);
const persona = personaFilePath("adopt", "myproj");
assert(existsSync(persona), "adopt wrote the persona file");
const body = existsSync(persona) ? readFileSync(persona, "utf8") : "";
assert(/name:\s*myproj/.test(body), "persona has name: myproj");
assert(/resume:\s*new-sess/.test(body), "persona has resume: <latest session>");

// re-adopt with an explicit older session WITHOUT --replace is refused and leaves the pin alone.
let repinRefused = "";
try { await runAdopt([folder, "--resume", "old-sess", "--no-start"]); } catch (e) { repinRefused = (e as Error).message; }
assert(/would replace it/.test(repinRefused) && /resume:\s*new-sess/.test(readFileSync(persona, "utf8")), "explicit --resume onto a pinned default is refused and the pin is untouched");
// with --replace it updates ONLY the resume line.
await runAdopt([folder, "--resume", "old-sess", "--replace", "--no-start"]);
const body2 = readFileSync(persona, "utf8");
assert(/resume:\s*old-sess/.test(body2), "--resume pins the chosen session");
assert((body2.match(/resume:/g) ?? []).length === 1, "no duplicate resume: lines after re-adopt");
// A session STORED under another project dir (claude started in a worktree, then cd'd to the main checkout)
// but RECORDING this folder's cwd is still this folder's session — adopt's own undo hint depended on it.
const strayDir = join(home, ".claude", "projects", "-some-worktree-dir");
mkdirSync(strayDir, { recursive: true });
writeFileSync(join(strayDir, "stray-sess.jsonl"), JSON.stringify({ cwd: canonical, type: "x" }) + "\n");
await runAdopt([folder, "--resume", "stray-sess", "--replace", "--no-start"]);
assert(/resume:\s*stray-sess/.test(readFileSync(persona, "utf8")), "a session stored under another project dir but recorded at this folder is adoptable");
writeFileSync(join(strayDir, "foreign-sess.jsonl"), JSON.stringify({ cwd: "/some/other/project", type: "x" }) + "\n");
assert(/belongs to \/some\/other\/project/.test(await runAdopt([folder, "--resume", "foreign-sess", "--replace", "--no-start"]).then(() => "", (e: Error) => e.message)), "a stray session recorded at ANOTHER folder is still refused, naming that folder");
await runAdopt([folder, "--resume", "old-sess", "--replace", "--no-start"]);
// A session recorded in a WORKTREE of this repo is adoptable FROM THE REPO ROOT — the agent registers
// to the worktree's folder, not the root. (sameRepoWorktree is git-driven, so the list/toplevel are injected.)
{
  const { sameRepoWorktree } = await import("../src/adopt.js");
  const wt = join(work, "wt-a");
  mkdirSync(wt, { recursive: true });
  const list = (root: string) => (root === canonical ? [{ path: canonical }, { path: realpathSync(wt) }] : []);
  assert(sameRepoWorktree(canonical, realpathSync(wt), list as never, () => canonical), "a sibling worktree of the same repo is recognised");
  assert(!sameRepoWorktree(canonical, "/some/other/project", list as never, () => canonical), "an unrelated folder is not");
  assert(!sameRepoWorktree(canonical, realpathSync(wt), list as never, () => undefined), "a non-repo folder recognises nothing (no git toplevel)");
}
// --session remains an accepted alias for --resume.
await runAdopt([folder, "--session", "new-sess", "--replace", "--no-start"]);
assert(/resume:\s*new-sess/.test(readFileSync(persona, "utf8")), "--session alias still works");

// VERIFY: a session recorded at a different cwd must be refused (lossy-encoding guard).
assert(await throwsAsync(() => runAdopt([folder, "--session", "wrong"])), "adopt refuses a session recorded at a different cwd");

// A folder with no claude sessions fails loud.
const empty = mkdtempSync(join(tmpdir(), "paw-adopt-empty-"));
assert(await throwsAsync(() => runAdopt([empty])), "adopt throws when no sessions exist for the folder");

// A path-traversal session id is rejected before touching the filesystem (security).
assert(await throwsAsync(() => runAdopt([folder, "--resume", "../evil"])), "adopt rejects a traversal session id");
// An unknown flag fails loud rather than being silently ignored (the --resume-vs-misparse bug).
assert(await throwsAsync(() => runAdopt([folder, "--bogus", "x"])), "adopt rejects an unknown flag (no silent ignore)");
assert(await throwsAsync(() => runAdopt([folder, "extra-positional"])), "adopt rejects an extra positional");

// CRLF persona body is preserved on re-adopt (regex was LF-only → body was silently dropped).
writeFileSync(persona, "---\r\nname: myproj\r\nresume: old\r\n---\r\nMY CUSTOM BODY\r\n");
await runAdopt([folder, "--no-start"]); // latest = new-sess
const crlf = readFileSync(persona, "utf8");
assert(/MY CUSTOM BODY/.test(crlf), "CRLF persona body preserved on re-adopt");
assert(/resume:\s*new-sess/.test(crlf) && (crlf.match(/resume:/g) ?? []).length === 1, "CRLF persona resume updated (no dup)");

// A frontmatter-free hand-written persona is wrapped, never clobbered.
writeFileSync(persona, "Plain instructions, no frontmatter.");
await runAdopt([folder, "--no-start"]);
const wrapped = readFileSync(persona, "utf8");
assert(/Plain instructions, no frontmatter\./.test(wrapped), "frontmatter-free persona body preserved (wrapped, not clobbered)");
assert(/^---\nname: myproj\n(cwd: .*\n)?resume: new-sess\n---/.test(wrapped), "frontmatter prepended to a frontmatter-free persona");

// NAMED SESSIONS: `claude --session-name`/`/rename` records the name in ~/.claude/sessions/<pid>.json
// (NOT the transcript). `--resume <name>` must resolve name → session id, scoped to the folder.
const sessIndex = join(home, ".claude", "sessions");
mkdirSync(sessIndex, { recursive: true });
// "personal-burn" → new-sess at this folder; a same-named session at a DIFFERENT cwd must be ignored.
writeFileSync(join(sessIndex, "111.json"), JSON.stringify({ sessionId: "new-sess", cwd: canonical, name: "personal-burn", updatedAt: 200 }));
writeFileSync(join(sessIndex, "222.json"), JSON.stringify({ sessionId: "elsewhere", cwd: "/some/other/project", name: "personal-burn", updatedAt: 300 }));
const { resolveNamedSession, namesForFolder } = await import("../src/named.js");
assert(resolveNamedSession(canonical, "personal-burn") === "new-sess", "resolveNamedSession maps name → id scoped to the folder");
assert(resolveNamedSession(canonical, "no-such-name") === undefined, "resolveNamedSession returns undefined for an unknown name");
assert(namesForFolder(canonical).get("new-sess") === "personal-burn", "namesForFolder maps sessionId → name for the folder");
assert(!namesForFolder(canonical).has("elsewhere"), "namesForFolder excludes other folders' named sessions");
// adopt --resume <name> pins the resolved UUID, not the name. (--name myproj: without it the session's
// name would mint an EXTRA "personal-burn" on the session myproj already runs — refused, one agent per session.)
await runAdopt([folder, "--resume", "personal-burn", "--no-start"]);
assert(!existsSync(personaFilePath("adopt", "personal-burn")), "re-adopting a session this folder's agent already runs targets THAT agent, not a new extra named after the session");
assert(/already pinned to "myproj"/.test(await runAdopt([folder, "--resume", "personal-burn", "--name", "other", "--no-start"]).then(() => "", (e: Error) => e.message)), "a NEW --name onto a session another agent runs is refused — one agent per session");
assert(/resume:\s*new-sess/.test(readFileSync(persona, "utf8")), "--resume <name> pins the resolved session id");
// A name with no transcript on disk fails loud (index points at a missing jsonl).
writeFileSync(join(sessIndex, "333.json"), JSON.stringify({ sessionId: "ghost", cwd: canonical, name: "orphan", updatedAt: 100 }));
assert(await throwsAsync(() => runAdopt([folder, "--resume", "orphan", "--no-start"])), "--resume <name> fails loud when the resolved transcript is missing");
// Most-recently-updated wins when two sessions at the folder share a name.
writeFileSync(join(sessIndex, "444.json"), JSON.stringify({ sessionId: "old-sess", cwd: canonical, name: "dup", updatedAt: 100 }));
writeFileSync(join(sessIndex, "555.json"), JSON.stringify({ sessionId: "new-sess", cwd: canonical, name: "dup", updatedAt: 999 }));
assert(resolveNamedSession(canonical, "dup") === "new-sess", "resolveNamedSession picks the most-recently-updated of duplicate names");

// TWO-WRITERS GUARD: a session open in a live, non-mesh process must block the start path.
// Use this test runner's own pid as a guaranteed-alive process; its command line is `node …/tsx …`
// (no --dangerously-load-development-channels), so liveSessionProcs marks it mesh:false = foreign.
const { liveSessionProcs } = await import("../src/named.js");
writeFileSync(join(sessIndex, "666.json"), JSON.stringify({ sessionId: "new-sess", cwd: canonical, name: "open-tui", pid: process.pid }));
const procs = liveSessionProcs("new-sess");
assert(procs.some((p) => p.pid === process.pid && !p.mesh), "liveSessionProcs reports the live non-mesh process as foreign");
// A dead pid in the index is ignored (not reported as live).
writeFileSync(join(sessIndex, "777.json"), JSON.stringify({ sessionId: "new-sess", cwd: canonical, name: "ghost-tui", pid: 2147480000 }));
assert(!liveSessionProcs("new-sess").some((p) => p.pid === 2147480000), "liveSessionProcs skips a dead pid");
// Start path refuses (the guard throws BEFORE ensure(), so no daemons boot).
assert(/open in another process/.test(await runAdopt([folder, "--resume", "new-sess", "--name", "myproj"]).then(() => "", (e: Error) => e.message)), "adopt refuses to start a session open in another process");
// --no-start still pins (warns, doesn't throw) even when the session is open elsewhere.
await runAdopt([folder, "--resume", "new-sess", "--name", "myproj", "--no-start"]);
assert(/resume:\s*new-sess/.test(readFileSync(persona, "utf8")), "adopt --no-start pins despite the session being open elsewhere");

// latestSession: the auto-pick (adopt with no --resume) takes the NEWEST session by mtime — INCLUDING
// one a live foreign claude holds. adopt() then lets the two-writer guard refuse + propose --force,
// rather than silently skipping to an older session and leaving the running claude behind.
const lus = mkdtempSync(join(tmpdir(), "paw-adopt-lus-"));
writeFileSync(join(lus, "lus-older.jsonl"), "{}\n");
utimesSync(join(lus, "lus-older.jsonl"), 1000, 1000);
writeFileSync(join(lus, "lus-newer.jsonl"), "{}\n");
utimesSync(join(lus, "lus-newer.jsonl"), 2000, 2000); // newest by mtime
// Even with the NEWEST foreign-held (live non-mesh proc = this test's pid), the auto-pick still takes it.
writeFileSync(join(sessIndex, "888.json"), JSON.stringify({ sessionId: "lus-newer", cwd: canonical, pid: process.pid }));
assert(latestSession(lus) === "lus-newer", "auto-pick takes the NEWEST session even when it's foreign-held (guard then proposes --force)");
rmSync(lus, { recursive: true, force: true });

// SELF-ADOPT plumbing (hermetic — no daemons, no mesh). isSelfAncestor lets `paw adopt .` tell "the
// claude I'm running INSIDE" (an ancestor — must hand off to a detached child) from "another terminal's
// claude" (safe to kill inline); sanitizeAdoptName fails loud on an empty --name; adoptInFlight guards
// against stacking a second detached takeover.
const { isSelfAncestor, selfSessionProc } = await import("../src/named.js");
const { adoptInFlight } = await import("../src/lifecycle.js");

assert(isSelfAncestor(process.ppid) === true, "isSelfAncestor(ppid) is true — our parent IS an ancestor");
assert(isSelfAncestor(1) === false, "isSelfAncestor(1) is false — launchd/init is everyone's ancestor, never 'self'");
assert(isSelfAncestor(process.pid) === false, "isSelfAncestor(self) is false — a pid is not its own ancestor");
assert(isSelfAncestor(2147480000) === false, "isSelfAncestor of a non-existent pid is false");

assert(sanitizeAdoptName("feat/random-feature") === "feat-random-feature", "sanitizeAdoptName cleans a slashed name to the safe charset");
assert(sanitizeAdoptName("   ") === "", "sanitizeAdoptName of whitespace is empty (the fail-loud trigger)");
assert(sanitizeAdoptName("///") === "", "sanitizeAdoptName of all-separators is empty (the fail-loud trigger)");

// planAdoptName — the aws/research incident class: a desired name that differs from an existing
// default must become an EXTRA instance, never a rename or a silent re-pin of the default.
assert(planAdoptName(undefined, undefined).kind === "folder-default", "no desired name → folder default");
assert(planAdoptName(undefined, "research").kind === "folder-default", "no desired name, default exists → folder default (bare repin allowed)");
{
  const p = planAdoptName("aws", undefined);
  assert(p.kind === "register-default" && p.name === "aws", "desired name, unregistered folder → first registration");
}
{
  const p = planAdoptName("research", "research");
  assert(p.kind === "repin-default" && p.name === "research", "desired name equals the default → repin it");
}
{
  const p = planAdoptName("aws", "research");
  assert(p.kind === "extra" && p.name === "aws", "desired name differs from the default → EXTRA instance, default untouched");
}
{
  const p = planAdoptName("feat/aws", "research");
  assert(p.kind === "extra" && p.name === "feat-aws", "desired name is sanitized before the compare");
}
let namePlanThrew = false;
try { planAdoptName("///", "research"); } catch { namePlanThrew = true; }
assert(namePlanThrew, "a desired name that sanitizes to empty fails loud");

// assertSafeRepin — the 2026-09-14 incident: `paw adopt --resume <id> .` (meaning "add an agent")
// re-pinned the folder's default, and a session ended up with two agents running it.
const base = { sessionId: "S2", explicitResume: true, name: "evals", planKind: "folder-default" as const, prevPin: "S1", replace: false, target: ".", pinnedBy: [] as string[] };
const refuses = (o: Parameters<typeof assertSafeRepin>[0]) => { try { assertSafeRepin(o); return ""; } catch (e) { return (e as Error).message; } };
assert(/would replace it/.test(refuses(base)) && /--name <new-name>/.test(refuses(base)) && /--replace/.test(refuses(base)), "explicit --resume onto an existing default pinned elsewhere is REFUSED, naming --name and --replace");
assert(refuses({ ...base, replace: true }) === "", "--replace makes the re-pin deliberate");
assert(refuses({ ...base, planKind: "repin-default" }) !== "", "naming the default explicitly still needs --replace");
assert(refuses({ ...base, planKind: "extra" }) === "", "an EXTRA (--name) never touches the default's pin");
assert(refuses({ ...base, explicitResume: false }) === "", "a bare `paw adopt .` keeps its re-pin-to-latest behaviour");
assert(refuses({ ...base, prevPin: "S2" }) === "", "re-adopting the SAME session is a no-op, not a refusal");
assert(refuses({ ...base, prevPin: undefined }) === "", "a first pin replaces nothing");
assert(/already pinned to "arena-tier-list"/.test(refuses({ ...base, planKind: "extra", pinnedBy: ["arena-tier-list"] })), "a session another agent is pinned to is refused even with --name — one transcript, one agent");
assert(refuses({ ...base, replace: true, pinnedBy: ["x"] }) !== "", "--replace does not lift the one-agent-per-session rule");
assert(parseArgs(["--replace"]).replace === true, "parseArgs reads --replace");

// parseArgs handles the new flags and still rejects unknown ones.
assert(parseArgs(["--name", "foo"]).name === "foo", "parseArgs reads --name <n>");
assert(parseArgs(["--no-attach"]).noAttach === true, "parseArgs reads --no-attach");
assert(parseArgs(["--force"]).force === true, "parseArgs reads --force");
const combo = parseArgs(["myfolder", "--resume", "abc", "--name", "n", "--no-attach", "--force"]);
assert(
  combo.target === "myfolder" && combo.session === "abc" && combo.name === "n" && combo.noAttach === true && combo.force === true,
  "parseArgs reads a full flag combination",
);
assert(throws(() => parseArgs(["--bogus", "x"])), "parseArgs still rejects an unknown flag");

// selfSessionProc for a folder with no live self-held session (a bogus path) is undefined.
assert(selfSessionProc("/nonexistent/folder/xyz") === undefined, "selfSessionProc returns undefined for a folder with no self-held session");

// adoptInFlight is false under this isolated PAW_HOME with no adopt.pid on disk.
assert(adoptInFlight("adopt-check-nopid") === false, "adoptInFlight is false when no adopt.pid exists");

// ---- persona claudeArgs: the flags a MANAGED `paw claude` replays on every launch ----
const { readClaudeArgs } = await import("../src/session.js");
const argSpace = "adoptargs";
const argAgent = "argsagent";

assert(readClaudeArgs(undefined) === undefined || readClaudeArgs(undefined).length === 0, "no config → no claude args");

pinSession(argSpace, argAgent, "sess-1");
const argPersona = personaFilePath(argSpace, argAgent);
assert(readClaudeArgs(argPersona).length === 0, "a persona with only a resume pin has no claude args");

// An arg containing SPACES is the whole reason this is stored as JSON rather than a shell string —
// flattening it would re-split on the space and hand claude two arguments instead of one.
pinClaudeArgs(argSpace, argAgent, ["--model", "opus", "--append-system-prompt", "be terse, please"]);
assert(
  JSON.stringify(readClaudeArgs(argPersona)) === JSON.stringify(["--model", "opus", "--append-system-prompt", "be terse, please"]),
  "claudeArgs round-trip, including an argument with spaces",
);
assert(readFileSync(argPersona, "utf8").includes("resume: sess-1"), "pinning claude args preserves the session pin");

// Writing the pin again must not disturb the args (and vice versa) — they are separate keys the
// connector reads independently, and clobbering one from the other would silently change the launch.
pinSession(argSpace, argAgent, "sess-2");
assert(readClaudeArgs(argPersona).length === 4, "re-pinning the session preserves claude args");
assert(readFileSync(argPersona, "utf8").includes("resume: sess-2"), "the session pin actually moved");

// An EMPTY list removes the key rather than writing `[]`, so "no flags" and "never asked" match.
pinClaudeArgs(argSpace, argAgent, []);
assert(!readFileSync(argPersona, "utf8").includes("claudeArgs:"), "clearing claude args removes the key entirely");
assert(readClaudeArgs(argPersona).length === 0, "cleared claude args read back empty");

// A hand-mangled value must fail loud: launching without the operator's flags silently is worse.
writeFileSync(argPersona, `---\nname: ${argAgent}\nclaudeArgs: --model opus\n---\nbody\n`);
assert(throws(() => readClaudeArgs(argPersona)), "a non-JSON claudeArgs value throws rather than launching without it");
writeFileSync(argPersona, `---\nname: ${argAgent}\nclaudeArgs: ["--model", 7]\n---\nbody\n`);
assert(throws(() => readClaudeArgs(argPersona)), "a non-string element throws");

rmSync(home, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
rmSync(empty, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw adopt check(s) failed`);
  process.exit(1);
}
console.log("\nall paw adopt checks passed 🐾");

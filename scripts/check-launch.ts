/**
 * Smoke check for paw's connector + cwd safety. Verifies buildLaunch composes cotal's launch with
 * paw's opinions (bypass permissions, mesh brief, channel wake, blocking-tool denial, env passthrough)
 * and that resume-id parsing is robust; and that confineAndTrustCwd (src/cwd.ts — folder pre-trust +
 * PAW_ROOT confinement, which moved out of the connector when cotal #43 gave the manager the cwd)
 * lands trust in ~/.claude.json and confines correctly. Runs against an isolated temp HOME so the real
 * config is never touched. Run: pnpm check:launch
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ~/.claude.json before pre-trust reads it (os.homedir() honours $HOME on posix).
const home = mkdtempSync(join(tmpdir(), "paw-home-"));
process.env.HOME = home;
writeFileSync(join(home, ".claude.json"), "{}");

// The cwd checks below pre-trust folders under tmpdir; point PAW_ROOT at the canonical tmpdir so they
// count as in-root. The dedicated confinement tests at the end override this to exercise the guard.
process.env.PAW_ROOT = realpathSync(tmpdir());

const { pawConnector } = await import("../src/connector.js");
const { readResumeId } = await import("../src/session.js");
const { confineAndTrustCwd } = await import("../src/cwd.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
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

// ---- connector: buildLaunch composition (the connector no longer takes a cwd as of cotal #43) ----
const work = mkdtempSync(join(tmpdir(), "paw-work-"));
const spec = pawConnector.buildLaunch({ space: "demo", name: "tester" });
const args = spec.args;
const joined = args.join(" ");
const appendIdx = args.indexOf("--append-system-prompt");

assert(spec.command === "claude", "launch command is claude");
assert(
  args.indexOf("--permission-mode") !== -1 && args[args.indexOf("--permission-mode") + 1] === "bypassPermissions",
  "bypassPermissions injected by default",
);
assert(joined.includes("--dangerously-load-development-channels"), "channel-registration flag preserved (lets idle agents wake on DMs)");
assert(joined.includes("server:cotal"), "channel ref server:cotal preserved");
assert(joined.includes("--strict-mcp-config"), "cotal --strict-mcp-config preserved");
assert(joined.includes("--disallowedTools") && /AskUserQuestion/.test(joined), "blocking tools denied (a warm agent can't hang on a terminal prompt)");
assert(
  appendIdx !== -1 && /paw agent/.test(args[appendIdx + 1]) && /cotal_dm/.test(args[appendIdx + 1]),
  "mesh brief appended to system prompt",
);
assert(spec.env?.COTAL_CHANNEL === "1", "COTAL_CHANNEL=1 inherited from cotal connector");
assert(spec.env?.COTAL_NAME === "tester", "COTAL_NAME passed through");

// cotal ≥0.48 passes an agent-file persona as `--append-system-prompt-file <tmp>`; claude refuses that
// flag alongside `--append-system-prompt`, so paw's brief must ride INSIDE the file, not a second flag
// (every seat exited 1 at launch when it did — 2026-09-08).
{
  const persona = join(work, "persona.md");
  writeFileSync(persona, "---\nname: filed\nsubscribe: [general]\nallowSubscribe: [\">\"]\nallowPublish: [\">\"]\n---\nI am the persona body.\n");
  const withFile = pawConnector.buildLaunch({ space: "demo", name: "filed", configPath: persona }).args;
  const fileIdx = withFile.indexOf("--append-system-prompt-file");
  assert(fileIdx !== -1, "persona launch: cotal emits --append-system-prompt-file");
  assert(withFile.indexOf("--append-system-prompt") === -1, "persona launch: paw adds NO inline --append-system-prompt beside the file flag");
  const merged = readFileSync(withFile[fileIdx + 1], "utf8");
  assert(/I am the persona body/.test(merged) && /paw agent/.test(merged) && /cotal_dm/.test(merged), "persona launch: the file carries the persona AND paw's brief");
}

// PAW_PERMISSION overrides (connector reads it from env; no cwd involved).
process.env.PAW_PERMISSION = "lol";
assert(throws(() => pawConnector.buildLaunch({ space: "demo", name: "bad" })), "PAW_PERMISSION with an unknown mode throws");
process.env.PAW_PERMISSION = "plan";
const spec2 = pawConnector.buildLaunch({ space: "demo", name: "t2" });
assert(spec2.args[spec2.args.indexOf("--permission-mode") + 1] === "plan", "PAW_PERMISSION overrides the permission mode");
process.env.PAW_PERMISSION = "default";
const spec3 = pawConnector.buildLaunch({ space: "demo", name: "t3" });
assert(spec3.args.indexOf("--permission-mode") === -1, "PAW_PERMISSION=default emits no permission flag");
delete process.env.PAW_PERMISSION;

// ---- cwd safety: confineAndTrustCwd (folder pre-trust + PAW_ROOT confinement) ----
const canon = confineAndTrustCwd(work);
assert(canon === realpathSync(work), "confineAndTrustCwd returns the canonical cwd");
const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
const workKey = realpathSync(work); // pre-trust canonicalises symlinks; tmpdir is symlinked
assert(config.projects?.[workKey]?.hasTrustDialogAccepted === true, "target folder pre-trusted (under canonical realpath) in ~/.claude.json");
assert(config.projects?.[workKey]?.hasCompletedProjectOnboarding === true, "project onboarding marked complete");

// Pre-trust must create ~/.claude.json when Claude has never run (fresh machine).
rmSync(join(home, ".claude.json"), { force: true });
const fresh = mkdtempSync(join(tmpdir(), "paw-fresh-"));
confineAndTrustCwd(fresh);
const created = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
assert(created.projects?.[realpathSync(fresh)]?.hasTrustDialogAccepted === true, "pre-trust creates ~/.claude.json when absent");

// Fail-loud: invalid cwd inputs must throw, not silently misbehave.
assert(throws(() => confineAndTrustCwd(join(tmpdir(), "paw-does-not-exist-zzz"))), "confineAndTrustCwd throws on a nonexistent cwd (no phantom trust)");
assert(throws(() => confineAndTrustCwd("some/relative/dir")), "confineAndTrustCwd throws on a relative cwd");

// PAW_ROOT confinement: a sibling cwd outside the root must be refused.
const root = realpathSync(mkdtempSync(join(tmpdir(), "paw-root-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "paw-outside-")));
const inside = mkdtempSync(join(root, "agent-"));
process.env.PAW_ROOT = root;
assert(!throws(() => confineAndTrustCwd(inside)), "in-root cwd allowed under PAW_ROOT");
assert(throws(() => confineAndTrustCwd(outside)), "out-of-root cwd throws (cwd confinement)");

process.env.PAW_ALLOW_ANY_CWD = "1";
assert(!throws(() => confineAndTrustCwd(outside)), "PAW_ALLOW_ANY_CWD=1 permits an out-of-root cwd");
const outsideCfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
assert(outsideCfg.projects?.[realpathSync(outside)] === undefined, "allowed out-of-root cwd is not pre-trusted (override grants access, not silent trust)");
delete process.env.PAW_ALLOW_ANY_CWD;

// Confinement is opt-in: with PAW_ROOT unset, any cwd is allowed.
delete process.env.PAW_ROOT;
assert(!throws(() => confineAndTrustCwd(outside)), "PAW_ROOT unset disables confinement (any cwd allowed)");
// Fail-loud: a PAW_ROOT that is set-but-empty or relative throws rather than silently defaulting.
process.env.PAW_ROOT = "   ";
assert(throws(() => confineAndTrustCwd(inside)), "empty PAW_ROOT throws (fail-loud)");
process.env.PAW_ROOT = "relative/root";
assert(throws(() => confineAndTrustCwd(inside)), "relative PAW_ROOT throws (fail-loud)");
process.env.PAW_ROOT = realpathSync(tmpdir());

// ---- readResumeId: robust frontmatter parsing. ----
const agentFile = join(work, "agent.md");
writeFileSync(agentFile, "---\nname: x\nresume: sess-123 # adopted 2026-06-18\n---\nbody\n");
assert(readResumeId(agentFile) === "sess-123", "readResumeId strips inline YAML comment");
writeFileSync(agentFile, '---\nresume: "sess-456"\n---\n');
assert(readResumeId(agentFile) === "sess-456", "readResumeId strips surrounding quotes");
writeFileSync(agentFile, "---\nname: x\n---\nno resume key\n");
assert(readResumeId(agentFile) === undefined, "readResumeId returns undefined when key absent");
assert(readResumeId(undefined) === undefined, "readResumeId returns undefined for no config path");
writeFileSync(agentFile, "---\nresume: |\n---\n");
assert(throws(() => readResumeId(agentFile)), "readResumeId throws on a YAML block-scalar resume value");

// ---- durable session pinning: a persona's resume id becomes --session-id on FIRST boot (no
// transcript yet) and --resume once the transcript exists. Guards the paw-reset bug (2026-06-26):
// a pinless agent cold-starts a fresh, amnesiac session on every restart. (HOME is the isolated temp
// dir, so transcriptExists scans an empty projects tree until we plant one.) ----
const pinId = "11111111-2222-3333-4444-555555555555";
writeFileSync(agentFile, `---\nname: pin\nresume: ${pinId}\n---\nbody\n`);
const firstBoot = pawConnector.buildLaunch({ space: "demo", name: "pin", configPath: agentFile }).args;
assert(
  firstBoot.indexOf("--session-id") !== -1 && firstBoot[firstBoot.indexOf("--session-id") + 1] === pinId,
  "first boot creates the session AT the pinned id (--session-id) so it can be resumed later",
);
assert(firstBoot.indexOf("--resume") === -1, "first boot does not --resume (no transcript exists yet)");

const projDir = join(home, ".claude", "projects", "-planted-cwd");
mkdirSync(projDir, { recursive: true });
writeFileSync(join(projDir, `${pinId}.jsonl`), "");
const restart = pawConnector.buildLaunch({ space: "demo", name: "pin", configPath: agentFile }).args;
assert(
  restart.indexOf("--resume") !== -1 && restart[restart.indexOf("--resume") + 1] === pinId,
  "restart RESUMES the pinned id once its transcript exists (--resume) — no amnesia across a bounce",
);
assert(restart.indexOf("--session-id") === -1, "restart does not re-create the session (--session-id absent)");

if (failures > 0) {
  console.error(`\n${failures} paw connector check(s) failed`);
  process.exit(1);
}
console.log("\nall paw connector checks passed 🐾");

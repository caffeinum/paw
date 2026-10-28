/**
 * `paw relocate` hermetic checks (src/relocate.ts): argument parsing + the `<agent>#<space>` hoist, the
 * real incident (`skills` in ~/Github/team2027/2027-skills, then `mv 2027-skills skills`: re-point only),
 * paw moving a folder itself (a running agent stopped and started again in the new folder), the session
 * chain + sidecar copied with `cwd` rewritten and the originals left as the backup, memory keyed by the
 * canonical git root (moves with a repo root, stays for a subfolder of a repo that doesn't move), every
 * refusal, `--all`, legacy folders.json/agents.json, the rollback, and `paw rename`'s "no agent named" fix.
 *
 * Isolated: HOME (so ~/.claude/projects) and PAW_HOME are temp dirs. No mesh, no manager: stop/start are
 * fakes. Run: pnpm check:relocate
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-relocate-home-")));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ALLOW_ANY_CWD = "1";
delete process.env.PAW_SPACE;
delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE;
delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR;

const rl = await import("../src/relocate.ts");
const { setFolderName, ensurePersonaFile, personaFilePath, registerInstance } = await import("../src/addressing.ts");
const { readCwd, readResumeId, transcriptPath, transcriptPaths } = await import("../src/session.ts");
const { hoistAddressSpace } = await import("../src/dispatch.ts");
const { noAgentNamed } = await import("../src/rename.ts");
const { sanitizePath } = await import("../src/teleport-memory.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
  }
}
async function rejects(p: Promise<unknown>, re: RegExp, msg: string): Promise<string> {
  try {
    await p;
    assert(false, `${msg} (did not reject)`);
    return "";
  } catch (e) {
    const m = (e as Error).message;
    assert(re.test(m), `${msg} — ${m.split("\n")[0]}`);
    return m;
  }
}

const S = "rl";
const spaces = join(process.env.PAW_HOME!, "spaces");
mkdirSync(join(spaces, S), { recursive: true });
mkdirSync(join(spaces, "other"), { recursive: true });
const projects = join(home, ".claude", "projects");
const proj = (folder: string) => join(projects, sanitizePath(folder));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** An agent registered at `folder` with a transcript there (cwd-stamped lines) and memory beside it. */
function seed(space: string, name: string, folder: string, o: { memory?: string; transcript?: boolean; extra?: boolean } = {}): string {
  mkdirSync(folder, { recursive: true });
  if (o.extra) registerInstance(space, folder, name);
  else setFolderName(space, folder, name);
  const pin = readResumeId(ensurePersonaFile(space, name))!;
  if (o.transcript !== false) {
    mkdirSync(proj(folder), { recursive: true });
    writeFileSync(join(proj(folder), `${pin}.jsonl`), `${JSON.stringify({ type: "user", cwd: folder, sessionId: pin, message: { content: `work in ${folder}` } })}\n`);
  }
  if (o.memory) {
    mkdirSync(join(proj(folder), "memory"), { recursive: true });
    writeFileSync(join(proj(folder), "memory", "MEMORY.md"), o.memory);
  }
  return pin;
}

type Call = [op: "stop" | "start", space: string, name: string, cwd?: string];
function fakeDeps(o: { failStart?: (cwd: string) => boolean; unreleased?: boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      stop: async (space: string, name: string) => {
        calls.push(["stop", space, name]);
        return { released: !o.unreleased };
      },
      start: async (space: string, name: string, cwd: string) => {
        calls.push(["start", space, name, cwd]);
        if (o.failStart?.(cwd)) throw new Error("boom: the seat never came up");
      },
      log: () => {},
    },
  };
}
const idle = (d: import("../src/relocate.ts").RelocateDisk) => new Map(d.movers.map((m) => [rl.moverKey(m), { listed: false, running: false, strangers: [] as string[] }]));
const running = (d: import("../src/relocate.ts").RelocateDisk, activeMs = Date.now() - 30 * 60_000) =>
  new Map(d.movers.map((m) => [rl.moverKey(m), { listed: true, running: true, activeMs, strangers: [] as string[] }]));

// ── args ────────────────────────────────────────────────────────────────────────────────────────
console.log("args");
{
  const a = rl.parseRelocateArgs(["skills", "~/x", "--all", "--dry-run", "--yes", "--space", S]);
  assert(a.name === "skills" && a.target === "~/x" && a.all && a.dryRun && a.yes && a.space === S, "full flag set parses");
  throws(() => rl.parseRelocateArgs(["skills"]), /where to/, "no folder fails loud");
  throws(() => rl.parseRelocateArgs([]), /which agent/, "no agent fails loud");
  throws(() => rl.parseRelocateArgs(["./x", "y"]), /not an agent name/, "a path as the agent is refused");
  throws(() => rl.parseRelocateArgs(["a", "b", "c"]), /one agent and one folder/, "three positionals refused");
  throws(() => rl.parseRelocateArgs(["a", "b", "--force"]), /unknown flag/, "unknown flag refused");
  const h = hoistAddressSpace("relocate", [`skills#${S}`, "/new/place"]);
  assert(JSON.stringify(h) === JSON.stringify(["skills", "/new/place", "--space", S]), `skills#${S} hoists to --space; the folder slot is untouched (${JSON.stringify(h)})`);
  assert(rl.resolveNewFolder("~/a/b", "/x", home) === join(home, "a", "b"), "~ expands to HOME");
}

// ── the incident: `mv 2027-skills skills`, then relocate re-points ─────────────────────────────────
console.log("incident: folder already moved by hand");
const team = join(home, "Github", "team2027");
const oldSkills = join(team, "2027-skills");
const newSkills = join(team, "skills");
const skillsPin = seed(S, "skills", oldSkills, { memory: "# skills memory\n" });
writeFileSync(join(proj(oldSkills), "memory", ".last-dream"), "1700000000\n");
// a predecessor continued into the pin, a sidecar (subagent) dir, and a stranger session in the same dir
const prev = "11111111-1111-4111-8111-111111111111";
writeFileSync(join(proj(oldSkills), `${prev}.jsonl`), `${JSON.stringify({ type: "user", cwd: oldSkills, sessionId: prev })}\n${JSON.stringify({ type: "continued-in", sessionId: prev, continuedInSessionId: skillsPin })}\n`);
mkdirSync(join(proj(oldSkills), skillsPin, "subagents"), { recursive: true });
writeFileSync(join(proj(oldSkills), skillsPin, "subagents", "agent-a1.jsonl"), `${JSON.stringify({ type: "user", cwd: join(oldSkills, "sub"), isSidechain: true })}\n`);
writeFileSync(join(proj(oldSkills), skillsPin, "tool-results.txt"), "raw bytes mention /cwd/ but are not json\n");
writeFileSync(join(proj(oldSkills), "22222222-2222-4222-8222-222222222222.jsonl"), `${JSON.stringify({ type: "user", cwd: oldSkills })}\n`);
writeFileSync(join(spaces, S, "folders.json"), `${JSON.stringify({ [oldSkills]: "skills", "/elsewhere": "x" })}\n`);
const origTranscript = readFileSync(join(proj(oldSkills), `${skillsPin}.jsonl`), "utf8");
const past = new Date(Date.now() - 3600_000);
utimesSync(join(proj(oldSkills), `${skillsPin}.jsonl`), past, past);
renameSync(oldSkills, newSkills); // the operator's `mv 2027-skills skills`
{
  const msg = noAgentNamed(S, "2027-skills");
  assert(msg.includes(`no agent named "2027-skills" in space "${S}"`) && msg.includes(`paw relocate skills#${S} <new-folder>`), `paw rename 2027-skills … says "no agent named" + points at relocate (${msg})`);
  assert(!/ENOENT|lstat/.test(msg), "no raw ENOENT/lstat");
  assert(noAgentNamed(S, "nobody").includes("paw status --space"), "an unrelated word: plain 'no agent named' + status hint");

  const d = rl.relocateDisk({ space: S, name: "skills", target: "skills", all: false }, { cwd: team });
  assert(d.blockers.length === 0, `no blockers (${d.blockers.join(" | ")})`);
  assert(d.mode === "repoint" && d.from === oldSkills && d.to === newSkills, `mode repoint, ${d.from} → ${d.to}`);
  const plan = rl.relocatePlan(d, idle(d), { now: Date.now() }).join("\n");
  console.log(plan.replace(/^/gm, "      "));
  assert(plan.includes("already moved — ") && plan.includes(`skills#${S} (claude) cwd: ${oldSkills} → ${newSkills}  — not running`), "plan: already moved, agent line");
  assert(plan.includes("session chain") && plan.includes(`${prev} → ${skillsPin}`), "plan names the continued-in chain");
  assert(/sessions +4 file\(s\)/.test(plan), `plan: 4 session files (2 transcripts in the chain + a subagent transcript + a tool result) — ${plan.match(/sessions.*$/m)?.[0]}`);
  assert(plan.includes("1 other session(s)"), "the stranger session in the old dir is said to stay");
  assert(plan.includes(`memory     2 file(s) → ~/.claude/projects/${sanitizePath(newSkills)}/`), "plan: memory lands in the new folder's dir");
  assert(plan.includes("1 legacy entry re-pointed"), "plan: legacy folders.json entry");
  assert(plan.includes(`backup     originals stay where they are: ~/.claude/projects/${sanitizePath(oldSkills)}`), "plan: says where the originals stay");

  const f = fakeDeps();
  const r = await rl.applyRelocate(d, idle(d), f.deps, () => rl.relocateDisk({ space: S, name: "skills", target: "skills", all: false }, { cwd: team }));
  assert(r.started.length === 0 && f.calls.length === 0, "not running: nothing stopped or started");
  assert(readCwd(personaFilePath(S, "skills")) === newSkills, "persona cwd: → the new folder");
  assert(readResumeId(personaFilePath(S, "skills")) === skillsPin, "pin unchanged");
  const copy = readFileSync(join(proj(newSkills), `${skillsPin}.jsonl`), "utf8");
  assert(copy.includes(`"cwd":${JSON.stringify(newSkills)}`) && !copy.includes(JSON.stringify(oldSkills)) && copy.includes(`work in ${oldSkills}`), "copied transcript: cwd field rewritten, message text untouched");
  assert(readFileSync(join(proj(oldSkills), `${skillsPin}.jsonl`), "utf8") === origTranscript, "original transcript untouched (the backup)");
  assert(existsSync(join(proj(newSkills), `${prev}.jsonl`)), "the predecessor in the chain is copied too");
  assert(!existsSync(join(proj(newSkills), "22222222-2222-4222-8222-222222222222.jsonl")), "a stranger session is NOT copied");
  const sub = readFileSync(join(proj(newSkills), skillsPin, "subagents", "agent-a1.jsonl"), "utf8");
  assert(sub.includes(JSON.stringify(join(newSkills, "sub"))), "subagent transcript: a cwd UNDER the folder follows it");
  assert(readFileSync(join(proj(newSkills), skillsPin, "tool-results.txt"), "utf8").includes("/cwd/"), "non-jsonl sidecar copied verbatim");
  assert(readFileSync(join(proj(newSkills), "memory", "MEMORY.md"), "utf8") === "# skills memory\n" && existsSync(join(proj(oldSkills), "memory", "MEMORY.md")), "memory copied, original kept");
  assert(readFileSync(join(proj(newSkills), "memory", ".last-dream"), "utf8").trim() === "1700000000", "dream stamp copied");
  assert(JSON.parse(readFileSync(join(spaces, S, "folders.json"), "utf8"))[newSkills] === "skills", "legacy folders.json re-pointed");
  assert(transcriptPath(skillsPin) === join(proj(newSkills), `${skillsPin}.jsonl`), "transcriptPath: the newer copy wins over the original (no readdir-order coin flip)");
  const many = transcriptPaths([skillsPin, prev, "a", "b", "c"]);
  assert(many.get(skillsPin) === join(proj(newSkills), `${skillsPin}.jsonl`), "transcriptPaths (bulk path) agrees");

  // running it again: everything is already there → nothing to do, nothing blocked
  const again = rl.relocateDisk({ space: S, name: "skills", target: newSkills, all: false }, { cwd: team });
  assert(again.blockers.some((b) => b.includes("already")), `relocating to where it is now: "${again.blockers[0]}"`);
}

// ── paw moves the folder itself; the agent is running ──────────────────────────────────────────────
console.log("move: paw renames the folder, a running agent is stopped and started again");
const work = join(home, "work");
const wOld = join(work, "proj-a");
const wNew = join(work, "proj-b");
const wPin = seed(S, "worker", wOld, { memory: "# worker\n" });
writeFileSync(join(wOld, "file.txt"), "hello\n");
{
  const d = rl.relocateDisk({ space: S, name: "worker", target: wNew, all: false });
  assert(d.mode === "move" && d.blockers.length === 0, `mode move, no blockers (${d.blockers.join(" | ")})`);
  const live = running(d);
  const plan = rl.relocatePlan(d, live, { now: Date.now() }).join("\n");
  assert(plan.includes(`mv ${wOld} → ${wNew}`) && plan.includes("running, transcript written 30m ago: stopped, then started again in the new folder"), "plan: mv line + running agent line");
  assert(rl.liveBlockers(d, live, { yes: false, now: Date.now() }).length === 0, "idle 30m: not busy");
  assert(rl.liveBlockers(d, running(d, Date.now() - 60_000), { yes: false, now: Date.now() })[0]?.includes("is busy"), "written 1m ago: busy without --yes");
  assert(rl.liveBlockers(d, running(d, Date.now() - 60_000), { yes: true, now: Date.now() }).length === 0, "--yes overrides busy");
  const strangers = new Map([[rl.moverKey(d.movers[0]), { listed: true, running: true, strangers: ["pid 42 (a standalone claude)"] }]]);
  assert(rl.liveBlockers(d, strangers, { yes: true, now: Date.now() })[0]?.includes("two writers"), "a standalone claude on its session: blocked even with --yes");
  const f = fakeDeps();
  await rl.applyRelocate(d, live, f.deps, () => rl.relocateDisk({ space: S, name: "worker", target: wNew, all: false }));
  assert(!existsSync(wOld) && readFileSync(join(wNew, "file.txt"), "utf8") === "hello\n", "folder moved (one rename)");
  assert(JSON.stringify(f.calls) === JSON.stringify([["stop", S, "worker"], ["start", S, "worker", wNew]]), `stopped, then started in the new folder (${JSON.stringify(f.calls)})`);
  assert(readCwd(personaFilePath(S, "worker")) === wNew && existsSync(join(proj(wNew), `${wPin}.jsonl`)) && existsSync(join(proj(wNew), "memory", "MEMORY.md")), "persona, session and memory follow");
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────
console.log("refusals");
{
  const a = join(work, "both-a");
  const b = join(work, "both-b");
  seed(S, "both", a);
  mkdirSync(b, { recursive: true });
  assert(rl.relocateDisk({ space: S, name: "both", target: b, all: false }).blockers.some((x) => x.includes("never merges folders")), "both folders exist → refused");
  assert(rl.relocateDisk({ space: S, name: "both", target: join(a, "inner"), all: false }).blockers.some((x) => x.includes("can't move into itself")), "into itself → refused");
  assert(rl.relocateDisk({ space: S, name: "both", target: join(work, "no", "such", "parent"), all: false }).blockers.some((x) => x.includes("create the parent first")), "missing parent → refused");
  const gone = join(work, "gone");
  seed(S, "ghost", gone);
  renameSync(gone, join(work, "gone-tmp"));
  assert(rl.relocateDisk({ space: S, name: "ghost", target: join(work, "nowhere"), all: false }).blockers.some((x) => x.includes("neither")), "neither folder exists → refused");
  throws(() => rl.relocateDisk({ space: S, name: "nobody", target: b, all: false }), /no agent named "nobody"/, "unknown agent fails loud");
  // across filesystems: / is the sealed system volume on macOS, the temp dir is on the data volume
  const rootDev = statSync("/").dev;
  if (rootDev !== statSync(a).dev)
    assert(rl.relocateDisk({ space: S, name: "both", target: "/paw-relocate-never", all: false }).blockers.some((x) => x.includes("different filesystems")), "another filesystem → refused (no copy+delete)");
  else console.log("  skip  cross-device: / and the temp dir share a device here");
}

// ── other agents in the folder: refused unless --all ──────────────────────────────────────────────
console.log("--all");
{
  const shared = join(work, "shared");
  seed(S, "lead", shared);
  seed(S, "helper", shared, { extra: true });
  seed("other", "nested", join(shared, "pkg"));
  const d = rl.relocateDisk({ space: S, name: "lead", target: join(work, "shared2"), all: false });
  const b = d.blockers.find((x) => x.includes("other agent(s)")) ?? "";
  assert(b.includes(`helper#${S}`) && b.includes("nested#other") && b.includes("--all"), `lists the other agents (any space, under the folder) and points at --all`);
  const all = rl.relocateDisk({ space: S, name: "lead", target: join(work, "shared2"), all: true });
  assert(all.blockers.length === 0 && all.movers.length === 3, `--all: 3 movers, no blockers (${all.blockers.join(" | ")})`);
  const f = fakeDeps();
  await rl.applyRelocate(all, idle(all), f.deps, () => rl.relocateDisk({ space: S, name: "lead", target: join(work, "shared2"), all: true }));
  assert(readCwd(personaFilePath("other", "nested")) === join(work, "shared2", "pkg"), "a nested agent in another space keeps its place inside the folder");
  assert(readCwd(personaFilePath(S, "helper")) === join(work, "shared2"), "the extra follows too");
}

// ── memory: clash, git root keys ───────────────────────────────────────────────────────────────────
console.log("memory");
{
  const m1 = join(work, "mem-a");
  const m2 = join(work, "mem-b");
  seed(S, "mem", m1, { memory: "mine\n" });
  mkdirSync(join(proj(m2), "memory"), { recursive: true });
  writeFileSync(join(proj(m2), "memory", "MEMORY.md"), "someone else's\n");
  const d = rl.relocateDisk({ space: S, name: "mem", target: m2, all: false });
  assert(d.blockers.some((x) => x.includes("never overwrites memory") && x.includes("MEMORY.md")), "a different MEMORY.md in the destination blocks (never overwritten)");
  writeFileSync(join(proj(m2), "memory", "MEMORY.md"), "mine\n");
  const ok = rl.relocateDisk({ space: S, name: "mem", target: m2, all: false });
  assert(ok.blockers.length === 0 && ok.memory[0]?.same === 1 && ok.memory[0].copies.length === 0, "an identical one is just 'already there'");

  // a repo root moves: memory keyed by it follows; a subfolder agent of a repo that stays keeps its key
  const repo = join(work, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  seed(S, "repo-root", repo, { memory: "repo memory\n" });
  // a Claude Code worktree slug of the repo holds older memory: merged into the new key
  mkdirSync(join(projects, `${sanitizePath(repo)}--claude-worktrees-x`, "memory"), { recursive: true });
  writeFileSync(join(projects, `${sanitizePath(repo)}--claude-worktrees-x`, "memory", "wt.md"), "wt\n");
  const sub = join(repo, "pkg");
  const subPin = seed(S, "pkg", sub, { memory: "pkg old per-folder memory\n" });
  const r = rl.relocateDisk({ space: S, name: "pkg", target: join(repo, "pkg2"), all: false });
  assert(r.blockers.length === 0 && r.memory.length === 0 && r.notes.some((n) => n.includes(`memory stays — Claude Code keys it by ${repo}`)), "subfolder of a repo that stays: memory key unchanged");
  assert(r.sessions.some((c) => c.src.endsWith(`${subPin}.jsonl`)), "…but its session still follows the folder slug");
  const repo2 = join(work, "repo2");
  const rr = rl.relocateDisk({ space: S, name: "repo-root", target: repo2, all: true });
  assert(rr.blockers.length === 0, `repo root move (--all takes pkg along): no blockers (${rr.blockers.join(" | ")})`);
  const mm = rr.memory.find((x) => x.toBase === repo2);
  assert(!!mm && mm.copies.some((c) => c.dst.endsWith("memory/wt.md")) && mm.copies.some((c) => c.dst.endsWith("memory/MEMORY.md")), "repo root moves: its memory + a Claude worktree slug's merge into the new root's key");
  const f = fakeDeps();
  await rl.applyRelocate(rr, idle(rr), f.deps, () => rl.relocateDisk({ space: S, name: "repo-root", target: repo2, all: true }));
  assert(existsSync(join(repo2, ".git")) && readFileSync(join(proj(repo2), "memory", "MEMORY.md"), "utf8") === "repo memory\n", "repo moved, memory under the new root's slug");
  assert(readCwd(personaFilePath(S, "pkg")) === join(repo2, "pkg"), "the subfolder agent rode along");
}

// ── transcript clash + rollback ────────────────────────────────────────────────────────────────────
console.log("transcript clash + rollback");
{
  const t1 = join(work, "tr-a");
  const t2 = join(work, "tr-b");
  const pin = seed(S, "tr", t1);
  mkdirSync(proj(t2), { recursive: true });
  writeFileSync(join(proj(t2), `${pin}.jsonl`), "{}\n");
  assert(rl.relocateDisk({ space: S, name: "tr", target: t2, all: false }).blockers.some((x) => x.includes("never overwrites a transcript")), "a different transcript at the destination blocks");

  const r1 = join(work, "rb-a");
  const r2 = join(work, "rb-b");
  const rpin = seed(S, "rb", r1, { memory: "rb\n" });
  const before = readFileSync(personaFilePath(S, "rb"), "utf8");
  const d = rl.relocateDisk({ space: S, name: "rb", target: r2, all: false });
  const f = fakeDeps({ failStart: (cwd) => cwd === r2 });
  const msg = await rejects(rl.applyRelocate(d, running(d), f.deps, () => rl.relocateDisk({ space: S, name: "rb", target: r2, all: false })), /failed: boom.*\n  rolled back/s, "a start that fails in the new folder rolls back");
  assert(msg.includes("everything is as before, running again"), `rollback says it's back (${msg.split("\n")[1]})`);
  assert(existsSync(r1) && !existsSync(r2), "folder moved back");
  assert(readFileSync(personaFilePath(S, "rb"), "utf8") === before, "persona restored byte-for-byte");
  assert(!existsSync(join(proj(r2), `${rpin}.jsonl`)) && !existsSync(proj(r2)), "copies removed (and the dir paw created)");
  assert(JSON.stringify(f.calls.map((c) => c.slice(0, 1).concat(c.slice(3)))) === JSON.stringify([["stop"], ["start", r2], ["stop"], ["start", r1]]), `stop → start(new) fails → stop → start(old) (${JSON.stringify(f.calls)})`);

  const u = fakeDeps({ unreleased: true });
  await rejects(rl.applyRelocate(d, running(d), u.deps, () => d), /still held .* nothing was relocated/, "session not released after the stop → nothing relocated");
  assert(existsSync(r1) && JSON.stringify(u.calls.map((c) => c[0])) === JSON.stringify(["stop", "start"]), "…and it was started again where it was");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall relocate checks passed");
process.exit(failures ? 1 : 0);

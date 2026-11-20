/**
 * Hermetic check for `paw archive` / `paw unarchive` (src/archive.ts, archive-store.ts, archive-worktree.ts):
 *   1  arguments, and who is calling (self vs outside vs the detached child)
 *   2  the idle wait: a turn must END and stay ended; the bound leaves the agent alone
 *   3  every worktree-safety rule, against real git repos (a local bare origin; gh faked)
 *   4  retire: persona archived with its record, every revival path emptied — and proven not to bring it back
 *   5  unarchive: the refusals (name taken, session pinned, folder default taken, folder gone), then the restore
 * Temp HOME + PAW_HOME, no mesh, no daemons, no network. Run: pnpm check:archive
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
process.env.HOME = tmp("paw-arch-home-");
process.env.PAW_HOME = tmp("paw-arch-pawhome-");
process.env.PAW_SPACE = "archtest";
for (const k of ["COTAL_NAME", "COTAL_SPACE", "PAW_ARCHIVE_INFLIGHT", "PAW_ARCHIVE_BY"]) delete process.env[k];
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" });
const space = "archtest";

const A = await import("../src/archive.ts");
const W = await import("../src/archive-worktree.ts");
const S = await import("../src/archive-store.ts");
const { agentRecord, folderForName, listAgents, personaFilePath, setFolderName, setPersonaKeys } = await import("../src/addressing.ts");
const { readLiveRecord, currentBootAt, liveRecordPath } = await import("../src/boot-live.ts");
const { pendingNames, writeReviveList, readReviveList } = await import("../src/revive.ts");
const cron = await import("../src/cron.ts");
const { unfireable } = await import("../src/commands/cron.ts");
const gh = await import("../src/github-relay.ts");
const { writeSleepRecord, sleepState } = await import("../src/sleep-state.ts");
const { runBoot, agentFacts } = await import("../src/reboot.ts");
const { notRegisteredSkip } = await import("../src/start.ts");
const { OfficeBridge } = await import("../src/office-bridge.ts");
const { handoffLogPath } = await import("../src/lifecycle.ts");
const { readResumeId, readCwd } = await import("../src/session.ts");

let failures = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};
const throwsLike = async (fn: () => unknown, re: RegExp): Promise<string> => {
  try {
    await fn();
    return "(did not throw)";
  } catch (e) {
    const m = (e as Error).message;
    return re.test(m) ? "" : m;
  }
};
const cli = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "..", "bin", "paw.ts"), ...args, "--space", space], { env: { ...process.env, PAW_RELEASE: "dev" }, encoding: "utf8", timeout: 60_000, cwd: tmpdir() });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `${file}: ${text}`);
  return git(cwd, "rev-parse", "HEAD");
};

/** A bare origin, a main clone with origin/HEAD set, and helpers to add worktrees. */
function makeRepo() {
  const base = tmp("paw-arch-repo-");
  const origin = join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const main = join(base, "main");
  git(base, "clone", "-q", origin, main);
  commit(main, "README", "hello");
  git(main, "push", "-q", "-u", "origin", "main");
  git(main, "remote", "set-head", "origin", "main");
  const add = (branch: string) => {
    const wt = join(base, `wt-${branch}`);
    git(main, "worktree", "add", "-q", "-b", branch, wt);
    return realpathSync(wt);
  };
  /** A worktree whose branch is pushed and fast-forward merged into origin/main. */
  const merged = (branch: string) => {
    const wt = add(branch);
    commit(wt, `${branch}.txt`, branch);
    git(wt, "push", "-q", "-u", "origin", branch);
    git(main, "merge", "-q", "--ff-only", branch);
    git(main, "push", "-q", "origin", "main");
    return wt;
  };
  return { base, origin, main: realpathSync(main), add, merged };
}

const noGh: import("../src/archive-worktree.ts").Run = () => ({ ok: false, out: "", err: "", missing: true });
const ghPrs = (prs: Array<{ number: number; headRefOid: string; url?: string }>): import("../src/archive-worktree.ts").Run => () => ({
  ok: true,
  out: JSON.stringify(prs.map((p) => ({ url: `https://github.com/o/r/pull/${p.number}`, ...p }))),
  err: "",
});
const judgeWith = (over: Partial<import("../src/archive-worktree.ts").JudgeDeps> = {}) => ({ git: W.realGit, gh: noGh, cwdHolders: () => [], agentsUsing: () => [], fetch: true, ...over });

// ── 1. arguments + who is calling ───────────────────────────────────────────────────────────────────
console.log("1. arguments, self vs outside");
{
  const p = A.parseArchiveArgs(["@bead-1", "--keep-worktree", "--space", "s"]);
  ok(p.target === "bead-1" && p.keepWorktree && p.space === "s" && !p.now && !p.list, "parse: @name, --keep-worktree, --space");
  ok(A.parseArchiveArgs(["--list", "--space", "s"]).list, "parse: --list");
  ok((await throwsLike(() => A.parseArchiveArgs(["--list", "x"]), /--list takes only --space/)) === "", "parse: --list with a name is refused");
  ok((await throwsLike(() => A.parseArchiveArgs(["a", "b"]), /one agent/)) === "", "parse: two names refused");
  ok((await throwsLike(() => A.parseArchiveArgs(["--bogus"]), /unknown flag/)) === "", "parse: unknown flag refused");
  ok(A.parseUnarchiveArgs(["bead-1", "--space", "s"]).name === "bead-1", "unarchive parse");
  ok((await throwsLike(() => A.parseUnarchiveArgs([]), /usage/)) === "", "unarchive: a name is required");
  ok((await throwsLike(() => A.parseUnarchiveArgs(["../x"]), /not an agent name/)) === "", "unarchive: a path is not a name");

  ok((await A.selfIn(space, { COTAL_NAME: "bead-9", COTAL_SPACE: space })) === "bead-9", "selfIn: COTAL_NAME/COTAL_SPACE of this space");
  ok((await throwsLike(() => A.selfIn(space, { COTAL_NAME: "bead-9", COTAL_SPACE: "other" }), /you are "bead-9" in space other/)) === "", "selfIn: an agent of another space is told to name itself");
  ok((await A.selfIn(space, {})) === undefined, "selfIn: a plain shell (no agent, no ancestor holding a pin) is nobody");
  ok(A.callerIs(space, "bead-9", undefined, { COTAL_NAME: "bead-9", COTAL_SPACE: space }), "callerIs: the agent itself");
  ok(!A.callerIs(space, "bead-9", undefined, { COTAL_NAME: "hirer", COTAL_SPACE: space }), "callerIs: another agent is outside");
  ok(!A.callerIs(space, "bead-9", undefined, {}), "callerIs: a plain shell is outside");
  ok(A.archiveSpace("paw", false, { COTAL_SPACE: "team2027" }) === "team2027", "space: a DEFAULTED space yields to the calling agent's own");
  ok(A.archiveSpace("lab", true, { COTAL_SPACE: "team2027" }) === "lab", "space: a chosen one (--space, #space, PAW_SPACE) stands");
  ok(A.archiveSpace("paw", false, {}) === "paw", "space: a plain shell keeps the default");
}

// ── 2. the idle wait ────────────────────────────────────────────────────────────────────────────────
console.log("2. idle wait");
{
  ok(A.turnEnded(undefined).ended && A.turnEnded({ live: false, mesh: "offline" }).ended, "turnEnded: offline / not listed = nothing runs");
  ok(!A.turnEnded({ live: true, mesh: "working" }).ended, "turnEnded: working is mid-turn");
  ok(!A.turnEnded({ live: true, mesh: "waiting" }).ended, "turnEnded: waiting is mid-turn");
  ok(!A.turnEnded({ live: true, mesh: "idle", busy: true }).ended, "turnEnded: idle presence but the transcript shows a turn in flight = mid-turn");
  ok(!A.turnEnded({ live: true, mesh: "starting" }).ended, "turnEnded: starting is not idle");
  ok(A.turnEnded({ live: true, mesh: "idle", busy: false }).ended, "turnEnded: idle and not busy");

  const run = async (rows: Array<import("../src/archive.ts").TurnRow | Error>, o: { bound?: number; blocked?: (t: number) => string | undefined } = {}) => {
    let t = 0;
    let i = 0;
    const logs: string[] = [];
    const r = await A.waitForTurnEnd({
      read: async () => {
        const v = rows[Math.min(i++, rows.length - 1)];
        if (v instanceof Error) throw v;
        return v;
      },
      ...(o.blocked ? { blocked: () => o.blocked!(t) } : {}),
      now: () => t,
      sleep: async (ms) => void (t += ms),
      log: (l) => logs.push(l),
      boundMs: o.bound ?? 60_000,
      settleMs: 8_000,
      pollMs: 4_000,
    });
    return { r, reads: i, logs, t };
  };
  const busy = { live: true, mesh: "idle", busy: true };
  const idle = { live: true, mesh: "idle", busy: false };
  const a = await run([busy, busy, idle, idle, idle]);
  ok(a.r.ended && a.reads === 5 && a.t === 16_000, `waits through the turn, then 8s of idle (${a.reads} reads, ${a.t}ms)`);
  const b = await run([idle, idle, busy, idle, idle, idle]);
  ok(b.r.ended && b.reads === 6, `a new turn inside the settle window restarts it (${b.reads} reads)`);
  const c = await run([busy], { bound: 60_000 });
  ok(!c.r.ended && c.r.waitedMs >= 60_000 && "last" in c.r && /mid-turn/.test(c.r.last), "never idle → gives up at the bound, saying why");
  ok(c.logs.length === 1, "an unchanged reason is logged once");
  const d = await run([new Error("manager down"), idle, idle, idle]);
  ok(d.r.ended && d.logs.some((l) => /status unreadable: manager down/.test(l)), "an unreadable status is not idle, and is said");
  const e = await run([idle], { blocked: (t) => (t < 20_000 ? "a paw restart is in flight" : undefined) });
  ok(e.r.ended && e.t >= 28_000 && e.logs.some((l) => /restart is in flight/.test(l)), "a restart in flight is waited out like a turn");
}

// ── 3. worktree safety ──────────────────────────────────────────────────────────────────────────────
console.log("3. worktree safety rules");
const repo = makeRepo();
{
  const wt = repo.merged("feat");
  const v = W.judgeWorktree(wt, judgeWith());
  ok(v.remove && /in origin\/main/.test(v.proof ?? "") && v.facts?.branch === "feat" && v.facts.mainCheckout === repo.main, "merged + clean + pushed + unused → removable", JSON.stringify(v));

  mkdirSync(join(repo.base, "nm-target"));
  symlinkSync(join(repo.base, "nm-target"), join(wt, "node_modules"));
  const nm = W.judgeWorktree(wt, judgeWith());
  ok(nm.remove && nm.force && nm.facts?.nodeModules !== undefined && nm.facts.nodeModules !== "dir" && nm.facts.nodeModules.link === join(repo.base, "nm-target"), "an untracked node_modules (symlink) is allowed; removal needs --force; its target is recorded");

  const plain = tmp("paw-arch-plain-");
  ok(/not a git checkout/.test(W.judgeWorktree(plain, judgeWith()).keep.join()), "a non-git folder is kept");
  ok(/main checkout/.test(W.judgeWorktree(repo.main, judgeWith()).keep.join()), "the main checkout is kept");
  mkdirSync(join(wt, "sub"));
  ok(/subfolder of the checkout/.test(W.judgeWorktree(join(wt, "sub"), judgeWith()).keep.join()), "a subfolder of a worktree is kept");
  rmSync(join(wt, "sub"), { recursive: true });

  writeFileSync(join(wt, "README"), "changed");
  ok(/uncommitted change\(s\): M README/.test(W.judgeWorktree(wt, judgeWith()).keep.join()), "a modified tracked file keeps it");
  git(wt, "checkout", "-q", "--", "README");
  writeFileSync(join(wt, "notes.txt"), "scratch");
  ok(/uncommitted change\(s\): \?\? notes.txt/.test(W.judgeWorktree(wt, judgeWith()).keep.join()), "an untracked file (not node_modules) keeps it");
  rmSync(join(wt, "notes.txt"));

  ok(/live process\(es\) have their cwd in it: 4242 vim/.test(W.judgeWorktree(wt, judgeWith({ cwdHolders: () => [{ pid: 4242, command: "vim", cwd: wt }] })).keep.join()), "a process with its cwd inside keeps it");
  ok(/registered agent\(s\) use it: other#lab/.test(W.judgeWorktree(wt, judgeWith({ agentsUsing: () => ["other#lab"] })).keep.join()), "another registered agent's folder keeps it");
  git(repo.main, "worktree", "lock", wt);
  ok(/locked/.test(W.judgeWorktree(wt, judgeWith()).keep.join()), "a locked worktree is kept");
  git(repo.main, "worktree", "unlock", wt);

  const sleeper = spawn("sleep", ["30"], { cwd: wt, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const holders = W.cwdHoldersUnder(wt);
  ok(holders.some((h) => h.pid === sleeper.pid), `lsof sees a real process whose cwd is inside (${holders.map((h) => `${h.pid} ${h.command}`).join(", ")})`);
  sleeper.kill();

  const un = repo.add("unpushed");
  commit(un, "u.txt", "u");
  const vu = W.judgeWorktree(un, judgeWith());
  ok(!vu.remove && /not in origin\/main/.test(vu.keep.join()) && /1 commit\(s\) are on no remote/.test(vu.keep.join()), "an unpushed, unmerged branch is kept (both said)", vu.keep.join(" | "));

  const pushed = repo.add("pushed");
  const head = commit(pushed, "p.txt", "p");
  git(pushed, "push", "-q", "-u", "origin", "pushed");
  const vp = W.judgeWorktree(pushed, judgeWith());
  ok(!vp.remove && vp.keep.length === 1 && /not in origin\/main and no merged PR of pushed/.test(vp.keep[0]!) && vp.notes.some((n) => /gh is not installed/.test(n)), "pushed but unmerged is kept; gh missing is said", JSON.stringify(vp));
  ok(!W.judgeWorktree(pushed, judgeWith({ gh: ghPrs([{ number: 3, headRefOid: "0".repeat(40) }]) })).remove, "a merged PR of the same BRANCH but another head does not count");
  const sq = W.judgeWorktree(pushed, judgeWith({ gh: ghPrs([{ number: 7, headRefOid: head }]) }));
  ok(sq.remove && /merged PR #7/.test(sq.proof ?? ""), "squash-merged: HEAD is a merged PR's headRefOid → removable");
  git(pushed, "push", "-q", "origin", "--delete", "pushed");
  git(pushed, "fetch", "-q", "--prune", "origin");
  ok(W.judgeWorktree(pushed, judgeWith({ gh: ghPrs([{ number: 7, headRefOid: head }]) })).remove, "…even after GitHub deleted the branch (the PR head proves it was pushed)");
  ok(/1 commit\(s\) are on no remote/.test(W.judgeWorktree(pushed, judgeWith()).keep.join()), "…while without that PR the deleted branch reads unpushed");

  const lone = tmp("paw-arch-lone-");
  git(lone, "init", "-q", "-b", "main");
  commit(lone, "a", "a");
  git(lone, "worktree", "add", "-q", "-b", "x", join(lone, "..", `${lone.split("/").at(-1)}-x`));
  const loneWt = realpathSync(join(lone, "..", `${lone.split("/").at(-1)}-x`));
  ok(/no `origin` remote/.test(W.judgeWorktree(loneWt, judgeWith()).keep.join()), "a repo with no origin is kept");

  // remove + recreate
  const failed = W.removeWorktree(nm.facts!, nm.force);
  ok(failed === undefined && !existsSync(wt), "removeWorktree: --force + prune removed it", failed);
  ok(git(repo.main, "rev-parse", "--verify", "refs/heads/feat") === nm.facts!.head, "the local branch is kept");
  ok(!git(repo.main, "worktree", "list").includes(wt), "git no longer lists it");
  const notes = W.recreateWorktree(nm.facts!);
  ok(existsSync(join(wt, "feat.txt")) && git(wt, "rev-parse", "--abbrev-ref", "HEAD") === "feat", "recreateWorktree: back at the same path on its branch", notes.join(" | "));
  ok(existsSync(join(wt, "node_modules")) && notes.some((n) => /re-linked/.test(n)), "…and its node_modules link re-made");
  W.removeWorktree(nm.facts!, true);
  git(repo.main, "branch", "-q", "-D", "feat");
  ok((await throwsLike(() => W.recreateWorktree(nm.facts!), new RegExp(`branch feat no longer exists.*git -C ${repo.main} branch feat ${nm.facts!.head}`))) === "", "a deleted branch fails loud with the exact command");
}

// ── 4. retire + every revival path ──────────────────────────────────────────────────────────────────
console.log("4. retire: persona archived, nothing brings it back");
const PIN = "11111111-2222-3333-4444-555555555555";
const wt1 = repo.merged("bead-1");
symlinkSync(join(repo.base, "nm-target"), join(wt1, "node_modules"));
const otherFolder = tmp("paw-arch-other-");
setFolderName(space, wt1, "bead-1");
setPersonaKeys(space, "bead-1", { resume: PIN });
setFolderName(space, otherFolder, "other");
const logs: string[] = [];
const stops: string[] = [];
const fakeRetire: import("../src/archive.ts").RetireDeps = {
  stop: async (o) => (stops.push(`${o.name}${o.now ? " --now" : ""}`), true),
  sessionStillHeld: async () => [],
  cwdReleased: async () => {},
  judge: (f, s, n) => W.judgeWorktree(f, judgeWith({ agentsUsing: (d) => A.agentsUsing(d, { space: s, name: n }) })),
  remove: (v) => W.removeWorktree(v.facts!, v.force),
  forgetGithub: (s, n) => gh.forgetAgent(s, n, 1_000),
  fleetJob: () => undefined,
  log: (l) => logs.push(l),
};
{
  writeFileSync(liveRecordPath(space), JSON.stringify({ space, bootAt: currentBootAt(), at: new Date().toISOString(), names: ["bead-1", "other"] }));
  writeReviveList(space, ["bead-1", "other"]);
  cron.updateStore(space, (s) => {
    s.jobs.push({ id: "c1", agent: "bead-1", prompt: "check prod", cron: "0 9 * * *", createdAt: 1, createdBy: "bead-1" });
    s.jobs.push({ id: "c2", agent: "other", prompt: "hi", cron: "0 9 * * *", createdAt: 1, createdBy: "other" });
  });
  gh.updateStore((s) => {
    s.watches.push({ space, agent: "bead-1", pr: "o/r#1", by: "bead-1", at: 1 }, { space, agent: "other", pr: "o/r#1", by: "other", at: 1 });
    s.mutes.push({ space, agent: "bead-1", pr: "o/r#2" });
    s.outbox.push({ space, agent: "bead-1", pr: "o/r#1", text: "ci passed", attempts: 1 });
    s.prs["o/r#1"] = { url: "u", title: "t", state: "OPEN", updatedAt: "x", cursor: "x", seen: [], subs: [{ space, agent: "bead-1", pr: "o/r#1", why: "watch" }, { space, agent: "other", pr: "o/r#1", why: "watch" }] };
  });
  writeSleepRecord(space, { name: "bead-1", folder: wt1, since: 1, cursorSeq: 0, reason: "idle" });

  const base = await A.retire({ space, name: "bead-1", folder: wt1, keepWorktree: false, now: false, by: "itself" }, fakeRetire);
  ok(stops.join() === "bead-1", "it was stopped (the wait-then-stop step ran once, without --now)");
  ok(!existsSync(personaFilePath(space, "bead-1")) && existsSync(S.archivedPersonaPath(space, base)), `persona moved to ${S.archivedPersonaPath(space, base)}`);
  ok(readResumeId(S.archivedPersonaPath(space, base)) === PIN && readCwd(S.archivedPersonaPath(space, base)) === wt1, "the archived persona keeps its session pin and folder");
  const rec = S.readArchiveRecord(S.recordPath(space, base));
  ok(rec.by === "itself" && rec.session === PIN && rec.folder === wt1 && rec.stopped, "the record: by, session, folder, stopped");
  ok(rec.worktree.outcome === "removed" && rec.worktree.facts?.branch === "bead-1" && !existsSync(wt1), "worktree removed, recorded with its branch", JSON.stringify(rec.worktree));
  ok(git(repo.main, "rev-parse", "--verify", "refs/heads/bead-1").length === 40, "its branch is kept");
  ok(logs.some((l) => /worktree removed:/.test(l)) && logs.some((l) => /bring it back: paw unarchive bead-1#archtest/.test(l)), "the summary says what happened and how to undo it");

  // registry + status + start
  ok(agentRecord(space, "bead-1") === undefined && !listAgents(space).some((a) => a.name === "bead-1") && folderForName(space, "bead-1") === undefined, "not registered: listAgents (status, start, completion) and folderForName (DM wake, revive) don't know it");
  ok(listAgents(space).some((a) => a.name === "other"), "the other agent is untouched");
  ok(notRegisteredSkip(space, "bead-1") === "bead-1 (not registered)", "`paw start bead-1` skips it as not registered");
  // live.json + paw start --boot
  ok(readLiveRecord(space)?.names.join() === "other" && rec.revival.liveRecord, "live.json: dropped (other kept)");
  const booted: string[] = [];
  await runBoot(space, [], {
    spaces: () => [space],
    record: readLiveRecord,
    facts: agentFacts,
    registered: (s) => listAgents(s).map((a) => a.name),
    start: async (_s, names) => (booted.push(...names), { started: names, alive: [], skipped: [], stuck: [] }),
    restamp: () => {},
    sleep: async () => {},
    log: () => {},
  });
  ok(booted.join() === "other", `paw start --boot brings back only "other" (${booted.join()})`);
  // restart-revive.json
  ok(pendingNames(space).join() === "other" && rec.revival.reviveList, "restart-revive.json: dropped (other still owed)");
  // cron
  ok(cron.readStore(space).jobs.map((j) => j.id).join() === "c2" && rec.revival.cron.map((j) => j.id).join() === "c1", "cron: its job moved into the record, other's stays");
  ok(/not a registered agent/.test(unfireable(space, "bead-1") ?? ""), "cron: a leftover fire for it would be refused (not registered)");
  // github
  const g = gh.readStore();
  const mine = (f: { agent: string }) => f.agent === "bead-1";
  ok(!g.watches.some(mine) && !g.mutes.some(mine) && !g.outbox.some(mine) && !g.prs["o/r#1"]!.subs.some(mine), "github relay: no watch, mute, queued DM or follower row left for it");
  ok(g.watches.some((w) => w.agent === "other") && g.prs["o/r#1"]!.subs.some((x) => x.agent === "other"), "github relay: other's follow stays");
  ok(rec.revival.github.watches.length === 1 && rec.revival.github.mutes.length === 1 && rec.revival.github.queued === 1, "github: its watch + mute kept in the record, the queued DM dropped");
  ok(!gh.hostedSeats(() => "here").seats.some(mine), "github: branch/author follows read registered personas — it has none");
  // sleep
  ok(sleepState(space, "bead-1") === undefined && rec.revival.asleep, "sleep: its record is gone (a DM to a stand-in can't wake it)");
  // office
  const calls: string[] = [];
  const state = { office: "o", agents: { "bead-1": { id: "i1", token: "t1", joinedAt: 0 } } } as import("../src/office-link.ts").BridgeState;
  const bridge = new OfficeBridge({ call: async (tool, _a, o) => (calls.push(`${tool}:${(o as { token?: string } | undefined)?.token ?? ""}`), {}), state, save: () => {}, deliver: async () => ({ from: "x" }), log: () => {}, operator: "op", now: () => 1_000_000 });
  bridge.setRows([]);
  await bridge.tick();
  ok(calls.includes("leave:t1") && !state.agents["bead-1"], "office: a row-less agent is walked out and its token forgotten");

  // the list
  const list: string[] = [];
  A.printList(space, (l) => list.push(l));
  ok(list.some((l) => /bead-1 .* by itself .*worktree removed, branch bead-1 kept.*session 11111111/.test(l)), "archive --list shows it", list.join("\n"));
}

// ── 5. unarchive ────────────────────────────────────────────────────────────────────────────────────
console.log("5. unarchive");
{
  const squat = tmp("paw-arch-squat-");
  setFolderName(space, squat, "bead-1");
  ok((await throwsLike(() => A.runUnarchive(["bead-1", "--space", space], () => {}), /name "bead-1" is taken.*nothing was changed/)) === "", "a name taken since is refused");
  ok(!existsSync(wt1) && S.listArchived(space).length === 1, "…and nothing changed (no worktree re-added, still archived)");
  rmSync(personaFilePath(space, "bead-1"));

  setPersonaKeys(space, "thief", { resume: PIN, cwd: squat });
  ok((await throwsLike(() => A.runUnarchive(["bead-1", "--space", space], () => {}), /session 1111.* is pinned by thief#archtest/)) === "", "its session pinned by another agent since is refused");
  rmSync(personaFilePath(space, "thief"));

  const out: string[] = [];
  await A.runUnarchive(["bead-1", "--space", space], (l) => out.push(l));
  ok(existsSync(join(wt1, "bead-1.txt")) && git(wt1, "rev-parse", "--abbrev-ref", "HEAD") === "bead-1", "the removed worktree is back at the same path on its branch", out.join(" | "));
  ok(existsSync(join(wt1, "node_modules")), "…with its node_modules link");
  ok(folderForName(space, "bead-1") === wt1 && readResumeId(personaFilePath(space, "bead-1")) === PIN, "registered again at its folder with the same session pin");
  ok(S.listArchived(space).length === 0 && out.some((l) => l.includes(`resumes its session ${PIN}`)) && out.some((l) => /offline/.test(l)), "no longer archived; left offline, `paw start` resumes the session");
  ok(out.some((l) => /not restored: 1 cron job\(s\), 1 GitHub watch\(es\), 1 GitHub mute\(s\)/.test(l)), "it says what was archived with it and not restored");
  ok(cron.readStore(space).jobs.every((j) => j.agent !== "bead-1") && readLiveRecord(space)?.names.join() === "other", "nothing schedules it: no cron job, not in live.json");

  // archive again, keeping the folder; then a default agent claims the folder
  logs.length = 0;
  await A.retire({ space, name: "bead-1", folder: wt1, keepWorktree: true, now: false, by: "operator" }, fakeRetire);
  ok(existsSync(wt1) && logs.some((l) => /worktree kept: .* \(--keep-worktree\)/.test(l)), "--keep-worktree keeps the folder");
  setFolderName(space, wt1, "squat2");
  ok((await throwsLike(() => A.runUnarchive(["bead-1", "--space", space], () => {}), /has a default agent now \("squat2"\)/)) === "", "a folder whose default agent changed is refused");
  rmSync(personaFilePath(space, "squat2"));
  git(repo.main, "worktree", "remove", "--force", wt1);
  ok((await throwsLike(() => A.runUnarchive(["bead-1", "--space", space], () => {}), /gone and paw did not remove it/)) === "", "a folder removed by hand (not by paw) is refused");
  git(repo.main, "worktree", "add", "-q", wt1, "bead-1");
  const listed = cli(["archive", "--list"]);
  ok(listed.status === 0 && /bead-1 .* by operator .*\(folder skipped\)/.test(listed.stdout), "CLI: `paw archive --list`", listed.stdout + listed.stderr);
  const back = cli(["unarchive", "bead-1"]);
  ok(back.status === 0 && /✓ unarchived "bead-1"/.test(back.stdout) && folderForName(space, "bead-1") === wt1, "CLI: `paw unarchive bead-1` — put back by hand, it unarchives", back.stdout + back.stderr);
  ok((await throwsLike(() => A.runUnarchive(["bead-1", "--space", space], () => {}), /no archived agent "bead-1"/)) === "", "nothing archived → fails loud");
}

// ── 6. the verb: self hands off, outside runs inline, refusals ──────────────────────────────────────
console.log("6. the verb");
{
  const handoffs: Array<{ space: string; sub: string[]; env: NodeJS.ProcessEnv; opts: { key: string; cwd: string } }> = [];
  const retired: Array<import("../src/archive.ts").RetireOpts> = [];
  const said: string[] = [];
  const deps = (env: NodeJS.ProcessEnv, over: Partial<import("../src/archive.ts").ArchiveDeps> = {}): import("../src/archive.ts").ArchiveDeps => ({
    env,
    chosen: () => true,
    handoff: (s, sub, e, o) => (handoffs.push({ space: s, sub, env: e, opts: o }), true),
    retire: async (o) => void retired.push(o),
    preview: (f) => W.judgeWorktree(f, judgeWith({ cwdHolders: undefined })),
    restartInFlight: () => false,
    wake: () => ({ ok: true, detail: "" }),
    log: (l) => said.push(l),
    ...over,
  });
  const args = (...a: string[]) => A.parseArchiveArgs([...a, "--space", space]);
  const me = { COTAL_NAME: "bead-1", COTAL_SPACE: space };

  await A.runArchive(args(), deps(me));
  const h = handoffs.at(-1);
  ok(handoffs.length === 1 && retired.length === 0, "self (no name, inside the agent): hands off, retires nothing inline");
  ok(h?.sub.join(" ") === `archive bead-1 --space ${space}` && h.opts.key === "bead-1" && h.env.PAW_ARCHIVE_BY === "itself", "…the child runs `archive bead-1 --space s`, keyed by the agent, by itself");
  ok(h?.opts.cwd === process.env.PAW_HOME && !h.opts.cwd.startsWith(wt1), "…from a cwd outside the folder it may remove");
  ok(said.some((l) => /archived once THIS turn ends — the reply you write now is your last/.test(l)) && said.some((l) => l.includes(handoffLogPath(space, "archive", "bead-1"))), "…and says the reply is its last, with the progress log");
  ok(said.some((l) => /will be removed if nothing changes \(HEAD .* is in origin\/main\)/.test(l)), "…with the folder verdict as a preview");
  said.length = 0;
  writeFileSync(join(wt1, "wip.txt"), "x");
  await A.runArchive(args("bead-1"), deps(me));
  ok(handoffs.length === 2 && said.some((l) => /will be KEPT unless/.test(l)) && said.some((l) => /uncommitted change/.test(l)), "self by name: hands off too; a dirty folder is previewed as KEPT, with why");
  rmSync(join(wt1, "wip.txt"));
  ok((await throwsLike(() => A.runArchive(args("--now"), deps(me)), /--now stops an agent mid-turn — not yourself/)) === "", "self + --now is refused");
  await A.runArchive(A.parseArchiveArgs(["--space", "paw"]), deps(me, { chosen: () => false }));
  ok(handoffs.at(-1)?.space === space && handoffs.length === 3, "self with a defaulted space (no PAW_SPACE): its own space (COTAL_SPACE), not `paw`");

  await A.runArchive(args("bead-1"), deps({}));
  ok(retired.at(-1)?.name === "bead-1" && retired.at(-1)?.by === "operator" && retired.at(-1)?.folder === wt1 && handoffs.length === 3, "outside (a shell): retires inline, by operator");
  await A.runArchive(args("bead-1", "--now", "--keep-worktree"), deps({ COTAL_NAME: "hirer", COTAL_SPACE: space }));
  ok(retired.at(-1)?.by === "hirer" && retired.at(-1)?.now === true && retired.at(-1)?.keepWorktree === true, "another agent archiving it: inline, by that agent, flags passed");
  await A.runArchive(args(wt1), deps({}));
  ok(retired.at(-1)?.name === "bead-1", "a folder target resolves to its agent");

  const pidDir = join(process.env.PAW_HOME!, "spaces", space);
  writeFileSync(join(pidDir, "archive.bead-1.pid"), `${process.pid}\n`);
  ok((await throwsLike(() => A.runArchive(args("bead-1"), deps({})), /already in flight/)) === "", "an archive of it already in flight is refused");
  const n = retired.length;
  await A.runArchive(args("bead-1"), deps({ PAW_ARCHIVE_INFLIGHT: "1", PAW_ARCHIVE_BY: "itself" }));
  ok(retired.length === n + 1 && retired.at(-1)?.by === "itself" && !existsSync(join(pidDir, "archive.bead-1.pid")), "the detached child retires (by itself) and drops its pidfile");
  writeFileSync(join(pidDir, "archive.ghost.pid"), `${process.pid}\n`);
  ok((await throwsLike(() => A.runArchive(args("ghost"), deps({ PAW_ARCHIVE_INFLIGHT: "1" })), /no agent "ghost"/)) === "" && !existsSync(join(pidDir, "archive.ghost.pid")), "a child whose agent can't be resolved fails loud and still drops its pidfile");

  const neverIdle = deps({ PAW_ARCHIVE_INFLIGHT: "1" }, { retire: async () => { throw new A.TurnNeverEnded("never idle"); }, wake: (_s, who, text) => (said.push(`DM ${who}: ${text}`), { ok: true, detail: "" }) });
  ok((await throwsLike(() => A.runArchive(args("bead-1"), neverIdle), /never idle/)) === "" && said.some((l) => /DM bead-1: ✗ paw archive gave up/.test(l)), "a child whose agent never went idle tells the agent and archives nothing");
  ok(folderForName(space, "bead-1") === wt1, "…it is still registered");

  ok((await throwsLike(() => A.runArchive(args("bead-1"), deps({}, { restartInFlight: () => true })), /restart is in flight/)) === "", "a restart in flight is refused (it would revive it)");
  ok((await throwsLike(() => A.runArchive(args(), deps({})), /needs an agent outside one/)) === "", "no name outside an agent fails loud");
  setPersonaKeys(space, "away", { cwd: otherFolder, "paw-extra": "true", teleported: "ssh:mini" });
  const before = readFileSync(personaFilePath(space, "away"), "utf8");
  ok((await throwsLike(() => A.runArchive(args("away"), deps({})), /frozen copy; archive it there/)) === "" && readFileSync(personaFilePath(space, "away"), "utf8") === before, "a teleported record is refused, untouched (assertMutableByName)");
  mkdirSync(join(process.env.PAW_HOME!, "global"), { recursive: true });
  setFolderName(space, realpathSync(join(process.env.PAW_HOME!, "global")), "global");
  ok((await throwsLike(() => A.runArchive(args("global"), deps({})), /keeper's always-on agent/)) === "", "the keeper's global agent is refused");
}

rmSync(process.env.PAW_HOME!, { recursive: true, force: true });
rmSync(process.env.HOME!, { recursive: true, force: true });
rmSync(repo.base, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} archive check(s) failed`);
  process.exit(1);
}
console.log("\nall archive checks passed 🐾");

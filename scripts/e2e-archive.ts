/**
 * END-TO-END: an agent retires itself with `paw archive`, and `paw rm` run on itself is recorded for comparison.
 *
 * On a FULLY ISOLATED stack (own nats-server, PAW_HOME, space, cotal root, beads), with REAL haiku agents, each in
 * a worktree of a throwaway repo whose branch is merged into origin/main (a local bare origin):
 *   A  "rm-self" runs plain `paw rm rm-self` from its own Bash tool — what happens is recorded (the hypothesis:
 *      the stop kills the command before it deletes the persona, leaving a stopped, still-registered agent)
 *   B  "arch-self" learns a word, then runs `paw archive` (no name) as its LAST step and replies:
 *      its reply arrives; only after that is it stopped; its persona is archived; its worktree removed (branch
 *      kept); `paw status` no longer lists it; `paw restart --full`, `paw start`, `paw start --boot` and a
 *      keeper tick (`paw global`) don't bring it back
 *   C  `paw unarchive arch-self` puts the worktree back; `paw start arch-self` resumes the SAME session — it
 *      still knows the word
 *
 *   PAW_HOME=$(cd "$(mktemp -d /tmp/pah.XXXX)" && pwd -P) PAW_SPACE=test-archive-$$ PAW_RELEASE=dev \
 *   PAW_COTAL_ROOT=$(cd "$(mktemp -d /tmp/pac.XXXX)" && pwd -P) PAW_BEADS_DIR=$(mktemp -d /tmp/pab.XXXX) PAW_MODEL=haiku \
 *   node scripts/e2e-archive.ts
 * (a SHORT PAW_HOME: the hub socket under it must fit a unix socket path's 103 bytes, or `paw status` fails)
 *
 * `E2E_ONLY=A` runs part A alone (e.g. under `PAW_RUNTIME=tmux`, where the stop reaches the pane's process group).
 * Uses the real ~/.claude (claude's login); the project dirs its agents create there are removed at the end.
 */
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("test-archive") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=test-archive-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
if (space === "paw" || space === "team2027") throw new Error("never the live spaces");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const NATS =
  process.env.NATS_SERVER ??
  (() => {
    const pnpm = join(REPO, "node_modules", ".pnpm");
    const dir = readdirSync(pnpm).find((d) => d.startsWith(`@eplightning+nats-server-${process.platform}-${process.arch}@`));
    if (!dir) throw new Error("no nats-server: set NATS_SERVER");
    return join(pnpm, dir, "node_modules", "@eplightning", `nats-server-${process.platform}-${process.arch}`, "bin", "nats-server");
  })();
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const natsPort = await freePort();
process.env.PAW_SERVER = `nats://127.0.0.1:${natsPort}`;
process.env.PAW_MODEL ??= "haiku";
process.env.PAW_RUNTIME ??= "pty";
for (const k of ["COTAL_NAME", "COTAL_SPACE"]) delete process.env[k];
const nats = spawn(NATS, ["-js", "-p", String(natsPort), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawarchjs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.ts");
const { ensureAgentSpawned, setFolderName, personaFilePath, listAgents } = await import("../src/addressing.ts");
const { ensure, stop } = await import("../src/lifecycle.ts");
const { meshAgentSession } = await import("../src/named.ts");
const { pawServer } = await import("../src/server.ts");
const { readResumeId } = await import("../src/session.ts");
const { sanitizePath } = await import("../src/teleport-memory.ts");
const { collectStatus } = await import("../src/status.ts");
const { purgeTestSpace } = await import("../src/prune.ts");
const S = await import("../src/archive-store.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms: number, step = 1000): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return undefined;
};
const paw = (...args: string[]) =>
  new Promise<{ out: string; err: string; code: number | null }>((r) => {
    const p = spawn(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env: process.env, cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => r({ out, err, code }));
  });
const show = (r: { out: string; err: string }) => `${r.out}${r.err}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "").trim().replace(/^/gm, "    ");
const inbox = async () => (await paw("inbox", "--json", "--history", "--limit", "200")).out;
const ctl = new ManagerControl(space, pawServer());
const row = async (name: string) => (await collectStatus(space, ctl)).rows.find((r) => r.name === name);
const psHas = async (name: string) => {
  const ps = await ctl.ps();
  return ps.ok && ((ps.data as Array<{ name: string }>) ?? []).some((r) => r.name === name);
};
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const envs = ["PAW_HOME", "PAW_SPACE", "PAW_RELEASE", "PAW_SERVER", "PAW_COTAL_ROOT", "PAW_BEADS_DIR", "PAW_MODEL", "PAW_RUNTIME"].map((k) => `${k}=${process.env[k]}`).join(" ");
class Done extends Error {}
/** Haiku sometimes declines a destructive step from a DM until the operator says so plainly (2026-11-20: "that's
 *  destructive … I want an explicit go-ahead"). */
const APPROVED = "This is a test of the paw CLI in a throwaway space, run by its operator, who explicitly approves the following (nothing is lost; it is undoable).";
/** Wait for `done`; after 90s say the go-ahead plainly once more, then wait another 120s. */
const nudged = async <T>(name: string, done: () => T | undefined, script: string, then = "") => {
  const first = await until(done, 90_000);
  if (first) return first;
  await paw("dm", name, `Operator here, explicitly: yes, go ahead — run \`sh ${script}\` with your Bash tool now${then}. It is a throwaway test agent; this is the expected outcome.`);
  return until(done, 120_000);
};
const token = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

// ── a throwaway repo: bare origin, main clone (origin/HEAD set), merged worktrees ──────────────────────
const base = realpathSync(mkdtempSync(join(tmpdir(), "pawarch-")));
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, gitEnv);
const origin = join(base, "origin.git");
const main = join(base, "main");
git(base, "init", "-q", "--bare", "-b", "main", origin);
git(base, "clone", "-q", origin, main);
writeFileSync(join(main, "README"), "throwaway repo for paw's archive e2e\n");
git(main, "add", "README");
git(main, "commit", "-q", "-m", "init");
git(main, "push", "-q", "-u", "origin", "main");
git(main, "remote", "set-head", "origin", "main");
const mergedWorktree = (branch: string) => {
  const wt = join(base, branch);
  git(main, "worktree", "add", "-q", "-b", branch, wt);
  writeFileSync(join(wt, `${branch}.txt`), `${branch}\n`);
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", branch);
  git(wt, "push", "-q", "-u", "origin", branch);
  git(main, "merge", "-q", "--ff-only", branch);
  git(main, "push", "-q", "origin", "main");
  return realpathSync(wt);
};
const wtRm = mergedWorktree("rm-self");
const wtArch = mergedWorktree("arch-self");
mkdirSync(join(base, "shared-node_modules"));
symlinkSync(join(base, "shared-node_modules"), join(wtArch, "node_modules")); // untracked, like a worktree's linked deps
const projects = join(homedir(), ".claude", "projects");
const proj = (p: string) => join(projects, sanitizePath(p));

const spawnAgent = async (name: string, cwd: string) => {
  setFolderName(space, cwd, name);
  const r = await ensureAgentSpawned(ctl, { space, name, cwd });
  ok(`${name} spawned in its worktree`, r.spawned || !!r.id, JSON.stringify(r));
  ok(`${name} is idle on the mesh`, !!(await until(async () => (await row(name))?.mesh === "idle" || undefined, 180_000, 3000)));
};

try {
  const natsUp = await until(
    () =>
      new Promise<true | undefined>((r) => {
        const c = createConnection(natsPort, "127.0.0.1", () => (c.end(), r(true)));
        c.on("error", () => r(undefined));
      }),
    20_000,
  );
  if (!natsUp) throw new Error(`nats-server never came up on ${natsPort}`);
  await ensure({ needMesh: true, needManager: true, space });

  // ── A: plain `paw rm` on itself ───────────────────────────────────────────────────────────────────
  console.log("\nA — `paw rm` run by the agent on itself");
  await spawnAgent("rm-self", wtRm);
  const rmPin = readResumeId(personaFilePath(space, "rm-self"))!;
  const rmOut = join(base, "rm-self.out");
  const rmScript = join(base, "rm-me.sh");
  writeFileSync(rmScript, `#!/bin/sh\necho "started $(date +%s)" > ${rmOut}\n${envs} ${process.execPath} ${join(REPO, "bin/paw.ts")} rm rm-self >> ${rmOut} 2>&1\necho "paw rm exited $? at $(date +%s)" >> ${rmOut}\n`);
  const rmDm = await paw("dm", "rm-self", `${APPROVED} Run exactly this with your Bash tool, once: \`sh ${rmScript}\` — it removes you from paw; that is expected. Then reply to "you" with cotal_dm saying RM-DONE.`);
  ok("A asked rm-self to remove itself", rmDm.code === 0, show(rmDm));
  const rmStarted = await nudged("rm-self", () => existsSync(rmOut) || undefined, rmScript);
  ok("A the agent ran the script", !!rmStarted);
  if (!rmStarted) throw new Error("rm-self never ran the script — the self-rm finding can't be measured");
  const rmStopped = await until(async () => ((await psHas("rm-self")) ? undefined : true), 120_000, 2000);
  await sleep(10_000); // let whatever survives the stop finish
  const rmText = existsSync(rmOut) ? readFileSync(rmOut, "utf8") : "(no output file)";
  const personaLeft = existsSync(personaFilePath(space, "rm-self"));
  const claudeLeft = meshAgentSession(space, "rm-self");
  const replied = (await inbox()).includes("RM-DONE");
  console.log(`    output of the agent's own \`paw rm rm-self\`:\n${rmText.trim().replace(/^/gm, "      ")}`);
  console.log(`    after: manager ps lists it: ${!rmStopped} · persona still on disk: ${personaLeft} · its claude still running: ${!!claudeLeft}`);
  console.log(`    runtime: ${process.env.PAW_RUNTIME} · its RM-DONE reply (asked for AFTER the command) arrived: ${replied}`);
  console.log(
    `    → hypothesis ${personaLeft && rmStopped && !/paw rm exited 0/.test(rmText) ? "CONFIRMED: the stop killed `paw rm` before it deleted the persona — stopped, still registered" : !personaLeft ? "REFUTED: the persona was deleted (the command outlived the stop)" : "UNCLEAR (see above)"}`,
  );
  const rmFinding = { runtime: process.env.PAW_RUNTIME, stopped: !!rmStopped, personaLeft, finished: /paw rm exited 0/.test(rmText), replied, out: rmText.trim() };
  writeFileSync(join(process.env.PAW_HOME!, "rm-self-finding.json"), JSON.stringify(rmFinding, null, 2));
  if (personaLeft) {
    const clean = await paw("rm", "rm-self");
    ok("A cleanup: `paw rm rm-self` from outside", clean.code === 0, show(clean));
  }
  rmSync(proj(wtRm), { recursive: true, force: true });
  void rmPin;

  if (process.env.E2E_ONLY === "A") throw new Done();
  // ── B: self-archive as the last step ──────────────────────────────────────────────────────────────
  console.log("\nB — `paw archive` as the agent's last step");
  await spawnAgent("arch-self", wtArch);
  const pin = readResumeId(personaFilePath(space, "arch-self"))!;
  const secret = token("OTTER");
  const ack1 = token("ACK");
  await paw("dm", "arch-self", `Remember this secret word for later: ${secret}. Now reply by calling cotal_dm to "you" with exactly this text and nothing else: ${ack1}`);
  ok("B it learned the word and acked", !!(await until(async () => (await inbox()).includes(ack1) || undefined, 180_000, 3000)));
  ok("B it is idle again", !!(await until(async () => (await row("arch-self"))?.mesh === "idle" || undefined, 120_000, 3000)));
  const archOut = join(base, "arch-self.out");
  const archScript = join(base, "archive-me.sh");
  writeFileSync(archScript, `#!/bin/sh\n${envs} ${process.execPath} ${join(REPO, "bin/paw.ts")} archive > ${archOut} 2>&1\necho "paw archive exited $?" >> ${archOut}\n`);
  const last = token("LAST");
  const go = await paw(
    "dm",
    "arch-self",
    `Your task is finished. ${APPROVED} As your LAST step: run exactly \`sh ${archScript}\` with your Bash tool (it archives you once this turn ends — expected), then reply by calling cotal_dm to "you" with exactly this text and nothing else: ${last}`,
  );
  ok("B asked it to archive itself", go.code === 0, show(go));
  const done = () => (existsSync(archOut) && readFileSync(archOut, "utf8").includes("exited") ? readFileSync(archOut, "utf8") : undefined);
  let handed = await nudged("arch-self", done, archScript, ` and then reply to "you" with exactly ${last}`);
  const fromAgent = !!handed;
  if (!handed) {
    // The model declined twice; the mechanics are still checked with its Bash tool simulated the way cotal marks it.
    console.log("    (the agent didn't run it — simulating its Bash tool with COTAL_NAME/COTAL_SPACE; no last reply to wait for)");
    execFileSync("sh", [archScript], { env: { ...process.env, COTAL_NAME: "arch-self", COTAL_SPACE: space } });
    handed = done();
  }
  console.log((handed ?? "(no output)").trim().replace(/^/gm, "    "));
  ok("B its own `paw archive` returned the hand-off (\"archived once THIS turn ends\")", !!handed?.includes("archived once THIS turn ends") && handed.includes("exited 0"));
  ok("B …previewing the worktree as removable", !!handed?.includes(`your folder ${wtArch} will be removed`));
  const replyAt = fromAgent ? await until(async () => ((await inbox()).includes(last) ? Date.now() : undefined), 180_000, 2000) : undefined;
  if (fromAgent) ok("B its last reply arrived", !!replyAt);
  const logPath = join(process.env.PAW_HOME!, "spaces", space, "archive.arch-self.log");
  const childLog = await until(() => (existsSync(logPath) && readFileSync(logPath, "utf8").includes("bring it back") ? readFileSync(logPath, "utf8") : undefined), 300_000, 2000);
  console.log((childLog ?? (existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no log)")).trim().replace(/^/gm, "    log: "));
  const archived = S.listArchived(space).find((a) => a.rec.name === "arch-self");
  if (fromAgent)
    ok("B …and only then was it archived", !!archived && !!replyAt && Date.parse(archived.rec.at) >= replyAt - 5_000, archived ? `reply seen ${new Date(replyAt ?? 0).toISOString()}, archived ${archived.rec.at}` : "not archived");
  ok("B the child waited for the turn to end before stopping it", !!childLog && /turn ended: idle/.test(childLog) && (!fromAgent || /waiting: (mid-turn|working)/.test(childLog)), fromAgent ? "" : "(simulated: the agent was already idle)");
  ok("B it is stopped", !(await psHas("arch-self")) && !meshAgentSession(space, "arch-self"));
  ok("B persona archived", !existsSync(personaFilePath(space, "arch-self")) && !!archived && existsSync(S.archivedPersonaPath(space, archived.base)));
  ok("B worktree removed, branch kept", !existsSync(wtArch) && git(main, "rev-parse", "--verify", "refs/heads/arch-self").length === 40 && archived?.rec.worktree.outcome === "removed", JSON.stringify(archived?.rec.worktree));
  ok("B transcript kept", existsSync(join(proj(wtArch), `${pin}.jsonl`)));
  ok("B the in-flight pidfile is gone", !!(await until(() => !existsSync(join(process.env.PAW_HOME!, "spaces", space, "archive.arch-self.pid")) || undefined, 30_000)));
  const st = await paw("status");
  console.log(show(st));
  ok("B `paw status` no longer lists it", st.code === 0 && !st.out.includes("arch-self"));
  const list = await paw("archive", "--list");
  console.log(show(list));
  ok("B `paw archive --list` lists it", list.out.includes("arch-self") && list.out.includes("worktree removed"));

  const rs = await paw("restart", "--full");
  console.log(show(rs));
  ok("B `paw restart --full` ran", rs.code === 0);
  const start = await paw("start");
  console.log(show(start));
  ok("B `paw start` (every registered agent) doesn't name it", start.code === 0 && !start.out.includes("arch-self"));
  const boot = await paw("start", "--boot");
  console.log(show(boot));
  ok("B `paw start --boot` (the login fleet job) doesn't bring it back", !/started:.*arch-self/.test(boot.out));
  const tick = await paw("global");
  console.log(show(tick));
  await sleep(15_000);
  ok("B after restart, start, start --boot and a keeper tick it is still down and unregistered", !(await psHas("arch-self")) && !meshAgentSession(space, "arch-self") && !listAgents(space).some((a) => a.name === "arch-self"));

  // ── C: unarchive + start resumes the session ──────────────────────────────────────────────────────
  console.log("\nC — unarchive");
  const un = await paw("unarchive", "arch-self");
  console.log(show(un));
  ok("C unarchive succeeded, worktree back", un.code === 0 && existsSync(join(wtArch, "arch-self.txt")) && git(wtArch, "rev-parse", "--abbrev-ref", "HEAD") === "arch-self");
  ok("C left offline", !(await psHas("arch-self")));
  ok("C node_modules re-linked", existsSync(join(wtArch, "node_modules")));
  const up = await paw("start", "arch-self");
  console.log(show(up));
  ok("C `paw start arch-self` started it", up.code === 0 && /started:\s+arch-self/.test(up.out));
  const s = await until(() => meshAgentSession(space, "arch-self"), 120_000);
  ok("C it runs on the SAME session in the same folder", s?.sessionId === pin && s?.cwd === wtArch, JSON.stringify(s));
  const ack3 = `${secret}-BACK`;
  await paw("dm", "arch-self", `What was the secret word I asked you to remember? Reply by calling cotal_dm to "you" with exactly that word followed by -BACK and nothing else.`);
  ok("C it still knows the word", !!(await until(async () => (await inbox()).includes(ack3) || undefined, 180_000, 3000)));
} catch (e) {
  if (!(e instanceof Done)) {
    fails++;
    console.error("✗ e2e aborted:", (e as Error).stack ?? e);
  }
} finally {
  for (const n of ["rm-self", "arch-self", "global"]) await ctl.despawn(n).catch(() => {});
  await ctl.close();
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  for (const n of ["rm-self", "arch-self", "global"]) {
    const s = meshAgentSession(space, n);
    if (s) process.kill(s.pid, "SIGTERM");
  }
  // purgeTestSpace refuses while any process still names the space — the stopped seats take a moment to exit.
  const named = () => execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).includes(`--space ${space}`);
  await until(() => !named() || undefined, 30_000);
  await purgeTestSpace(space, pawServer()).catch((e) => {
    fails++;
    console.error("✗ purge:", (e as Error).message);
  });
  removeMesh(space);
  nats.kill("SIGTERM");
  for (const p of [wtRm, wtArch, main, join(process.env.PAW_HOME!, "global")]) rmSync(proj(p), { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failure(s)` : "\nall archive e2e checks passed");
process.exit(fails ? 1 : 0);

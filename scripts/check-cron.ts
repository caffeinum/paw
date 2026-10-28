/**
 * `paw cron` (src/cron.ts + src/commands/cron.ts): cron parsing, next-fire in local time, one-shot times,
 * catch-up-once, one-shot delete/retry/drop, the store (lock + atomic write), `add`'s argv shapes and
 * self default, and the fire gate (registered + hosted here). Hermetic: temp PAW_HOME, no mesh.
 * Run: pnpm check:cron
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-cron-"));
const SPACE = `test-${process.pid}`;
process.env.PAW_HOME = home;
process.env.PAW_SPACE = SPACE;
process.env.PAW_RELEASE = "dev";
delete process.env.COTAL_NAME;
delete process.env.COTAL_SPACE;

const cron = await import("../src/cron.ts");
const { buildJob, parseCronArgs, unfireable, formatJobs, runCommand } = await import("../src/commands/cron.ts");
const { setFolderName } = await import("../src/addressing.ts");

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
    assert(re.test((e as Error).message), `${msg}${re.test((e as Error).message) ? "" : ` (got: ${(e as Error).message})`}`);
  }
}
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const show = (t: number) => new Date(t).toString().slice(0, 21);

console.log("parse");
{
  const s = cron.parseCron("*/15 9-17 * * mon-fri");
  assert([...s.minute].join() === "0,15,30,45" && s.hour.size === 9 && s.dow.has(1) && s.dow.has(5) && !s.dow.has(0), "steps, ranges, day names");
  assert(cron.parseCron("0 0 * * 7").dow.has(0), "7 is Sunday");
  assert(cron.parseCron("0 0 1 jan,jul *").month.has(1) && cron.parseCron("0 0 1 jan,jul *").month.has(7), "month names in a list");
  assert([...cron.parseCron("5/20 * * * *").minute].join() === "5,25,45", "n/step = from n to max");
  throws(() => cron.parseCron("* * * *"), /5 fields/, "4 fields fail loud");
  throws(() => cron.parseCron("60 * * * *"), /bad minute "60"/, "out-of-range minute fails loud");
  throws(() => cron.parseCron("* * * * funday"), /bad day-of-week/, "unknown name fails loud");
  throws(() => cron.parseCron("*/0 * * * *"), /bad step/, "zero step fails loud");
  throws(() => cron.parseCron("5-1 * * * *"), /backwards range/, "backwards range fails loud");
}

console.log("next fire (local time)");
{
  const base = at(2026, 10, 28, 14, 7); // a Wednesday
  assert(cron.nextFire("*/15 * * * *", base) === at(2026, 10, 28, 14, 15), "*/15 → next quarter hour");
  assert(cron.nextFire("30 3 * * *", base) === at(2026, 10, 29, 3, 30), "30 3 * * * → tomorrow 03:30");
  assert(cron.nextFire("0 9 * * 1", base) === at(2026, 11, 2, 9, 0), "0 9 * * mon → next Monday");
  assert(cron.nextFire("7 14 * * *", base) === at(2026, 10, 29, 14, 7), "strictly AFTER: the same minute is tomorrow");
  assert(cron.nextFire("0 0 1 * *", base) === at(2026, 11, 1), "first of next month");
  assert(cron.nextFire("0 0 13 * 5", base) === at(2026, 10, 30), "dom AND dow restricted → either matches (Friday 30th first)");
  assert(cron.nextFire("0 0 29 2 *", base) === at(2028, 2, 29), "Feb 29 → the next leap year");
  throws(() => cron.nextFire("0 0 30 2 *", base), /never fires/, "Feb 30 fails loud");
}

console.log("one-shot times");
{
  const now = at(2026, 10, 28, 14, 7);
  assert(cron.parseIn("20m") === 20 * 60_000 && cron.parseIn("1h30m") === 90 * 60_000 && cron.parseIn("2d") === 2 * 86_400_000, "--in units");
  throws(() => cron.parseIn("20"), /bad --in/, "--in without a unit fails loud");
  throws(() => cron.parseIn("5x"), /bad --in/, "--in with a bad unit fails loud");
  assert(cron.parseAt("15:00", now) === at(2026, 10, 28, 15, 0), "--at HH:MM later today");
  assert(cron.parseAt("09:00", now) === at(2026, 10, 29, 9, 0), "--at HH:MM already past → tomorrow");
  assert(cron.parseAt("2026-11-10 09:30", now) === at(2026, 11, 10, 9, 30), "--at 'YYYY-MM-DD HH:MM' is local time");
  throws(() => cron.parseAt("2026-10-01 09:00", now), /in the past/, "--at in the past fails loud");
  throws(() => cron.parseAt("tomorrowish", now), /bad --at/, "--at garbage fails loud");
}

console.log("catch-up once");
{
  const created = at(2026, 10, 20, 12, 0);
  const job: import("../src/cron.ts").CronJob = { id: "r1", agent: "a", prompt: "p", cron: "0 * * * *", createdAt: created, createdBy: "operator" };
  const store = { jobs: [job] };
  const now = at(2026, 10, 28, 14, 7); // ~8 days of hourly occurrences missed (machine asleep)
  const first = cron.claimDue(store, now);
  assert(first.length === 1, "a recurring job with ~200 missed occurrences fires ONCE");
  assert(cron.claimDue(store, now).length === 0 && cron.claimDue(store, now + 30_000).length === 0, "…and not again on the next ticks");
  assert(cron.nextDue(store.jobs[0]) === at(2026, 10, 28, 15, 0), `next occurrence is the next one after the catch-up fire (${show(cron.nextDue(store.jobs[0]))})`);
  assert(cron.claimDue(store, at(2026, 10, 28, 15, 0)).length === 1, "fires at the next real occurrence");
  assert(cron.settle(store, "r1", "boom") === "kept" && store.jobs[0].lastError === "boom", "a failed recurring fire keeps the job and its error");
  assert(cron.settle(store, "r1", undefined) === "kept" && store.jobs[0].lastError === undefined, "a good fire clears the error");
  assert(cron.claimDue({ jobs: [{ ...job, createdAt: now }] }, now).length === 0, "a just-created job is not due");
}

console.log("one-shots");
{
  const now = at(2026, 10, 28, 14, 7);
  const mk = (): import("../src/cron.ts").CronStore => ({ jobs: [{ id: "o1", agent: "a", prompt: "p", at: now - 1000, createdAt: now - 60_000, createdBy: "a" }] });
  const s1 = mk();
  assert(cron.claimDue(s1, now).length === 1 && cron.settle(s1, "o1", undefined) === "removed" && s1.jobs.length === 0, "a delivered one-shot is deleted");
  const s2 = mk();
  cron.claimDue(s2, now);
  assert(cron.settle(s2, "o1", "mesh down") === "kept" && s2.jobs[0].attempts === 1, "a failed one-shot is kept for retry");
  assert(cron.claimDue(s2, now + 60_000).length === 0, "…not retried on the very next tick");
  assert(cron.claimDue(s2, now + cron.ONE_SHOT_RETRY_MS).length === 1, "…retried after the retry gap");
  cron.settle(s2, "o1", "still down");
  cron.claimDue(s2, now + 2 * cron.ONE_SHOT_RETRY_MS);
  assert(cron.settle(s2, "o1", "still down") === "dropped" && s2.jobs.length === 0, `dropped after ${cron.ONE_SHOT_MAX_ATTEMPTS} attempts`);
  assert(cron.settle({ jobs: [] }, "o1", undefined) === "gone", "a job rm'd mid-fire settles as gone");
  assert(cron.claimDue(mk(), now - 2000).length === 0, "a one-shot is not due before its time");
}

console.log("add: argv shapes");
{
  const now = at(2026, 10, 28, 14, 7);
  const b = (argv: string[], self?: string) => buildJob(parseCronArgs(argv), { space: SPACE, self, now, id: "x" });
  const j1 = b(["add", "bob", "30 3 * * *", "check upstream"]);
  assert(j1.agent === "bob" && j1.cron === "30 3 * * *" && j1.prompt === "check upstream" && j1.createdBy === "operator", "add <agent> <cron> <prompt>");
  const j2 = b(["add", "*/5 * * * *", "poll"], "me");
  assert(j2.agent === "me" && j2.createdBy === "me" && j2.cron === "*/5 * * * *", "add <cron> <prompt> inside an agent → the caller");
  const j3 = b(["add", "--in", "20m", "later"], "me");
  assert(j3.agent === "me" && j3.at === now + 20 * 60_000 && j3.cron === undefined, "add --in <t> <prompt> → one-shot for the caller");
  const j4 = b(["add", "@bob", "--at", "15:00", "x"]);
  assert(j4.agent === "bob" && j4.at === at(2026, 10, 28, 15, 0), "add @agent --at HH:MM");
  const j5 = b(["add", "bob", "0 9 * * 1", "standup", "--once"]);
  assert(j5.at === at(2026, 11, 2, 9, 0) && j5.cron === undefined, "--once pins a cron expression's next match as a one-shot");
  throws(() => b(["add", "*/5 * * * *", "poll"]), /not run from inside an agent/, "no agent and no caller fails loud");
  throws(() => b(["add", "bob", "--in", "5m", "--at", "10:00", "x"]), /--in OR --at/, "--in + --at fails loud");
  throws(() => b(["add", "bob", "--in", "5m", "x", "--once"]), /--once is for a cron/, "--once with --in fails loud");
  throws(() => b(["add", "bob", "every day", "x"]), /5 fields/, "a non-cron schedule fails loud");
  throws(() => b(["add", "a", "b", "c", "d"]), /wrong arguments/, "too many positionals fail loud");
  throws(() => b(["add", "bob", "* * * * *", "  "]), /empty prompt/, "empty prompt fails loud");
  throws(() => parseCronArgs(["add", "--every", "5m"]), /unknown flag/, "unknown flag fails loud");
}

console.log("--run: argv");
{
  const now = at(2026, 10, 28, 14, 7);
  const b = (argv: string[], self?: string) => buildJob(parseCronArgs(argv), { space: SPACE, self, now, id: "x" });
  const r1 = b(["add", "bob", "0 * * * *", "--run", "./check.sh"]);
  assert(r1.agent === "bob" && r1.cron === "0 * * * *" && r1.run === "./check.sh" && r1.prompt === "", "add <agent> <cron> --run <cmd> (prompt optional)");
  const r2 = b(["add", "0 * * * *", "--run", "./check.sh"], "me");
  assert(r2.agent === "me" && r2.cron === "0 * * * *", "add <cron> --run <cmd> inside an agent → the caller");
  const r3 = b(["add", "0 * * * *", "look at this", "--run", "x", "--timeout", "90s"], "me");
  assert(r3.agent === "me" && r3.prompt === "look at this" && r3.timeoutMs === 90_000, "add <cron> <prompt> --run --timeout");
  const r4 = b(["add", "bob", "--in", "5m", "--run", "x"]);
  assert(r4.agent === "bob" && r4.at === now + 300_000 && r4.prompt === "", "add <agent> --in <t> --run (lone word = agent)");
  const r5 = b(["add", "--in", "5m", "--run", "x"], "me");
  assert(r5.agent === "me" && r5.prompt === "", "add --in <t> --run inside an agent");
  const r6 = b(["add", "check the result", "--in", "5m", "--run", "x"], "me");
  assert(r6.agent === "me" && r6.prompt === "check the result", "add <multi-word prompt> --in --run → the caller");
  throws(() => b(["add", "bob", "0 * * * *", "--run", "  "]), /empty --run/, "empty --run fails loud");
  throws(() => b(["add", "bob", "0 * * * *", "p", "--timeout", "5m"]), /--timeout is for --run/, "--timeout without --run fails loud");
  throws(() => b(["add", "bob", "0 * * * *", "p", "q", "--run", "x"]), /wrong arguments/, "too many positionals with --run fail loud");
  assert(formatJobs([r3], now).includes("run: x (timeout 90s)"), "ls shows the command and its timeout");
}

console.log("--run: output → message");
{
  const job = { id: "j", agent: "a", prompt: "", cron: "0 * * * *", createdAt: 0, createdBy: "me", run: "./c.sh" };
  const ok = (stdout: string, stderr = "") => ({ code: 0, timedOut: false, stdout, stderr });
  assert(cron.runText(job, ok(""), 1000) === undefined, "exit 0 + empty stdout → silent (nothing sent)");
  assert(cron.runText(job, ok("  \n", "noise on stderr"), 1000) === undefined, "whitespace stdout + stderr only → still silent");
  const t = cron.runText({ ...job, prompt: "act on this" }, ok("3 new rows\n"), 1000)!;
  assert(t.startsWith("⏰ paw cron j (") && t.includes(": act on this") && t.includes("`./c.sh` printed:\n3 new rows"), "output → prompt + output");
  const big = cron.runText(job, ok("x".repeat(cron.RUN_OUTPUT_MAX + 500)), 1000)!;
  assert(big.includes(`output truncated: ${cron.RUN_OUTPUT_MAX + 500} chars, first ${cron.RUN_OUTPUT_MAX} shown`) && big.length < cron.RUN_OUTPUT_MAX + 600, "large output is truncated and says so");
  const f = cron.runText(job, { code: 2, timedOut: false, stdout: "step 1\n", stderr: "boom\n" }, 1000)!;
  assert(/FAILED — exited 2\.\nlast output:\nstep 1\nboom/.test(f), "non-zero exit → failure + tail of stdout+stderr");
  const to = cron.runText(job, { code: undefined, timedOut: true, stdout: "", stderr: "" }, 600_000)!;
  assert(/FAILED — timed out after 600s\. \(no output\)/.test(to), "timeout → says so");
  const tail = cron.runText(job, { code: 1, timedOut: false, stdout: "a".repeat(5000) + "END", stderr: "" }, 1000)!;
  assert(tail.endsWith("END") && tail.includes("last 4000 shown"), "failure keeps the TAIL of long output");
}

console.log("--run: execution");
{
  const dir = mkdtempSync(join(tmpdir(), "paw-cron-run-"));
  const r1 = await runCommand('pwd; echo "$PAW_CRON_JOB"; echo err >&2', dir, 10_000, { id: "jid", agent: "a", prompt: "", createdAt: 0, createdBy: "x" });
  assert(r1.code === 0 && r1.stdout.split("\n")[0] === realpathSync(dir) && r1.stdout.includes("jid") && r1.stderr.trim() === "err", "runs in the agent folder via /bin/sh, env carries the job id, stderr captured");
  const r2 = await runCommand("exit 3", dir, 10_000);
  assert(r2.code === 3 && !r2.timedOut, "exit code captured");
  const t0 = Date.now();
  const r3 = await runCommand("sleep 30 & sleep 30", dir, 500);
  assert(r3.timedOut && Date.now() - t0 < 5_000, "timeout kills the whole process group promptly");
  const r4 = await runCommand("command -v sh >/dev/null && echo ok", dir, 10_000);
  assert(r4.stdout.trim() === "ok", "PATH is set (daemonEnv)");
  rmSync(dir, { recursive: true, force: true });
}

console.log("store");
{
  assert(cron.readStore(SPACE).jobs.length === 0 && !existsSync(cron.cronPath(SPACE)), "no store file → empty, nothing written");
  const job = { id: "s1", agent: "a", prompt: "p", cron: "0 * * * *", createdAt: Date.now(), createdBy: "operator" };
  cron.updateStore(SPACE, (s) => void s.jobs.push(job));
  cron.updateStore(SPACE, (s) => void s.jobs.push({ ...job, id: "s2" }));
  const raw = JSON.parse(readFileSync(cron.cronPath(SPACE), "utf8"));
  assert(raw.jobs.length === 2 && raw.jobs[1].id === "s2", "updates persist as JSON");
  const dir = join(home, "spaces", SPACE);
  assert(!readdirSync(dir).some((f) => f.endsWith(".tmp") || f.endsWith(".lock")), "no tmp or lock file left behind");
  assert(cron.spacesWithCron().includes(SPACE), "the space is listed for the sweep");
  assert(formatJobs(cron.readStore(SPACE).jobs, Date.now()).includes("s2  a  cron \"0 * * * *\""), "ls renders a row per job");
  throws(() => cron.updateStore(SPACE, () => { throw new Error("mid-update"); }), /mid-update/, "a throwing update propagates");
  assert(cron.readStore(SPACE).jobs.length === 2, "…and writes nothing");
}

console.log("fire gate");
{
  const folder = mkdtempSync(join(tmpdir(), "paw-cron-agent-"));
  const name = setFolderName(SPACE, folder, "cronee").name;
  assert(unfireable(SPACE, name) === undefined, "a registered local agent is fireable");
  assert(/not a registered agent/.test(unfireable(SPACE, "nobody") ?? ""), "an unregistered name is refused (never spawned)");
  assert(cron.fireText({ id: "i", agent: name, prompt: "go", cron: "0 * * * *", createdAt: 0, createdBy: "me" }).startsWith('⏰ paw cron i ("0 * * * *", set by me'), "the fire text names job, schedule and author");
  rmSync(folder, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} cron check(s) failed`);
  process.exit(1);
}
console.log("\nall cron checks passed 🐾");

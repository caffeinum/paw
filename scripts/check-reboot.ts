/**
 * check:reboot — after a reboot the login fleet job brings back EVERY space this machine hosts, not just
 * the one baked into its plist (src/boot-live.ts, src/reboot.ts, `paw start --boot`).
 *
 * The incident: the mini rebooted 2026-11-07 04:07; the fleet job (`paw start <names> --space paw`) brought
 * `paw` back and team2027 (a remote mesh) stayed down. Hermetic: a temp PAW_HOME with fake personas, a fake
 * remote record, fake ps answers and a fake start — no mesh, no manager, no launchctl.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-reboot-"));
process.env.PAW_HOME = home;
process.env.PAW_SPACE = `test-reboot-${process.pid}`;
delete process.env.PAW_MACHINE;

let failures = 0;
const assert = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const throws = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};

const live = await import("../src/boot-live.ts");
const rb = await import("../src/reboot.ts");
const { writeRemoteMesh } = await import("../src/remote-mesh.ts");
const { personaFilePath } = await import("../src/addressing.ts");
const { sleepDir } = await import("../src/sleep-state.ts");

const PRIMARY = process.env.PAW_SPACE;
const REMOTE = `t2027-${process.pid}`;
const QUIET = `quiet-${process.pid}`;
const HERE = "aleks-mac-mini";
const folder = join(home, "work");
mkdirSync(folder, { recursive: true });
const persona = (space: string, name: string, extra = "") => writeFileSync(personaFilePath(space, name), `---\nname: ${name}\ncwd: ${folder}\n${extra}---\nbody\n`);
writeRemoteMesh({ space: REMOTE, server: "tls://127.0.0.1:14999", root: home, human: HERE, ts: new Date().toISOString() } as never);
for (const n of ["lizard", "paw", "mcpc", "evals-intern"]) persona(REMOTE, n, `machine: ${HERE}\nhost: mini.local\n`);
persona(REMOTE, "fly-hello", "machine: aleks-macbook\n");
persona(REMOTE, "nostamp");
writeFileSync(join(sleepDir(REMOTE), "mcpc.json"), "{}");
for (const n of ["a", "b", "stopped"]) persona(PRIMARY, n);
persona(QUIET, "q1");

console.log("the live record (spaces/<s>/live.json)");
{
  const boot = Date.UTC(2026, 10, 7, 4, 7);
  const rows = [
    { name: "lizard", status: "running", mesh: "idle" },
    { name: "paw", status: "running", mesh: "offline" }, // process up, heartbeat lost in a broker stall: still live
    { name: "evals-intern", status: "exited", mesh: "offline" }, // exited and off the mesh: down
    { name: "mcpc", status: "running", mesh: "idle" }, // recorded asleep: never "live"
    { name: "cotal-spawned", status: "running", mesh: "idle" }, // no persona here
  ];
  const r = live.recordFromPs(REMOTE, { ok: true, data: rows }, { now: boot + 3600_000 * 5, bootAt: boot });
  assert(r.names?.join(",") === "lizard,paw", "running seats with a persona here, not asleep (psRowRunning, the restart rule)");
  const rec = live.readLiveRecord(REMOTE)!;
  assert(rec.space === REMOTE && rec.bootAt === boot && rec.names.join(",") === "lizard,paw", "written as {space, bootAt, at, names}");
  assert(live.recordFromPs(REMOTE, { ok: false }, { now: boot + 3600_000 * 6, bootAt: boot }).held?.includes("last record stands") && live.readLiveRecord(REMOTE)!.names.length === 2, "a ps that didn't answer never overwrites the record");

  const nextBoot = boot + 3600_000 * 24;
  const early = live.recordFromPs(REMOTE, { ok: true, data: [] }, { now: nextBoot + 5 * 60_000, bootAt: nextBoot });
  assert(early.held?.includes("held for the login fleet job") && live.readLiveRecord(REMOTE)!.names.join(",") === "lizard,paw", "after a reboot, the previous boot's record is HELD (a half-booted fleet is not 'what was live')");
  assert(live.mayRecord(rec, nextBoot, nextBoot + live.BOOT_HOLD_MS), "…until BOOT_HOLD_MS after boot (no fleet job ever re-stamps it)");
  live.restampLiveRecord(REMOTE, nextBoot + 6 * 60_000, nextBoot);
  const re = live.readLiveRecord(REMOTE)!;
  assert(re.bootAt === nextBoot && re.names.join(",") === "lizard,paw", "the fleet job re-stamps it with this boot, names kept");
  assert(live.recordFromPs(REMOTE, { ok: true, data: rows }, { now: nextBoot + 7 * 60_000, bootAt: nextBoot }).names?.length === 2, "…and the keeper keeps it current again");
  assert(live.sameBoot(boot, boot + 1500) && !live.sameBoot(boot, boot + 10 * 60_000), "boot times a few ms apart are the same boot");

  writeFileSync(live.liveRecordPath(QUIET), "{nope");
  assert(throws(() => live.readLiveRecord(QUIET), /not valid JSON/), "a malformed record throws (paw wrote it)");
  writeFileSync(live.liveRecordPath(QUIET), JSON.stringify({ space: "other", bootAt: 1, at: "x", names: [] }));
  assert(throws(() => live.readLiveRecord(QUIET), /not a live record for space/), "…so does another space's");
  writeFileSync(live.liveRecordPath(QUIET), ""); // reset below
  const { rmSync } = await import("node:fs");
  rmSync(live.liveRecordPath(QUIET));
}

console.log("the keeper records every other space whose manager runs HERE");
{
  const asked: string[] = [];
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (l: string) => errs.push(l);
  const done = await live.recordLiveElsewhere(PRIMARY, {
    spaces: () => [PRIMARY, REMOTE, QUIET, "down"],
    managerUp: (s) => s !== "down",
    ps: async (s) => {
      asked.push(s);
      if (s === QUIET) throw new Error("broker stall");
      return { ok: true, data: [{ name: "lizard", status: "running", mesh: "idle" }] };
    },
  });
  console.error = origErr;
  assert(!asked.includes(PRIMARY) && !asked.includes("down"), "skips its own space (recorded in-tick) and spaces with no manager here (never starts one)");
  assert(done.join(",") === REMOTE && errs.some((e) => e.includes(QUIET) && e.includes("broker stall")), "a failing space is logged, the others still recorded, the tick never fails");
}

console.log("who comes back in a space (planSpace)");
{
  const f = rb.agentFacts(REMOTE);
  assert(f.remote && f.localMachine === HERE, "a remote space: this machine is its `--as` name there");
  const p = rb.planSpace(["lizard", "mcpc", "fly-hello", "nostamp", "ghost", "lizard"], f);
  assert(p.start.join(",") === "lizard", "only an agent whose persona says machine: <this machine> comes back");
  const why = Object.fromEntries(p.skip.map((s) => [s.name, s.why]));
  assert(/asleep — stays asleep/.test(why.mcpc), "a sleeping agent stays asleep");
  assert(/hosted on aleks-macbook, not aleks-mac-mini/.test(why["fly-hello"]), "another machine's agent is skipped and named");
  assert(/no machine: stamp/.test(why.nostamp), "an unstamped persona on a remote space is skipped (no guessing)");
  assert(/no persona on this machine/.test(why.ghost), "a name with no persona here is skipped");
  const local = rb.planSpace(["a", "b"], rb.agentFacts(PRIMARY));
  assert(local.start.join(",") === "a,b" && !local.skip.length, "a local space has one manager: every registered name is hosted here");
}

console.log("paw start --boot (runBoot)");
const mkDeps = (over: Partial<import("../src/reboot.ts").BootDeps> = {}) => {
  const log: string[] = [];
  const started: Array<[string, string[]]> = [];
  const slept: number[] = [];
  const restamped: string[] = [];
  const deps: import("../src/reboot.ts").BootDeps = {
    spaces: () => [QUIET, PRIMARY, REMOTE],
    record: (s) => live.readLiveRecord(s),
    facts: rb.agentFacts,
    registered: (s) => (s === QUIET ? ["q1"] : []),
    start: async (s, ns) => {
      started.push([s, ns]);
      return { started: ns, alive: [], skipped: [], stuck: [] };
    },
    restamp: (s) => restamped.push(s),
    sleep: async (ms) => void slept.push(ms),
    log: (l) => log.push(l),
    delays: [1, 2, 3],
    ...over,
  };
  if (over.start) {
    const inner = over.start;
    deps.start = async (s, ns) => {
      started.push([s, ns]);
      return inner(s, ns);
    };
  }
  return { deps, log, started, slept, restamped };
};
{
  // The primary's record says b was live; the plist baked a. team2027's says lizard, paw, mcpc (asleep).
  const now = Date.now();
  writeFileSync(live.liveRecordPath(PRIMARY), JSON.stringify({ space: PRIMARY, bootAt: now - 86_400_000, at: "2026-11-07T04:00:00Z", names: ["b"] }));
  writeFileSync(live.liveRecordPath(REMOTE), JSON.stringify({ space: REMOTE, bootAt: now - 86_400_000, at: "2026-11-07T04:00:00Z", names: ["lizard", "paw", "mcpc", "fly-hello"] }));
  const t = mkDeps();
  await rb.runBoot(PRIMARY, ["a"], t.deps);
  assert(t.started[0]?.[0] === PRIMARY && t.started[0][1].join(",") === "a,b", "the plist's space first: its baked names ∪ its live record");
  assert(t.started[1]?.[0] === REMOTE && t.started[1][1].join(",") === "lizard,paw", "the remote space comes back too — only what was live AND hosted here, sleeper excluded");
  assert(t.started.length === 2 && !t.started.some(([s]) => s === QUIET), "a space with no record starts NOTHING (never the whole registry)");
  assert(t.log.some((l) => l.includes(QUIET) && l.includes("no live record") && l.includes(`paw start q1 --space ${QUIET}`)), "…and says so, with the command to start them by hand");
  assert(t.log.some((l) => l.includes("not starting mcpc — asleep")) && t.log.some((l) => l.includes("not starting fly-hello — hosted on aleks-macbook")), "every skipped name is logged with why");
  assert(t.restamped.join(",") === `${PRIMARY},${REMOTE}`, "each record read is re-stamped for the keeper");
}
{
  let calls = 0;
  const t = mkDeps({
    start: async (s, ns) => {
      if (s === REMOTE && ++calls < 3) throw new Error("connect ETIMEDOUT 2027-cotal.fly.dev:4222\nstack…");
      return { started: ns, alive: [], skipped: [], stuck: [] };
    },
  });
  await rb.runBoot(PRIMARY, [], t.deps);
  assert(calls === 3 && t.slept.join(",") === "1,2" && t.started.length === 4, "an unreachable remote broker is retried with the bounded backoff");
  assert(t.log.filter((l) => l.includes(`${REMOTE}: attempt`) && l.includes("ETIMEDOUT")).length === 2, "…each failed attempt logged loud with its error");
}
{
  const t = mkDeps({
    start: async (s, ns) => {
      if (s === REMOTE) throw new Error("connect ETIMEDOUT 2027-cotal.fly.dev:4222");
      return { started: ns, alive: [], skipped: [], stuck: [] };
    },
  });
  let err = "";
  try {
    await rb.runBoot(PRIMARY, ["a"], t.deps);
  } catch (e) {
    err = (e as Error).message;
  }
  assert(t.slept.length === 3 && t.log.some((l) => l.includes(`✗ ${REMOTE}: gave up after 4 attempts`)), "after the last retry the space is given up on, loud");
  assert(err.includes(`${REMOTE}: did not come up`) && err.includes(`paw start lizard paw --space ${REMOTE}`), "the job exits non-zero naming who is down and the exact command to finish");
  assert(t.started.some(([s]) => s === PRIMARY), "the other spaces still came back");
  assert(t.restamped.includes(REMOTE), "a failed space's record is re-stamped too (names kept: the keeper only rewrites it once its manager runs)");
}
{
  const t = mkDeps({ start: async (s, ns) => ({ started: [], alive: [], skipped: [], stuck: s === PRIMARY ? [`${ns[0]} is stuck`] : [] }) });
  let err = "";
  try {
    await rb.runBoot(PRIMARY, ["a"], t.deps);
  } catch (e) {
    err = (e as Error).message;
  }
  assert(err.includes("1 agent(s) stuck") && err.includes(`${PRIMARY}: a is stuck`) && t.started.length === 2, "a stuck seat still fails the job loud, after every space ran");
}

console.log("the fleet plist (paw launchd)");
{
  const { fleetJob, fleetJobBoots, renameInFleetArgs, parseLaunchdArgs } = await import("../src/commands/launchd.ts");
  const { parseArgs } = await import("../src/start.ts");
  const job = fleetJob("paw", ["a", "b"], { cli: ["/n", "/paw.ts"], env: {}, log: "/l", cwd: "/c" });
  assert(job.args.join(" ") === "/n /paw.ts start --boot a b --space paw", "install bakes `paw start --boot <names> --space <s>` — the same argv every run (idempotent)");
  assert(fleetJobBoots(job.args) && !fleetJobBoots(["/n", "/paw.ts", "start", "a", "--space", "paw"]), "status can tell an old plist (no --boot) from a new one");
  assert(renameInFleetArgs(job.args, "paw", "a", "z")?.join(" ") === "/n /paw.ts start --boot z b --space paw", "paw rename still rewrites a baked name with --boot present");
  const p = parseArgs(["--boot", "a", "--space", "paw"]);
  assert(p.boot && p.names.join(",") === "a" && p.space === "paw", "paw start parses --boot");
  assert(parseLaunchdArgs(["install", "a"]).names.join(",") === "a", "launchd install's explicit names are unchanged");
  const src = readFileSync(join(import.meta.dirname, "..", "src", "commands", "launchd.ts"), "utf8");
  assert(!/startInterval/.test(src.slice(src.indexOf("export function fleetJob"), src.indexOf("export function webJob"))), "the fleet job still never re-runs on an interval");
}

console.log(failures ? `\n${failures} FAILED` : "\ncheck:reboot passed");
process.exit(failures ? 1 : 0);

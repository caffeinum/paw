/**
 * check:doctor — `paw doctor`, hermetic: every check id against fixtures (exact fact strings), the
 * class-A fixes and their idempotence, the safety guard (doctor never stops, restarts or prunes), the
 * render/JSON shapes, the args, the restart-free rule (no manager-fingerprint input changed) and a CLI
 * smoke under --offline. No network, no real daemons: ps, launchctl, plutil, statfs, the probes and every
 * write a fix makes beyond the fixture tree are injected. PAW_HOME, HOME and COTAL_HOME are fixture dirs,
 * set BEFORE any src module loads. Run: pnpm check:doctor
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync("/tmp/pd-"); // short: the durable tmp dir must fit a socket path (see durableTmpPath)
const HOME = join(ROOT, "h");
const PAW = join(ROOT, "p");
const COTAL = join(HOME, ".cotal");
for (const d of [HOME, PAW, COTAL]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.PAW_HOME = PAW;
process.env.COTAL_HOME = COTAL;
process.env.PAW_SPACE = `test-doctor-${process.pid}`;
process.env.PAW_RELEASE = "dev";
for (const k of ["PAW_SERVER", "CLAUDE_CONFIG_DIR", "PAW_RUNTIME", "NODE_OPTIONS", "TMUX_TMPDIR", "PAW_CONTAINER", "PAW_CLAUDE_TOKEN_FILE", "PAW_MACHINE"]) delete process.env[k];
const REPO = join(import.meta.dirname, "..");

let failures = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}${detail !== undefined ? `\n        got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
assert(homedir() === HOME, "os.homedir() is the fixture HOME (no real ~ is read)");

const dc = await import("../src/doctor-checks.ts");
const doc = await import("../src/doctor.ts");
const locks = await import("../src/doctor-locks.ts");
const lockTs = await import("../src/lock.ts");
const lc = await import("../src/lifecycle.ts");
const rel = await import("../src/release.ts");
type Row = import("../src/doctor-checks.ts").Row;
type DoctorSh = import("../src/doctor-checks.ts").DoctorSh;
type DoctorNet = import("../src/doctor-checks.ts").DoctorNet;
type DoctorCtx = import("../src/doctor-checks.ts").DoctorCtx;

const children: ChildProcess[] = [];
const deadPid = (): number => spawnSync("true").pid!;
const days = (n: number) => n * 86_400_000;
const touch = (p: string, ageMs: number) => {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
};
const sp = (s: string) => join(PAW, "spaces", s);
function space(s: string): string {
  mkdirSync(join(sp(s), "personas"), { recursive: true });
  return sp(s);
}
function wipe(): void {
  for (const d of [PAW, HOME]) for (const e of readdirSync(d)) rmSync(join(d, e), { recursive: true, force: true });
  mkdirSync(join(COTAL, "meshes"), { recursive: true });
}
function persona(s: string, name: string, keys: Record<string, string>): string {
  const file = join(space(s), "personas", `${name}.md`);
  writeFileSync(file, `---\nname: ${name}\n${Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`);
  return file;
}

/** A mutable fake process table. */
let listing: string[] = [];
const realSh = dc.realSh();
function fakeSh(over: Partial<DoctorSh> = {}): DoctorSh {
  return {
    ps: () => listing.join("\n"),
    psCmd: (pid) => {
      const line = listing.find((l) => l.trim().startsWith(`${pid} `));
      return line ? line.trim().split(/\s+/).slice(2).join(" ") : realSh.psCmd(pid);
    },
    psEnv: () => undefined,
    launchctl: () => ({ ok: false, out: "Could not find service" }),
    plutil: (p) => readFileSync(p, "utf8"),
    statfs: () => ({ bavail: (100 * 2 ** 30) / 4096, bsize: 4096, blocks: (1000 * 2 ** 30) / 4096 }),
    nodeVersion: () => "v25.8.2",
    git: () => ({ ok: true, out: "" }),
    tmuxHasSession: () => true,
    containerStatus: async () => ({ timedOut: false, ok: true, out: "apiserver is running" }),
    outsideGui: () => false,
    ...over,
  };
}
const okTrace = (steps: Array<[string, string, number, string?]>) => ({
  host: "h",
  port: 1,
  stepMs: 800,
  steps: steps.map(([step, outcome, ms, code]) => ({ step, outcome, ms, ...(code ? { code } : {}) })),
}) as unknown as import("../src/connect-diag.ts").ConnectTrace;
function fakeNet(over: Partial<DoctorNet> = {}): DoctorNet {
  return {
    diagnose: async () => okTrace([["tcp", "ok", 1], ["info", "ok", 2], ["tls", "not-offered", 0]]),
    managerPs: async () => [],
    presence: async () => ({ kind: "ok" }),
    sweep: async () => ({ retired: [], skipped: [] }),
    ...over,
  };
}
function ctx(over: Partial<DoctorCtx> & { sh?: DoctorSh; net?: DoctorNet } = {}): DoctorCtx {
  return dc.gatherCtx({
    offline: false,
    spaces: [],
    sh: fakeSh(),
    net: fakeNet(),
    nodeBin: () => join(HOME, ".nvm/versions/node/v25.8.2/bin/node"),
    platform: "darwin",
    host: "testhost",
    defaultHome: false,
    cotalHomeSet: true,
    env: { ...process.env },
    ensureMailbox: () => {
      throw new Error("ensureMailbox not expected here");
    },
    kill: () => {
      throw new Error("kill not expected here");
    },
    ...over,
  });
}
const one = (rows: Row[], id: string): Row | undefined => rows.find((r) => r.id === id);
function expectRow(rows: Row[], id: string, status: Row["status"], fact: string, action: "fix" | "command" | "none" | "skipped", msg: string): Row | undefined {
  const r = one(rows, id);
  const kind = r?.fix ? "fix" : r?.skipped ? "skipped" : r?.command ? "command" : "none";
  assert(!!r && r.status === status && r.fact === fact && kind === action, `${id}: ${msg}`, r ? { status: r.status, fact: r.fact, kind } : "no row");
  return r;
}

// ── locks ──────────────────────────────────────────────────────────────────────────────────────────
console.log("locks");
{
  wipe();
  const dir = space("test-l");
  const dead = deadPid();
  writeFileSync(join(dir, "spawn.dead.lock"), String(dead));
  touch(join(dir, "spawn.dead.lock"), days(58));
  let rows = dc.checkSpaceLocks(ctx(), "test-l");
  const r = expectRow(rows, "locks", "warn", `1 stale lock — holder gone: spawn.dead (pid ${dead}, 58d)`, "fix", "a dead holder is stale and fixable");
  writeFileSync(join(dir, "spawn.mine.lock"), String(process.pid));
  writeFileSync(join(dir, "spawn.young.lock"), "");
  const did = await r!.fix!.run();
  assert(did === "removed 1: spawn.dead" && !existsSync(join(dir, "spawn.dead.lock")) && existsSync(join(dir, "spawn.mine.lock")), "fix removes only the dead holder's lock", did);
  rmSync(join(dir, "spawn.young.lock"));
  rows = dc.checkSpaceLocks(ctx(), "test-l");
  expectRow(rows, "locks", "ok", `1 held by pid ${process.pid} (live)`, "none", "a live holder (this process) is kept");
  rmSync(join(dir, "spawn.mine.lock"));
  writeFileSync(join(dir, "lifecycle.lock"), "");
  expectRow(dc.checkSpaceLocks(ctx(), "test-l"), "locks", "ok", "1 held, none stale", "none", "a pidless young lock is kept (mid-write)");
  touch(join(dir, "lifecycle.lock"), lc.LIFECYCLE_LOCK_OPTS.staleMs! + 60_000);
  expectRow(dc.checkSpaceLocks(ctx(), "test-l"), "locks", "warn", `1 stale lock — holder gone: lifecycle (no pid, 10m)`, "fix", "a pidless lock older than the lifecycle stale age is stale");
  rmSync(join(dir, "lifecycle.lock"));
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(sleeper);
  writeFileSync(join(dir, "other.lock"), String(sleeper.pid));
  touch(join(dir, "other.lock"), 120_000);
  expectRow(dc.checkSpaceLocks(ctx(), "test-l"), "locks", "warn", `1 stale lock — holder gone: other (pid ${sleeper.pid} reused, 2m)`, "fix", "a live pid running someone else's program, older than the stale age, is a reused pid");
  rmSync(join(dir, "other.lock"));
  assert(dc.checkSpaceLocks(ctx(), "test-l").length === 0, "no lock files → no locks row");
  const tmp = await import("../src/addressing.ts");
  assert(dc.LOCK_STALE.spawn === tmp.SPAWN_LOCK_OPTS.staleMs && dc.LOCK_STALE.lifecycle === lc.LIFECYCLE_LOCK_OPTS.staleMs, "doctor's stale ages agree with addressing.ts and lifecycle.ts");

  // machine lock
  writeFileSync(join(HOME, ".claude.json.paw-lock"), String(dead));
  touch(join(HOME, ".claude.json.paw-lock"), 3 * 3_600_000);
  expectRow(dc.checkMachineLocks(ctx()), "locks", "warn", `1 stale lock — holder gone: ~/.claude.json.paw-lock (pid ${dead}, 3h) — every spawn's folder pre-trust waits on it`, "fix", "~/.claude.json.paw-lock is a machine row");
  rmSync(join(HOME, ".claude.json.paw-lock"));
  assert(dc.checkMachineLocks(ctx()).length === 0, "no machine lock file → no machine locks row");

  // parity with lock.ts: withFileLock succeeds exactly when doctor calls a lock stale
  const cases: Array<[string, string, number, number]> = [
    ["dead", String(dead), 0, 60_000],
    ["pidless-old", "", 120_000, 60_000],
    ["reused", String(sleeper.pid), 120_000, 60_000],
    ["held", String(process.pid), 0, 60_000],
    ["fresh", "", 0, 60_000],
  ];
  for (const [kind, body, age, staleMs] of cases) {
    const p = join(dir, `parity-${kind}.lock`);
    writeFileSync(p, body);
    if (age) touch(p, age);
    const seen = locks.inspectLock(p, staleMs, Date.now(), (pid) => realSh.psCmd(pid));
    let acquired = false;
    try {
      lockTs.withFileLock(p, () => undefined, { maxWaitMs: 0, staleMs });
      acquired = true;
    } catch {
      acquired = false;
    }
    assert(seen?.kind === kind && acquired === locks.STALE_KINDS.has(seen.kind), `parity: a ${kind} lock — doctor says ${seen?.kind}, lock.ts ${acquired ? "breaks" : "waits on"} it`);
    rmSync(p, { force: true });
  }
}

// ── registry.leftover ──────────────────────────────────────────────────────────────────────────────
console.log("registry.leftover");
{
  wipe();
  listing = [];
  const rec = (space: string, extra: Record<string, unknown>) =>
    writeFileSync(join(COTAL, "meshes", `space.${Buffer.from(space).toString("hex")}.json`), JSON.stringify({ space, server: "nats://127.0.0.1:4222", root: HOME, mode: "open", tlsRequired: false, ts: new Date().toISOString(), ...extra }));
  rec("forktest-1", { storeDir: join(ROOT, "gone-store"), origin: "up" });
  rec("forktest-2", { storeDir: join(ROOT, "gone-store2"), origin: "up" });
  rec("manual-1", { storeDir: join(ROOT, "gone-store3"), origin: "manual" });
  rec("paw", { storeDir: join(ROOT, "gone-store4"), origin: "up" });
  listing = [`900 1 node x --space forktest-2`];
  let rows = dc.checkRegistryLeftover(ctx());
  const r = expectRow(rows, "registry.leftover", "warn", `forktest-1 claims nats://127.0.0.1:4222, but its store is gone and nothing runs it — the next mesh start fails "already in use"`, "fix", "a record whose store is gone and nothing runs is a fixable leftover");
  assert(rows.length === 1, "a live --space, an origin:manual record and paw are never leftovers", rows.map((x) => x.fact));
  const cr = dc.checkRegistry(ctx());
  expectRow(cr, "registry", "ok", "4 meshes in ~/.cotal/meshes (forktest-1, forktest-2, manual-1, paw)", "none", "the registry row lists every usable mesh");
  const gated = dc.checkRegistryLeftover(ctx({ cotalHomeSet: false, defaultHome: false }));
  assert(gated[0]?.skipped === "PAW_HOME is a test home; machine-wide repairs run from ~/.paw" && !gated[0]?.fix, "from a test home without COTAL_HOME the fix is skipped");
  const did = await r!.fix!.run();
  rows = dc.checkRegistryLeftover(ctx());
  assert(did === "dropped forktest-1 from ~/.cotal/meshes" && rows.length === 0, "the fix drops the record", did);
  listing = [];
  mkdirSync(join(ROOT, "s-a"), { recursive: true });
  rmSync(join(COTAL, "meshes"), { recursive: true });
  mkdirSync(join(COTAL, "meshes"));
  rec("shared-a", { storeDir: join(ROOT, "s-a"), origin: "up" });
  rec("shared-b", { storeDir: join(ROOT, "s-a"), origin: "up" });
  rows = dc.checkRegistryLeftover(ctx());
  assert(rows.length === 2 && rows.every((x) => x.fact.includes("beside another record")), "two idle records on one URL are both leftovers", rows.map((x) => x.fact));
  writeFileSync(join(COTAL, "meshes", "space.6e6f.json"), "{nope");
  const bad = dc.checkRegistry(ctx()).filter((x) => x.status === "fail");
  assert(bad.length === 1 && bad[0]!.command === "paw cotal meshes rm no", "an unusable record is a ✕ row naming `paw cotal meshes rm <space>`", bad);
}

// ── daemons.orphan (real sleepers named like a mailbox) ───────────────────────────────────────────
console.log("daemons.orphan");
{
  wipe();
  const binDir = join(ROOT, "fake", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "paw.ts"), "setTimeout(() => {}, 120000);\n");
  const goneHome = join(ROOT, "gone-home");
  const liveHome = join(ROOT, "live-home");
  mkdirSync(liveHome);
  const a = spawn(process.execPath, [join(binDir, "paw.ts"), "mailbox", "--space", "test-doctor-x", "--home", goneHome], { stdio: "ignore" });
  const b = spawn(process.execPath, [join(binDir, "paw.ts"), "mailbox", "--space", "test-doctor-y", "--home", liveHome], { stdio: "ignore" });
  children.push(a, b);
  await new Promise((r) => setTimeout(r, 300));
  const ours = new Set([a.pid, b.pid]);
  const realPs = () => realSh.ps().split("\n").filter((l) => ours.has(Number(l.trim().split(/\s+/)[0]))).join("\n");
  const asked: number[] = [];
  const sh = fakeSh({ ps: realPs, psCmd: (pid) => realSh.psCmd(pid) });
  const kill = (pid: number, sig: NodeJS.Signals) => {
    asked.push(pid);
    if (ours.has(pid)) process.kill(pid, sig);
  };
  const rows = dc.checkDaemonsOrphan(ctx({ sh, defaultHome: true, kill }));
  const r = expectRow(rows, "daemons.orphan", "warn", `mailbox pid ${a.pid} (space test-doctor-x) belongs to PAW_HOME ${goneHome}, which is gone`, "fix", "a mailbox of a deleted PAW_HOME is a fixable orphan");
  assert(rows.length === 1, "a mailbox whose --home exists is not an orphan");
  const gated = dc.checkDaemonsOrphan(ctx({ sh, defaultHome: false, kill }));
  assert(gated.length === 1 && !!gated[0]!.skipped && !gated[0]!.fix, "from a test PAW_HOME the orphan fix is skipped");
  await r!.fix!.run();
  await new Promise((res) => setTimeout(res, 300));
  assert(asked.length === 1 && asked[0] === a.pid && !lockTs.pidAlive(a.pid!) && lockTs.pidAlive(b.pid!), "the fix signals ONLY the orphan; the other mailbox lives", { asked, a: a.pid, b: b.pid });
  b.kill();
}

// ── manager / manager.tmpdir / ui ──────────────────────────────────────────────────────────────────
console.log("manager");
{
  wipe();
  space("test-m");
  const mgr = (pid: number, ppid: number, extra = "") => `${pid} ${ppid} /n/node /x/releases/abc123/bin/cotald.ts supervise --space test-m --server nats://127.0.0.1:4222${extra}`;
  listing = [];
  expectRow(await dc.checkManager(ctx(), "test-m"), "manager", "ok", "not running here — starts on the next paw command", "none", "no manager");
  listing = [mgr(100, 1, " --runtime tmux")];
  expectRow(await dc.checkManager(ctx({ net: fakeNet({ managerPs: async () => ["a", "b"] }) }), "test-m"), "manager", "ok", "pid 100 · tmux · release abc123 · answers (2 agents)", "none", "one answering manager");
  listing = [mgr(100, 1), mgr(101, 100)];
  expectRow(await dc.checkManager(ctx(), "test-m"), "manager", "ok", "pid 100 · pty · release abc123 · answers (0 agents)", "none", "a wrapper+child pair counts as one");
  listing = [mgr(100, 1), mgr(102, 1)];
  expectRow(await dc.checkManager(ctx(), "test-m"), "manager", "fail", "2 managers serve test-m (pids 100, 102) — they fight for the lease", "command", "two independent managers");
  assert(one(await dc.checkManager(ctx(), "test-m"), "manager")!.command === "paw restart --full --space test-m  (bounces every agent in test-m — your go)", "the duplicate's command carries the bounce caveat");
  listing = [`100 1 /u/.bun/bin/bun /x/bin/cotald.ts supervise --space test-m --server nats://127.0.0.1:4222`];
  expectRow(await dc.checkManager(ctx(), "test-m"), "manager", "fail", "pid 100 runs under bun — node-pty breaks every agent", "command", "a manager under bun");
  listing = [mgr(100, 1)];
  writeFileSync(join(sp("test-m"), "manager.log"), "boot\nmanager: already serves space test-m\n");
  expectRow(await dc.checkManager(ctx({ net: fakeNet({ managerPs: async () => { throw new Error("request timeout"); } }) }), "test-m"), "manager", "fail", "pid 100 · pty · release abc123 · isn't answering (no answer in 2s; log: another manager serves this space)", "command", "a manager that doesn't answer names the log's cause");
  expectRow(await dc.checkManager(ctx({ capMs: 100, net: fakeNet({ managerPs: () => new Promise(() => {}) }) }), "test-m"), "manager", "fail", "pid 100 · pty · release abc123 · isn't answering (no answer in 0.1s; log: another manager serves this space)", "command", "a hung manager is capped, never ok");
  expectRow(await dc.checkManager(ctx({ offline: true }), "test-m"), "manager", "ok", "pid 100 · pty · release abc123 · answer not checked (--offline)", "none", "--offline doesn't probe");
  const env = (tmp: string) => fakeSh({ psEnv: () => `${mgr(100, 1).split(" ").slice(2).join(" ")} PATH=/bin TMPDIR=${tmp}` });
  expectRow(dc.checkManagerTmpdir(ctx({ sh: env("/var/folders/x1/T/") }), "test-m"), "manager.tmpdir", "warn", "manager pid 100 runs with TMPDIR=/var/folders/x1/T/ — a disk-full purge strands every seat", "command", "a purgeable TMPDIR");
  assert(dc.checkManagerTmpdir(ctx({ sh: env(lc.durableTmpPath()) }), "test-m").length === 0, "a durable TMPDIR → no row");
  listing = [mgr(100, 1, " --runtime tmux")];
  expectRow(dc.checkUi(ctx({ sh: fakeSh({ tmuxHasSession: () => false }) }), "test-m"), "ui", "warn", "no cotal-test-m session on the default tmux socket — paw attach can't find the agents", "none", "a missing tmux session");
  expectRow(dc.checkUi(ctx(), "test-m"), "ui", "ok", "tmux session cotal-test-m on the default socket", "none", "the tmux session is there");
  expectRow(dc.checkUi(ctx({ env: { ...process.env, TMUX_TMPDIR: "/x" } }), "test-m"), "ui", "warn", "your shell sets TMUX_TMPDIR=/x; paw's sessions are on the default socket", "command", "a shell TMUX_TMPDIR");
}

// ── mailbox ────────────────────────────────────────────────────────────────────────────────────────
console.log("mailbox");
{
  wipe();
  space("test-mb");
  listing = [`200 1 /n/node /x/bin/paw.ts mailbox --space test-mb --home /other/home`];
  expectRow(dc.checkMailbox(ctx(), "test-mb"), "mailbox", "fail", `pid 200 belongs to PAW_HOME /other/home — two homes on one space mint two "you" peers`, "command", "another home's mailbox is ✕, never auto-fixed");
  listing = [`200 1 /n/node /x/bin/paw.ts mailbox --space test-mb --home ${PAW}`];
  expectRow(dc.checkMailbox(ctx(), "test-mb"), "mailbox", "ok", "pid 200, this PAW_HOME", "none", "our own mailbox");
  listing = [];
  expectRow(dc.checkMailbox(ctx(), "test-mb"), "mailbox", "ok", "not running (nothing needs it)", "none", "no mailbox, nothing needs one");
  listing = [`100 1 /n/node /x/releases/r/bin/cotald.ts supervise --space test-mb --server nats://127.0.0.1:4222`];
  const called: string[] = [];
  const c = ctx({
    ensureMailbox: (s) => {
      called.push(s);
      listing.push(`300 1 /n/node /x/bin/paw.ts mailbox --space ${s} --home ${PAW}`);
    },
  });
  const r = expectRow(dc.checkMailbox(c, "test-mb"), "mailbox", "warn", "no mailbox — replies to you have no host", "fix", "a manager with no mailbox is fixable");
  const did = await r!.fix!.run();
  assert(called.join() === "test-mb" && did === `started the "you" mailbox (pid 300)`, "the fix calls ensureMailbox for the space (injected — nothing really spawns)", did);
  listing = [];
  mkdirSync(join(sp("test-mb"), "sleep"));
  writeFileSync(join(sp("test-mb"), "sleep", "aws.json"), JSON.stringify({ name: "aws", folder: "/x", since: 1, cursorSeq: 1, reason: "idle" }));
  expectRow(dc.checkMailbox(ctx(), "test-mb"), "mailbox", "warn", "no mailbox — replies to you (and wakes of 1 sleeping agent) have no host", "fix", "a sleeper needs the mailbox too");
}

// ── release ────────────────────────────────────────────────────────────────────────────────────────
console.log("release");
{
  wipe();
  listing = [];
  expectRow(dc.checkRelease(ctx({ env: { ...process.env, PAW_RELEASE: "dev" } })), "release", "warn", "PAW_RELEASE=dev — daemons start from the checkout", "command", "PAW_RELEASE=dev");
  delete process.env.PAW_RELEASE;
  expectRow(dc.checkRelease(ctx({ env: { ...process.env } })), "release", "fail", "no release pinned — daemons can't start", "command", "nothing pinned");
  expectRow(dc.checkRelease(ctx({ env: { ...process.env, PAW_RELEASE: "nope" } })), "release", "fail", `PAW_RELEASE=nope but ${rel.releasePath("nope")} is gone`, "command", "a pin that's gone from disk");
  const dir = rel.releasesDir();
  mkdirSync(join(dir, "r1"), { recursive: true });
  symlinkSync("r1", join(dir, "current"));
  touch(join(dir, "r1"), days(5));
  expectRow(dc.checkRelease(ctx({ env: { ...process.env } })), "release", "ok", "current r1 (5d)", "none", "the current release");
  process.env.PAW_RELEASE = "dev";
  mkdirSync(join(dir, `.staging-r2-${deadPid()}`));
  mkdirSync(join(dir, `.staging-r3-${process.pid}`));
  const st = dc.checkReleaseStaging(ctx());
  const r = expectRow(st, "release.staging", "warn", `1 torn release snapshot (${readdirSync(dir).find((n) => n.startsWith(".staging-r2"))})`, "fix", "a staging dir whose writer is dead is torn; a live one isn't");
  await r!.fix!.run();
  assert(!readdirSync(dir).some((n) => n.startsWith(".staging-r2")) && existsSync(join(dir, `.staging-r3-${process.pid}`)), "the fix removes only the torn snapshot");
  rmSync(join(dir, `.staging-r3-${process.pid}`), { recursive: true });
  expectRow(dc.checkReleaseCount(ctx()), "release.count", "ok", "1 release on disk (0 in use)", "none", "few releases");
  for (let i = 2; i <= 12; i++) mkdirSync(join(dir, `r${i}`));
  listing = [`400 1 /n/node ${dir}/r1/bin/paw.ts mailbox --space test-r --home ${PAW}`];
  expectRow(dc.checkReleaseCount(ctx()), "release.count", "warn", "12 releases on disk (1 in use, current kept)", "command", "more than 10 releases");
  listing = [`400 1 /n/node ${dir}/gone1/bin/cotald.ts supervise --space test-r --server nats://127.0.0.1:4222`, `401 1 /n/node ${dir}/gone2/bin/paw.ts mailbox --space test-r --home ${PAW}`];
  const iu = dc.checkReleaseInUse(ctx());
  assert(iu.length === 2 && iu[0]!.fact === "pid 400 runs release gone1, which is gone from disk" && iu[0]!.command === "paw restart --full --space test-r  (bounces every agent in test-r — your go)" && iu[1]!.command === "paw restart --space test-r", "a process on a deleted release: the command by kind", iu);
  listing = [];
  assert(dc.checkReleaseInUse(ctx()).length === 0, "nothing on a deleted release → no row");
}

// ── launchd ────────────────────────────────────────────────────────────────────────────────────────
console.log("launchd");
{
  wipe();
  const la = join(HOME, "Library", "LaunchAgents");
  mkdirSync(la, { recursive: true });
  const shim = join(HOME, ".paw", "bin", "paw-fleet");
  const plist = (label: string, args: string[]) => writeFileSync(join(la, `${label}.plist`), JSON.stringify({ Label: label, ProgramArguments: args }));
  expectRow(dc.checkLaunchdFleet(ctx()), "launchd.fleet", "warn", "no login job — after a reboot nothing comes back", "command", "no fleet job");
  plist("dev.cotal.paw", [shim, join(REPO, "bin", "paw.ts"), "start", "--boot", "a", "b", "--space", "paw"]);
  expectRow(dc.checkLaunchdFleet(ctx()), "launchd.fleet", "fail", "dev.cotal.paw runs ~/.paw/bin/paw-fleet, which is missing — nothing starts at login", "command", "the shim is missing");
  mkdirSync(join(HOME, ".paw", "bin"), { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  expectRow(dc.checkLaunchdFleet(ctx()), "launchd.fleet", "ok", "dev.cotal.paw: paw start --boot (2 agents in paw) at login", "none", "a current fleet job");
  writeFileSync(shim, `#!/bin/sh\nexport NVM_DIR="${join(HOME, ".nvm")}"\n. "$NVM_DIR/nvm.sh" --no-use\n`, { mode: 0o755 });
  expectRow(dc.checkLaunchdFleet(ctx()), "launchd.fleet", "fail", "dev.cotal.paw runs ~/.nvm/nvm.sh, which is missing — nothing starts at login", "command", "an nvm shim whose nvm.sh is gone");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  plist("dev.cotal.paw", [shim, join(REPO, "bin", "paw.ts"), "start", "a", "--space", "paw"]);
  expectRow(dc.checkLaunchdFleet(ctx()), "launchd.fleet", "warn", "the fleet job predates paw start --boot — after a reboot only paw comes back", "command", "an old plist without --boot");
  expectRow(dc.checkLaunchdWeb(ctx()), "launchd.web", "ok", "dev.cotal.paw-web: not installed", "none", "no web job is a fact");
  plist("dev.cotal.paw-web", [shim, "x", "web", "--space", "paw"]);
  const lctl = (out: string) => fakeSh({ launchctl: () => ({ ok: true, out }) });
  expectRow(dc.checkLaunchdWeb(ctx({ sh: lctl("state = not running\n\tlast exit code = 1\n") })), "launchd.web", "warn", "dev.cotal.paw-web: loaded, idle (last exit 1) — paw web is down", "command", "web loaded but idle");
  assert(one(dc.checkLaunchdWeb(ctx({ sh: lctl("last exit code = 1") })), "launchd.web")!.command === `launchctl kickstart -k gui/${process.getuid!()}/dev.cotal.paw-web  (log: ${PAW}/spaces/paw/launchd-web.log)`, "the web command names kickstart and the log");
  expectRow(dc.checkLaunchdWeb(ctx({ sh: lctl("pid = 812\n") })), "launchd.web", "ok", "dev.cotal.paw-web: running (pid 812)", "none", "web running");
  plist("dev.cotal.paw-global", [shim, "x", "global", "--space", "paw"]);
  expectRow(dc.checkLaunchdGlobal(ctx()), "launchd.global", "warn", "dev.cotal.paw-global is installed but not loaded — global can stay down", "command", "global installed but not loaded");
  expectRow(dc.checkLaunchdGlobal(ctx({ sh: lctl("last exit code = 0\n") })), "launchd.global", "ok", "dev.cotal.paw-global: every 60s, last exit 0", "none", "global healthy");
  expectRow(dc.checkLaunchdGlobal(ctx({ sh: lctl("last exit code = 1\n") })), "launchd.global", "warn", "dev.cotal.paw-global: every 60s, last exit 1", "command", "global failing");
  assert(dc.checkLaunchdFleet(ctx({ platform: "linux" })).length === 0, "launchd rows don't apply off macOS");
}

// ── remote space: broker / signer / name / chat-inboxes ───────────────────────────────────────────
console.log("remote");
{
  wipe();
  const signerRoot = join(ROOT, "signer");
  mkdirSync(join(signerRoot, ".cotal", "auth"), { recursive: true });
  space("test-rm");
  writeFileSync(join(sp("test-rm"), "remote-mesh.json"), JSON.stringify({ space: "test-rm", server: "tls://broker.example:4222", root: signerRoot, ts: new Date().toISOString() }));
  const rec = (await import("../src/remote-mesh.ts")).readRemoteMesh("test-rm")!;
  let expected = "";
  try {
    (await import("../src/signer-root.ts")).checkSignerRoot("test-rm", signerRoot);
  } catch (e) {
    expected = (e as Error).message.replace(/^paw: /, "");
  }
  expectRow(dc.checkSigner(ctx(), "test-rm", rec), "signer", "fail", expected, "none", "no signer → checkSignerRoot's own message");
  writeFileSync(join(signerRoot, ".cotal", "auth", "auth.json"), "{}", { mode: 0o644 });
  chmodSync(join(signerRoot, ".cotal", "auth", "auth.json"), 0o644);
  const r = expectRow(dc.checkSigner(ctx(), "test-rm", rec), "signer", "warn", "auth.json is 0644 — a bearer secret readable by others", "fix", "a world-readable signer");
  await r!.fix!.run();
  assert((statSync(join(signerRoot, ".cotal", "auth", "auth.json")).mode & 0o777) === 0o600, "the fix chmods it 600");
  expectRow(dc.checkName(ctx(), "test-rm", rec), "name", "warn", `you are "you" there — a shared broker needs one name per machine`, "command", "no human name");
  assert(one(dc.checkName(ctx(), "test-rm", rec), "name")!.command === "paw mesh set test-rm --as testhost  (running daemons keep the old name until a restart)", "the name command uses this machine's label");
  expectRow(dc.checkName(ctx(), "test-rm", { ...rec, human: "aleks-macbook" }), "name", "ok", `you are "aleks-macbook" there`, "none", "a human name");
  const refused = fakeNet({ diagnose: async () => okTrace([["dns", "ok", 1], ["tcp", "error", 2, "ECONNREFUSED"]]) });
  expectRow(await dc.checkBroker(ctx({ net: refused }), "test-rm"), "broker", "fail", "tls://broker.example:4222: connection refused — nothing listens there (the mesh server is down, or the port in `paw mesh ls` is wrong)", "none", "a refused remote broker");
  const tlsOk = fakeNet({ diagnose: async () => okTrace([["dns", "ok", 12], ["tcp", "ok", 41], ["info", "ok", 5], ["tls", "ok", 96]]) });
  expectRow(await dc.checkBroker(ctx({ net: tlsOk }), "test-rm"), "broker", "ok", "answers over TLS (dns 12ms · tcp 41ms · tls 96ms)", "none", "a remote broker over TLS");
  space("test-loc");
  expectRow(await dc.checkBroker(ctx(), "test-loc"), "broker", "ok", "answers (3ms)", "none", "a local broker");
  expectRow(await dc.checkBroker(ctx({ net: refused }), "test-loc"), "broker", "ok", "down — starts on the next paw command", "none", "a local broker down with no manager is a fact");
  listing = [`100 1 /n/node /x/bin/cotald.ts supervise --space test-loc --server nats://127.0.0.1:4222`];
  expectRow(await dc.checkBroker(ctx({ net: refused }), "test-loc"), "broker", "fail", "nats://127.0.0.1:4222: connection refused — the manager here has no broker", "command", "a local broker down under a running manager");
  assert((await dc.checkBroker(ctx({ offline: true }), "test-loc")).length === 0, "--offline omits the broker row");
  expectRow(await dc.checkPresence(ctx({ net: fakeNet({ presence: async () => ({ kind: "latched", bucket: "b", waitedMs: 1500 }) }) }), "test-loc"), "presence", "fail", "presence writes time out (latched) — agents can't come online", "command", "a latched presence store");
  expectRow(await dc.checkPresence(ctx(), "test-loc"), "presence", "ok", "presence writes land", "none", "presence writes land");
  expectRow(await dc.checkPresence(ctx({ net: fakeNet({ presence: async () => ({ kind: "unknown", message: "ECONNRESET socket hang up" }) }) }), "test-loc"), "presence", "warn", "presence probe: hung up", "none", "an unknown presence failure uses the reason word");
  listing = [];

  // chat-inboxes
  const inbox = join(sp("test-rm"), "chat-inboxes");
  mkdirSync(inbox);
  const dead = deadPid();
  const entry = (pid: number) => JSON.stringify({ pid, server: rec.server, channels: [], startedAt: 1 });
  writeFileSync(join(inbox, "u1.json"), entry(process.pid));
  expectRow(dc.checkChatInboxes(ctx(), "test-rm"), "chat-inboxes", "ok", "1 chat inbox, all held by running chats", "none", "every chat inbox held");
  writeFileSync(join(inbox, "u2.json"), entry(dead));
  const swept: string[] = [];
  const c = ctx({ net: fakeNet({ sweep: async (s) => (swept.push(s), { retired: ["u2"], skipped: ["u1"] }) }) });
  const ir = expectRow(dc.checkChatInboxes(c, "test-rm"), "chat-inboxes", "warn", `1 chat inbox left on the broker by dead chats (pid ${dead})`, "fix", "a dead chat's inbox is fixable");
  const did = await ir!.fix!.run();
  assert(swept.join() === "test-rm" && did === "retired 1, 1 held by running chats", "the fix sweeps the space once", { swept, did });
  const off = dc.checkChatInboxes(ctx({ offline: true }), "test-rm");
  assert(off[0]?.skipped === "(--offline)" && !off[0]?.fix, "--offline skips the sweep");
}

// ── agents.folder / frozen / pins ─────────────────────────────────────────────────────────────────
console.log("agents.folder, frozen, pins");
{
  wipe();
  listing = [];
  const here = join(ROOT, "folder-a");
  mkdirSync(here, { recursive: true });
  persona("test-ag", "a", { cwd: here });
  expectRow(await dc.checkAgentsFolder(ctx(), "test-ag"), "agents.folder", "ok", "1 agent, every folder present", "none", "every folder present");
  persona("test-ag", "b", { cwd: "/nonexistent/repo/.claude/worktrees/agent-1" });
  persona("test-ag", "c", { cwd: "/nonexistent/x" });
  const r = expectRow(await dc.checkAgentsFolder(ctx(), "test-ag"), "agents.folder", "warn", "2 agents' folders are gone (1 under .claude/worktrees) — paw status shows them ⚠", "command", "folder-gone agents");
  assert(r!.items!.length === 2 && r!.items![0]!.startsWith("paw rm b#test-ag"), "items name one `paw rm` per agent", r?.items);
  listing = [`100 1 /n/node /x/bin/cotald.ts supervise --space test-ag --server nats://127.0.0.1:4222`];
  expectRow(await dc.checkAgentsFolder(ctx({ net: fakeNet({ managerPs: async () => ["b"] }) }), "test-ag"), "agents.folder", "warn", "1 agent's folder is gone — paw status shows it ⚠", "command", "an agent the manager runs is not counted gone");
  listing = [];

  // the 2026-11-11 replica: a teleported copy whose pinned session was written here after it left
  const pin = "2ac38184-6e52-4eb9-a6d3-d3539a98c438";
  persona("test-fz", "tracepaper", { cwd: here, teleported: "ssh:mini", teleportedAt: "2026-10-23T17:04:15.118Z", resume: pin });
  const tdir = join(HOME, ".claude", "projects", "-slug");
  mkdirSync(tdir, { recursive: true });
  const tfile = join(tdir, `${pin}.jsonl`);
  writeFileSync(tfile, "{}\n");
  const at = (iso: string) => utimesSync(tfile, new Date(iso), new Date(iso));
  at("2026-11-10T12:00:00Z");
  const fz = expectRow(dc.checkFrozen(ctx(), "test-fz"), "frozen", "warn", "tracepaper → ssh:mini (2026-10-23), but its session 2ac38184 was written here 2026-11-10 — one session continued on two machines", "command", "a frozen copy written here after it left");
  assert(/^paw teleport tracepaper#test-fz --back {2}— or paw adopt .*folder-a, which makes tracepaper-.* here \(your call\)$/.test(fz?.command ?? ""), "its command offers --back or adopt under this machine's name", fz?.command);
  at("2026-10-20T12:00:00Z");
  expectRow(dc.checkFrozen(ctx(), "test-fz"), "frozen", "ok", "1 teleported away (tracepaper → ssh:mini) — none written here since", "none", "a frozen copy untouched since");

  // pins: the frozen copy is skipped; two live personas on one pin are ✕
  expectRow(dc.checkPins(ctx()), "pins", "ok", "no session pinned by two agents", "none", "no pin shared");
  persona("test-pin", "x", { cwd: here, resume: pin });
  persona("test-pin", "y", { cwd: here, resume: pin });
  expectRow(dc.checkPins(ctx()), "pins", "fail", "session 2ac38184 is pinned by x#test-pin and y#test-pin — two writers on one transcript", "command", "two personas on one pin");
}

// ── sleep / empty ──────────────────────────────────────────────────────────────────────────────────
console.log("sleep, empty");
{
  wipe();
  const sd = join(space("test-sl"), "sleep");
  mkdirSync(sd);
  writeFileSync(join(sd, "aws.json"), JSON.stringify({ name: "aws", folder: "/x", since: 1, cursorSeq: 1, reason: "idle" }));
  expectRow(dc.checkSleep(ctx(), "test-sl"), "sleep", "ok", "1 asleep (aws)", "none", "a sleeper");
  writeFileSync(join(sd, "research.json"), JSON.stringify({ name: "research", folder: "/x", since: 1, cursorSeq: 1, reason: "idle", wakeFailures: 3, lastError: "boom" }));
  expectRow(dc.checkSleep(ctx(), "test-sl"), "sleep", "warn", "wake failed: research (3×)", "command", "a failed wake");
  assert(one(dc.checkSleep(ctx(), "test-sl"), "sleep")!.command === "paw start research --space test-sl", "the failed wake's command");
  writeFileSync(join(sd, "bad.json"), "{");
  expectRow(dc.checkSleep(ctx(), "test-sl"), "sleep", "fail", "sleep record corrupt: bad.json", "none", "a corrupt sleep record");
  space("team20278");
  expectRow(dc.checkEmpty(ctx(), "team20278"), "empty", "warn", "nothing lives here — no agents, no daemons, no mesh record (a mistyped space?)", "command", "a mistyped space");
  assert(one(dc.checkEmpty(ctx(), "team20278"), "empty")!.command === `rm -r ${sp("team20278")}  (doctor never deletes a space)`, "the empty-space command");
  space("paw");
  assert(dc.checkEmpty(ctx(), "paw").length === 0, "paw is never empty");
}

// ── cmux / container ──────────────────────────────────────────────────────────────────────────────
console.log("cmux, container");
{
  wipe();
  listing = [];
  assert(dc.checkCmux(ctx()).length === 0, "cmux not in use → no row");
  const cfg = join(HOME, ".config", "cmux");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "cmux.json"), `{\n  // "socketControlMode": "fullOpenAccess",\n  "automation": { "socketControlMode": "cmuxOnly" }\n}\n`);
  const cm = ctx({ env: { ...process.env, PAW_RUNTIME: "cmux" } });
  expectRow(dc.checkCmux(cm), "cmux", "warn", "cmux automation is cmuxOnly (default) — it rejects paw's detached manager", "command", "a commented-out fullOpenAccess doesn't count");
  writeFileSync(join(cfg, "cmux.json"), `{ "automation": { "socketControlMode": "fullOpenAccess" } }\n`);
  expectRow(dc.checkCmux(cm), "cmux", "ok", "cmux automation: fullOpenAccess", "none", "fullOpenAccess");

  assert(dc.checkContainerRoot(ctx()).length === 0 && (await dc.checkContainerApiserver(ctx())).length === 0 && dc.checkContainerToken(ctx()).length === 0, "no sandboxed persona, no apiserver plist → no container rows");
  const good = join(ROOT, "good");
  mkdirSync(join(good, "bin"), { recursive: true });
  mkdirSync(join(good, "libexec", "container", "plugins", "container-network-vmnet"), { recursive: true });
  writeFileSync(join(good, "bin", "container"), "#!/bin/sh\n", { mode: 0o755 });
  const bad = join(ROOT, "bad");
  mkdirSync(bad, { recursive: true });
  const plistDir = join(HOME, "Library", "Application Support", "com.apple.container", "apiserver");
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(join(plistDir, "apiserver.json"), JSON.stringify({ Label: "x", EnvironmentVariables: { CONTAINER_INSTALL_ROOT: bad } }));
  execFileSync("plutil", ["-convert", "xml1", "-o", join(plistDir, "apiserver.plist"), join(plistDir, "apiserver.json")]);
  const cc = ctx({ env: { ...process.env, PAW_CONTAINER: join(good, "bin", "container") } });
  const cr = expectRow(dc.checkContainerRoot(cc), "container.root", "fail", `apiserver registered with CONTAINER_INSTALL_ROOT=${bad}, which has no container-network-vmnet — every container call times out`, "command", "an apiserver on a root without the network plugin");
  const real = realpathSync(good);
  assert(cr?.command === `${join(real, "bin", "container")} system stop; ${join(real, "bin", "container")} system start --install-root ${real}`, "the command is diagnoseInstallRoot's own", cr?.command);
  const ap = ctx({ env: cc.env, sh: fakeSh({ containerStatus: async () => ({ timedOut: false, ok: false, out: "apiserver is not running" }) }) });
  expectRow(await dc.checkContainerApiserver(ap), "container.apiserver", "warn", "apiserver isn't running (after a reboot?) — paw starts it on the next sandboxed wake", "command", "a stopped apiserver");
  expectRow(await dc.checkContainerApiserver(cc), "container.apiserver", "ok", "apiserver running", "none", "a running apiserver");
  persona("test-sb", "boxed", { cwd: ROOT, sandbox: "container" });
  expectRow(dc.checkContainerToken(ctx({ env: { ...process.env, PAW_CLAUDE_TOKEN_FILE: join(ROOT, "no-token") } })), "container.token", "fail", `a sandboxed claude signs in with your Claude OAuth token, and ${join(ROOT, "no-token")} does not exist — \`claude setup-token\`, save the token there, chmod 600`, "command", "a sandboxed agent with no token file");
  writeFileSync(join(ROOT, "tok"), "t", { mode: 0o600 });
  chmodSync(join(ROOT, "tok"), 0o600);
  expectRow(dc.checkContainerToken(ctx({ env: { ...process.env, PAW_CLAUDE_TOKEN_FILE: join(ROOT, "tok") } })), "container.token", "ok", `token file ${join(ROOT, "tok")} (0600)`, "none", "the token file");
}

// ── disk / node / node-options / tmpdir / env.space / worktrees ──────────────────────────────────
console.log("disk, node, node-options, tmpdir, env.space, worktrees");
{
  wipe();
  const sf = (g: number) => fakeSh({ statfs: () => ({ bavail: (g * 2 ** 30) / 4096, bsize: 4096, blocks: (100 * 2 ** 30) / 4096 }) });
  expectRow(dc.checkDisk(ctx({ sh: sf(1.5) })), "disk", "fail", `1.5 GiB free where ${PAW} lives — a full disk latched presence and took the fleet down (2026-10-13)`, "command", "1.5 GiB free");
  expectRow(dc.checkDisk(ctx({ sh: sf(5) })), "disk", "warn", `5.0 GiB free where ${PAW} lives — a full disk latched presence and took the fleet down (2026-10-13)`, "command", "5 GiB free");
  expectRow(dc.checkDisk(ctx({ sh: sf(38) })), "disk", "ok", `38 GiB free (62% used) where ${PAW} lives`, "none", "plenty free");
  expectRow(dc.checkNode(ctx()), "node", "ok", "~/.nvm/versions/node/v25.8.2/bin/node (v25.8.2, native TS)", "none", "nvm node");
  expectRow(dc.checkNode(ctx({ nodeBin: () => "/opt/homebrew/bin/node" })), "node", "warn", "daemons' node is Homebrew's (/opt/homebrew/bin/node) — a brew upgrade deletes it under running jobs", "command", "brew node");
  expectRow(dc.checkNode(ctx({ sh: fakeSh({ nodeVersion: () => "v22.3.0" }) })), "node", "warn", "node v22.3.0 can't strip types — the CLI falls back to tsx (slow)", "command", "an old node");
  expectRow(dc.checkNode(ctx({ nodeBin: () => { throw new Error("paw: can't find a node binary"); } })), "node", "fail", "can't find a node binary", "command", "no node");
  expectRow(dc.checkNodeOptions(ctx({ env: { ...process.env, NODE_OPTIONS: "--import /nope.mjs" } })), "node-options", "warn", "NODE_OPTIONS preloads a missing file: /nope.mjs — daemons drop it; every other node errors", "command", "a stale preload");
  expectRow(dc.checkNodeOptions(ctx({ env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" } })), "node-options", "ok", "NODE_OPTIONS preloads all present", "none", "no stale preload");
  assert(dc.checkNodeOptions(ctx()).length === 0, "no NODE_OPTIONS → no row");
  expectRow(dc.checkEnvSpace(ctx({ env: { ...process.env, PAW_SPACE: "" } })), "env.space", "fail", "PAW_SPACE is set but empty — every paw verb refuses", "command", "an empty PAW_SPACE");
  expectRow(dc.checkEnvSpace(ctx({ env: { ...process.env, PAW_SPACE: "team2027" } })), "env.space", "ok", "PAW_SPACE=team2027 in this shell — bare verbs act there", "none", "PAW_SPACE set");
  const tmp = join(PAW, "tmp");
  assert(lc.durableTmpPath() === tmp, "durableTmpPath under a short PAW_HOME is $PAW_HOME/tmp");
  const t = expectRow(dc.checkTmpdir(ctx()), "tmpdir", "warn", `${tmp} is missing — daemons create it on start`, "fix", "a missing tmp dir");
  await t!.fix!.run();
  assert((statSync(tmp).mode & 0o777) === 0o700, "the fix creates it 0700");
  assert(lc.durableTmpPath() === lc.daemonTmpDir(), "durableTmpPath() === daemonTmpDir() (short PAW_HOME)");
  chmodSync(tmp, 0o755);
  const t2 = expectRow(dc.checkTmpdir(ctx()), "tmpdir", "warn", `${tmp} is 0755 — seat control tokens live there`, "fix", "a loose tmp dir");
  await t2!.fix!.run();
  expectRow(dc.checkTmpdir(ctx()), "tmpdir", "ok", `${tmp}, durable (0700, 0 entries)`, "none", "a durable tmp dir");
  const long = join(ROOT, "x".repeat(90));
  process.env.PAW_HOME = long;
  const fallback = lc.durableTmpPath();
  const made = lc.daemonTmpDir();
  assert(fallback === made && fallback.startsWith(`/tmp/paw-${process.getuid!()}/`), "durableTmpPath() === daemonTmpDir() (over-long PAW_HOME → /tmp fallback)", { fallback, made });
  rmSync(made, { recursive: true, force: true });
  process.env.PAW_HOME = PAW;
  const repo = join(PAW, "repos", "acme", "widget");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(PAW, "repos", "acme", "widget.worktrees"));
  expectRow(dc.checkWorktrees(ctx()), "worktrees", "ok", "1 paw clone, no prunable worktrees", "none", "a clean clone");
  expectRow(dc.checkWorktrees(ctx({ sh: fakeSh({ git: () => ({ ok: true, out: "worktree /a\nprunable gitdir file points to non-existent location\n\nworktree /b\nprunable x\n" }) }) })), "worktrees", "warn", "acme/widget: 2 worktrees whose dir is gone", "command", "prunable worktrees");
}

// ── a thrown check is a ✕ row; the rest still render ─────────────────────────────────────────────
console.log("a check that throws");
{
  wipe();
  listing = [];
  space("test-th");
  persona("test-th", "a", { cwd: ROOT });
  chmodSync(join(sp("test-th"), "personas"), 0o000);
  const rows = await dc.spaceChecks(ctx({ offline: true, spaces: ["test-th"] }), "test-th");
  chmodSync(join(sp("test-th"), "personas"), 0o755);
  const bad = one(rows, "agents.folder");
  assert(bad?.status === "fail" && bad.fact.startsWith("check failed: EACCES"), "an unreadable personas dir is `✕ check failed: …`", bad);
  assert(one(rows, "manager")?.status === "ok", "…and the other rows still come back");
}

// ── fix idempotence + safety: every class-A fault at once ─────────────────────────────────────────
console.log("--fix: every class-A fault, twice");
{
  wipe();
  listing = [];
  const dead = deadPid();
  // locks, machine lock, staging, registry leftover, signer mode, chat inbox, missing mailbox, orphan mailbox
  const s = space("test-fix");
  writeFileSync(join(s, "spawn.x.lock"), String(dead));
  writeFileSync(join(HOME, ".claude.json.paw-lock"), String(dead));
  mkdirSync(join(rel.releasesDir(), `.staging-r-${dead}`), { recursive: true });
  writeFileSync(join(COTAL, "meshes", `space.${Buffer.from("forktest-9").toString("hex")}.json`), JSON.stringify({ space: "forktest-9", server: "nats://127.0.0.1:4222", root: HOME, mode: "open", tlsRequired: false, storeDir: join(ROOT, "gone"), origin: "up", ts: new Date().toISOString() }));
  const signerRoot = join(ROOT, "signer2");
  mkdirSync(join(signerRoot, ".cotal", "auth"), { recursive: true });
  writeFileSync(join(signerRoot, ".cotal", "auth", "auth.json"), "{}");
  chmodSync(join(signerRoot, ".cotal", "auth", "auth.json"), 0o644);
  space("test-fixr");
  writeFileSync(join(sp("test-fixr"), "remote-mesh.json"), JSON.stringify({ space: "test-fixr", server: "tls://b.example:4222", root: signerRoot, human: "m", ts: "2026-11-11T00:00:00Z" }));
  mkdirSync(join(sp("test-fixr"), "chat-inboxes"));
  writeFileSync(join(sp("test-fixr"), "chat-inboxes", "u.json"), JSON.stringify({ pid: dead, server: "tls://b.example:4222", channels: [], startedAt: 1 }));
  listing = [`100 1 /n/node /x/releases/r/bin/cotald.ts supervise --space test-fix --server nats://127.0.0.1:4222`, `500 1 /n/node /x/bin/paw.ts mailbox --space test-gone --home ${join(ROOT, "nohome")}`];
  const effects: string[] = [];
  const make = (o: { offline: boolean; spaces: string[] }) =>
    ctx({
      ...o,
      defaultHome: true,
      env: { ...process.env, PAW_RELEASE: "dev" },
      ensureMailbox: (sp2) => {
        effects.push(`mailbox ${sp2}`);
        listing.push(`300 1 /n/node /x/bin/paw.ts mailbox --space ${sp2} --home ${PAW}`);
      },
      kill: (pid) => {
        effects.push(`kill ${pid}`);
        listing = listing.filter((l) => !l.startsWith(`${pid} `));
      },
      net: fakeNet({
        diagnose: async () => okTrace([["dns", "ok", 1], ["tcp", "ok", 1], ["info", "ok", 1], ["tls", "ok", 1]]),
        managerPs: async () => [],
        sweep: async (sp2) => {
          effects.push(`sweep ${sp2}`);
          rmSync(join(sp(sp2), "chat-inboxes", "u.json"));
          return { retired: ["u"], skipped: [] };
        },
      }),
    });
  const before = await doc.runDoctor({ fix: false, offline: false, verbose: false, json: false }, { makeCtx: make });
  const fixable = before.rows.filter((r) => r.fix).map((r) => `${r.space ?? ""}/${r.id}`).sort();
  assert(
    JSON.stringify(fixable) === JSON.stringify(["/daemons.orphan", "/locks", "/registry.leftover", "/release.staging", "/tmpdir", "test-fix/locks", "test-fix/mailbox", "test-fixr/chat-inboxes", "test-fixr/signer"]),
    "the fixture carries every class-A fault",
    fixable,
  );
  const first = await doc.runDoctor({ fix: true, offline: false, verbose: false, json: false }, { makeCtx: make });
  assert(first.fixed.length === 9 && first.fixed.every((f) => f.error === undefined), "the first --fix applies all nine", first.fixed);
  assert(
    !existsSync(join(s, "spawn.x.lock")) && !existsSync(join(HOME, ".claude.json.paw-lock")) && !readdirSync(rel.releasesDir()).some((n) => n.startsWith(".staging")) &&
      !readdirSync(join(COTAL, "meshes")).length && (statSync(join(signerRoot, ".cotal", "auth", "auth.json")).mode & 0o777) === 0o600 && existsSync(join(PAW, "tmp")) &&
      effects.sort().join() === ["kill 500", "mailbox test-fix", "sweep test-fixr"].sort().join(),
    "each fix's effect landed (and only those signals/spawns)",
    effects,
  );
  assert(first.rows.every((r) => !r.fix), "the re-check after --fix finds nothing fixable", first.rows.filter((r) => r.fix).map((r) => r.id));
  const tree = (): string => {
    const h = createHash("sha256");
    const walk = (d: string): void => {
      for (const e of readdirSync(d).sort()) {
        const p = join(d, e);
        const st = statSync(p);
        h.update(`${p}\0${st.mode}\0`);
        if (st.isDirectory()) walk(p);
        else h.update(readFileSync(p));
      }
    };
    walk(ROOT);
    return h.digest("hex");
  };
  const t0 = tree();
  const n0 = effects.length;
  const second = await doc.runDoctor({ fix: true, offline: false, verbose: false, json: false }, { makeCtx: make });
  assert(second.fixed.length === 0 && tree() === t0 && effects.length === n0, "a second --fix: fixed [] and a byte-identical tree");
  const text = doc.renderReport(second, { tty: false, verbose: false });
  assert(text.includes("fixed\n  nothing to fix — no safe repair applies"), "the second --fix prints `nothing to fix`");
  assert(!/\x1b\[/.test(text), "no ANSI off a tty");
  const json = doc.reportJson(before) as Record<string, unknown>;
  const checks = json.checks as Array<Record<string, unknown>>;
  assert(
    Array.isArray(json.fixed) && (json.fixed as unknown[]).length === 0 && json.network === "checked" && typeof json.host === "string" && Array.isArray(json.spaces) &&
      checks.every((c) => typeof c.id === "string" && (c.space === null || typeof c.space === "string") && ["ok", "warn", "fail"].includes(c.status as string) && (c.fix === null || typeof c.fix === "string") && (c.command === null || typeof c.command === "string") && Array.isArray(c.items)) &&
      typeof (json.summary as Record<string, number>).fixable === "number",
    "JSON: schema keys and types, fixed [] without --fix",
  );
  assert(doc.exitCode(first) === 0 || first.rows.some((r) => r.status === "fail"), "exit code follows the ✕ rows");
  const failed = { ...second, fixed: [{ id: "locks", error: "boom" }] };
  assert(doc.exitCode(failed) === 1, "a failed fix exits 1");
}

// ── render (golden) ────────────────────────────────────────────────────────────────────────────────
console.log("render");
{
  const report = {
    host: "aleks-macbook",
    pawHome: join(HOME, ".paw"),
    cotalHome: COTAL,
    home: HOME,
    envSpace: "team2027",
    spaces: ["paw", "team2027"],
    servers: { paw: { server: "nats://127.0.0.1:4222", remote: false }, team2027: { server: "tls://2027-cotal.fly.dev:4222", remote: true } },
    network: "checked" as const,
    fix: false,
    fixed: [],
    rows: [
      { id: "disk", status: "ok" as const, fact: "38 GiB free (96% used) where ~/.paw lives" },
      { id: "release.count", status: "warn" as const, fact: "24 releases on disk (2 in use, current kept)", command: "paw release --prune 3  (keeps current + every in-use)", items: ["a"] },
      { id: "registry.leftover", status: "warn" as const, fact: "forktest-90246 claims nats://127.0.0.1:4222", fix: { action: "drop its record from ~/.cotal/meshes", run: async () => "" } },
      { id: "broker", space: "paw", status: "ok" as const, fact: "answers (3ms)" },
      { id: "locks", space: "paw", status: "warn" as const, fact: "1 stale lock — holder gone: spawn.x (pid 1, 58d)", fix: { action: "remove it (paw breaks it on its next use anyway)", run: async () => "" } },
      { id: "manager", space: "team2027", status: "fail" as const, fact: "pid 2210 · pty · release 1a2193e44a0f · isn't answering (no answer in 2s; log: nothing in the log)", command: "paw restart --full --space team2027  (bounces every agent in team2027 — your go)" },
      { id: "chat-inboxes", space: "team2027", status: "warn" as const, fact: "1 chat inbox left on the broker by dead chats (pid 9)", skipped: "(--offline)" },
    ],
  };
  const golden = [
    "paw doctor · aleks-macbook · ~/.paw · 2 spaces",
    "",
    "machine",
    "  ✓ disk             38 GiB free (96% used) where ~/.paw lives",
    "  ⚠ release.count    24 releases on disk (2 in use, current kept)",
    "      you: paw release --prune 3  (keeps current + every in-use)",
    "  ⚠ registry.leftover forktest-90246 claims nats://127.0.0.1:4222",
    "      --fix: drop its record from ~/.cotal/meshes",
    "",
    "space paw · local nats://127.0.0.1:4222",
    "  ✓ broker           answers (3ms)",
    "  ⚠ locks            1 stale lock — holder gone: spawn.x (pid 1, 58d)",
    "      --fix: remove it (paw breaks it on its next use anyway)",
    "",
    "space team2027 · remote tls://2027-cotal.fly.dev:4222 · PAW_SPACE",
    "  ✕ manager          pid 2210 · pty · release 1a2193e44a0f · isn't answering (no answer in 2s; log: nothing in the log)",
    "      you: paw restart --full --space team2027  (bounces every agent in team2027 — your go)",
    "  ⚠ chat-inboxes     1 chat inbox left on the broker by dead chats (pid 9)",
    "      --fix: skipped (--offline)",
    "",
    "1 ✕ · 4 ⚠ · 2 ✓ · paw doctor --fix repairs 2 (no agent is touched) · the rest need you (commands above)",
    "",
  ].join("\n");
  const got = doc.renderReport(report, { tty: false, verbose: false });
  assert(got === golden, "renderReport matches the golden text", got);
  const verbose = doc.renderReport(report, { tty: false, verbose: true });
  assert(verbose.includes("      you: paw release --prune 3  (keeps current + every in-use)\n      a\n"), "--verbose lists items under the row");
  const tty = doc.renderReport(report, { tty: true, verbose: false, columns: 60 });
  assert(/\x1b\[31m✕\x1b\[0m/.test(tty) && tty.split("\n").every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length <= 60), "on a tty: coloured glyphs, lines elided to the width");
  const fixedR = { ...report, fix: true, rows: [], fixed: [{ id: "locks", space: "paw", did: "removed 3: a, b, c" }, { id: "registry.leftover", did: "dropped forktest-90246 from ~/.cotal/meshes" }] };
  const ft = doc.renderReport(fixedR, { tty: false, verbose: false });
  assert(ft.startsWith("paw doctor --fix · aleks-macbook · ~/.paw · 2 spaces\n\nfixed\n  ✓ paw/locks        removed 3: a, b, c\n  ✓ registry.leftover dropped forktest-90246 from ~/.cotal/meshes\n"), "the --fix block", ft);
  assert(JSON.stringify(doc.orderSpaces(["a", "team2027", "paw", "b"], "team2027")) === JSON.stringify(["paw", "team2027", "a", "b"]), "spaces: paw, then PAW_SPACE, then the rest");
}

// ── args ───────────────────────────────────────────────────────────────────────────────────────────
console.log("args");
{
  const throws = (argv: string[], re: RegExp, msg: string) => {
    let m = "";
    try {
      doc.parseDoctorArgs(argv);
    } catch (e) {
      m = (e as Error).message;
    }
    assert(re.test(m), msg, m);
  };
  throws(["--space", "x", "--all"], /--space and --all/, "--space with --all is a usage error");
  throws(["--fixx"], /unexpected "--fixx" — doctor \[--fix\]/, "an unknown flag names the usage");
  throws(["a#b"], /no <agent>#<space>/, "<x>#space is a usage error");
  const a = doc.parseDoctorArgs(["--fix", "--space", "paw", "--offline", "--verbose", "--json"]);
  assert(a.fix && a.space === "paw" && a.offline && a.verbose && a.json, "every flag parses");
  wipe();
  space("paw");
  space("team2027");
  let m = "";
  try {
    await doc.runDoctor({ fix: false, offline: true, verbose: false, json: false, space: "nosuch" }, { makeCtx: (o) => ctx(o) });
  } catch (e) {
    m = (e as Error).message;
  }
  assert(m === `paw doctor: no space "nosuch" under ${join(PAW, "spaces")} (spaces here: paw, team2027)`, "--space <unknown> fails loud, listing the spaces", m);
}

// ── the static safety guard ────────────────────────────────────────────────────────────────────────
console.log("safety guard");
{
  const files = ["src/doctor.ts", "src/doctor-checks.ts", "src/doctor-locks.ts"].map((f) => [f, readFileSync(join(REPO, f), "utf8")] as const);
  const forbidden = [/\bensure\(/, /\brestartManager\b/, /\brestartMailbox\b/, /\brestartKeepingManager\b/, /\bstop\(/, /\bdespawnManagedAgents\b/, /\bstopOwnedManager\b/, /\bensureHub\b/, /\bstopHub\b/, /\bpruneReleases\b/, /\bexecutePrune\b/, /\bpurgeTestSpace\b/, /\bdeleteSpace\b/, /\bremoveRemoteMesh\b/, /\bwriteRemoteMesh\b/, /\bunloadJob\b/, /\bloadJob\b/];
  const hits = files.flatMap(([f, t]) => forbidden.filter((re) => re.test(t)).map((re) => `${f}: ${re}`));
  assert(hits.length === 0, "doctor never names a stop/restart/despawn/prune/delete verb", hits);
  const ctlCalls = files.flatMap(([, t]) => [...t.matchAll(/\bctl\.(\w+)\(/g)].map((m) => m[1]));
  assert(ctlCalls.length > 0 && ctlCalls.every((c) => c === "ps"), "the only control op is ps", ctlCalls);
  const all = files.map(([, t]) => t).join("\n");
  const kills = [...all.matchAll(/process\.kill\(/g)].length;
  const ctxKills = [...all.matchAll(/ctx\.kill\(/g)].length;
  const checks = files.find(([f]) => f === "src/doctor-checks.ts")![1];
  const orphan = checks.slice(checks.indexOf("export function checkDaemonsOrphan"), checks.indexOf("/** Every persona of every space"));
  assert(kills === 1 && ctxKills === 1 && orphan.includes("ctx.kill("), "the one signal is the orphan mailbox fix's", { kills, ctxKills });
}

// ── A1: no manager-fingerprint input changed (restart-free) ───────────────────────────────────────
console.log("restart-free (A1)");
{
  const fp = await import("../src/manager-fingerprint.ts");
  const git = (args: string[]) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
  const base = git(["merge-base", "HEAD", "origin/main"]);
  const baseRoot = join(ROOT, "base");
  mkdirSync(baseRoot);
  execFileSync("sh", ["-c", `git -C "${REPO}" archive ${base} bin src package.json | tar -x -C "${baseRoot}"`]);
  const inputs = (root: string) => {
    const launch = fp.launchClosure(join(root, "src", "lifecycle.ts"), "startManagerDaemon");
    const graph = fp.moduleGraph(root, [...["bin/cotald.ts", "src/hub/daemon.mjs", "src/hub/cotal-shim.c", "src/manager-features.json"].map((f) => join(root, f)), ...launch.files]);
    const files = Object.fromEntries([...graph].map((f) => [f.slice(root.length + 1), createHash("sha256").update(readFileSync(f)).digest("hex")]));
    const decls = Object.fromEntries([...launch.decls].map(([k, v]) => [k.slice(root.length + 1), createHash("sha256").update(v).digest("hex")]));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    delete pkg.scripts;
    delete pkg.description;
    return { files, decls, pkg };
  };
  const a = inputs(baseRoot);
  const b = inputs(REPO);
  const diff = (x: Record<string, unknown>, y: Record<string, unknown>) => [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  const df = diff(a.files, b.files);
  const dd = diff(a.decls, b.decls);
  assert(df.length === 0, `no manager-graph file differs from ${base.slice(0, 7)}`, df);
  assert(dd.length === 0, `no launch-closure declaration differs from ${base.slice(0, 7)}`, dd);
  assert(JSON.stringify(a.pkg) === JSON.stringify(b.pkg), "package.json's dependency manifest is unchanged");
}

// ── CLI smoke (isolated, --offline) ───────────────────────────────────────────────────────────────
console.log("CLI smoke");
{
  wipe();
  space("test-cli");
  writeFileSync(join(sp("test-cli"), "spawn.x.lock"), String(deadPid()));
  const env = { ...process.env, PAW_HOME: PAW, HOME, COTAL_HOME: COTAL, PAW_SPACE: `test-doctor-${process.pid}`, PAW_RELEASE: "dev", NODE_OPTIONS: "" };
  const run = (args: string[]) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [join(REPO, "bin", "paw.ts"), "doctor", ...args], { env, encoding: "utf8" });
    return { ...r, ms: Date.now() - t0 };
  };
  const before = spawnSync("pgrep", ["-f", "space test-cli"], { encoding: "utf8" }).stdout.trim();
  const r = run(["--offline"]);
  assert((r.status === 0 || r.status === 1) && r.stdout.startsWith("paw doctor · ") && r.stdout.includes("\nmachine\n") && r.stdout.includes("\nspace test-cli · local ") && /\d+ ✕ · \d+ ⚠ · \d+ ✓ .*network not checked \(--offline\)\n$/.test(r.stdout), "`paw doctor --offline`: header, sections, footer", r.stdout + r.stderr);
  assert(r.stdout.includes("✓ manager          not running here — starts on the next paw command"), "a fresh home: the manager isn't started");
  assert(r.ms < 1500, `--offline runs under 1.5s (${r.ms}ms)`);
  const j = run(["--json", "--offline"]);
  let parsed: { network?: string } = {};
  try {
    parsed = JSON.parse(j.stdout);
  } catch {
    parsed = {};
  }
  assert(parsed.network === "skipped", "`--json --offline` emits only JSON, and it parses");
  run(["--fix", "--offline"]);
  const second = run(["--fix", "--offline"]);
  assert(second.stdout.includes("nothing to fix — no safe repair applies"), "a second `--fix --offline` has nothing to fix", second.stdout);
  const after = spawnSync("pgrep", ["-f", "space test-cli"], { encoding: "utf8" }).stdout.trim();
  assert(before === "" && after === "", "doctor started nothing (no process names --space test-cli)", { before, after });
  const h = spawnSync(process.execPath, [join(REPO, "bin", "paw.ts"), "doctor", "--help"], { env, encoding: "utf8" });
  assert(h.status === 0 && h.stdout.startsWith("usage: paw doctor"), "`paw doctor --help` works with no mesh");
}

for (const c of children) c.kill();
rmSync(ROOT, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} paw doctor check(s) failed`);
  process.exit(1);
}
console.log("\nall paw doctor checks passed 🐾");
process.exit(0);

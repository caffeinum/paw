/**
 * check:restart — a `paw restart` that fails half-way can be finished (the 2026-10-26 team2027 incident:
 * despawn → old manager stopped → broker stall → `could not acquire the manager lease …: timeout` →
 * exit 1, with no manager, the OLD mailbox, and the live list lost).
 *
 *   1. classifyManagerFailure: the incident's lines are transient; a duplicate manager, auth, a broken
 *      install, an unknown or empty log are fatal; a fatal marker wins over a transient one.
 *   2. startWithRetry: transient failures retry with the 5s/15s/30s backoff (injected sleep), reaping
 *      between attempts and saying each one; a fatal one stops at once; the cap is 4 starts.
 *   3. explainManagerFailure names a broker stall and the retries.
 *   4. the revive list: written (merged with a pending one), survives a failed restart, read back,
 *      consumed by the next run (revivePending, injected reviver) and deleted; a stale list is dropped
 *      out loud; a malformed one throws; a held lock makes ensure()'s pass skip, leaving the list.
 *   5. the failed-restart message: manager down, mailbox release (old vs new), pending names, how to finish.
 *   6. the revive set IS the despawned set (team2027, 2026-10-28: 11 despawned, 8 back — the 3 were
 *      running but off the mesh, some sandboxed): a fake rail lists running+offline and sandboxed seats;
 *      every running one is owed, an exited one is left down BY NAME, the summary names both.
 *
 * Hermetic: temp PAW_HOME, PAW_SPACE=test-restart-<pid>, PAW_RELEASE=dev. No mesh, no manager, no agent.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "paw-restart-"));
const SPACE = `test-restart-${process.pid}`;
process.env.PAW_HOME = HOME;
process.env.PAW_RELEASE = "dev";
process.env.PAW_SPACE = SPACE;

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const { classifyManagerFailure, startWithRetry, explainManagerFailure, MANAGER_RETRY_BACKOFF_MS, reviveListPath, logSince, despawnManagedAgents } = await import("../src/lifecycle.ts");
const revive = await import("../src/revive.ts");

try {
  // ---- 1. classification ----
  const incident = [
    "! manager endpoint: timeout",
    'deprovision queue-ea (a1): membership inventory incomplete (timeout); rows on channels outside its launch policy stay RETAINED for uid u1',
    'could not acquire the manager lease for space "team2027": timeout',
  ];
  for (const l of incident) assert(classifyManagerFailure(l).kind === "transient", `transient: ${l.slice(0, 60)}`);
  assert(classifyManagerFailure(incident.join("\n")).reason === "lease timeout", "the incident tail is named a lease timeout");
  assert(classifyManagerFailure("nats: connect ETIMEDOUT 66.241.124.1:4222").kind === "transient", "transient: a connect timeout");
  assert(classifyManagerFailure("connection reset by peer").kind === "transient", "transient: a reset link");
  const fatal: Array<[string, string]> = [
    ['manager instance local.x already serves space "paw" from this workspace root (pty, pid 1, root /r) - stop it first', "duplicate manager"],
    ['could not acquire the manager lease for space "s": Permissions Violation for Publish to "$KV.x"', "lease refused by permissions"],
    ["nats: Authorization Violation", "auth refused"],
    ["tsx: line 20: exec: node: not found", "missing binary"],
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@cotal-ai/manager'", "broken install"],
    ["error: unknown option '--frobnicate'", "config error"],
    ["something unexplained happened", "unknown"],
    ["", "empty log"],
  ];
  for (const [l, what] of fatal) assert(classifyManagerFailure(l).kind === "fatal", `fatal: ${what}`);
  assert(classifyManagerFailure("! manager endpoint: timeout\nnats: Authorization Violation").kind === "fatal", "a fatal marker wins over a transient one");

  // ---- 2. retry / backoff with injected failures ----
  const run = async (results: Array<{ ok: true } | { ok: false; logTail: string }>) => {
    const sleeps: number[] = [];
    const logs: string[] = [];
    let cleanups = 0;
    let n = 0;
    const r = await startWithRetry({
      attempt: async () => results[Math.min(n++, results.length - 1)],
      cleanup: async () => void cleanups++,
      sleep: async (ms) => void sleeps.push(ms),
      log: (l) => logs.push(l),
    });
    return { r, sleeps, logs, cleanups, calls: n };
  };
  const stall = { ok: false as const, logTail: 'could not acquire the manager lease for space "team2027": timeout' };
  const a = await run([stall, stall, { ok: true }]);
  assert(a.r.ok && a.r.attempts === 3, "two stalls then up → up on attempt 3");
  assert(JSON.stringify(a.sleeps) === JSON.stringify([5_000, 15_000]), `backoff 5s then 15s (got ${a.sleeps})`);
  assert(a.cleanups === 2, "the half-started daemon is reaped before each retry");
  assert(a.logs.length === 3 && a.logs[0].includes("attempt 1/4") && a.logs[0].includes("lease timeout") && a.logs[0].includes("retrying in 5s"), "each failed attempt is said, with its cause and wait");
  assert(a.logs[2].includes("up on attempt 3/4"), "the recovery is said too");
  const b = await run([{ ok: false, logTail: "nats: Authorization Violation" }]);
  assert(!b.r.ok && b.r.attempts === 1 && b.sleeps.length === 0 && b.cleanups === 0, "a fatal failure is NOT retried");
  const c = await run([stall]);
  assert(!c.r.ok && c.r.attempts === 4 && c.calls === 4, "a stall that never clears stops after 4 starts");
  assert(JSON.stringify(c.sleeps) === JSON.stringify(MANAGER_RETRY_BACKOFF_MS) && MANAGER_RETRY_BACKOFF_MS.join() === "5000,15000,30000", "…after 5s, 15s, 30s");
  const d = await run([stall, { ok: false, logTail: 'a manager already serves space "x"' }]);
  assert(!d.r.ok && d.r.attempts === 2 && !d.r.ok && d.r.failure.kind === "fatal", "a fatal failure on a retry stops there");
  const e = await run([{ ok: true }]);
  assert(e.r.ok && e.r.attempts === 1 && e.logs.length === 0, "a first-try start says nothing extra");

  // logSince reads only this attempt's lines
  const log = join(HOME, "m.log");
  writeFileSync(log, "old: could not acquire the manager lease for space \"s\": timeout\n");
  const from = (await import("node:fs")).statSync(log).size;
  writeFileSync(log, "old: could not acquire the manager lease for space \"s\": timeout\nnew line\n");
  assert(logSince(log, from) === "new line", "logSince returns only what this attempt appended");

  // ---- 3. the error text ----
  const msg = explainManagerFailure({ logTail: incident.join("\n"), runtime: "pty", space: "team2027", logPath: "/x/manager.log", attempts: 4 });
  assert(msg.includes("on any of 4 attempts") && msg.includes("broker stalled") && msg.includes("lease timeout") && msg.includes("retried 3×"), "the final manager error names the stall and the retries");
  assert(msg.includes("/x/manager.log"), "…and points at the log");
  assert(!explainManagerFailure({ logTail: "x", runtime: "pty", space: "s", logPath: "/l" }).includes("attempts"), "a single attempt doesn't talk about attempts");

  // ---- 4. the revive list ----
  const path = reviveListPath(SPACE);
  assert(revive.writeReviveList(SPACE, []) === undefined && !existsSync(path), "nobody live → no list on disk");
  const t0 = new Date(Date.now() - 2 * 3_600_000); // the failed restart, 2h before the re-run
  const w = revive.writeReviveList(SPACE, ["queue-ea", "evals"], t0)!;
  assert(existsSync(path) && w.names.join() === "queue-ea,evals" && w.at === t0.toISOString(), "the live list is written with a timestamp");
  // the restart fails here: nothing clears the file
  const left = revive.readReviveList(SPACE)!;
  assert(left.names.join() === "queue-ea,evals", "the list survives a failed restart");
  const t1 = new Date();
  // the re-run finds nobody live (the manager is down) — the pending names still ride along
  const merged = revive.writeReviveList(SPACE, ["fly-hello", "evals"], t1)!;
  assert(merged.names.join() === "queue-ea,evals,fly-hello", "the next restart merges the pending names with its own live ones");
  assert(revive.pendingNames(SPACE, t1.getTime()).join() === "queue-ea,evals,fly-hello", "pendingNames reads a fresh list");

  // consumed by the next run
  const called: string[][] = [];
  const fakeRevive = async (_s: string, names: string[]) => (called.push(names), { revived: names, skipped: [] });
  await revive.revivePending(SPACE, fakeRevive);
  assert(called.length === 1 && called[0].join() === "queue-ea,evals,fly-hello", "ensure()'s pass revives exactly the listed agents");
  assert(!existsSync(path), "…and deletes the list");
  await revive.revivePending(SPACE, fakeRevive);
  assert(called.length === 1, "no list → nothing revived");

  // a listed agent that can't start: still consumed, said loud
  revive.writeReviveList(SPACE, ["queue-ea", "gone"]);
  const errs: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    await revive.revivePending(SPACE, async (_s, names) => ({ revived: names.filter((n) => n !== "gone"), skipped: [{ name: "gone", why: "its folder /x is gone" }] }));
  } finally {
    console.error = realErr;
  }
  assert(errs.some((l) => l.includes("did not start") && l.includes("gone: its folder /x is gone") && l.includes("paw start gone")), "an agent that can't start is named loud, with the fix");
  assert(!existsSync(path), "…and the list is still consumed (no retry storm on every command)");

  // stale list
  revive.writeReviveList(SPACE, ["queue-ea"], new Date(Date.now() - 25 * 3_600_000));
  const said: string[] = [];
  assert(revive.pendingNames(SPACE, Date.now(), (l) => said.push(l)).length === 0, "a list older than 24h is not revived");
  assert(!existsSync(path) && said[0]?.includes("queue-ea") && said[0].includes("older than 24h"), "…it is dropped out loud, naming who it listed");

  // malformed
  writeFileSync(path, "{nope");
  let threw = "";
  try {
    revive.readReviveList(SPACE);
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(threw.includes("not valid JSON"), "a malformed list fails loud");
  writeFileSync(path, JSON.stringify({ space: "other", at: new Date().toISOString(), names: [] }));
  threw = "";
  try {
    revive.readReviveList(SPACE);
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(threw.includes("not a revive list"), "a list for another space fails loud");
  revive.clearReviveList(SPACE);

  // a held lock (a restart mid-bounce) → ensure()'s pass skips and leaves the list
  revive.writeReviveList(SPACE, ["queue-ea"]);
  const during: string[][] = [];
  await revive.withReviveLock(SPACE, async () => {
    await revive.revivePending(SPACE, async (_s, names) => (during.push(names), { revived: names, skipped: [] }));
  }, true);
  assert(during.length === 0 && existsSync(path), "while a restart holds the lock, ensure() leaves the list alone");
  revive.clearReviveList(SPACE);

  // ---- 5. the failed-restart message ----
  const base = { space: "team2027", manager: { pids: [] as number[] }, target: "/h/releases/new", pending: ["queue-ea"], revivePath: "/h/spaces/team2027/restart-revive.json" };
  const describe = (r: string) => `release ${r.split("/").pop()}`;
  const fail = revive.describeFailedRestart("paw: the manager didn't answer…", { ...base, mailbox: { pids: [7], root: "/h/releases/old" } }, describe);
  assert(fail.startsWith("paw: the manager didn't answer…"), "the cause comes first");
  assert(fail.includes("manager: DOWN"), "says the manager is down");
  assert(fail.includes("mailbox: running on release old — NOT the release this restart was moving to (release new)"), "says the mailbox is still on the OLD release");
  assert(fail.includes("1 pending revive (saved in /h/spaces/team2027/restart-revive.json): queue-ea"), "names the pending agents and where they're saved");
  assert(fail.includes("`paw restart --space team2027` will bring back: queue-ea"), "says exactly how to finish");
  const ok = revive.describeFailedRestart("x", { ...base, manager: { pids: [9], root: "/h/releases/new" }, mailbox: { pids: [7], root: "/h/releases/new" }, pending: [] }, describe);
  assert(ok.includes("manager: running (pid 9, release new)") && ok.includes("mailbox: running on release new (the new release)") && ok.includes("nothing to revive"), "a mailbox on the new release and an empty list read as such");
  assert(revive.mailboxRootFromCommand("/n/node /h/releases/abc/bin/paw.ts mailbox --space s --home /h") === "/h/releases/abc", "a beacon's code root is read from its command line");

  // ---- 6. revive set == despawned set ----
  {
    const rows = [
      { name: "ok", status: "running", mesh: "idle" },
      { name: "offmesh", status: "running", mesh: "offline" }, // presence lost in a broker stall, process up
      { name: "mcp-intern", status: "running", mesh: "offline" },
      { name: "neon", status: "running", mesh: "offline", sandbox: "container" }, // sandboxed, link dropped
      { name: "booting", status: "running", mesh: "absent" },
      { name: "termlost", status: "exited", mesh: "idle" }, // terminal gone, agent heartbeating
      { name: "dead", status: "exited", mesh: "offline" }, // stopped/died before the restart
    ];
    const despawned: string[] = [];
    const ledger = new revive.RevivalLedger(SPACE);
    // the pre-bounce capture saw an OLDER, presence-filtered world (only "ok" looked live)…
    ledger.record([{ name: "ok", status: "running", mesh: "idle" }]);
    // …the despawn's own rows are what count
    const realErr = console.error;
    console.error = () => {};
    try {
      await despawnManagedAgents(
        { ps: async () => ({ ok: true, data: rows }), despawn: async (n: string) => (despawned.push(n), { ok: true }) },
        { onTargets: (t) => void ledger.record(t), exitWaitMs: 0 },
      );
    } finally {
      console.error = realErr;
    }
    const owed = revive.pendingNames(SPACE);
    const runningDespawned = despawned.filter((n) => n !== "dead");
    assert(despawned.length === rows.length, "the despawn takes every listed seat");
    assert([...owed].sort().join() === [...runningDespawned].sort().join(), `the revive list == the despawned running set (got ${owed.join(",")})`);
    for (const n of ["offmesh", "mcp-intern", "neon"]) assert(owed.includes(n), `running-but-off-mesh ${n} is owed a revive`);
    assert(!owed.includes("dead"), "a seat whose process had already exited is NOT revived");
    const down = ledger.leftDown();
    assert(down.length === 1 && down[0].name === "dead" && down[0].why.includes("already exited"), "…it is named, with why");
    const lines = revive.describeRevival(owed, owed.filter((n) => n !== "neon"), [{ name: "neon", why: "the container would not start" }], down);
    assert(lines[0].includes(`brought back ${owed.length - 1}/${owed.length}`) && lines[0].includes("mcp-intern") && lines[0].includes("NOT back: neon"), "the summary names who came back and who didn't");
    assert(lines.some((l) => l.startsWith("left down: dead") && l.includes("paw start dead")), "the summary names who was left down and how to start it");
    assert(revive.revivalFailure(SPACE, owed.length, [{ name: "neon", why: "the container would not start" }]).includes("neon: the container would not start"), "a despawned agent that didn't come back fails loud with its reason");
    // a name seen running in either look stays owed, even if the other look saw it exited
    const l2 = new revive.RevivalLedger(SPACE);
    revive.clearReviveList(SPACE);
    l2.record([{ name: "x", status: "running", mesh: "offline" }]);
    l2.record([{ name: "x", status: "exited", mesh: "offline" }]);
    assert(revive.pendingNames(SPACE).join() === "x" && l2.leftDown().length === 0, "seen running once → owed, not left down");
    assert(revive.revivalPlan([]).revive.length === 0 && revive.describeRevival([], [], []).length === 0, "nobody listed → nothing owed, nothing said");
    revive.clearReviveList(SPACE);
    const rt = (await import("node:fs")).readFileSync(join(import.meta.dirname, "..", "src", "commands", "runtime.ts"), "utf8");
    assert(!rt.includes("psRowAlive"), "runtime.ts no longer filters the revive set by mesh presence");
    assert(/onDespawnTargets:[\s\S]{0,200}ledger\.record\(rows\)/.test(rt), "paw restart records the despawn's own rows into the revive list");
  }
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

if (failures) {
  console.error(`check:restart — ${failures} failure(s)`);
  process.exit(1);
}
console.log("check:restart — all ok");

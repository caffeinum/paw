/**
 * The wake gate's judgement of a seat that isn't on the mesh (src/addressing.ts ensureAgentSpawned) and
 * the spawn lock's timeouts (src/lock.ts). Three 2026-10-14 failures, each pinned here:
 *
 *  1. "still booting" was read as a failed boot — the readiness timeout threw on a seat whose process
 *     was running, so the next wake restarted it and the sleep host retried into it;
 *  2. a waiter on spawn.<name>.lock gave up after 30s while a legitimate holder may hold it ~4 min
 *     ("timed out acquiring lock spawn.evals.lock", sleep.log), and a live holder's lock aged out at 60s;
 *  3. the keeper restarted `global` every ~3 min (562× in launchd-global.log) on a stale-PRESENCE
 *     judgement: its process ran, and 14–28 other agents went offline in the same minute.
 *
 * Hermetic: a fake manager, an isolated PAW_HOME and HOME (so ~/.claude.json and transcripts are temp).
 * Run: pnpm check:wake-gate
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-wakegate-home-"));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ALLOW_ANY_CWD = "1";
delete process.env.PAW_ROOT;

const {
  ensureAgentSpawned,
  ensurePersonaFile,
  personaFilePath,
  presencePlaneSuspect,
  seatBooting,
  BUSY_GUARD_MS,
  SPAWN_LOCK_HOLD_MS,
  SPAWN_LOCK_OPTS,
  STARTING_GRACE_MS,
  SESSION_RELEASE_MS,
  SPAWN_ACCEPT_MS,
  SPAWN_READY_MS,
} = await import("../src/addressing.ts");
const { readResumeId } = await import("../src/session.ts");
const { withFileLockAsync } = await import("../src/lock.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

type Row = { name: string; status?: string; mesh?: string; id?: string };
type Ctl = Parameters<typeof ensureAgentSpawned>[0];
/** A manager whose ps answers `rows()` (re-read every call), recording despawn/spawn. */
function fakeCtl(rows: () => Row[], calls: string[]): Ctl {
  return {
    ps: async () => ({ ok: true, data: rows() }),
    despawn: async (n: string) => {
      calls.push(`despawn ${n}`);
      return { ok: true };
    },
    spawn: async (a: { name: string }) => {
      calls.push(`spawn ${a.name}`);
      return { ok: true, data: { name: a.name, owner: "local", actor: "ACTORNEW" } };
    },
  } as unknown as Ctl;
}
const healthy = async () => ({ kind: "ok" as const });
const fast = { graceMs: 300, readyMs: 600 };

/** Give `name` a persona and a transcript last written `ageMs` ago (a `--resume` boot writes one). */
function transcriptAged(space: string, name: string, folder: string, ageMs: number | undefined): void {
  ensurePersonaFile(space, name);
  const pin = readResumeId(personaFilePath(space, name));
  if (!pin) throw new Error("persona has no resume pin");
  if (ageMs === undefined) return;
  const dir = join(home, ".claude", "projects", folder.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pin}.jsonl`);
  writeFileSync(file, '{"type":"mode"}\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
}

const folder = mkdtempSync(join(tmpdir(), "paw-wakegate-folder-"));

try {
  // --- pure judgements -----------------------------------------------------------------------------
  const now = 5_000_000_000;
  assert(seatBooting({ name: "a", status: "running", mesh: "absent" }, now - 20_000, now), "seatBooting: running + transcript 20s old → booting");
  assert(!seatBooting({ name: "a", status: "running", mesh: "absent" }, now - BUSY_GUARD_MS - 1, now), "seatBooting: nothing written for longer than the busy window → stuck (the 13-hour boot still restarts)");
  assert(!seatBooting({ name: "a", status: "running", mesh: "absent" }, undefined, now), "seatBooting: no transcript → no evidence → not booting");
  assert(!seatBooting({ name: "a", status: "exited", mesh: "absent" }, now - 1000, now), "seatBooting: an exited process is not booting");
  assert(!seatBooting(undefined, now - 1000, now), "seatBooting: no row → not booting");

  const fleet = (offline: number, idle: number): Row[] => [
    { name: "global", status: "running", mesh: "offline" },
    ...Array.from({ length: offline }, (_, i) => ({ name: `off${i}`, status: "running", mesh: "offline" })),
    ...Array.from({ length: idle }, (_, i) => ({ name: `idle${i}`, status: "running", mesh: "idle" })),
  ];
  assert(presencePlaneSuspect(fleet(20, 6), "global"), "plane: 20/26 other running seats offline → the presence plane, not global");
  assert(!presencePlaneSuspect(fleet(1, 20), "global"), "plane: global alone offline among a live fleet → a real zombie judgement");
  assert(!presencePlaneSuspect(fleet(1, 0), "global"), "plane: one other seat is too few to judge");
  assert(!presencePlaneSuspect([...fleet(0, 2), { name: "x", status: "exited", mesh: "offline" }, { name: "y", status: "exited", mesh: "offline" }], "global"), "plane: exited seats don't count — they're dead, not lagging");

  // --- fix 1a: a seat sitting at `starting…` that is still booting is left alone ----------------------
  {
    const calls: string[] = [];
    transcriptAged("g1", "evals", folder, 20_000);
    const r = await ensureAgentSpawned(fakeCtl(() => [{ name: "evals", status: "running", mesh: "absent", id: "ACTOROLD" }], calls), {
      space: "g1",
      name: "evals",
      cwd: folder,
      probePresence: healthy,
      timing: fast,
    });
    assert(r.starting === true && !r.spawned && r.id === "local.ACTOROLD", `absent + booting: returns starting with its address (${JSON.stringify(r)})`);
    assert(calls.length === 0, `absent + booting: nothing despawned or spawned (${calls.join() || "no calls"})`);
  }
  // ...and one that wrote nothing is still restarted (the bound on a stuck boot stays).
  {
    const calls: string[] = [];
    transcriptAged("g2", "evals", folder, undefined);
    const r = await ensureAgentSpawned(fakeCtl(() => (calls.includes("spawn evals") ? [{ name: "evals", status: "running", mesh: "idle" }] : [{ name: "evals", status: "running", mesh: "absent" }]), calls), {
      space: "g2",
      name: "evals",
      cwd: folder,
      probePresence: healthy,
      timing: fast,
    });
    assert(calls.join() === "despawn evals,spawn evals" && r.spawned && !r.starting, `absent + no progress: restarted as before (${calls.join()})`);
  }

  // --- fix 1b: the readiness timeout on a running process is "starting", not a throw -----------------
  {
    const calls: string[] = [];
    transcriptAged("g3", "fresh", folder, undefined);
    let spawned = false;
    const ctl = fakeCtl(() => (spawned ? [{ name: "fresh", status: "running", mesh: "absent" }] : []), calls);
    const spawn = (ctl as unknown as { spawn: (a: { name: string }) => Promise<unknown> }).spawn;
    (ctl as unknown as { spawn: (a: { name: string }) => Promise<unknown> }).spawn = async (a) => {
      spawned = true;
      return spawn(a);
    };
    const t = Date.now();
    const r = await ensureAgentSpawned(ctl, { space: "g3", name: "fresh", cwd: folder, probePresence: healthy, timing: fast });
    assert(r.spawned && r.starting === true && r.id === "local.ACTORNEW", `ready timeout + process running → starting, with the allocated principal (${JSON.stringify(r)})`);
    assert(Date.now() - t < 5000, "ready timeout: returns after the readiness wait, no extra blocking");
  }
  {
    const calls: string[] = [];
    let err = "";
    await ensureAgentSpawned(fakeCtl(() => [], calls), { space: "g4", name: "gone", cwd: folder, probePresence: healthy, timing: fast }).catch((e: Error) => (err = e.message));
    assert(err.includes("never reached the mesh") && err.includes("its process is gone (ps row: missing)"), `ready timeout + row gone → throws loud (${err.split("\n")[0]})`);
  }
  {
    let err = "";
    let spawned = false;
    const ctl = fakeCtl(() => (spawned ? [{ name: "dead", status: "exited", mesh: "absent" }] : []), []);
    const spawn = (ctl as unknown as { spawn: (a: { name: string }) => Promise<unknown> }).spawn;
    (ctl as unknown as { spawn: (a: { name: string }) => Promise<unknown> }).spawn = async (a) => {
      spawned = true;
      return spawn(a);
    };
    await ensureAgentSpawned(ctl, { space: "g5", name: "dead", cwd: folder, probePresence: healthy, timing: fast }).catch((e: Error) => (err = e.message));
    assert(err.includes("its process is gone (ps row: status=exited)"), "ready timeout + process exited → throws loud");
  }

  // --- fix 3: the global loop — running + offline + idle transcript, with the fleet offline too ------
  {
    const calls: string[] = [];
    transcriptAged("g6", "global", folder, 184_000); // just past the busy guard, as in launchd-global.log
    const r = await ensureAgentSpawned(fakeCtl(() => fleet(20, 6), calls), { space: "g6", name: "global", cwd: folder, probePresence: healthy, timing: fast });
    assert(!r.spawned && calls.length === 0, `global loop: fleet-wide offline → NOT restarted (${calls.join() || "no calls"})`);
  }
  {
    const calls: string[] = [];
    transcriptAged("g7", "global", folder, 184_000);
    let n = 0;
    const rows = () => (n++ < 1 ? fleet(0, 6) : [{ name: "global", status: "running", mesh: "idle" }, ...fleet(0, 6).slice(1)]);
    const r = await ensureAgentSpawned(fakeCtl(rows, calls), { space: "g7", name: "global", cwd: folder, probePresence: healthy, timing: fast });
    assert(calls.join() === "despawn global,spawn global" && r.spawned, `lone offline seat in a live fleet: still restarted (${calls.join()})`);
  }

  // --- fix 2: spawn-lock waiters outlast a legitimate holder ---------------------------------------
  assert(
    SPAWN_LOCK_HOLD_MS >= STARTING_GRACE_MS + 2 * SESSION_RELEASE_MS + 2 * SPAWN_ACCEPT_MS + SPAWN_READY_MS,
    `lock: wait (${SPAWN_LOCK_HOLD_MS / 1000}s) covers grace + session release + held-name retries + two spawn calls + readiness`,
  );
  assert(SPAWN_LOCK_OPTS.maxWaitMs === SPAWN_LOCK_HOLD_MS && SPAWN_LOCK_OPTS.staleMs === SPAWN_LOCK_HOLD_MS, "lock: waiters wait the hold bound, and a live holder isn't aged out sooner");
  {
    // A LIVE holder (our own pid) whose lock is 90s old — past the generic 60s stale age. With the spawn
    // opts it is waited out, not broken; with the old defaults it was broken mid-spawn.
    const lock = join(home, "spawn.live.lock");
    writeFileSync(lock, String(process.pid));
    const old = (Date.now() - 90_000) / 1000;
    utimesSync(lock, old, old);
    let entered = 0;
    const waiter = withFileLockAsync(lock, async () => (entered = Date.now()), SPAWN_LOCK_OPTS);
    await new Promise((r) => setTimeout(r, 400));
    assert(entered === 0, "lock: a 90s-old lock held by a LIVE pid is not broken (was: aged out at 60s → two spawners)");
    const released = Date.now();
    rmSync(lock);
    await waiter;
    assert(entered >= released, "lock: the waiter gets it once the holder releases");

    writeFileSync(lock, String(process.pid));
    utimesSync(lock, old, old);
    let broke = false;
    await withFileLockAsync(lock, async () => (broke = true), { maxWaitMs: 200 });
    assert(broke, "lock: (the old default 60s stale age broke that live holder — the bug)");

    writeFileSync(lock, "999999"); // a pid that doesn't exist
    const t = Date.now();
    await withFileLockAsync(lock, async () => {}, SPAWN_LOCK_OPTS);
    assert(Date.now() - t < 500, "lock: a DEAD holder's lock is still broken at once");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
}

if (failures) {
  console.error(`\ncheck:wake-gate — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:wake-gate — all ok");
process.exit(0);

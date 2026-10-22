/**
 * check:boot — a COLD boot of the local mesh succeeds, alone and under concurrency.
 *
 * The 2026-10-20 reboot: the login `paw start` fleet job (launchd, RunAtLoad) exited 1 with
 * "paw: mesh failed to start (cotal up exited 1)" while the broker it had just booted was up and fine.
 * Since cotal 0.84 a `cotal up --detach` whose control plane is "degraded" exits 1 — and driven through
 * bin/cotald.ts it ALWAYS was degraded: its manager start hit cotal's #1629 self-exec guard ("refusing
 * to re-exec this process as `cotal`"). paw starts its own manager, so it now passes `--no-manager`, and
 * a non-zero `up` whose broker answers anyway (PAW_AUTH's delivery daemon, a concurrent boot) is adopted.
 *
 * Everything runs on a PRIVATE port with a temp PAW_HOME, COTAL_HOME and cotal root (PAW_COTAL_ROOT) —
 * the live :4222 broker, ~/.paw and ~/.cotal are never touched. Every nats-server this starts carries
 * the temp dir in its argv and is killed by that signature on teardown.
 *
 *   1. meshUpArgs carries --no-manager (pure).
 *   2. canary: the OLD argv (no --no-manager) still exits 1 + "control plane degraded" under cotal's
 *      `up` driven through cotald — if cotal stops doing that, this says so (the fix stays harmless).
 *   3. bootLocalMesh from cold: resolves, mesh.log has no "control plane degraded", mesh.pid adopted.
 *   4. two processes boot the same cold broker AT ONCE with no lifecycle lock between them: both
 *      succeed — the loser's non-zero `cotal up` is adopted, not fatal.
 *   5. the lifecycle lock waits out a LIVE holder older than lock.ts's 60s default age-out, says so on
 *      stderr once (onWait), and a timeout names the holder pid.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

// ---- child mode: one concurrent cold boot (stage 4) ----
if (process.env.PAW_CHECK_BOOT_CHILD) {
  const { bootLocalMesh } = await import("../src/lifecycle.ts");
  try {
    await bootLocalMesh(process.env.PAW_CHECK_BOOT_CHILD, process.env.PAW_SERVER as string, { open: true });
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const base = mkdtempSync(join(tmpdir(), "paw-boot-"));
process.env.PAW_HOME = join(base, "home");
process.env.COTAL_HOME = join(base, "cotal-home");
process.env.PAW_COTAL_ROOT = join(base, "root");
process.env.PAW_RELEASE = "dev";
process.env.PAW_SPACE = `test-boot-${process.pid}`;
for (const d of [process.env.PAW_HOME, process.env.COTAL_HOME, process.env.PAW_COTAL_ROOT]) mkdirSync(d, { recursive: true });
delete process.env.PAW_AUTH;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

/** pids of every process whose argv names our temp dir (the nats-servers we booted). */
function ourProcs(): number[] {
  const r = spawnSync("pgrep", ["-f", base], { encoding: "utf8" });
  return r.stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

const lifecycle = await import("../src/lifecycle.ts");
const { meshUpArgs, bootLocalMesh, cotaldViaNode, LIFECYCLE_LOCK_OPTS, LIFECYCLE_LOCK_HOLD_MS, MESH_UP_TIMEOUT_MS, MESH_ADOPT_WAIT_MS } = lifecycle;
const { isReachable } = await import("@cotal-ai/core");
const meshLog = (space: string) => join(process.env.PAW_HOME as string, "spaces", space, "mesh.log");

try {
  // ---- 1. the argv ----
  {
    const a = meshUpArgs("s", "nats://127.0.0.1:1", true, "/x");
    assert(a[0] === "up" && a.includes("--detach"), "up args: `up --detach`");
    assert(a.includes("--no-manager"), "up args: --no-manager (paw starts its own manager; cotal's would hit the self-exec guard)");
    assert(!a.includes("--runtime") && !a.includes("--max-sessions"), "up args: no manager-shaping flag (cotal refuses them with --no-manager)");
    assert(a.includes("--open") && !meshUpArgs("s", "nats://127.0.0.1:1", false, "/x").includes("--open"), "up args: --open only for an open mesh");
  }

  // ---- 2. canary: the old argv, through cotald, exits 1 over a running broker ----
  {
    const port = await freePort();
    const root = join(base, "canary-root");
    mkdirSync(root, { recursive: true });
    const old = meshUpArgs(`test-canary-${process.pid}`, `nats://127.0.0.1:${port}`, true, join(base, "canary-nats")).filter((x) => x !== "--no-manager");
    const [exec, args] = cotaldViaNode(old);
    const r = spawnSync(exec, args, { cwd: root, encoding: "utf8", timeout: MESH_UP_TIMEOUT_MS, env: process.env });
    const out = `${r.stdout}${r.stderr}`;
    const up = await isReachable(`nats://127.0.0.1:${port}`);
    console.log(`  ..  canary: old argv exited ${r.status}, broker reachable=${up}`);
    assert(up, "canary: `cotal up --detach` (no --no-manager) via cotald does boot the broker");
    if (r.status === 1 && out.includes("control plane degraded"))
      assert(true, "canary: …and still exits 1 with \"control plane degraded\" (cotal 0.84 — the reboot failure's cause)");
    else console.log("  NOTE  canary: cotal no longer exits 1 here — --no-manager stays correct, but the note in lifecycle.ts meshUpArgs is history");
    for (const pid of ourProcs()) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }

  // ---- 3. bootLocalMesh from cold ----
  {
    const port = await freePort();
    const server = `nats://127.0.0.1:${port}`;
    process.env.PAW_SERVER = server;
    const space = `test-boot-${process.pid}`;
    let err: Error | undefined;
    const captured: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => void captured.push(a.join(" "));
    try {
      await bootLocalMesh(space, server, { open: true });
    } catch (e) {
      err = e as Error;
    } finally {
      console.error = origErr;
    }
    assert(!err, `cold boot: bootLocalMesh resolves${err ? ` — ${err.message.split("\n")[0]}` : ""}`);
    assert(await isReachable(server), "cold boot: the broker answers");
    const log = existsSync(meshLog(space)) ? readFileSync(meshLog(space), "utf8") : "";
    assert(!log.includes("control plane degraded"), "cold boot: mesh.log has no \"control plane degraded\" line");
    assert(!captured.some((l) => l.includes("adopting")), "cold boot: a clean `cotal up` (exit 0), not the adopt-after-failure path");
    const pidFile = join(process.env.PAW_HOME as string, "spaces", space, "mesh.pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
    assert(Number.isInteger(pid) && ourProcs().includes(pid), "cold boot: mesh.pid names the live nats-server paw booted");
    for (const p of ourProcs()) try { process.kill(p, "SIGTERM"); } catch { /* gone */ }
  }

  // ---- 4. two concurrent cold boots of one broker ----
  {
    const port = await freePort();
    const server = `nats://127.0.0.1:${port}`;
    const t0 = Date.now();
    const run = (space: string) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const c = spawn(process.execPath, [self], { env: { ...process.env, PAW_SERVER: server, PAW_CHECK_BOOT_CHILD: space }, stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        c.stderr.on("data", (d) => (err += d));
        c.on("exit", (code) => resolve({ code, err }));
      });
    // Same space, one fresh cotal root, NO lifecycle lock between them — what two paw processes got when
    // one broke the other's live lock at the old 60s age-out, or run under different PAW_HOMEs. cotal's
    // own startup lock / `.cotal` mkdir race fails the loser with exit 1 while the winner's broker boots.
    const space = `test-boot-race-${process.pid}`;
    process.env.PAW_COTAL_ROOT = join(base, "race-root");
    mkdirSync(process.env.PAW_COTAL_ROOT, { recursive: true });
    const [a, b] = await Promise.all([run(space), run(space)]);
    console.log(`  ..  concurrent: exits ${a.code}/${b.code} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [n, r] of [["a", a], ["b", b]] as const) if (r.code !== 0) console.error(`      ${n}: ${r.err.split("\n").slice(0, 4).join("\n      ")}`);
    assert(a.code === 0 && b.code === 0, "concurrent cold boot: BOTH processes succeed (the loser adopts the winner's broker)");
    const adopted = [a, b].filter((r) => r.err.includes("adopting it")).length;
    console.log(`  ..  concurrent: ${adopted} of 2 took the adopt-after-non-zero path`);
    assert(await isReachable(server), "concurrent cold boot: one broker answers");
    for (const p of ourProcs()) try { process.kill(p, "SIGTERM"); } catch { /* gone */ }
  }

  // ---- 5. the lifecycle lock under a cold boot's hold time ----
  {
    const { withFileLockAsync } = await import("../src/lock.ts");
    assert(
      LIFECYCLE_LOCK_HOLD_MS >= MESH_UP_TIMEOUT_MS + MESH_ADOPT_WAIT_MS + 20_000 + 15_000,
      "lifecycle lock: waiters outlast a full cold boot (cotal up + adopt wait + manager + hub)",
    );
    assert((LIFECYCLE_LOCK_OPTS.staleMs ?? 0) > (LIFECYCLE_LOCK_OPTS.maxWaitMs ?? Infinity), "lifecycle lock: a live holder is never aged out inside the wait window");
    const lock = join(base, "lifecycle.lock");
    writeFileSync(lock, String(process.pid)); // a LIVE holder…
    const old = (Date.now() - 90_000) / 1000;
    utimesSync(lock, old, old); // …past lock.ts's 60s default age-out
    let entered = 0;
    const notices: Array<number | undefined> = [];
    const waiter = withFileLockAsync(lock, async () => (entered = Date.now()), { ...LIFECYCLE_LOCK_OPTS, onWait: (h) => notices.push(h) });
    await new Promise((r) => setTimeout(r, 2600));
    assert(entered === 0, "lifecycle lock: a 90s-old lock held by a LIVE pid is waited out, not broken");
    assert(notices.length === 1 && notices[0] === process.pid, "lifecycle lock: the waiter says once that it is waiting, naming the holder pid");
    const released = Date.now();
    rmSync(lock);
    await waiter;
    assert(entered >= released, "lifecycle lock: the waiter proceeds once the holder releases");

    writeFileSync(lock, String(process.pid));
    let msg = "";
    try {
      await withFileLockAsync(lock, async () => {}, { maxWaitMs: 100, staleMs: 600_000 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes(`held by pid ${process.pid}`), "lock timeout: the error names the holder pid");
    rmSync(lock, { force: true });
  }
} finally {
  for (const p of ourProcs()) try { process.kill(p, "SIGTERM"); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 300));
  for (const p of ourProcs()) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
  rmSync(base, { recursive: true, force: true });
}

if (failures) {
  console.error(`\ncheck:boot — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:boot — all passed");
process.exit(0);

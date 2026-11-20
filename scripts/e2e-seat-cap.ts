/**
 * END-TO-END: the manager seat cap (src/seat-cap.ts, cotal 0.103 `seatCap`) on a FULLY ISOLATED stack (own
 * nats-server, PAW_HOME, space, cotal root) with REAL haiku agents:
 *   1  PAW_MAX_SEATS=2 → the manager paw starts carries `--seat-cap 2`
 *   2  two agents start; a third is refused by the manager — paw's error is the seat-cap problem line,
 *      and the CLI (`paw open <folder> --no-attach`) prints it and exits non-zero
 *   3  stopping one frees a seat: the third starts
 *   4  the cap changed (env unset) → `paw restart` plans a FULL restart naming the seat cap
 *
 *   PAW_HOME=$(cd "$(mktemp -d /tmp/pah.XXXX)" && pwd -P) PAW_SPACE=test-seatcap-$$ PAW_RELEASE=dev \
 *   PAW_COTAL_ROOT=$(cd "$(mktemp -d /tmp/pac.XXXX)" && pwd -P) node scripts/e2e-seat-cap.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("test-seatcap") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=test-seatcap-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
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
process.env.PAW_ALLOW_ANY_CWD = "1";
process.env.PAW_MAX_SEATS = "2";
for (const k of ["COTAL_NAME", "COTAL_SPACE"]) delete process.env[k];
const nats = spawn(NATS, ["-js", "-p", String(natsPort), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawseatjs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.ts");
const { ensureAgentSpawned, setFolderName } = await import("../src/addressing.ts");
const { actualManagerSeatCap, ensure, managerProcs, stop } = await import("../src/lifecycle.ts");
const { meshAgentSession } = await import("../src/named.ts");
const { pawServer } = await import("../src/server.ts");
const { sanitizePath } = await import("../src/teleport-memory.ts");
const { purgeTestSpace } = await import("../src/prune.ts");
const { planRestart } = await import("../src/manager-fingerprint.ts");
const { resolveSeatCap } = await import("../src/seat-cap.ts");

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
const ctl = new ManagerControl(space, pawServer());
const live = async () => {
  const ps = await ctl.ps();
  return ps.ok ? ((ps.data as Array<{ name: string }>) ?? []).map((r) => r.name) : [];
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "pawseat-")));
const names = ["cap-a", "cap-b", "cap-c"];
const dirs = Object.fromEntries(names.map((n) => [n, join(base, n)]));
for (const d of Object.values(dirs)) mkdirSync(d);
const proj = (p: string) => join(homedir(), ".claude", "projects", sanitizePath(p));

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
  ok("1 the manager runs with --seat-cap 2", actualManagerSeatCap(space) === 2, `seat cap ${actualManagerSeatCap(space)}`);

  for (const n of ["cap-a", "cap-b"]) {
    setFolderName(space, dirs[n], n);
    const r = await ensureAgentSpawned(ctl, { space, name: n, cwd: dirs[n] });
    ok(`2 ${n} started`, r.spawned || !!r.id);
  }
  setFolderName(space, dirs["cap-c"], "cap-c");
  let refusal = "";
  try {
    await ensureAgentSpawned(ctl, { space, name: "cap-c", cwd: dirs["cap-c"] });
  } catch (e) {
    refusal = (e as Error).message;
  }
  console.log(`    library error:\n      ${refusal}`);
  ok("2 the third is refused at the seat cap", /seat cap \(2 of 2 live agents\)/.test(refusal) && /nothing was launched/.test(refusal));
  ok("2 nothing of cap-c runs", !(await live()).includes("cap-c"));
  const cli = await paw("open", dirs["cap-c"], "--no-attach");
  console.log(`    \`paw open <cap-c> --no-attach\` exit ${cli.code}:\n${show(cli)}`);
  ok("2 the CLI prints the refusal and exits non-zero", cli.code !== 0 && /seat cap/.test(cli.out + cli.err));

  const stopped = await paw("stop", "cap-a");
  ok("3 stop cap-a", stopped.code === 0, show(stopped));
  await until(async () => ((await live()).includes("cap-a") ? undefined : true), 30_000);
  const r3 = await ensureAgentSpawned(ctl, { space, name: "cap-c", cwd: dirs["cap-c"] }).catch((e: Error) => e);
  ok("3 a freed seat admits cap-c", !(r3 instanceof Error), r3 instanceof Error ? r3.message : "");

  delete process.env.PAW_MAX_SEATS;
  const plan = await planRestart({
    full: false,
    pendingRevive: false,
    managerPids: managerProcs(space),
    managerRoot: "/r/releases/a",
    targetRoot: "/r/releases/a",
    runningRuntime: "pty",
    preferredRuntime: "pty",
    runningSeatCap: actualManagerSeatCap(space),
    preferredSeatCap: resolveSeatCap(space),
    releaseOf: () => "a",
    fingerprintOf: () => "f",
    managerAnswers: async () => true,
  });
  ok("4 a changed cap plans a full restart", plan.kind === "full" && /seat cap 2/.test(plan.why), JSON.stringify(plan));
} catch (e) {
  fails++;
  console.error("✗ e2e aborted:", (e as Error).stack ?? e);
} finally {
  for (const n of names) await ctl.despawn(n).catch(() => {});
  await ctl.close();
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  for (const n of names) {
    const s = meshAgentSession(space, n);
    if (s) process.kill(s.pid, "SIGTERM");
  }
  const named = () => execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).includes(`--space ${space}`);
  await until(() => !named() || undefined, 30_000);
  await purgeTestSpace(space, pawServer()).catch((e) => {
    fails++;
    console.error("✗ purge:", (e as Error).message);
  });
  removeMesh(space);
  nats.kill("SIGTERM");
  for (const d of Object.values(dirs)) rmSync(proj(d), { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failure(s)` : "\nall seat-cap e2e checks passed");
process.exit(fails ? 1 : 0);

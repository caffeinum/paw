/**
 * END-TO-END `paw doctor` on the real wire, on an ISOLATED broker of its own (refuses anything else):
 *
 *   1. own nats-server (PAW_SERVER) + ensure() → mesh, manager, mailbox in a test space (no claude agent);
 *   2. `paw doctor --space <s>` → broker ✓, manager ✓ answers (0 agents), mailbox ✓, presence ✓, under 3s;
 *   3. a stale `spawn.x.lock` (dead pid) → `--fix` removes it;
 *   4. the manager SIGSTOPped → manager ✕ "isn't answering", the restart command printed, and the manager
 *      NOT touched (same pid, still stopped) — then SIGCONT.
 *   Teardown: paw down, purgeTestSpace, removeMesh, stop nats, rm the tmp dirs.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=doctor-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) COTAL_HOME=$(mktemp -d) node scripts/e2e-doctor.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("doctor-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.COTAL_HOME)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=doctor-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, COTAL_HOME");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), "pawdoctorjs-"));
const natsBin = spawnSync("sh", ["-c", "command -v nats-server"], { encoding: "utf8" }).stdout.trim() || join(homedir(), ".local", "share", "nats", "nats-server");
if (!existsSync(natsBin)) throw new Error(`no nats-server on PATH or at ${natsBin}`);
const nats: ChildProcess = spawn(natsBin, ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", storeDir], { stdio: "ignore" });

const { ensure, stop, managerMatchPattern } = await import("../src/lifecycle.ts");
const { purgeTestSpace } = await import("../src/prune.ts");
const { removeMesh } = await import("@cotal-ai/workspace");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const doctor = (...args: string[]) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(REPO, "bin/paw.ts"), "doctor", "--space", space, ...args], { env: process.env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
};
const row = (out: string, id: string) => out.split("\n").find((l) => new RegExp(`^  . ${id.replace(".", "\\.")} `).test(l)) ?? "";
const managerPid = (): number | undefined => {
  const r = spawnSync("pgrep", ["-f", managerMatchPattern(space)], { encoding: "utf8" });
  return r.stdout.trim().split("\n").map(Number).find((n) => n > 0);
};

let stopped: number | undefined;
try {
  for (let i = 0; i < 40 && !(await new Promise<boolean>((r) => { const c = createServer().once("error", () => r(true)).listen(port, "127.0.0.1", () => c.close(() => r(false))); })); i++) await sleep(100);
  await ensure({ needMesh: true, needManager: true, space });
  await sleep(1500); // the mailbox comes up detached, ~1s

  const a = doctor();
  ok("broker ✓", row(a.out, "broker").includes("✓ broker") && row(a.out, "broker").includes("answers ("), row(a.out, "broker"));
  ok("manager ✓ answers (0 agents)", /✓ manager .*answers \(0 agents\)/.test(row(a.out, "manager")), row(a.out, "manager"));
  ok("mailbox ✓", /✓ mailbox +pid \d+, this PAW_HOME/.test(row(a.out, "mailbox")), row(a.out, "mailbox"));
  ok("presence ✓", row(a.out, "presence").includes("✓ presence         presence writes land"), row(a.out, "presence"));
  ok(`the default run under 3s (${a.ms}ms)`, a.ms < 3000);

  const dead = spawnSync("true").pid!;
  const lock = join(process.env.PAW_HOME!, "spaces", space, "spawn.x.lock");
  writeFileSync(lock, String(dead));
  const f = doctor("--fix");
  ok("--fix removes a stale spawn lock", !existsSync(lock) && f.out.includes(`${space}/locks`), f.out.split("\n").filter((l) => l.includes("locks")).join(" | "));

  const pid = managerPid();
  if (!pid) throw new Error("no manager pid to stop");
  process.kill(pid, "SIGSTOP");
  stopped = pid;
  const h = doctor();
  ok("a stopped manager is ✕ isn't answering", /✕ manager .*isn't answering/.test(row(h.out, "manager")), row(h.out, "manager"));
  ok("…with the restart command and its caveat", h.out.includes(`you: paw restart --full --space ${space}  (bounces every agent in ${space} — your go)`));
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  ok("…and doctor left it alone (same pid, still stopped)", managerPid() === pid && stat.startsWith("T"), `stat ${stat}`);
  ok(`the hung-manager run stays under 3.5s (${h.ms}ms)`, h.ms < 3500);
  process.kill(pid, "SIGCONT");
  stopped = undefined;
} finally {
  if (stopped) process.kill(stopped, "SIGCONT");
  await stop({ space }).catch((e: Error) => console.error(`teardown: paw down — ${e.message}`));
  await purgeTestSpace(space, process.env.PAW_SERVER!).catch((e: Error) => console.error(`teardown: purge — ${e.message}`));
  try {
    removeMesh(space);
  } catch (e) {
    console.error(`teardown: removeMesh — ${(e as Error).message}`);
  }
  nats.kill();
  rmSync(storeDir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e-doctor passed");
process.exit(fails ? 1 : 0);

/**
 * END-TO-END: an agent running OUTSIDE the current manager is reached, not duplicated (2026-10-05).
 *
 * cotal >=0.49 spares a stopped manager's agents and the next manager does not adopt them, so after a
 * manager restart `paw chat @evals` saw an empty ps, tried to start a second evals, and the two-writer
 * guard refused it. On a FULLY ISOLATED stack (own nats-server, PAW_HOME, space, cotal root, beads):
 *   1  spawn one REAL haiku agent under the manager (tmux runtime)
 *   2  SIGTERM the manager process only → the agent survives (spared), a fresh manager's ps lacks it
 *   3  `paw dm <folder>` reaches it WITHOUT spawning (same pid, the dim note, its PONG comes back)
 *   4  `paw chat <name>` (stdin piped) reaches it the same way
 *   5  `paw status --json` shows it live + unmanaged; the table says `live (unmanaged)`
 *   6  `paw restart <name>` re-adopts it: the old pid goes, the manager's ps lists it
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=unmanaged-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) \
 *   PAW_BEADS_DIR=$(mktemp -d) node scripts/e2e-unmanaged.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("unmanaged-test") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=unmanaged-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
const REPO = fileURLToPath(new URL("..", import.meta.url));
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
process.env.PAW_RUNTIME ??= "tmux";
const nats = spawn("nats-server", ["-js", "-p", String(natsPort), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawunjs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.ts");
const { ensureAgentSpawned, setFolderName } = await import("../src/addressing.ts");
const { ensure, stop, managerProcs } = await import("../src/lifecycle.ts");
const { meshAgentSession } = await import("../src/named.ts");
const { pawServer } = await import("../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return undefined;
};
const paw = (...args: string[]) => {
  try {
    return { out: execFileSync(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }), err: "" };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string };
    return { out: x.stdout ?? "", err: (x.stderr ?? "") + x.message, failed: true };
  }
};
const pawErr = (...args: string[]) =>
  new Promise<{ out: string; err: string; code: number | null }>((r) => {
    const p = spawn(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => r({ out, err, code }));
  });
const inboxHas = (token: string) => paw("inbox", "--json").out.includes(token);
const psNames = async () => {
  const ctl = new ManagerControl(space, pawServer());
  try {
    const ps = await ctl.ps();
    return ((ps.data as Array<{ name: string }>) ?? []).map((r) => r.name);
  } finally {
    await ctl.close();
  }
};

const name = "solo";
const strays = new Set<number>();
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

  // 1 ─ one real agent under the manager
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pawsolo-")));
  setFolderName(space, dir, name);
  const ctl = new ManagerControl(space, pawServer());
  const first = await ensureAgentSpawned(ctl, { space, name, cwd: dir });
  await ctl.close();
  ok("1 agent spawned under the manager", first.spawned);
  const before = meshAgentSession(space, name);
  ok("1 its claude process is found by COTAL_NAME/COTAL_SPACE", !!before, JSON.stringify(before));
  if (before) strays.add(before.pid);

  // 2 ─ kill the MANAGER only
  const mgr = managerProcs(space);
  for (const pid of mgr) process.kill(pid, "SIGTERM");
  await until(() => managerProcs(space).length === 0 || undefined, 20_000);
  ok("2 the manager is gone", managerProcs(space).length === 0, `was ${mgr.join(",")}`);
  await sleep(3000);
  ok("2 cotal 0.66.1 spared the tmux agent (its claude still runs)", !!before && alive(before.pid));
  await ensure({ needMesh: true, needManager: true, space });
  const fresh = await psNames();
  ok("2 the fresh manager's ps does NOT list it", !fresh.includes(name), JSON.stringify(fresh));

  // 3 ─ paw dm <folder> reaches it, no spawn
  const t3 = `PONG-${Math.random().toString(36).slice(2, 8)}`;
  const dm = await pawErr("dm", dir, `Reply by calling cotal_dm to "you" with exactly this text and nothing else: ${t3}`);
  ok("3 paw dm succeeded", dm.code === 0, dm.err.slice(-600));
  ok("3 it printed the unmanaged note", dm.err.includes(`${name} is running but not managed by the current manager — talking to it directly`), dm.err.slice(-600));
  ok("3 no two-writer refusal", !/won't start|can't start/.test(dm.err));
  ok("3 nothing was spawned: same pid, still not in ps", !!before && alive(before.pid) && meshAgentSession(space, name)?.pid === before.pid && !(await psNames()).includes(name));
  ok("3 the agent answered (its PONG is in the inbox)", !!(await until(() => inboxHas(t3) || undefined, 120_000)), t3);

  // 4 ─ paw chat <name> with piped stdin
  const t4 = `PONG-${Math.random().toString(36).slice(2, 8)}`;
  const chat = spawn(process.execPath, [join(REPO, "bin/paw.ts"), "chat", name], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let chatOut = "";
  chat.stdout.on("data", (d) => (chatOut += d));
  chat.stderr.on("data", (d) => (chatOut += d));
  await until(() => /talking to it directly|›|>/.test(chatOut) || undefined, 60_000);
  await sleep(2000);
  chat.stdin.write(`Reply by calling cotal_dm to "you" with exactly this text and nothing else: ${t4}\n`);
  const chatGot = await until(() => chatOut.includes(t4) || inboxHas(t4) || undefined, 120_000);
  chat.kill("SIGTERM");
  ok("4 paw chat reached it without a refusal", !/won't start|can't start/.test(chatOut), chatOut.slice(-600));
  ok("4 paw chat printed the unmanaged note", chatOut.includes("talking to it directly"));
  ok("4 its reply came back", !!chatGot, t4);
  ok("4 still the same process, still unmanaged", !!before && meshAgentSession(space, name)?.pid === before.pid && !(await psNames()).includes(name));

  // 5 ─ status
  const sj = JSON.parse(paw("status", "--json").out) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = Array.isArray(sj) ? sj : (sj.rows ?? []);
  const row = rows.find((r) => r.name === name);
  ok("5 status --json: live + unmanaged", row?.live === true && row?.unmanaged === true, JSON.stringify(row));
  const table = paw("status", name).out;
  ok("5 status table says live (unmanaged)", table.includes("live (unmanaged)"), table);

  // 6 ─ paw restart <name> re-adopts
  const rs = await pawErr("restart", name);
  ok("6 paw restart <name> succeeded", rs.code === 0, (rs.out + rs.err).slice(-600));
  const after = meshAgentSession(space, name);
  if (after) strays.add(after.pid);
  ok("6 the old process is gone, a new one runs", !!before && !alive(before.pid) && !!after && after.pid !== before.pid, `${before?.pid} → ${after?.pid}`);
  ok("6 the manager's ps lists it again", (await psNames()).includes(name));
} catch (e) {
  fails++;
  console.error("✗ e2e aborted:", (e as Error).stack ?? e);
} finally {
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  for (const pid of strays) if (alive(pid)) process.kill(pid, "SIGTERM");
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `\n${fails} failure(s)` : "\nall unmanaged-agent e2e checks passed");
process.exit(fails ? 1 : 0);

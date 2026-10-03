/**
 * END-TO-END cotal hub (PAW_COTAL_HUB=1) with REAL claude agents on an ISOLATED broker of its own.
 *
 *   1. its own nats-server on a free port (PAW_SERVER), ensure() → hub + manager + mailbox;
 *   2. three agents spawn with the shim as their cotal MCP server (no `node mcp.cjs` anywhere);
 *   3. DM → reply, and a #general broadcast wakes all three (claude/channel push through the hub);
 *   4. RAM: hub + shims, measured;
 *   5. IDENTITY ACROSS A HUB CRASH: SIGKILL the hub, DM every agent DURING the gap, all DMs answered
 *      and every agent's mesh id unchanged — then the same with the supervisor killed too, recovered
 *      by ensure() (what any paw command / the keeper tick does);
 *   6. paw status: every row live, inbox drained, no lag query errors;
 *   7. paw sleep: a slept agent's seat (and shim session) goes away, a DM wakes it, it answers;
 *   8. paw restart (the CLI, as the operator runs it): hub renewed, agents revived, DM answered;
 *   9. paw down: hub, shims, manager and mailbox all gone.
 *
 *   PAW_HOME=/tmp/<short> PAW_SPACE=hubtest-<n> PAW_RELEASE=dev PAW_COTAL_ROOT=<tmp> tsx scripts/e2e-hub.ts
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("hubtest") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=hubtest-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
process.env.PAW_COTAL_HUB = "1";
process.env.PAW_RUNTIME ??= "pty";
process.env.PAW_MODEL ??= "haiku";
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawhubjs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.js");
const { ensureAgentSpawned, personaFilePath, setFolderName, waitForPeerId } = await import("../src/addressing.js");
const { ensure, stop, hubProcs, managerProcs, mailboxProcs } = await import("../src/lifecycle.js");
const { hubSocketPath } = await import("../src/hub/paths.js");
const { liveSessionProcs } = await import("../src/named.js");
const { readResumeId, personaValue } = await import("../src/session.js");
const { collectStatus, inboxText } = await import("../src/status.js");
const { dmLastSeq, extraChannels, readActivity, sleepAgent, sleepDecision } = await import("../src/sleep.js");
const { isAsleep, standInHolder } = await import("../src/sleep-state.js");
const { pawServer } = await import("../src/server.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const ps = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }));
const footprintMb = (pid: number): number => {
  const out = spawnSync("footprint", [String(pid)], { encoding: "utf8" }).stdout ?? "";
  const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
  if (!m) return NaN;
  const v = Number(m[1]);
  return m[2] === "KB" ? v / 1024 : m[2] === "GB" ? v * 1024 : v;
};
const sock = hubSocketPath(space);
const shims = () => ps().filter((p) => p.cmd.includes("cotal-shim") && p.cmd.includes(sock));
const hubNodes = () => ps().filter((p) => hubProcs(space).includes(p.pid) && !p.cmd.startsWith("/bin/sh"));

const names = ["h1", "h2", "h3"];
const ctl = new ManagerControl(space, pawServer());
let prober: CotalEndpoint | undefined;
const inbox: Array<{ from: string; text: string }> = [];
const waitText = async (text: string, from?: string, ms = 180_000) => {
  for (let t = 0; t < ms; t += 500) {
    const hit = inbox.find((m) => m.text.includes(text) && (!from || m.from === from));
    if (hit) return hit;
    await sleep(500);
  }
  return undefined;
};
const idOf = (n: string) => prober!.getRoster().find((p) => p.card.name === n && p.status !== "offline")?.card.id;

try {
  for (let i = 0; i < 50; i++) {
    const r = spawnSync("nc", ["-z", "127.0.0.1", String(port)]);
    if (r.status === 0) break;
    await sleep(100);
  }
  await ensure({ needMesh: true, needManager: true, space });
  ok("ensure() started the hub under its supervisor", hubProcs(space).length >= 2, `pids ${hubProcs(space).join(",")}`);
  const dirs = new Map<string, string>();
  for (const n of names) {
    const d = mkdtempSync(join(tmpdir(), `pawhub-${n}-`));
    dirs.set(n, d);
    setFolderName(space, d, n);
  }
  // One at a time: three cold claudes at once on a loaded machine is a boot-time test, not a hub test.
  for (const n of names) await ensureAgentSpawned(ctl, { space, name: n, cwd: dirs.get(n)! });
  ok("three agents spawned", true);

  prober = new CotalEndpoint({ space, servers: pawServer(), channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ kind: string; text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();
  for (const n of names) await waitForPeerId(prober, n, 60_000);

  const claudePids = names.map((n) => liveSessionProcs(readResumeId(personaFilePath(space, n))!)[0]?.pid);
  const procs = ps();
  const kidsOf = (pid?: number) => procs.filter((p) => p.ppid === pid).map((p) => p.cmd);
  ok("every claude's cotal MCP server is the shim", claudePids.every((pid) => kidsOf(pid).some((c) => c.includes("cotal-shim") && c.includes(sock))), JSON.stringify(claudePids));
  ok("no claude runs `node mcp.cjs`", claudePids.every((pid) => !kidsOf(pid).some((c) => c.includes("mcp.cjs"))));

  // ── 3. DM + channel wake ─────────────────────────────────────────────────────────────────────
  for (const n of names) await prober.unicast(idOf(n)!, `Reply to prober with cotal_dm saying exactly READY-${n}, nothing else.`);
  for (const n of names) ok(`DM → ${n} answered through the hub`, !!(await waitText(`READY-${n}`, n)));
  await sleep(4000);
  await prober.multicast("Everyone on #general: reply to prober with cotal_dm saying exactly GEN-<your name>, nothing else.", { channel: "general" });
  for (const n of names) ok(`#general broadcast woke ${n}`, !!(await waitText(`GEN-${n}`, n)));

  // ── 4. RAM ───────────────────────────────────────────────────────────────────────────────────
  const hubMb = hubNodes().map((p) => footprintMb(p.pid)).reduce((a, b) => a + b, 0);
  const shimMb = shims().map((p) => footprintMb(p.pid));
  console.log(`  RAM (phys_footprint): hub processes ${hubMb.toFixed(1)} MB [${hubNodes().map((p) => `${p.pid}:${footprintMb(p.pid)}MB`).join(" ")}]; shims ${shimMb.map((m) => m.toFixed(1)).join(" + ")} MB`);

  // ── 5. identity across a hub crash ───────────────────────────────────────────────────────────
  await sleep(5000);
  const idsBefore = Object.fromEntries(names.map((n) => [n, idOf(n)]));
  const seqBefore = await dmLastSeq(space);
  for (const p of hubNodes()) process.kill(p.pid, "SIGKILL");
  const tKill = Date.now();
  for (const n of names) await prober.unicast(idsBefore[n]!, `Reply to prober with cotal_dm saying exactly GAP1-${n}, nothing else.`);
  console.log(`  hub SIGKILLed; 3 DMs sent ${Date.now() - tKill}ms into the gap (stream seq ${seqBefore} → ${await dmLastSeq(space)})`);
  for (const n of names) ok(`DM sent during a hub crash reached ${n}`, !!(await waitText(`GAP1-${n}`, n)));
  await sleep(3000);
  for (const n of names) ok(`${n} kept its mesh identity across the hub restart`, idOf(n) === idsBefore[n], `${idsBefore[n]} → ${idOf(n)}`);

  // supervisor gone too: only ensure() (any paw command, the keeper tick) brings it back
  for (const pid of hubProcs(space)) process.kill(pid, "SIGKILL");
  await sleep(500);
  ok("hub + supervisor fully down", hubProcs(space).length === 0);
  for (const n of names) await prober.unicast(idsBefore[n]!, `Reply to prober with cotal_dm saying exactly GAP2-${n}, nothing else.`);
  await sleep(10_000);
  await ensure({ needMesh: true, needManager: true, space });
  ok("ensure() restarted the hub", hubProcs(space).length >= 2);
  for (const n of names) ok(`DM sent while NO hub ran (10s) reached ${n}`, !!(await waitText(`GAP2-${n}`, n)));

  // ── 6. paw status ────────────────────────────────────────────────────────────────────────────
  await sleep(8000);
  const st = await collectStatus(space, ctl, { git: false });
  for (const n of names) {
    const r = st.rows.find((x) => x.name === n);
    ok(`paw status: ${n} live, inbox ${r ? inboxText(r.inbox) : "?"}`, !!r?.live && r !== undefined && inboxText(r.inbox) === "✓", r ? `${r.mesh}` : "no row");
  }
  ok("paw status: no inbox-lag query errors", st.errors.length === 0, st.errors.join("; "));

  // ── 7. paw sleep ─────────────────────────────────────────────────────────────────────────────
  const s = "h3";
  const pin = readResumeId(personaFilePath(space, s))!;
  const row = (await collectStatus(space, ctl, { git: false })).rows.find((r) => r.name === s)!;
  const decision = sleepDecision(row, 0, Date.now(), readActivity(pin), extraChannels(personaValue(personaFilePath(space, s), "subscribe")));
  ok("sleep gate passes for idle h3", decision.sleep, decision.reason);
  await sleepAgent(space, ctl, s, "e2e-hub", { cursorSeq: await dmLastSeq(space), snapshotActiveMs: row.activeMs });
  for (let i = 0; i < 30 && standInHolder(space, s) === undefined; i++) await sleep(1000);
  ok("h3 asleep with a stand-in", isAsleep(space, s) && standInHolder(space, s) !== undefined);
  await sleep(4000);
  ok("h3's claude and its shim are gone", liveSessionProcs(pin).length === 0 && shims().length === 2, `${shims().length} shims`);
  const standIn = prober.getRoster().find((p) => p.card.name === s && p.status !== "offline")?.card.id;
  await prober.unicast(standIn!, `Reply to prober with cotal_dm saying exactly WOKE-${s}, nothing else.`);
  ok("a DM woke h3 and it answered through the hub", !!(await waitText(`WOKE-${s}`, s, 300_000)));
  ok("woken h3 is back on a shim", shims().length === 3, `${shims().length} shims`);

  // ── 8. paw restart (the CLI) ─────────────────────────────────────────────────────────────────
  const hubBefore = hubNodes().map((p) => p.pid).join();
  const tsx = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const rr = spawnSync(process.execPath, [tsx, join(REPO, "bin", "paw.ts"), "restart", "--space", space], { encoding: "utf8", env: process.env, timeout: 300_000 });
  ok("paw restart exited 0", rr.status === 0, (rr.stderr ?? "").split("\n").slice(-4).join(" | "));
  ok("paw restart renewed the hub", hubNodes().length > 0 && hubNodes().map((p) => p.pid).join() !== hubBefore);
  for (const n of names) await waitForPeerId(prober, n, 120_000).catch(() => undefined);
  await sleep(3000);
  await prober.unicast(idOf("h1")!, "Reply to prober with cotal_dm saying exactly AFTER-RESTART, nothing else.");
  ok("after paw restart a revived agent answers through the new hub", !!(await waitText("AFTER-RESTART", "h1")));
  ok("revived agents are on shims", shims().length === 3, `${shims().length} shims`);

  // ── 9. paw down ──────────────────────────────────────────────────────────────────────────────
  await prober.stop();
  prober = undefined;
  await ctl.close();
  await stop({ space });
  await sleep(3000);
  ok("paw down: hub + supervisor gone", hubProcs(space).length === 0);
  ok("paw down: no shim left", shims().length === 0, `${shims().length}`);
  ok("paw down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
} finally {
  await prober?.stop().catch(() => {});
  await ctl.close().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

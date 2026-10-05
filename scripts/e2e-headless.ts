/**
 * END-TO-END headless agents (docs/notes/headless.md) with REAL claudes on an ISOLATED broker.
 *
 *   1. own nats-server (PAW_SERVER), `paw hub on`, ensure() → hub + manager + mailbox;
 *   2. two agents, same prompts: `hl` (persona `headless: true`) and `tui` (the default TUI);
 *   3. hl runs `claude -p` stream-json, no TUI; its cotal MCP server is the hub shim;
 *   4. DM → reply for both; presence: hl shows working during a turn, idle after;
 *   5. queueing: two DMs sent while hl is mid-turn are both answered, in ONE extra turn;
 *   6. durable pin: hl remembers a word across a restart (`--resume`), launched with --session-id first;
 *   7. paw log reads hl's transcript; paw open/attach refuses with the headless note;
 *   8. RAM: phys_footprint of each agent's claude + its children, after the same turns.
 *
 *   PAW_HOME=/tmp/<short> PAW_SPACE=headless-test-<n> PAW_RELEASE=dev PAW_COTAL_ROOT=<tmp> tsx scripts/e2e-headless.ts
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("headless-test") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=headless-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
delete process.env.PAW_COTAL_HUB;
process.env.PAW_RUNTIME = "pty"; // no tmux server touched at all
process.env.PAW_MODEL ??= "haiku";
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawhljs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.ts");
const { ensureAgentSpawned, ensurePersonaFile, personaFilePath, setFolderName, setPersonaKeys, waitForPeerId } = await import("../src/addressing.ts");
const { ensure, stop, hubProcs, managerProcs, mailboxProcs } = await import("../src/lifecycle.ts");
const { headlessDir } = await import("../src/hub/paths.ts");
const { isResult } = await import("../src/hub/headless.mjs");
const { liveSessionProcs } = await import("../src/named.ts");
const { readResumeId } = await import("../src/session.ts");
const { pawServer } = await import("../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const ps = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssMb: Number(m[3]) / 1024, cmd: m[4]! }));
const footprintMb = (pid: number): number => {
  const out = spawnSync("footprint", [String(pid)], { encoding: "utf8" }).stdout ?? "";
  const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
  if (!m) return NaN;
  const v = Number(m[1]);
  return m[2] === "KB" ? v / 1024 : m[2] === "GB" ? v * 1024 : v;
};
/** pid + every descendant, with footprint and rss. */
const tree = (root: number) => {
  const all = ps();
  const out: Array<{ pid: number; cmd: string; fp: number; rss: number }> = [];
  const walk = (pid: number) => {
    const p = all.find((x) => x.pid === pid);
    if (!p) return;
    out.push({ pid, cmd: p.cmd.slice(0, 60), fp: footprintMb(pid), rss: p.rssMb });
    for (const k of all.filter((x) => x.ppid === pid)) walk(k.pid);
  };
  walk(root);
  return out;
};
const ram = (label: string, root: number | undefined) => {
  if (!root) return console.log(`  RAM ${label}: no pid`);
  const t = tree(root);
  // The steady cost is claude + its cotal shim. Other descendants are the operator's own global
  // hooks (npm/bun/git… from ~/.claude/settings.json), transient and identical in both modes.
  const steady = t.filter((x) => x.pid === root || x.cmd.includes("cotal-shim"));
  const fp = steady.reduce((a, b) => a + b.fp, 0);
  const rss = steady.reduce((a, b) => a + b.rss, 0);
  console.log(`  RAM ${label}: claude+shim footprint ${fp.toFixed(1)} MB, rss ${rss.toFixed(1)} MB  [all descendants: ${t.map((x) => `${x.cmd.split(" ")[0]!.split("/").pop()} fp=${x.fp.toFixed(1)} rss=${x.rss.toFixed(1)}`).join(" · ")}]`);
  return { fp, rss };
};

const names = ["hl", "tui"];
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
const peer = (n: string) => prober!.getRoster().find((p) => p.card.name === n && p.status !== "offline");
const claudePid = (n: string) => liveSessionProcs(readResumeId(personaFilePath(space, n))!)[0]?.pid;
const results = () => readFileSync(join(headlessDir(space, "hl"), "out.jsonl"), "utf8").split("\n").filter(isResult).length;

try {
  for (let i = 0; i < 50; i++) {
    if (spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0) break;
    await sleep(100);
  }
  const cli = (...a: string[]) => spawnSync(process.execPath, [join(REPO, "bin", "paw.mjs"), ...a, "--space", space], { encoding: "utf8", env: process.env, timeout: 300_000 });
  const on = cli("hub", "on");
  ok("`paw hub on`", on.status === 0, (on.stdout + on.stderr).split("\n").slice(-3).join(" | "));
  await ensure({ needMesh: true, needManager: true, space });
  const dirs = new Map<string, string>();
  for (const n of names) {
    const d = mkdtempSync(join(tmpdir(), `pawhl-${n}-`));
    dirs.set(n, d);
    setFolderName(space, d, n);
    ensurePersonaFile(space, n);
  }
  setPersonaKeys(space, "hl", { headless: "true" });

  prober = new CotalEndpoint({ space, servers: pawServer(), channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ kind: string; text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();

  const t0 = Date.now();
  await ensureAgentSpawned(ctl, { space, name: "hl", cwd: dirs.get("hl")! });
  await waitForPeerId(prober, "hl", 60_000);
  console.log(`  hl on the mesh after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const t1 = Date.now();
  await ensureAgentSpawned(ctl, { space, name: "tui", cwd: dirs.get("tui")! });
  await waitForPeerId(prober, "tui", 60_000);
  console.log(`  tui on the mesh after ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // ── 3. shape ─────────────────────────────────────────────────────────────────────────────────
  const hlPid = claudePid("hl");
  const hlCmd = ps().find((p) => p.pid === hlPid)?.cmd ?? "";
  ok("hl is `claude -p` stream-json", / -p --input-format stream-json --output-format stream-json/.test(hlCmd), hlCmd.slice(0, 160));
  ok("hl launched with --session-id on first boot", hlCmd.includes(`--session-id ${readResumeId(personaFilePath(space, "hl"))}`));
  ok("hl's cotal MCP server is the hub shim", ps().some((p) => p.ppid === hlPid && p.cmd.includes("cotal-shim")));
  const tuiCmd = ps().find((p) => p.pid === claudePid("tui"))?.cmd ?? "";
  ok("tui is the TUI (no -p)", !!tuiCmd && !/ -p /.test(tuiCmd));
  ram("hl at boot (idle, 0 turns)", hlPid);
  ram("tui at boot (idle, 0 turns)", claudePid("tui"));

  // ── 4. DM + presence ─────────────────────────────────────────────────────────────────────────
  for (const n of names) await prober.unicast(peer(n)!.card.id, `Reply to prober with cotal_dm saying exactly READY-${n}, nothing else.`);
  for (const n of names) ok(`DM → ${n} answered`, !!(await waitText(`READY-${n}`, n)));
  await sleep(3000);
  ok("hl idle after its turn", peer("hl")?.status === "idle", peer("hl")?.status);

  // ── 5. busy turn + queueing ──────────────────────────────────────────────────────────────────
  const before = results();
  await prober.unicast(peer("hl")!.card.id, "Run the shell command `sleep 20` with your Bash tool, then reply to prober with cotal_dm saying exactly SLEPT, nothing else.");
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    seen.add(peer("hl")?.status ?? "?");
    if (seen.has("working")) break;
    await sleep(500);
  }
  ok("hl shows working during a turn", seen.has("working"), [...seen].join(","));
  await sleep(4000);
  await prober.unicast(peer("hl")!.card.id, "Reply to prober with cotal_dm saying exactly Q1, nothing else.");
  await prober.unicast(peer("hl")!.card.id, "Reply to prober with cotal_dm saying exactly Q2, nothing else.");
  ok("hl answered the busy turn", !!(await waitText("SLEPT", "hl")));
  ok("hl answered Q1 (sent mid-turn)", !!(await waitText("Q1", "hl")));
  ok("hl answered Q2 (sent mid-turn)", !!(await waitText("Q2", "hl")));
  await sleep(5000);
  const turns = results() - before;
  ok("mid-turn DMs coalesced: the busy turn + ONE turn for both queued DMs", turns >= 1 && turns <= 2, `${turns} turns`);
  ok("hl idle again", peer("hl")?.status === "idle", peer("hl")?.status);
  // same work for tui, so the RAM comparison is at similar context
  await prober.unicast(peer("tui")!.card.id, "Run the shell command `sleep 20` with your Bash tool, then reply to prober with cotal_dm saying exactly SLEPT, nothing else.");
  await sleep(4000);
  await prober.unicast(peer("tui")!.card.id, "Reply to prober with cotal_dm saying exactly Q1, nothing else.");
  await prober.unicast(peer("tui")!.card.id, "Reply to prober with cotal_dm saying exactly Q2, nothing else.");
  ok("tui answered all three", !!(await waitText("SLEPT", "tui")) && !!(await waitText("Q1", "tui")) && !!(await waitText("Q2", "tui")));

  // ── 6. durable pin across a restart ──────────────────────────────────────────────────────────
  await prober.unicast(peer("hl")!.card.id, "Remember the code word MANGO-7. Reply to prober with cotal_dm saying exactly NOTED, nothing else.");
  ok("hl noted the word", !!(await waitText("NOTED", "hl")));
  await sleep(4000);
  await sleep(8000); // let both settle before measuring
  const rHl = ram("hl after 5 DMs + a Bash turn", claudePid("hl"));
  const rTui = ram("tui after 4 DMs + a Bash turn", claudePid("tui"));
  if (rHl && rTui) console.log(`  SAVING per agent: footprint ${(rTui.fp - rHl.fp).toFixed(1)} MB, rss ${(rTui.rss - rHl.rss).toFixed(1)} MB`);
  console.log(`  out.jsonl ${statSync(join(headlessDir(space, "hl"), "out.jsonl")).size} bytes`);
  const hub = hubProcs(space).filter((p) => !ps().find((x) => x.pid === p)?.cmd.startsWith("/bin/sh"));
  console.log(`  hub (shared by every agent): ${hub.map((p) => `${p} fp=${footprintMb(p).toFixed(1)}MB`).join(" ")}`);

  const rr = cli("restart", "hl");
  ok("paw restart hl", rr.status === 0, (rr.stdout + rr.stderr).trim().split("\n").slice(-2).join(" | "));
  await waitForPeerId(prober, "hl", 120_000).catch(() => undefined);
  await sleep(3000);
  const hlCmd2 = ps().find((p) => p.pid === claudePid("hl"))?.cmd ?? "";
  ok("restarted hl resumes its pin (--resume)", hlCmd2.includes(`--resume ${readResumeId(personaFilePath(space, "hl"))}`), hlCmd2.slice(0, 200));
  await prober.unicast(peer("hl")!.card.id, "What code word did I ask you to remember? Reply to prober with cotal_dm saying only the word.");
  ok("hl remembers across the restart", !!(await waitText("MANGO-7", "hl")));

  // ── 7. log + open ────────────────────────────────────────────────────────────────────────────
  const lg = cli("log", "hl", "--tail", "5");
  ok("paw log hl reads the transcript", lg.status === 0 && lg.stdout.length > 0, (lg.stdout + lg.stderr).trim().split("\n").slice(-2).join(" | "));
  const op = cli("open", "hl");
  ok("paw open hl says it is headless", /is headless/.test(op.stdout), (op.stdout + op.stderr).trim().slice(0, 200));

  await prober.stop();
  prober = undefined;
  await ctl.close();
  await stop({ space });
  await sleep(3000);
  ok("down: hub, manager, mailbox gone", hubProcs(space).length === 0 && managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  ok("down: no headless claude left", !claudePid("hl"));
} finally {
  await prober?.stop().catch(() => {});
  await ctl.close().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

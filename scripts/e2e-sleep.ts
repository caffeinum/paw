/**
 * END-TO-END `paw sleep` with REAL claude agents in an ISOLATED space (refuses anything else):
 *  1. spawn "sleeper" and "caller"; measure sleeper's RSS (claude + its process tree);
 *  2. put sleeper to sleep through the same gate the sweep uses (`--now` semantics: no idle threshold);
 *  3. wait for the sleep host (inside the mailbox daemon) to raise sleeper's stand-in;
 *  4. ask CALLER (an agent) to `cotal_dm("sleeper", …)` — the agent-to-agent path the operator requires;
 *  5. the DM must wake sleeper and sleeper must answer (it DMs the prober a token).
 *
 *   PAW_HOME=<tmp> PAW_SPACE=sleeptest-<n> PAW_RELEASE=dev PAW_COTAL_ROOT=<tmp> tsx scripts/e2e-sleep.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, resolvePeer } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";
import { ManagerControl } from "../src/control.js";
import { ensureAgentSpawned, personaFilePath, setFolderName, waitForPeerId } from "../src/addressing.js";
import { ensure, stop } from "../src/lifecycle.js";
import { liveSessionProcs } from "../src/named.js";
import { readResumeId } from "../src/session.js";
import { collectStatus } from "../src/status.js";
import { dmLastSeq, extraChannels, readActivity, sleepAgent, sleepDecision } from "../src/sleep.js";
import { isAsleep, readWakingRecord, standInHolder, writeSleepRecord } from "../src/sleep-state.js";
import { personaValue } from "../src/session.js";
import { pawServer } from "../src/server.js";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("sleeptest") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT) {
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=sleeptest-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
}
process.env.PAW_RUNTIME ??= "pty";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};

/** RSS (MB) of `pid` and every descendant. */
function treeRssMb(pid: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 3 && r.every(Number.isFinite));
  const kids = new Map<number, number[]>();
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const rss = new Map(rows.map(([p, , r]) => [p, r]));
  let total = 0;
  const walk = (p: number) => {
    total += rss.get(p) ?? 0;
    for (const k of kids.get(p) ?? []) walk(k);
  };
  walk(pid);
  return Math.round(total / 1024);
}
const vmFreeMb = () => {
  const out = execFileSync("vm_stat", { encoding: "utf8" });
  const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
  const n = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  return Math.round(((n("Pages free") + n("Pages speculative")) * page) / 1048576);
};

const ctl = new ManagerControl(space, pawServer());
let prober: CotalEndpoint | undefined;
try {
  await ensure({ needMesh: true, needManager: true, space });
  await sleep(3000);
  const sleeperDir = mkdtempSync(join(tmpdir(), "pawsleeper-"));
  const callerDir = mkdtempSync(join(tmpdir(), "pawcaller-"));
  const sleeper = setFolderName(space, sleeperDir, "sleeper").name;
  const caller = setFolderName(space, callerDir, "caller").name;
  await Promise.all([ensureAgentSpawned(ctl, { space, name: sleeper, cwd: sleeperDir }), ensureAgentSpawned(ctl, { space, name: caller, cwd: callerDir })]);
  ok("both agents spawned", true);

  prober = new CotalEndpoint({ space, servers: pawServer(), channels: [], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint" } });
  prober.on("error", () => {});
  const inbox: Array<{ from: string; text: string }> = [];
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ kind: string; text?: string }> }) =>
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") }),
  );
  await prober.start();

  // Give sleeper one quick turn so it has a transcript (a never-used session can't be judged idle).
  const sleeperId = await waitForPeerId(prober, sleeper, 30_000);
  await prober.unicast(sleeperId!, "Reply to prober with cotal_dm saying exactly READY1, nothing else.");
  for (let i = 0; i < 120 && !inbox.some((m) => m.text.includes("READY1")); i++) await sleep(1000);
  ok("sleeper answered before sleeping", inbox.some((m) => m.text.includes("READY1")));
  await sleep(5000); // let the turn close

  const pin = readResumeId(personaFilePath(space, sleeper))!;
  const proc = liveSessionProcs(pin)[0];
  const rssBefore = treeRssMb(proc.pid);
  const freeBefore = vmFreeMb();
  console.log(`  sleeper claude pid ${proc.pid}, tree RSS ${rssBefore} MB, system free ${freeBefore} MB`);

  const cursorSeq = await dmLastSeq(space);
  const { rows } = await collectStatus(space, ctl, { git: false });
  const row = rows.find((r) => r.name === sleeper)!;
  const activity = readActivity(pin);
  const d = sleepDecision(row, 0, Date.now(), activity, extraChannels(personaValue(personaFilePath(space, sleeper), "subscribe")));
  ok("sleep gate passes for an idle agent with nothing running", d.sleep, d.reason);
  const stale = await sleepAgent(space, ctl, sleeper, "e2e", { cursorSeq, snapshotActiveMs: (row.activeMs ?? 0) - 1 }).then(
    () => "slept",
    (e: Error) => e.message,
  );
  ok("#2 a snapshot the transcript moved past aborts the despawn", stale.includes("written after the decision"), stale);
  await sleepAgent(space, ctl, sleeper, "e2e", { cursorSeq, snapshotActiveMs: row.activeMs });
  ok("record written", isAsleep(space, sleeper));
  for (let i = 0; i < 30 && standInHolder(space, sleeper) === undefined; i++) await sleep(1000);
  ok("stand-in raised by the mailbox's sleep host", standInHolder(space, sleeper) !== undefined);
  await sleep(4000);
  const gone = liveSessionProcs(pin).length === 0;
  ok("sleeper's claude process is gone", gone);
  console.log(`  freed: sleeper tree was ${rssBefore} MB; system free ${freeBefore} → ${vmFreeMb()} MB (noisy)`);
  const status = (await collectStatus(space, ctl, { git: false })).rows.find((r) => r.name === sleeper);
  ok("paw status reads asleep", status?.mesh === "asleep", status?.mesh);

  // The agent-to-agent DM. CALLER resolves "sleeper" through its own roster (the stand-in).
  const token = `WOKE${Date.now() % 100000}`;
  const callerId = await waitForPeerId(prober, caller, 30_000);
  await prober.unicast(
    callerId!,
    `Use your cotal_dm tool to send the agent named "sleeper" this exact message: "Reply to prober with cotal_dm saying exactly ${token}, nothing else." Then reply to prober with cotal_dm saying SENT (or the exact error if the DM failed).`,
  );
  const t0 = Date.now();
  // #3: watch the name through the wake — it must never be missing from the roster during the boot.
  let deadMs = 0;
  let ambiguousMs = 0;
  for (let i = 0; i < 1200 && !inbox.some((m) => m.text.includes(token)); i++) {
    // Exactly the lookup a sender's cotal_dm does: undefined = "no peer", a throw = ambiguous.
    try {
      if (!resolvePeer(prober.getRoster(), sleeper)) deadMs += 250;
    } catch {
      ambiguousMs += 250;
    }
    await sleep(250);
  }
  console.log(`  during the wake: name unresolvable ~${deadMs}ms, ambiguous ~${ambiguousMs}ms (250ms sampling)`);
  // "no peer" never happens. A brief AMBIGUOUS window is inherent while the stand-in yields the name
  // (offline) for the hard-pinned spawn: a watcher that saw the old seat leave still holds it offline too
  // (core marks a deleted presence key offline, never removes it), so two offline rows share the name
  // until the new seat goes live. Loud (AmbiguousPeerError to the sender), never a silent loss — bounded here.
  ok("#3 the name never went missing during the wake", deadMs === 0, `dead ${deadMs}ms`);
  ok("#3 the ambiguous window is bounded to the boot", ambiguousMs < 15_000, `ambiguous ${ambiguousMs}ms`);
  const callerSaid = inbox.filter((m) => m.from === caller).map((m) => m.text);
  console.log(`  caller said: ${JSON.stringify(callerSaid)}`);
  const answer = inbox.find((m) => m.text.includes(token));
  ok("a DM from another agent woke sleeper and it answered", answer?.from === sleeper, answer ? `${answer.from} in ${Math.round((Date.now() - t0) / 1000)}s` : "no answer in 300s");
  ok("sleep record cleared", !isAsleep(space, sleeper) && standInHolder(space, sleeper) === undefined);
  const newProc = liveSessionProcs(pin)[0];
  if (newProc) console.log(`  woken sleeper tree RSS ${treeRssMb(newProc.pid)} MB (resumed the same session ${pin})`);
  // Follow-up 1: a sleep record beside a LIVE seat (what a late boot / `paw claude` leaves behind). The
  // host raises a stand-in for it, then its 15s reconcile must notice the live seat and treat it as woken.
  await sleep(5000);
  writeSleepRecord(space, { name: caller, folder: callerDir, since: Date.now(), cursorSeq: await dmLastSeq(space), reason: "e2e: record + live seat" });
  let reconciled = false;
  for (let i = 0; i < 60 && !reconciled; i++) {
    await sleep(1000);
    reconciled = !isAsleep(space, caller) && !readWakingRecord(space, caller) && standInHolder(space, caller) === undefined;
  }
  ok("F1 a sleep record beside a live seat is reconciled (stand-in lowered, record cleared)", reconciled);
  await sleep(2000);
  let unambiguous = true;
  try {
    resolvePeer(prober.getRoster(), caller);
  } catch {
    unambiguous = false;
  }
  ok("F1 the live seat's name resolves unambiguously afterwards", unambiguous);
  console.log(readFileSync(join(process.env.PAW_HOME!, "spaces", space, "sleep.log"), "utf8"));
} finally {
  await prober?.stop().catch(() => {});
  await ctl.despawn("sleeper").catch(() => {});
  await ctl.despawn("caller").catch(() => {});
  await ctl.close();
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

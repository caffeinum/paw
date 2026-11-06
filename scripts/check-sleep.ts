/** Hermetic checks for `paw sleep`'s pure parts (no mesh, no claude). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "pawsleepchk-"));
const { parseHibernate, extraChannels, openBackgroundTasks, shellDescendants, sleepDecision } = await import("../src/sleep.ts");
const { backlogFilters, dmSender } = await import("../src/sleep-host.ts");
const { standInActor, writeSleepRecord, prepareWake, isAsleep, readWakingRecord, markStandIn, standInHolder, scanRecords, listSleeping, sleepState, failWake, clearSleep, sleepDir, MAX_WAKE_FAILURES } = await import("../src/sleep-state.ts");
const { scanActivity, preDespawnCheck } = await import("../src/sleep.ts");
const { effectiveCursor, toForward } = await import("../src/sleep-host.ts");
const { stopAgent } = await import("../src/addressing.ts");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

// parseHibernate
ok("60m parses", parseHibernate("60m") === 3_600_000);
ok("2h parses", parseHibernate("2h") === 7_200_000);
ok("off parses", parseHibernate("off") === "off");
ok("quoted value parses", parseHibernate('"90m"') === 5_400_000);
ok("30m refused (under the cache TTL)", throws(() => parseHibernate("30m")));
ok("garbage refused", throws(() => parseHibernate("soon")));

// extraChannels
ok("[general] has no extras", extraChannels("[general]").length === 0);
ok("absent subscribe has no extras", extraChannels(undefined).length === 0);
ok("extra channel found", extraChannels('[general, "team2027"]').join() === "team2027");

// openBackgroundTasks
const t = (iso: string, rec: object) => JSON.stringify({ timestamp: iso, ...rec });
const bash = t("2026-10-02T10:00:00Z", { type: "user", toolUseResult: { stdout: "", backgroundTaskId: "bA" } });
const bashDone = t("2026-10-02T10:05:00Z", { type: "user", message: { content: "<task-notification>\n<task-id>bA</task-id>\n<status>completed</status>\n</task-notification>" } });
const mon = t("2026-10-02T10:00:00Z", { type: "user", message: { content: [{ type: "tool_result", content: "Monitor started (task mX, timeout 600000ms). You will be notified" }] } });
const monForever = t("2026-10-02T10:00:00Z", { type: "user", message: { content: [{ type: "tool_result", content: "Monitor started (task mP). You will be notified" }] } });
const monEvent = t("2026-10-02T10:01:00Z", { type: "user", message: { content: "<task-notification>\n<task-id>mP</task-id>\n<event>line</event>\n</task-notification>" } });
const wf = t("2026-10-02T10:00:00Z", { type: "user", toolUseResult: { status: "async_launched", taskId: "wW" } });
const stop = t("2026-10-02T10:02:00Z", { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskStop", input: { task_id: "wW" } }] } });
const since = Date.parse("2026-10-02T09:00:00Z");
const at = (iso: string) => Date.parse(iso);
ok("background bash is open", openBackgroundTasks([bash], since, at("2026-10-02T10:01:00Z")).join() === "bA");
ok("completed notification closes it", openBackgroundTasks([bash, bashDone], since, at("2026-10-02T10:06:00Z")).length === 0);
ok("monitor with timeout is open before its deadline", openBackgroundTasks([mon], since, at("2026-10-02T10:05:00Z")).join() === "mX");
ok("monitor with timeout is closed after its deadline", openBackgroundTasks([mon], since, at("2026-10-02T10:11:00Z")).length === 0);
ok("persistent monitor stays open through an event", openBackgroundTasks([monForever, monEvent], since, at("2026-10-02T12:00:00Z")).join() === "mP");
ok("TaskStop closes an async workflow", openBackgroundTasks([wf, stop], since, at("2026-10-02T10:03:00Z")).length === 0);
const agentBg = t("2026-10-02T10:00:00Z", { type: "user", toolUseResult: { isAsync: true, status: "async_launched", agentId: "aB", description: "x" } });
const agentDone = t("2026-10-02T10:04:00Z", { type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>aB</task-id>\n<status>completed</status>\n</task-notification>" });
const wfReal = t("2026-10-02T10:00:00Z", { type: "user", toolUseResult: { status: "async_launched", taskId: "wR", taskType: "local_workflow", workflowName: "w" } });
ok("an async Agent (agentId, no taskId) is open — beads-y1eg", openBackgroundTasks([agentBg], since, at("2026-10-02T10:01:00Z")).join() === "aB");
ok("its task-notification closes it", openBackgroundTasks([agentBg, agentDone], since, at("2026-10-02T10:05:00Z")).length === 0);
ok("a Workflow is kind workflow, an async Agent kind agent", JSON.stringify(scanActivity([wfReal, agentBg], since, at("2026-10-02T10:01:00Z")).open.map((o) => o.kind).sort()) === '["agent","workflow"]');
ok("a task from before the process started is ignored", openBackgroundTasks([bash], at("2026-10-02T11:00:00Z"), at("2026-10-02T11:01:00Z")).length === 0);

// shellDescendants
const ps = ["  100     1 /usr/local/bin/claude --resume x", "  101   100 node /x/mcp.cjs", "  102   100 /bin/zsh -c sleep 600", "  103   102 sleep 600", "  200     1 /bin/zsh -c unrelated"].join("\n");
const sh = shellDescendants(100, ps);
ok("finds the background shell under claude, not the MCP server or a stranger", sh.length === 1 && sh[0].startsWith("102 "), sh.join("; "));
// cotal ≥0.59 forks its launch-artifact reclaim watcher under claude for the agent's whole life
// (rendered by ps with literal \012 newlines) — it must never read as the agent running a shell.
const watcher = String.raw`  104   100 /bin/sh -c p=$$ n=$1\012shift\012(\012  trap '' HUP INT QUIT TERM\012  while kill -0 "$p" 2>/dev/null; do sleep 1; done\012) </dev/null >/dev/null 2>&1 &\012shift "$n"\012exec "$@" cotal-launch 1 /tmp/cotal-x claude`;
const shW = shellDescendants(100, [ps, watcher, "  105   104 sleep 1"].join("\n"));
ok("cotal's reclaim watcher under claude is not an agent shell", shW.length === 1 && shW[0].startsWith("102 "), shW.join("; "));

// sleepDecision
const base = {
  name: "a",
  folder: "/x",
  mesh: "idle",
  live: true,
  durable: true,
  conflictPids: [] as number[],
  inbox: { kind: "lag" as const, queued: 0, unread: 0 },
  busy: false,
  activeMs: at("2026-10-02T10:00:00Z"),
};
const quiet = { tasks: [], shells: [] };
const H = 3_600_000;
ok("idle 61m with nothing running sleeps", sleepDecision(base, H, at("2026-10-02T11:01:00Z"), quiet, []).sleep);
ok("idle 59m stays up", !sleepDecision(base, H, at("2026-10-02T10:59:00Z"), quiet, []).sleep);
ok("busy stays up", !sleepDecision({ ...base, busy: true }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);
ok("undrained inbox stays up", !sleepDecision({ ...base, inbox: { kind: "lag", queued: 1, unread: 0 } }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);
ok("unknown inbox stays up", !sleepDecision({ ...base, inbox: { kind: "error" } }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);
ok("open task stays up", !sleepDecision(base, H, at("2026-10-02T12:00:00Z"), { tasks: ["bA"], shells: [] }, []).sleep);
ok("running shell stays up", !sleepDecision(base, H, at("2026-10-02T12:00:00Z"), { tasks: [], shells: ["1 zsh"] }, []).sleep);
ok("unreadable activity stays up", !sleepDecision(base, H, at("2026-10-02T12:00:00Z"), { tasks: [], shells: [], unknown: "x" }, []).sleep);
ok("extra channel stays up", !sleepDecision(base, H, at("2026-10-02T12:00:00Z"), quiet, ["team"]).sleep);
ok("global never sleeps", !sleepDecision({ ...base, name: "global" }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);
ok("non-claude harness stays up", !sleepDecision({ ...base, harness: "codex" }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);
for (const h of ["codex", "hermes", "acp", "opencode"]) {
  const r = sleepDecision({ ...base, harness: h }, H, at("2026-10-02T12:00:00Z"), quiet, []).reason;
  ok(`unsupported harness ${h} says so`, r === `harness ${h} not supported yet (paw sleep reads claude and kit sessions)`, r);
}
ok("a kit agent, idle with nothing running, sleeps", sleepDecision({ ...base, harness: "kit" }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);
ok("offline is not slept again", !sleepDecision({ ...base, live: false }, H, at("2026-10-02T12:00:00Z"), quiet, []).sleep);

// host helpers
ok("dmSender parses the sender tokens", JSON.stringify(dmSender("cotal.s.inst.local.R.local.S")) === JSON.stringify({ owner: "local", actor: "S" }));
ok("dmSender rejects a non-DM subject", dmSender("cotal.s.chat.x") === undefined);
const actor = standInActor("s", "a");
ok("stand-in actor is stable and NATS-safe", actor === standInActor("s", "a") && /^[A-Za-z0-9_]+$/.test(actor) && actor !== standInActor("s", "b"));
const f = backlogFilters("s", { name: "a", folder: "/x", since: 0, cursorSeq: 5, lastId: "local.OLD", reason: "" });
ok("backlog covers the stand-in AND the despawned seat", f.length === 2 && f[0].includes(actor) && f[1].includes(".OLD."), f.join(" "));


// state: prepareWake flips the record but leaves the stand-in up (it stays until the seat is live)
writeSleepRecord("s", { name: "a", folder: "/x", since: 1, cursorSeq: 5, reason: "t" });
markStandIn("s", "a", true);
ok("stand-in holder is this process", standInHolder("s", "a") === process.pid);
ok("prepareWake reports a wake in progress", prepareWake("s", "a"));
ok("record flipped to waking", !isAsleep("s", "a") && readWakingRecord("s", "a")?.cursorSeq === 5);
ok("#3 stand-in is NOT dropped by prepareWake (name stays addressable through the boot)", standInHolder("s", "a") === process.pid);
ok("status reads waking", sleepState("s", "a") === "waking");
ok("prepareWake on an awake agent is a no-op", !prepareWake("s", "nobody"));
markStandIn("s", "a", false);

// #6 a wake that keeps failing goes back to sleep with its error visible
const f1 = failWake("s", "a", "two writers");
ok("#6 first failure stays waking, shown as wake failed", !f1.backToSleep && sleepState("s", "a") === "wake failed" && readWakingRecord("s", "a")?.wakeFailures === 1);
for (let i = 1; i < MAX_WAKE_FAILURES - 1; i++) failWake("s", "a", "two writers");
const fN = failWake("s", "a", "folder gone");
ok("#6 after MAX failures it is asleep again (stand-in re-raised by the host)", fN.backToSleep && isAsleep("s", "a") && !readWakingRecord("s", "a"));
ok("#6 the error stays on the record", sleepState("s", "a") === "wake failed");

// #1 one corrupt record never throws out of the scan
writeFileSync(join(sleepDir("s"), "broken.json"), "{not json");
const scan = scanRecords("s", ".json");
ok("#1 corrupt record reported, good ones still returned", scan.bad.length === 1 && scan.bad[0].startsWith("broken.json") && scan.records.some((r) => r.name === "a"));
ok("#1 listSleeping does not throw on a corrupt file", listSleeping("s").length === 1);
ok("#1 status says the record is corrupt instead of throwing", sleepState("s", "broken") === "sleep record corrupt");

// #4 stop/rm/rename (all through stopAgent) clear the sleep state
const fakeCtl = { space: "s", ps: async () => ({ ok: true, data: [] }) } as unknown as Parameters<typeof stopAgent>[0];
await stopAgent(fakeCtl, "a");
ok("#4 stopAgent drops the sleep record, so a DM can't resurrect it", !isAsleep("s", "a") && sleepState("s", "a") === undefined);
ok("#4 clearSleep reports when there was nothing", !clearSleep("s", "a"));

// #5 runtime channel joins since the process started
const join1 = t("2026-10-02T10:00:00Z", { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__cotal__cotal_join", input: { channel: "team2027" } }] } });
const joinGen = t("2026-10-02T10:00:00Z", { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__cotal__cotal_join", input: { channel: "general" } }] } });
const leave1 = t("2026-10-02T10:10:00Z", { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__cotal__cotal_leave", input: { channel: "team2027" } }] } });
const now5 = at("2026-10-02T11:00:00Z");
ok("#5 a runtime cotal_join is found", scanActivity([join1], since, now5).joined.join() === "team2027");
ok("#5 #general is not a blocker", scanActivity([joinGen], since, now5).joined.length === 0);
ok("#5 a later cotal_leave cancels it", scanActivity([join1, leave1], since, now5).joined.length === 0);
ok("#5 a join from a previous incarnation is ignored", scanActivity([join1], at("2026-10-02T10:30:00Z"), now5).joined.length === 0);
ok("#5 a joined channel blocks the sleep", !sleepDecision(base, H, at("2026-10-02T12:00:00Z"), { tasks: [], shells: [], joined: ["team2027"] }, []).sleep);

// #2/#7 the last gate before despawn
ok("#2 nothing moved → despawn allowed", preDespawnCheck({ snapshotActiveMs: 5, activeMsNow: 5, meshNow: "idle", dmsSinceCursor: 0 }) === undefined);
ok("#2 transcript written since the decision → abort", !!preDespawnCheck({ snapshotActiveMs: 5, activeMsNow: 9, meshNow: "idle", dmsSinceCursor: 0 }));
ok("#2 agent left idle → abort", !!preDespawnCheck({ snapshotActiveMs: 5, activeMsNow: 5, meshNow: "working", dmsSinceCursor: 0 }));
ok("#2/#7 a DM after the cursor → abort (it may be waking a turn; never forwarded twice)", !!preDespawnCheck({ snapshotActiveMs: 5, activeMsNow: 5, meshNow: "idle", dmsSinceCursor: 1 }));

// LOW: cursor sanity + idempotent forward
ok("cursor within the stream is kept", effectiveCursor(5, 9) === 5);
ok("cursor past the stream's end (reset) forwards everything", effectiveCursor(12, 3) === 0);
const backlog = [{ seq: 6 }, { seq: 7 }, { seq: 8 }];
ok("already-forwarded seqs are skipped on a retry", toForward(backlog, [6, 7]).map((m) => m.seq).join() === "8");
ok("nothing forwarded yet → all of it", toForward(backlog, undefined).length === 3);

// follow-up 1: a live seat beside a sleep record is treated as woken
const { reconcileTargets, retryDelayMs } = await import("../src/sleep-host.ts");
const { mergeSleepRecord } = await import("../src/sleep.ts");
const rows1 = [
  { name: "z1", status: "running", mesh: "idle" },
  { name: "z2", status: "running", mesh: "absent" },
  { name: "z3", status: "exited", mesh: "offline" },
  { name: "z5", status: "running", mesh: "working" },
];
ok("F1 a sleeping name with a live idle seat is reconciled", reconcileTargets(["z1"], rows1, new Set()).join() === "z1");
ok("F1 a working seat is reconciled too", reconcileTargets(["z5"], rows1, new Set()).join() === "z5");
ok("F1 a mid-boot (absent) seat is left to its own wake", reconcileTargets(["z2"], rows1, new Set()).length === 0);
ok("F1 a dead seat or no seat is not a wake", reconcileTargets(["z3", "z4"], rows1, new Set()).length === 0);
ok("F1 a wake already in flight is not doubled", reconcileTargets(["z1"], rows1, new Set(["z1"])).length === 0);
writeSleepRecord("s", { name: "h", folder: "/x", since: 1, cursorSeq: 3, reason: "t" });
await stopAgent({ space: "s", ps: async () => ({ ok: true, data: [] }) } as unknown as Parameters<typeof stopAgent>[0], "nobody-else"); // unrelated: untouched
ok("F1 setup: h asleep", isAsleep("s", "h"));
const { ensureAgentSpawned } = await import("../src/addressing.ts");
const { clearRestartHistory } = await import("../src/restart-history.ts");
const liveCtl = { space: "s", ps: async () => ({ ok: true, data: [{ name: "h", status: "running", mesh: "idle" }] }) } as unknown as Parameters<typeof ensureAgentSpawned>[0];
const reused = await ensureAgentSpawned(liveCtl, { space: "s", name: "h", cwd: "/x" });
ok("F1 ensureAgentSpawned's reuse path heals: record handed to the host as waking", !reused.spawned && !isAsleep("s", "h") && readWakingRecord("s", "h")?.cursorSeq === 3);
clearSleep("s", "h");
const merged = mergeSleepRecord({ name: "m", folder: "/x", since: 1, cursorSeq: 4, forwarded: [5], reason: "a" }, { name: "m", folder: "/x", since: 9, cursorSeq: 20, lastId: "local.NEW", reason: "b" });
ok("F1 a re-sleep over an unreconciled record keeps the earlier cursor and forwarded set", merged.cursorSeq === 4 && merged.forwarded?.join() === "5" && merged.lastId === "local.NEW");

// follow-up 2: stopping a sleeping agent says so
const { stopMessage } = await import("../src/commands/stop.ts");
ok("F2 stop of a sleeper says it was asleep and is now stopped", /was asleep; a DM no longer wakes it/.test(stopMessage("q", false, true) ?? ""));
ok("F2 stop of a live agent is unchanged", stopMessage("q", true, false) === "✓ stopped q");
ok("F2 nothing stopped and not asleep → caller's 'isn't running' path", stopMessage("q", false, false) === undefined);

// follow-up 3: a failed wake is retried on a backoff, not only on the next DM
ok("F3 no failures → no delay", retryDelayMs(0) === 0);
ok("F3 backoff doubles from 1m", retryDelayMs(1) === 60_000 && retryDelayMs(2) === 120_000 && retryDelayMs(3) === 240_000);
ok("F3 backoff caps at 30m", retryDelayMs(20) === 30 * 60_000);

// B (2026-10-11 evals): a waking agent's ps row reads `offline` through the sleep stand-in (ps matches
// mesh BY NAME). The wake gate must not read that as a zombie and restart the seat that is still booting.
const ok1 = { kind: "ok" as const };
const calls: string[] = [];
const bootCtl = (comesUpAfter: number) => {
  let polls = 0;
  return {
    space: "s",
    ps: async () => ({ ok: true, data: [{ name: "w", status: "running", mesh: ++polls > comesUpAfter ? "idle" : "offline", id: "local.SEAT" }] }),
    despawn: async (n: string) => (calls.push(`despawn ${n}`), { ok: true }),
    spawn: async (a: { name: string }) => (calls.push(`spawn ${a.name}`), { ok: false, error: "stub" }),
  } as unknown as Parameters<typeof ensureAgentSpawned>[0];
};
const { ensurePersonaFile, setPersonaKeys } = await import("../src/addressing.ts");
ensurePersonaFile("s", "w"); // the restart branch reads its resume pin
writeSleepRecord("s", { name: "w", folder: "/x", since: 1, cursorSeq: 7, reason: "t" });
prepareWake("s", "w"); // another process (`paw chat @w`) started the wake and spawned the seat
const booted = await ensureAgentSpawned(bootCtl(3), { space: "s", name: "w", cwd: "/x", probePresence: async () => ok1 });
ok("B a waking agent's stand-in-offline row is given time, not restarted", !booted.spawned && calls.length === 0, calls.join() || "no calls");
ok("B the wake stays handed to the host", readWakingRecord("s", "w")?.cursorSeq === 7);
const t0 = Date.now();
await ensureAgentSpawned(bootCtl(Infinity), { space: "s", name: "w", cwd: "/x", probePresence: async () => ok1, restartLive: "allow" }).catch((e: Error) => console.log("   (gate threw:", e.message.split("\n")[0], ")"));
ok("B a seat that never comes up is still restarted after the grace", calls[0] === "despawn w" && Date.now() - t0 >= 14_000, `${calls.join()} after ${Date.now() - t0}ms`);
clearSleep("s", "w");
clearRestartHistory("s", "w"); // the case above restarted "w"; its backoff must not leak into this one
calls.length = 0;
await ensureAgentSpawned(bootCtl(Infinity), { space: "s", name: "w", cwd: "/x", probePresence: async () => ok1, restartLive: "allow" }).catch((e: Error) => console.log("   (gate threw:", e.message.split("\n")[0], ")"));
ok("B an agent with no sleep record keeps the immediate zombie restart", calls[0] === "despawn w", calls.join());

// B: `paw sleep` proves the seat is gone before it records the agent asleep.
const { seatLingers, sleepAgent } = await import("../src/sleep.ts");
ensurePersonaFile("s", "z");
setPersonaKeys("s", "z", { cwd: "/x" });
const sleepCtl = (stays: boolean) => {
  let gone = false;
  return {
    space: "s",
    ps: async () => ({ ok: true, data: gone && !stays ? [] : [{ name: "z", status: "running", mesh: "idle", id: "local.Z" }] }),
    despawn: async () => ((gone = true), { ok: true }),
  } as unknown as Parameters<typeof sleepAgent>[1];
};
let sleepErr = "";
await sleepAgent("s", sleepCtl(true), "z", "test", { cursorSeq: 1, force: true }).catch((e: Error) => (sleepErr = e.message));
ok("B a seat still listed after despawn fails the sleep loudly", /still lists its seat/.test(sleepErr) && !isAsleep("s", "z"), sleepErr);
sleepErr = "";
await sleepAgent("s", sleepCtl(false), "z", "test", { cursorSeq: 1, force: true }).catch((e: Error) => (sleepErr = e.message));
ok("B a seat that went is recorded asleep", !sleepErr && isAsleep("s", "z"), sleepErr);
clearSleep("s", "z");
ok("B a different seat under the name is not the despawned one", (await seatLingers({ ps: async () => ({ ok: true, data: [{ name: "z", id: "local.NEW" }] }) } as unknown as Parameters<typeof seatLingers>[0], "z", "local.Z", 0)) === undefined);
let psErr = "";
await seatLingers({ ps: async () => ({ ok: false, error: "down" }) } as unknown as Parameters<typeof seatLingers>[0], "z", "local.Z", 0).catch((e: Error) => (psErr = e.message));
ok("B a silent ps is no proof the seat went — it throws", /can't confirm the seat is gone/.test(psErr), psErr);

// ── 2026-11-04: stale transcript tasks, sandboxed agents, the multi-space keeper sweep, --dry-run ──────────
const { mkdirSync } = await import("node:fs");
const S = await import("../src/sleep.ts");
const { personaTranscriptRoots } = await import("../src/session.ts");
const { setFolderName, personaFilePath } = await import("../src/addressing.ts");

// G1: Claude Code's api-request-blob lines copy whole request bodies (old tool results included) with NO
// timestamp — live: firegoat-cli's Monitor bbdqj945e, TaskStop'd on 10-20, kept "open" by a blob after it.
const monStart = t("2026-10-02T10:00:00Z", { type: "user", message: { content: [{ type: "tool_result", content: "Monitor started (task bbdq). You will be notified" }] } });
const monStop = t("2026-10-02T10:02:00Z", { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskStop", input: { task_id: "bbdq" } }] } });
const blob = JSON.stringify({ type: "api-request-blob", sessionId: "x", message: { role: "user", content: [{ type: "tool_result", content: "Monitor started (task bbdq). You will be notified" }] } });
ok("G1 a timestamp-less request blob replaying a stopped Monitor does not reopen it", openBackgroundTasks([monStart, monStop, blob], since, at("2026-10-02T11:00:00Z")).length === 0);
ok("G1 nor does one from a previous incarnation", openBackgroundTasks([blob], at("2026-10-02T11:00:00Z"), at("2026-10-02T11:01:00Z")).length === 0);
const monExpires = t("2026-10-02T10:00:00Z", { type: "user", message: { content: [{ type: "tool_result", content: "Monitor started (task mE, expires in 30m unless the source ends first; …)" }] } });
ok("G1 a Monitor that 'expires in 30m' is open before then", openBackgroundTasks([monExpires], since, at("2026-10-02T10:20:00Z")).join() === "mE");
ok("G1 … and closed after", openBackgroundTasks([monExpires], since, at("2026-10-02T10:31:00Z")).length === 0);
ok("G1 task kinds are reported", JSON.stringify(scanActivity([bash, wf, monForever], since, at("2026-10-02T10:01:00Z")).open.map((o) => o.kind).sort()) === '["agent","bash","monitor"]');

// G2: a transcript task is believed only while a live process backs it.
const troot = mkdtempSync(join(tmpdir(), "pawsleep-tr-"));
mkdirSync(join(troot, "proj"));
writeFileSync(join(troot, "proj", "PIN.jsonl"), [bash, wf].join("\n") + "\n");
const startedAt = at("2026-10-02T09:30:00Z");
const nowG = at("2026-10-02T12:00:00Z");
const host = (shells: string[], detached: string[] = []) => ({ ok: true as const, where: "host" as const, startedAt, shells, detached });
const noProc = S.readActivity("PIN", host([]), nowG, [troot]);
ok("G2 a Bash task record with no live process is stale, not running", !noProc.tasks.includes("bA") && noProc.stale?.join() === "bA", JSON.stringify(noProc));
ok("G2 an async agent task runs in-process — its record alone still blocks", noProc.tasks.join() === "wW");
writeFileSync(join(troot, "proj", "PIN.jsonl"), bash + "\n");
const staleOnly = S.readActivity("PIN", host([]), nowG, [troot]);
const dStale = sleepDecision(base, H, nowG, staleOnly, []);
ok("G2 a stale record does not block the sleep, and the verdict says it was ignored", dStale.sleep && /stale task record\(s\), ignored — no live process: bA/.test(dStale.reason), dStale.reason);
const withShell = S.readActivity("PIN", host(["9 /bin/zsh -c source …shell-snapshots… eval 'sleep 600'"]), nowG, [troot]);
ok("G2 with a live shell under claude the task is real and blocks", withShell.tasks.join() === "bA" && !sleepDecision(base, H, nowG, withShell, []).sleep);
const withOrphan = S.readActivity("PIN", host([], ["77 pnpm dev"]), nowG, [troot]);
ok("G2 a reparented orphan carrying its name backs the task too", withOrphan.tasks.join() === "bA" && !sleepDecision(base, H, nowG, withOrphan, []).sleep);
writeFileSync(join(troot, "proj", "EMPTY.jsonl"), "");
ok("G2 a host orphan alone (no open task) does not block — it outlives the seat", sleepDecision(base, H, nowG, S.readActivity("EMPTY", host([], ["77 x"]), nowG, [troot]), []).sleep);
ok("G2 an uninspectable process table keeps it awake", /can't tell what is running \(boom\)/.test(sleepDecision(base, H, nowG, S.readActivity("PIN", { ok: false, unknown: "boom" }, nowG, [troot]), []).reason));
// host attribution: shells under claude + orphans stamped with its name, younger than its claude
const { parsePs } = await import("../src/fleet.ts");
const hostPs = parsePs([
  "  400     1   400 02:00:00 0:01.00 node cotald.ts supervise --space s",
  "  500   400   500 01:00:00 0:01.00 /Users/x/.local/bin/claude --resume PIN COTAL_NAME=a COTAL_SPACE=s",
  "  501   500   500 00:10:00 0:00.10 /bin/zsh -c source /Users/x/.claude/shell-snapshots/s.sh eval 'sleep 600' COTAL_NAME=a COTAL_SPACE=s",
  "  600     1   600 00:20:00 0:00.10 node dev-server.js COTAL_NAME=a COTAL_SPACE=s",
  "  601     1   601 9-00:00:00 0:00.10 node old-server.js COTAL_NAME=a COTAL_SPACE=s",
  "  602     1   602 00:05:00 0:00.10 node other.js COTAL_NAME=b COTAL_SPACE=s",
].join("\n"));
const groupOrph = (await import("../src/fleet.ts")).groupProcs(hostPs, "s").orphans.filter((o) => o.agent === "a" && o.tree[0].ageMs <= 3_600_000).map((o) => o.tree[0].pid);
ok("G2 host attribution: only its own orphans younger than its claude", groupOrph.join() === "600", groupOrph.join());

// G3: sandboxed agents — read INSIDE the VM (container exec … ps).
const vmPs = (extra: string[] = []) =>
  [
    "      1       0  309735 /.cz-init -- docker-entrypoint.sh /usr/local/bin/claude --dangerously-load-development-channels server:cotal",
    "      2       1  309735 /usr/local/bin/claude --dangerously-load-development-channels server:cotal --resume PIN",
    "     31       2  309734 node --optimize-for-size /x/connector-claude-code/dist/mcp.cjs",
    " 250238       0       0 ps -eo pid=,ppid=,etimes=,args=",
    " 250100       0       3 cat /proc/net/tcp /proc/net/tcp6",
    ...extra,
  ].join("\n");
const vmQuiet = S.vmSessionProcs(vmPs(), nowG);
ok("G3 an idle VM: one claude, no shells, exec sessions (ppid 0) are not the agent's", vmQuiet.ok && vmQuiet.where === "vm" && !vmQuiet.shells.length && !vmQuiet.detached.length && vmQuiet.startedAt === nowG - 309_735_000, JSON.stringify(vmQuiet));
const vmShell = S.vmSessionProcs(vmPs(["    300       2     100 /bin/bash -c source /root/.claude/shell-snapshots/s.sh eval 'npm test'"]), nowG);
ok("G3 a shell under the VM's claude is seen", vmShell.ok && vmShell.shells.length === 1 && vmShell.shells[0].startsWith("300 "));
const vmFly = S.vmSessionProcs(vmPs(["  124154       1    9000 /root/.fly/bin/flyctl agent run /root/.fly/agent-logs/1.log"]), nowG);
ok("G3 a process detached to the VM's init is seen", vmFly.ok && vmFly.detached.length === 1 && vmFly.detached[0].startsWith("124154 "));
const twoSeats = S.vmSessionProcs(vmPs(["      9       1     10 /usr/local/bin/claude --resume OTHER"]), nowG);
ok("G3 two claudes in the VM → can't tell", !twoSeats.ok && /2 claude processes/.test(twoSeats.unknown));
ok("G3 an empty ps → can't tell", !S.vmSessionProcs("", nowG).ok);

// The sweep, with the sandbox verdict coming through an injectable inspector.
const mkAgent = (space: string, name: string, keys: Record<string, string>) => {
  const folder = mkdtempSync(join(tmpdir(), `pawsleep-${name}-`));
  setFolderName(space, folder, name);
  ensurePersonaFile(space, name);
  setPersonaKeys(space, name, { cwd: folder, resume: `PIN-${name}`, ...keys });
  return folder;
};
mkAgent("sb", "vm1", { hibernate: "60m", sandbox: "container" });
const vmRoot = personaTranscriptRoots(personaFilePath("sb", "vm1"))[0];
ok("G3 a sandboxed agent's transcripts are read from its own claude dir", /sandbox/.test(vmRoot), vmRoot);
mkdirSync(join(vmRoot, "proj"), { recursive: true });
writeFileSync(join(vmRoot, "proj", "PIN-vm1.jsonl"), "");
const row = (name: string) => ({ ...base, name, pin: `PIN-${name}`, activeMs: at("2026-10-02T09:00:00Z") });
const sweepCtl = {} as unknown as Parameters<typeof S.sleepSweep>[1];
const seen: string[] = [];
const sweepDeps = (rows: ReturnType<typeof row>[], inspect: import("../src/sleep.ts").ProcInspector, slept: string[] = []) => ({
  now: nowG,
  inspect,
  cursorSeq: async () => 1,
  status: async () => ({ rows, ps: new Map() }),
  sleep: (async (_s: string, _c: unknown, name: string) => void slept.push(name)) as unknown as typeof S.sleepAgent,
});
const vmDown = await S.sleepSweep("sb", sweepCtl, sweepDeps([row("vm1")], (o) => (seen.push(`${o.name}:${o.sandboxed}`), { ok: false, unknown: "its VM can't be inspected: not running" })));
ok("G3 the inspector is told the agent is sandboxed", seen.join() === "vm1:true", seen.join());
ok("G3 a VM that can't be inspected stays awake with that reason", !vmDown.slept.length && /can't tell what is running \(its VM can't be inspected/.test(vmDown.skipped[0]?.reason ?? ""), JSON.stringify(vmDown));
const vmSlept: string[] = [];
const vmOk = await S.sleepSweep("sb", sweepCtl, sweepDeps([row("vm1")], () => S.vmSessionProcs(vmPs(), nowG), vmSlept));
ok("G3 an idle, inspectable VM sleeps", vmSlept.join() === "vm1", JSON.stringify(vmOk));
const vmBusy = await S.sleepSweep("sb", sweepCtl, sweepDeps([row("vm1")], () => S.vmSessionProcs(vmPs(["  124154       1    9000 /root/.fly/bin/flyctl agent run"]), nowG)));
ok("G3 work detached inside the VM keeps it awake (it dies with the container)", !vmBusy.slept.length && /in its VM outside claude/.test(vmBusy.skipped[0]?.reason ?? ""), JSON.stringify(vmBusy));

const vmCtl = () => {
  let gone = false;
  return { space: "sb", ps: async () => ({ ok: true, data: gone ? [] : [{ name: "vm1", status: "running", mesh: "idle", id: "local.VM1" }] }), despawn: async () => ((gone = true), { ok: true }) } as unknown as Parameters<typeof sleepAgent>[1];
};
// sleeping a sandboxed agent cleans its container up (like paw stop), after recording it asleep
const reaped: string[] = [];
await sleepAgent("sb", vmCtl(), "vm1", "test", { cursorSeq: 1, force: true, reap: async (_s, n) => (reaped.push(n), ["old-ctr"]) }).catch((e: Error) => console.log("   (sleepAgent threw:", e.message, ")"));
ok("G3 sleeping a sandboxed agent reaps its container", reaped.join() === "vm1" && isAsleep("sb", "vm1"));
clearSleep("sb", "vm1");
let reapErr = "";
await sleepAgent("sb", vmCtl(), "vm1", "test", { cursorSeq: 1, force: true, reap: async () => { throw new Error("delete failed"); } }).catch((e: Error) => (reapErr = e.message));
ok("G3 a container that won't go fails loud — but the agent IS recorded asleep (a DM still wakes it)", /asleep, but its container was not cleaned up/.test(reapErr) && isAsleep("sb", "vm1"), reapErr);
clearSleep("sb", "vm1");

// G4/G5 agents are host agents: their transcripts are read from ~/.claude/projects — a throwaway HOME, never the real one.
const realHome = process.env.HOME;
process.env.HOME = mkdtempSync(join(tmpdir(), "pawsleep-home-"));
mkdirSync(join(process.env.HOME, ".claude", "projects", "proj"), { recursive: true });
for (const n of ["d1", "d2", "a2"]) writeFileSync(join(process.env.HOME, ".claude", "projects", "proj", `PIN-${n}.jsonl`), "");
// G4: --dry-run prints verdicts, sleeps nobody, reads no DM cursor.
mkAgent("dr", "d1", { hibernate: "60m" });
mkAgent("dr", "d2", { hibernate: "60m" });
const drSlept: string[] = [];
let cursorRead = false;
const dry = await S.sleepSweep("dr", sweepCtl, {
  ...sweepDeps([row("d1"), { ...row("d2"), busy: true }], () => host([]), drSlept),
  cursorSeq: async () => ((cursorRead = true), 1),
  dryRun: true,
});
ok("G4 dry run: the eligible agent is listed as would-sleep", dry.would.map((w) => w.name).join() === "d1" && dry.skipped.map((x) => x.name).join() === "d2", JSON.stringify(dry));
ok("G4 dry run: nobody slept, no cursor read", !drSlept.length && !dry.slept.length && !cursorRead);
const { spawnSync } = await import("node:child_process");
const cli = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "..", "bin", "paw.mjs"), "sleep", ...args], { encoding: "utf8", env: { ...process.env, PAW_SPACE: "dr", PAW_RELEASE: "dev" } });
const noSweep = cli(["--dry-run"]);
ok("G4 --dry-run without --sweep fails loud", noSweep.status !== 0 && /--dry-run goes with --sweep/.test(noSweep.stderr), noSweep.stderr.trim());
const noMgr = cli(["--sweep", "--dry-run", "--space", "dr"]);
ok("G4 --sweep --dry-run on a space with no manager here fails loud and starts nothing", noMgr.status !== 0 && /no manager of this machine runs space "dr"/.test(noMgr.stderr), noMgr.stderr.trim());

// G5: the keeper sweeps EVERY space with opted-in agents, each on its own handle, failures isolated.
mkAgent("k1", "a1", { hibernate: "60m" });
mkAgent("k2", "a2", { hibernate: "60m" });
mkAgent("k3", "a3", { hibernate: "60m" });
mkAgent("k4", "a4", {}); // registered, not opted in
const listed = S.spacesWithOptIns();
ok("G5 spaces with opted-in agents are found (and only those)", ["k1", "k2", "k3", "sb", "dr"].every((x) => listed.includes(x)) && !listed.includes("k4"), listed.join());
const sleptBy: Record<string, string[]> = {};
const handles: string[] = [];
const logs: string[] = [];
const res = await S.sweepOtherSpaces("k1", {
  spaces: () => ["k1", "k2", "k3", "dr"],
  managerUp: (s) => s !== "k3",
  withCtl: async (s, fn) => (handles.push(s), fn({ space: s } as unknown as Parameters<typeof S.sleepSweep>[1])),
  sweep: async (s, ctl) => {
    if ((ctl as unknown as { space: string }).space !== s) throw new Error("wrong handle");
    if (s === "dr") throw new Error("broker down");
    const slept: string[] = (sleptBy[s] = []);
    return S.sleepSweep(s, ctl, sweepDeps([row(`a${s.slice(1)}`)], () => host([]), slept));
  },
  log: (l) => logs.push(l),
});
ok("G5 the primary space is left to the tick's own sweep", !handles.includes("k1"));
ok("G5 another space is swept on its own manager handle", handles.join() === "k2,dr" && sleptBy.k2?.join() === "a2", JSON.stringify({ handles, sleptBy }));
ok("G5 a space whose manager isn't running here is skipped, nothing started", res.find((r) => r.space === "k3")?.skipped === "no manager of this machine runs it");
ok("G5 one space failing is logged and does not stop the others", res.find((r) => r.space === "dr")?.error === "broker down" && logs.some((l) => /sleep sweep of dr failed: broker down/.test(l)) && logs.some((l) => /put to sleep in k2: a2/.test(l)), logs.join(" | "));

// remote space: an opted-in agent this machine doesn't host is skipped, named (never slept)
const remoteRows = await S.sleepSweep("dr", sweepCtl, { ...sweepDeps([row("d1")], () => host([])), status: async () => ({ rows: [row("d1")], ps: new Map() }) });
ok("G5 local space: hosting is always here", remoteRows.slept.join() === "d1");


// G6: kit agents (persona `agent: kit`) — idle from kit's own store, running work from the `kit run` seat's tree.
const kitPs = (extra: string[] = []) =>
  parsePs(
    [
      "  400     1   400 09:00:00 0:01.00 node cotald.ts supervise --space kt",
      "  700   400   700 05:00:00 0:01.00 /Users/x/.paw/bin/kit run --cwd . --name k1 --space kt --server nats://127.0.0.1:4222 --provider codex --channels general --actor A --lifecycle-uid U --resume PIN-k1 COTAL_NAME=k1 COTAL_SPACE=kt",
      "  701   700   701 05:00:00 0:00.10 /bin/bash --noprofile --norc COTAL_NAME=k1 COTAL_SPACE=kt",
      "  800   400   800 05:00:00 0:01.00 /Users/x/.local/bin/claude --resume PIN-c COTAL_NAME=c COTAL_SPACE=kt",
      ...extra,
    ].join("\n"),
  );
const nowK = at("2026-10-02T12:00:00Z");
const kQuiet = S.kitSessionProcs("kt", "k1", kitPs(), nowK);
ok("G6 an idle kit seat: its persistent shell is plumbing, not work", kQuiet.ok && !kQuiet.shells.length && kQuiet.startedAt === nowK - 5 * 3_600_000, JSON.stringify(kQuiet));
const kBusy = S.kitSessionProcs("kt", "k1", kitPs(["  702   701   701 00:30:00 0:00.10 npm run dev COTAL_NAME=k1 COTAL_SPACE=kt", "  703   702   701 00:30:00 0:00.10 node server.js COTAL_NAME=k1 COTAL_SPACE=kt"]), nowK);
ok("G6 a command backgrounded in kit's shell is running work", kBusy.ok && kBusy.shells.length === 2 && kBusy.shells[0].startsWith("702 "), JSON.stringify(kBusy));
ok("G6 … and keeps the kit agent awake, named", /process\(es\) running under kit: 702 npm run dev/.test(sleepDecision({ ...base, harness: "kit" }, H, nowK, { tasks: [], shells: kBusy.ok ? kBusy.shells : [] }, []).reason));
const kOrphan = S.kitSessionProcs("kt", "k1", kitPs(["  704     1   704 00:10:00 0:00.10 node detached.js COTAL_NAME=k1 COTAL_SPACE=kt"]), nowK);
ok("G6 a process kit detached (reparented, outlives the seat) is reported, not blocking", kOrphan.ok && !kOrphan.shells.length && kOrphan.detached.join().startsWith("704 "), JSON.stringify(kOrphan));
const kNone = S.kitSessionProcs("kt", "k2", kitPs(), nowK);
ok("G6 no `kit run` seat for the name → can't tell (stays awake)", !kNone.ok && /0 `kit run` processes run as "k2"/.test(kNone.unknown), JSON.stringify(kNone));
const kTwo = S.kitSessionProcs("kt", "k1", kitPs(["  900   400   900 01:00:00 0:01.00 /Users/x/.paw/bin/kit run --cwd . --name k1 --space kt --resume PIN-k1 COTAL_NAME=k1 COTAL_SPACE=kt"]), nowK);
ok("G6 two kit seats for one name → can't tell", !kTwo.ok && /2 `kit run`/.test(kTwo.unknown));
ok("G6 a claude seat is never read as a kit seat", !S.kitSessionProcs("kt", "c", kitPs(), nowK).ok);

// kit's own store (storage absent = kit's): the transcript under KIT_HOME is where activity + the wake's --resume come from.
process.env.KIT_HOME = mkdtempSync(join(tmpdir(), "pawsleep-kithome-"));
process.env.KIT_BIN = process.execPath; // an existing binary; kitArgs are empty, so no preflight runs
const { kitSessionsRoot, transcriptMtime } = await import("../src/session.ts");
const { utimesSync, rmSync } = await import("node:fs");
mkAgent("kt", "k1", { hibernate: "3h", agent: "kit", provider: "fake" });
const kRoots = personaTranscriptRoots(personaFilePath("kt", "k1"));
ok("G6 a kit agent's sessions are looked up in kit's store first", kRoots[0] === kitSessionsRoot(), kRoots.join());
mkdirSync(join(kitSessionsRoot(), "proj"), { recursive: true });
const kFile = join(kitSessionsRoot(), "proj", "PIN-k1.jsonl");
writeFileSync(kFile, t("2026-10-02T08:00:00Z", { type: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n");
utimesSync(kFile, new Date("2026-10-02T08:00:00Z"), new Date("2026-10-02T08:00:00Z"));
ok("G6 kit idle time is its own store's transcript", transcriptMtime("PIN-k1", kRoots) === at("2026-10-02T08:00:00Z"));
const kRow = { ...base, name: "k1", harness: "kit", pin: "PIN-k1", activeMs: transcriptMtime("PIN-k1", kRoots)! };
const kitInspect = (extra: string[] = []): import("../src/sleep.ts").ProcInspector => (o) => (seen.push(`${o.name}:${o.harness}`), S.kitSessionProcs(o.space, o.name, kitPs(extra), nowK));
seen.length = 0;
const kSlept: string[] = [];
const kOk = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect(), kSlept));
ok("G6 the inspector is told the agent runs on kit", seen.join() === "k1:kit", seen.join());
ok("G6 a kit agent idle 4h ≥ 3h with nothing under its seat sleeps", kSlept.join() === "k1" && !kOk.skipped.length, JSON.stringify(kOk));
const kStillBusy = await S.sleepSweep("kt", sweepCtl, sweepDeps([{ ...kRow, mesh: "working", busy: true }], kitInspect()));
ok("G6 a kit agent mid-turn (presence working) stays awake", !kStillBusy.slept.length && /mesh working|turn is in flight/.test(kStillBusy.skipped[0]?.reason ?? ""), JSON.stringify(kStillBusy));
const kShell = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect(["  702   701   701 00:30:00 0:00.10 sleep 9999 COTAL_NAME=k1 COTAL_SPACE=kt"])));
ok("G6 a busy kit seat (work under its shell) stays awake", !kShell.slept.length && /running under kit: 702 sleep 9999/.test(kShell.skipped[0]?.reason ?? ""), JSON.stringify(kShell));
const { kitAgentDir } = await import("../src/kit.ts");
mkdirSync(kitAgentDir("kt", "k1"), { recursive: true });
writeFileSync(join(kitAgentDir("kt", "k1"), "schedules.json"), JSON.stringify({ version: 1, jobs: [{ id: "j1", kind: "cron", prompt: "check CI", schedule: "0 * * * *", next: "2026-10-02T13:00:00Z" }] }));
const kSched = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect()));
ok("G6 an armed kit schedule keeps it awake (it fires only while kit runs)", !kSched.slept.length && /kit schedule\(s\) armed: j1 \(cron\)/.test(kSched.skipped[0]?.reason ?? ""), JSON.stringify(kSched));
writeFileSync(join(kitAgentDir("kt", "k1"), "schedules.json"), "{not json");
const kSchedBad = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect()));
ok("G6 an unreadable schedules.json is 'can't tell', never 'none'", !kSchedBad.slept.length && /kit's schedules can't be read/.test(kSchedBad.skipped[0]?.reason ?? ""), JSON.stringify(kSchedBad));
writeFileSync(join(kitAgentDir("kt", "k1"), "schedules.json"), JSON.stringify({ version: 1, jobs: [] }));
ok("G6 an empty schedule list does not block", (await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect(), []))).skipped.length === 0);
// the wake must be able to RESUME it — else it never sleeps
process.env.KIT_BIN = join(process.env.KIT_HOME, "no-such-kit");
const kNoBin = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect()));
ok("G6 no kit binary to relaunch it → refuses to sleep, says why", !kNoBin.slept.length && /couldn't wake it back into its session: no kit binary at/.test(kNoBin.skipped[0]?.reason ?? ""), JSON.stringify(kNoBin));
process.env.KIT_BIN = process.execPath;
rmSync(kFile);
const kNoTr = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect()));
ok("G6 no transcript in its store → refuses (a wake would start a fresh session)", !kNoTr.slept.length && /a wake would start a fresh session/.test(kNoTr.skipped[0]?.reason ?? ""), JSON.stringify(kNoTr));
writeFileSync(kFile, "");
setPersonaKeys("kt", "k1", { provider: "claude-sonnet" });
const kBadPersona = await S.sleepSweep("kt", sweepCtl, sweepDeps([kRow], kitInspect()));
ok("G6 a persona the kit connector would refuse → refuses to sleep", !kBadPersona.slept.length && /couldn't wake it back.*kit drives codex or grok/.test(kBadPersona.skipped[0]?.reason ?? ""), JSON.stringify(kBadPersona));
setPersonaKeys("kt", "k1", { provider: "fake" });
ok("G6 kitWakeBlocker: kitArgs kit's own parse rejects → refuses", /does not accept/.test(S.kitWakeBlocker(personaFilePath("kt", "k1"), "PIN-k1", kRoots, { preflight: () => { throw new Error("paw: x: `kit run` does not accept the kit args [\"--nope\"]"); } }) ?? ""));
ok("G6 kitWakeBlocker: a resumable kit agent has no blocker", S.kitWakeBlocker(personaFilePath("kt", "k1"), "PIN-k1", kRoots) === undefined);


// G7 — the stuck `.waking` (team2027 2027-intern/fly/vercel, 2026-11-05): a wedged host tick never yielded
// nor finished the wake; `paw start` then collided with paw's own stand-in, and a re-sleep left a `.waking`
// beside the new `.json`. Hermetic: no mesh, no manager.
{
  const SS = await import("../src/sleep-state.ts");
  const H = await import("../src/sleep-host.ts");
  const A = await import("../src/addressing.ts");
  const sp = "g7";
  // (a) the exact 2027-intern state: asleep + its stand-in held by a live process that never yields.
  SS.writeSleepRecord(sp, { name: "intern", folder: "/x", since: 1, cursorSeq: 5435, reason: "idle" });
  SS.markStandIn(sp, "intern", true);
  let spawned = 0;
  const g7Ctl = { space: sp, ps: async () => ({ ok: true, data: [] }), spawn: async () => { spawned++; return { ok: false, error: "hard-pinned name already held by a live incarnation" }; }, despawn: async () => ({ ok: true }) } as unknown as Parameters<typeof A.ensureAgentSpawned>[0];
  const t0 = Date.now();
  let err = "";
  try {
    await A.ensureAgentSpawned(g7Ctl, { space: sp, name: "intern", cwd: "/x", reuseUnmanaged: false, probePresence: async () => ({ kind: "ok" }), timing: { yieldMs: 300 }, say: () => {} });
  } catch (e) {
    err = (e as Error).message;
  }
  ok("G7a a waking spawn whose stand-in never yields is REFUSED before any spawn (no self-collision)", spawned === 0 && /did not yield the name within/.test(err) && /paw restart --mailbox --space g7/.test(err) && /no agent is touched/.test(err), err);
  ok("G7a …after waiting the yield window, not instantly", Date.now() - t0 >= 300);
  const w = SS.readWakingRecord(sp, "intern");
  ok("G7a the wake stays queued for the host, stamped with when it was asked", !!w && w.cursorSeq === 5435 && typeof w.wakeRequestedAt === "number" && !SS.isAsleep(sp, "intern"));
  ok("G7a the refusal names the holder and its code", /mailbox pid 4242, release abc/.test(A.standInYieldRefusal(sp, "intern", 4242, 20_000, "release abc")));

  // (b) the yield handshake
  ok("G7b no ack → not yielded", SS.standInYield(sp, "intern").holder === process.pid && !SS.standInYield(sp, "intern").yielded);
  writeFileSync(join(SS.sleepDir(sp), "intern.yielded"), "1\n");
  ok("G7b an ack from ANOTHER pid (a restarted host) means nothing", !SS.standInYield(sp, "intern").yielded);
  setTimeout(() => SS.markYielded(sp, "intern", true), 100);
  const y = await SS.awaitStandInYield(sp, "intern", 2000, 20);
  ok("G7b an ack that arrives while waiting is seen", y.yielded && y.holder === process.pid);
  SS.markStandIn(sp, "intern", false);
  ok("G7b lowering the stand-in clears the ack; no holder → nothing to wait for", !SS.standInYield(sp, "intern").yielded && (await SS.awaitStandInYield(sp, "intern", 10)).holder === undefined);
  SS.markStandIn(sp, "intern", true);
  SS.markYielded(sp, "intern", true);
  SS.markStandIn(sp, "intern", true);
  ok("G7b a re-raised stand-in is not yielded until it acks again", !SS.standInYield(sp, "intern").yielded);
  SS.markStandIn(sp, "intern", false);
  SS.clearSleep(sp, "intern");

  // (c) fly/vercel: a `.waking` left beside a later `.json`
  SS.writeWakingRecord(sp, { name: "fly", folder: "/f", since: 1, cursorSeq: 5633, reason: "idle", forwarded: [5640] });
  SS.writeSleepRecord(sp, { name: "fly", folder: "/f", since: 2, cursorSeq: 5700, reason: "idle again", forwarded: [5701] });
  ok("G7c a .json beside a stale .waking reads asleep, not waking", SS.sleepState(sp, "fly") === "asleep");
  ok("G7c foldStaleWaking folds it", SS.foldStaleWaking(sp, "fly"));
  const fly = SS.readSleepRecord(sp, "fly");
  ok("G7c …keeping the earlier cursor and every forwarded seq, dropping the .waking", fly?.cursorSeq === 5633 && fly?.forwarded?.join() === "5640,5701" && fly?.reason === "idle again" && !SS.readWakingRecord(sp, "fly"), JSON.stringify(fly));
  ok("G7c nothing to fold → false", !SS.foldStaleWaking(sp, "fly"));
  SS.writeWakingRecord(sp, { name: "fly", folder: "/f", since: 1, cursorSeq: 5600, reason: "x" });
  ok("G7c prepareWake over a .json + stale .waking merges both backlogs", SS.prepareWake(sp, "fly") && SS.readWakingRecord(sp, "fly")?.cursorSeq === 5600 && !SS.isAsleep(sp, "fly"));
  SS.clearSleep(sp, "fly");

  // (d) the host's loops can't wedge: a body that never settles is reported and the guard released
  ok("G7d bounded rejects a promise that never settles, naming it", await H.bounded(new Promise(() => {}), 30, "a hung read").then(() => "", (e: Error) => e.message).then((m) => /a hung read did not settle within/.test(m)));
  ok("G7d bounded passes a settled value through", (await H.bounded(Promise.resolve(7), 1000, "x")) === 7);
  const reports: string[] = [];
  let runs = 0;
  const ticker = H.guardedTicker("test tick", 50, async (step) => {
    runs++;
    step(`raising agent${runs}`);
    if (runs === 1) await new Promise(() => {}); // the 2026-11-05 wedge
  }, (l) => reports.push(l));
  await ticker();
  ok("G7d a wedged tick is reported with the step it is stuck at", reports.length === 1 && /stuck at: raising agent1/.test(reports[0]), reports.join());
  await ticker();
  ok("G7d …and the NEXT tick runs anyway (the old guard held it forever)", runs === 2 && reports.length === 1);
  const overlapping = H.guardedTicker("t2", 1000, async () => { runs++; await new Promise((r) => setTimeout(r, 30)); }, () => {});
  const before = runs;
  await Promise.all([overlapping(), overlapping()]);
  ok("G7d a tick still within its deadline is not doubled", runs === before + 1);
  const failing = H.guardedTicker("t3", 1000, async (step) => { step("reading ps"); throw new Error("timeout"); }, (l) => reports.push(l));
  await failing();
  ok("G7d a failing tick says where it failed", /t3 failed at reading ps: timeout/.test(reports.at(-1) ?? ""), reports.at(-1));
  const serial = H.boundedSerial(40);
  const order: string[] = [];
  const hung = serial("intern", "first read", () => new Promise<void>(() => {})).catch((e: Error) => order.push(`first: ${e.message}`));
  const second = serial("intern", "second read", async () => { order.push("second ran"); });
  await Promise.all([hung, second]);
  ok("G7d a hung backlog read is cut loose; the agent's next read still runs", order[0]?.startsWith("first: first read did not settle") && order[1] === "second ran", order.join(" | "));

  // (e) sleepAgent clears a stale .waking when it records the new sleep
  const SL = await import("../src/sleep.ts");
  const { personaFilePath: pfp } = await import("../src/addressing.ts");
  mkdirSync(join(pfp(sp, "vercel"), ".."), { recursive: true });
  writeFileSync(pfp(sp, "vercel"), "---\ncwd: /v\n---\n");
  SS.writeWakingRecord(sp, { name: "vercel", folder: "/v", since: 1, cursorSeq: 5601, reason: "idle", forwarded: [5610] });
  let psCalls = 0;
  const vCtl = {
    space: sp,
    ps: async () => ({ ok: true, data: psCalls++ === 0 ? [{ name: "vercel", id: "local.OLD", status: "running", mesh: "idle" }] : [] }),
    despawn: async () => ({ ok: true }),
  } as unknown as Parameters<typeof SL.sleepAgent>[1];
  await SL.sleepAgent(sp, vCtl, "vercel", "idle 61m", { cursorSeq: 5990, force: true });
  const v = SS.readSleepRecord(sp, "vercel");
  ok("G7e a re-sleep over a never-finished wake leaves ONE record: asleep, the old backlog still owed", !SS.readWakingRecord(sp, "vercel") && v?.cursorSeq === 5601 && v?.forwarded?.join() === "5610" && SS.sleepState(sp, "vercel") === "asleep", JSON.stringify(v));
  SS.clearSleep(sp, "vercel");

  // (f) `paw status <name>` — the name filter is a filter, not a verdict
  const ST = await import("../src/status.ts");
  const fa = () => ({ folder: "/f", names: ["a1", "a2"] });
  ok("G7f wantedNames on a set without the target is empty, never a throw (it threw `no agent` for every name)", ST.wantedNames([], ["2027-intern"], fa).size === 0);
  ok("G7f wantedNames keeps the asked names", [...ST.wantedNames(["2027-intern", "fly"], ["2027-intern"], fa)].join() === "2027-intern");
  ok("G7f wantedNames resolves a folder target", [...ST.wantedNames(["a1", "a2", "z"], ["."], fa)].join() === "a1,a2");
  ok("G7f a sleeping row is selected by name", ST.selectRows([{ name: "2027-intern", mesh: "waking" }] as never[], ["2027-intern"], fa).length === 1);
  ok("G7f an unknown name still fails loud on the collected rows", throws(() => ST.selectRows([{ name: "fly" }] as never[], ["nope"], fa)));

  // (g) `paw restart --mailbox`
  const R = await import("../src/commands/runtime.ts");
  ok("G7g restart --mailbox parses", R.parseArgs(["--mailbox", "--space", "team2027"], "restart").mailbox === true);
  ok("G7g restart --mailbox refuses an agent beside it", throws(() => R.parseArgs(["--mailbox", "fly"], "restart")));
  const MF = await import("../src/manager-features.ts");
  ok("G7g this checkout's host acks yields (the feature a CLI checks before waiting on it)", MF.codeRootFeatures(join(import.meta.dirname, "..")).includes(MF.SLEEP_YIELD_ACK_FEATURE));
}

process.env.HOME = realHome;
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

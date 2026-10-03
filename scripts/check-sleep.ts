/** Hermetic checks for `paw sleep`'s pure parts (no mesh, no claude). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "pawsleepchk-"));
const { parseHibernate, extraChannels, openBackgroundTasks, shellDescendants, sleepDecision } = await import("../src/sleep.js");
const { backlogFilters, dmSender } = await import("../src/sleep-host.js");
const { standInActor, writeSleepRecord, prepareWake, isAsleep, readWakingRecord, markStandIn, standInHolder, scanRecords, listSleeping, sleepState, failWake, clearSleep, sleepDir, MAX_WAKE_FAILURES } = await import("../src/sleep-state.js");
const { scanActivity, preDespawnCheck } = await import("../src/sleep.js");
const { effectiveCursor, toForward } = await import("../src/sleep-host.js");
const { stopAgent } = await import("../src/addressing.js");

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
ok("a task from before the process started is ignored", openBackgroundTasks([bash], at("2026-10-02T11:00:00Z"), at("2026-10-02T11:01:00Z")).length === 0);

// shellDescendants
const ps = ["  100     1 /usr/local/bin/claude --resume x", "  101   100 node /x/mcp.cjs", "  102   100 /bin/zsh -c sleep 600", "  103   102 sleep 600", "  200     1 /bin/zsh -c unrelated"].join("\n");
const sh = shellDescendants(100, ps);
ok("finds the background shell under claude, not the MCP server or a stranger", sh.length === 1 && sh[0].startsWith("102 "), sh.join("; "));

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

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

/** Hermetic checks for `paw sleep`'s pure parts (no mesh, no claude). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "pawsleepchk-"));
const { parseHibernate, extraChannels, openBackgroundTasks, shellDescendants, sleepDecision } = await import("../src/sleep.js");
const { backlogFilters, dmSender } = await import("../src/sleep-host.js");
const { standInActor, writeSleepRecord, prepareWake, isAsleep, readWakingRecord, markStandIn, standInHolder } = await import("../src/sleep-state.js");

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

// state: prepareWake flips the record and waits for the stand-in to drop
writeSleepRecord("s", { name: "a", folder: "/x", since: 1, cursorSeq: 5, reason: "t" });
markStandIn("s", "a", true);
ok("stand-in holder is this process", standInHolder("s", "a") === process.pid);
setTimeout(() => markStandIn("s", "a", false), 400);
const t0 = Date.now();
const woke = await prepareWake("s", "a", 5000);
ok("prepareWake waited for the stand-in to drop", woke && Date.now() - t0 >= 350 && standInHolder("s", "a") === undefined);
ok("record flipped to waking", !isAsleep("s", "a") && readWakingRecord("s", "a")?.cursorSeq === 5);
ok("prepareWake on an awake agent is a no-op", !(await prepareWake("s", "nobody")));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

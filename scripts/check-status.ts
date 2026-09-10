/**
 * Smoke check for `paw status` (the merged ps+status view): the pure formatter (status/runtime/cwd/
 * session/last-active + durability + two-writer rendering), the `meshStatus` + `ago` helpers, and the
 * `foreignWriters` detector that backs both status and the spawn/adopt two-writer guard. Isolated temp
 * HOME for the index scan; pure/no daemons. Run: pnpm check:status
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-status-home-"));
process.env.HOME = home;

const { formatStatus, meshStatus, ago, inboxText, inboxStuck } = await import("../src/status.js");
type InboxState = import("../src/status.js").InboxState;
const { foreignWriters } = await import("../src/named.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

// ---- meshStatus: manager ps row → display status ----
assert(meshStatus(undefined).text === "offline" && meshStatus(undefined).live === false, "not listed → offline");
assert(meshStatus({ name: "x", mesh: "absent" }).text === "starting", "mesh:absent → starting (mid-boot)");
assert(meshStatus({ name: "x", mesh: "absent" }).live === true, "starting counts as live");
assert(meshStatus({ name: "x", mesh: "offline", status: "running" }).text === "offline", "mesh:offline → offline");
assert(meshStatus({ name: "x", mesh: "idle", status: "running" }).text === "idle", "mesh:idle → idle");
assert(meshStatus({ name: "x", mesh: "idle", status: "exited" }).live === false, "exited process → not live");

// ---- ago: relative time (now injected) ----
const NOW = 1_000_000_000_000;
assert(ago(undefined, NOW) === "—", "no timestamp → em-dash");
assert(ago(NOW - 5_000, NOW) === "5s", "5s ago");
assert(ago(NOW - 120_000, NOW) === "2m", "2m ago");
assert(ago(NOW - 3 * 3600_000, NOW) === "3h", "3h ago");
assert(ago(NOW - 2 * 86400_000, NOW) === "2d", "2d ago");

// ---- inboxText / inboxStuck: DM-consumer lag rendering + the zombie detector ----
const lag = (queued: number, unread: number): InboxState => ({ kind: "lag", queued, unread });
assert(inboxText({ kind: "none" }) === "—", "no consumer → em-dash (legit never-connected state)");
assert(inboxText({ kind: "error" }) === "?", "failed query → ? (never a fabricated 0)");
assert(inboxText(lag(0, 0)) === "✓", "0 queued / 0 unread → ✓");
assert(inboxText(lag(3, 0)) === "3 queued", "pending-only → N queued");
assert(inboxText(lag(0, 2)) === "2 unread", "ack-pending-only → N unread");
assert(inboxText(lag(1, 2)) === "1 queued, 2 unread", "both → queued, unread");

const stuckBase = { name: "z", folder: "/z", mesh: "idle", live: true, runtime: undefined, pin: "p", sessionName: undefined, durable: true, activeMs: NOW, conflictPids: [] as number[] };
assert(inboxStuck({ ...stuckBase, inbox: lag(0, 1) }), "live + unread → stuck (the zombie signature)");
assert(inboxStuck({ ...stuckBase, inbox: lag(1, 0) }), "live + queued-undelivered → stuck (deaf consumer)");
assert(!inboxStuck({ ...stuckBase, inbox: lag(0, 0) }), "live + drained → not stuck");
assert(!inboxStuck({ ...stuckBase, live: false, mesh: "offline", inbox: lag(0, 3) }), "offline with backlog → not the zombie case");
assert(!inboxStuck({ ...stuckBase, inbox: { kind: "error" } }), "query error → rendered ?, not claimed stuck");
assert(!inboxStuck({ ...stuckBase, inbox: { kind: "none" } }), "no consumer → not stuck");
// A turn IN FLIGHT holds its own message unacked — the healthy state, not the zombie.
assert(!inboxStuck({ ...stuckBase, busy: true, inbox: lag(0, 1) }), "busy (paw's inference) + unread → the turn in flight, not stuck");
assert(!inboxStuck({ ...stuckBase, mesh: "working", inbox: lag(0, 1) }), "working (agent's own claim) + unread → not stuck");
assert(!inboxStuck({ ...stuckBase, busy: true, inbox: lag(3, 0) }), "busy + queued → drains when the turn ends");
assert(inboxStuck({ ...stuckBase, busy: false, inbox: lag(0, 1) }), "idle + unread → STILL the zombie signature the detector exists for");

// ---- formatStatus: the unified table ----
assert(formatStatus([], NOW) === "(no agents registered)", "empty → friendly message");

const base = { sessionName: undefined as string | undefined, runtime: undefined as "pty" | "tmux" | "cmux" | undefined, inbox: lag(0, 0) };
const out = formatStatus(
  [
    { ...base, name: "paw", folder: "/home/u/p", mesh: "idle", live: true, runtime: "cmux", pin: "abcd1234-aaaa", durable: true, activeMs: NOW - 120_000, conflictPids: [] },
    { ...base, name: "foo", folder: "/f", mesh: "offline", live: false, pin: undefined, durable: false, activeMs: undefined, conflictPids: [], inbox: { kind: "none" } },
    { ...base, name: "new", folder: "/n", mesh: "starting", live: true, runtime: "cmux", pin: "11112222-bbbb", durable: false, activeMs: NOW - 5_000, conflictPids: [] },
    { ...base, name: "bar", folder: "/b", mesh: "idle", live: true, runtime: "cmux", pin: "99998888-cccc", sessionName: "research", durable: true, activeMs: NOW - 3600_000, conflictPids: [50812] },
  ],
  NOW,
);
assert(/NAME\s+STATUS\s+RUNTIME\s+CWD\s+SESSION\s+INBOX\s+ACTIVE/.test(out), "header row present (incl. INBOX)");
assert(/^paw\s+idle\s+cmux\s+\S+\s+abcd1234…\s+✓\s+2m$/m.test(out), "live durable agent → status + runtime + short id + ✓ inbox + active, no note");
assert(/^foo\s+offline\s+—\s+\S+\s+—\s+—\s+—\s+⚠ no pin/m.test(out), "pinless offline → runtime — + inbox — + no-pin warning");
{
  const g = formatStatus([{ ...base, name: "g", folder: "/g", mesh: "idle", live: true, runtime: "tmux", durable: false, conflictPids: [], harness: "opencode" }], NOW);
  assert(g.indexOf("no pin") === -1 && !/fresh/.test(g), "pinless opencode → no claude-pin or claude-fresh note");
}
assert(/^new\s+starting\s+cmux\s+\S+\s+11112222…\s+✓\s+5s\s+fresh/m.test(out), "pinned-but-no-transcript live → starting + fresh");
assert(/^bar\s+idle\s+cmux\s+\S+\s+"research"\s+✓\s+1h\s+⚠ two writers \(pid 50812\)/m.test(out), "named session shown; conflict warns with pid");
assert(out.includes("⚠ 1 two-writer conflict(s), 1 unpinned"), "footer summarizes conflicts + unpinned");
assert(
  formatStatus([{ ...base, name: "ok", folder: "/o", mesh: "idle", live: true, runtime: "pty", pin: "x", durable: true, activeMs: NOW, conflictPids: [] }], NOW).indexOf("⚠") === -1,
  "all-healthy → no warning footer",
);

// ---- formatStatus: the zombie row (the 2026-07-12 team2027-research incident shape) ----
const zombieOut = formatStatus(
  [
    { ...base, name: "research", folder: "/r", mesh: "idle", live: true, runtime: "pty", pin: "aaaa1111-bbbb", durable: true, activeMs: NOW - 7200_000, conflictPids: [], inbox: lag(1, 1) },
    { ...base, name: "erragent", folder: "/e", mesh: "idle", live: true, runtime: "pty", pin: "cccc2222-dddd", durable: true, activeMs: NOW - 60_000, conflictPids: [], inbox: { kind: "error" } },
  ],
  NOW,
);
assert(/^research\s+idle\s+pty\s+\S+\s+aaaa1111…\s+1 queued, 1 unread\s+2h\s+⚠ inbox stuck — 1 queued, 1 unread, agent not consuming$/m.test(zombieOut), "idle zombie → lag in INBOX + stuck warning");
assert(/^erragent\s+idle\s+pty\s+\S+\s+cccc2222…\s+\?\s+1m$/m.test(zombieOut), "query error → ? in INBOX, no fabricated health, no stuck claim");
assert(zombieOut.includes("⚠ 1 stuck inbox(es)"), "footer counts stuck inboxes");

// ---- foreignWriters: standalone (non-mesh) live procs holding a session ----
const idx = join(home, ".claude", "sessions");
mkdirSync(idx, { recursive: true });
const SID = "deadbeef-1111-2222-3333-444455556666";
// our own pid is alive and not a mesh agent (no --dangerously-load-development-channels) → foreign
writeFileSync(join(idx, "self.json"), JSON.stringify({ sessionId: SID, cwd: home, pid: process.pid }));
// a long-dead pid for the same session → excluded
writeFileSync(join(idx, "dead.json"), JSON.stringify({ sessionId: SID, cwd: home, pid: 2147480000 }));
// an unrelated session → never matches
writeFileSync(join(idx, "other.json"), JSON.stringify({ sessionId: "ffffffff-0000", cwd: home, pid: process.pid }));

const fw = foreignWriters(SID);
assert(fw.some((p) => p.pid === process.pid), "detects the live standalone holder (our own pid)");
assert(!fw.some((p) => p.pid === 2147480000), "excludes the dead pid");
assert(foreignWriters("no-such-session").length === 0, "unknown session → no writers");

// inferBusy — paw's own "mid-turn" guess, which exists because the mesh publishes `working` only on
// UserPromptSubmit and a DM-woken turn never submits one.
const { inferBusy } = await import("../src/status.js");
const BUSY_NOW = 1_000_000;
assert(inferBusy("idle", true, BUSY_NOW - 2_000, BUSY_NOW), "a live idle agent whose transcript moved 2s ago reads BUSY");
assert(!inferBusy("idle", true, BUSY_NOW - 60_000, BUSY_NOW), "a transcript untouched for a minute is not busy");
assert(!inferBusy("idle", false, BUSY_NOW - 2_000, BUSY_NOW), "an OFFLINE agent is never busy, however fresh its transcript");
assert(!inferBusy("working", true, BUSY_NOW - 2_000, BUSY_NOW), "the agent's OWN `working` wins — never overwritten by the guess");
assert(!inferBusy("waiting", true, BUSY_NOW - 2_000, BUSY_NOW), "`waiting` (blocked on input) likewise wins");
assert(!inferBusy("idle", true, undefined, BUSY_NOW), "no transcript mtime → no inference, never a fabricated one");
assert(!inferBusy("idle", true, BUSY_NOW + 5_000, BUSY_NOW), "an mtime in the FUTURE (clock skew) is not evidence — not busy");

if (failures > 0) {
  console.error(`\n${failures} paw status check(s) failed`);
  process.exit(1);
}
console.log("\nall paw status checks passed 🐾");


// ---- keeper: unstickDecision (src/keeper.ts) — restart only an idle agent that never drains its inbox ----
{
  const { unstickDecision, STUCK_MS, UNSTICK_COOLDOWN_MS } = await import("../src/keeper.js");
  const now = 10_000_000;
  const quiet = now - STUCK_MS - 1;
  const base = { name: "a", folder: "/x", mesh: "idle", live: true, durable: true, conflictPids: [], inbox: { kind: "lag", queued: 0, unread: 6 }, activeMs: quiet } as any;
  assert(unstickDecision(base, now, undefined).restart, "live + idle + unread + quiet transcript → restart");
  assert(!unstickDecision({ ...base, activeMs: now - 30_000 }, now, undefined).restart, "a transcript written 30s ago may be mid-turn → never restart");
  assert(!unstickDecision({ ...base, mesh: "working" }, now, undefined).restart, "an agent that says working is not stuck");
  assert(!unstickDecision({ ...base, live: false, mesh: "offline" }, now, undefined).restart, "offline is the wake gate's job, not the keeper's");
  assert(!unstickDecision({ ...base, inbox: { kind: "lag", queued: 0, unread: 0 } }, now, undefined).restart, "nothing waiting → nothing to unstick");
  assert(!unstickDecision({ ...base, inbox: { kind: "error" } }, now, undefined).restart, "an unknown inbox is not evidence");
  assert(!unstickDecision({ ...base, failure: { text: "You've hit your session limit", ts: quiet } }, now, undefined).restart, "a refused turn can't drain either — restarting changes nothing");
  assert(!unstickDecision({ ...base, activeMs: undefined }, now, undefined).restart, "no transcript activity known → no inference");
  assert(!unstickDecision(base, now, now - UNSTICK_COOLDOWN_MS + 1).restart, "inside the cooldown → wait");
  assert(unstickDecision(base, now, now - UNSTICK_COOLDOWN_MS - 1).restart, "past the cooldown → eligible again");
  assert(/6 unread/.test(unstickDecision(base, now, undefined).reason), "the reason carries the evidence");
  
// An agent the manager lists but paw never registered (cotal_spawn) gets a row with no folder and an honest note.
{
  const unreg = {
    name: "gpt-6_2", folder: "", mesh: "idle", live: true, runtime: "tmux" as const, durable: false, conflictPids: [], inbox: { kind: "none" as const }, busy: false, unregistered: { agent: "codex" },
  };
  const out = formatStatus([unreg as never], Date.now());
  assert(out.includes("gpt-6_2") && out.includes("unregistered codex peer"), "status: an unregistered manager-listed agent renders with its harness and a note");
  assert(/gpt-6_2\s+idle\s+tmux\s+—/.test(out), "status: an unregistered agent shows — for CWD, never a fabricated folder");
}
console.log("✓ keeper unstickDecision");
}

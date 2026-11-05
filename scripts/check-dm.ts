/**
 * `paw dm` to a known-but-absent agent (src/dm-wait.ts): the decision, the budget parsing, the
 * expiry messages. Pure; no mesh. The wire half is scripts/e2e-dm-wait.ts. Run: pnpm check:dm
 */
import { absentVerdict, DM_WAIT_MS, dmWaitMs, retryUntil, KNOWN_PEER_MAX_AGE_MS, seenInLedger, unknownAgentMessage, waitExpiredMessage } from "../src/dm-wait.ts";
import type { Ledger } from "../src/peer-ledger.ts";

let failures = 0;
function assert(cond: boolean, msg: string, detail = ""): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}${detail ? ` — ${detail}` : ""}`);
  }
}
const throws = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};

// ── the decision table ─────────────────────────────────────────────────────────────────────────
const v = (present: boolean, registered: boolean, onRoster: boolean, inLedger: boolean) => absentVerdict({ present, registered, onRoster, inLedger });
assert(v(true, false, true, false) === "send", "present on the roster → send now");
assert(v(true, true, true, true) === "send", "present beats registered (no wake for a live agent)");
assert(v(false, true, false, false) === "wake", "registered here, absent → wake (ensureAgentSpawned, unchanged)");
assert(v(false, true, false, true) === "wake", "registered + seen → still wake, never a passive wait");
assert(v(false, false, false, true) === "wait", "seen by the ledger, absent → wait for it");
assert(v(false, false, true, false) === "wait", "on the roster but offline → wait for it");
assert(v(false, false, false, false) === "unknown", "never registered, never seen → unknown, fail now");

// ── "seen recently" ────────────────────────────────────────────────────────────────────────────
const now = 1_800_000_000_000;
const ledger: Ledger = {
  "o.a1": { name: "Evals", first: now - 3600_000, last: now - 60_000 },
  "o.a2": { name: "ancient", first: now - 20 * 86400_000, last: now - KNOWN_PEER_MAX_AGE_MS - 1 },
};
assert(seenInLedger(ledger, "evals", now), "ledger match is case-insensitive");
assert(!seenInLedger(ledger, "ancient", now), "a sighting older than the window is not 'known'");
assert(!seenInLedger(ledger, "nobody", now), "a name the ledger never saw is not known");
assert(!seenInLedger({}, "evals", now), "an empty ledger knows nobody");

// ── the budget ─────────────────────────────────────────────────────────────────────────────────
assert(dmWaitMs(undefined, undefined) === DM_WAIT_MS && DM_WAIT_MS === 20_000, "default budget is 20s");
assert(dmWaitMs(undefined, "45") === 45_000, "PAW_DM_WAIT is seconds");
assert(dmWaitMs("2.5", "45") === 2500, "--wait-for beats PAW_DM_WAIT");
assert(dmWaitMs("0", undefined) === 0, "0 = don't wait");
assert(dmWaitMs(undefined, "  ") === DM_WAIT_MS, "a blank env var is unset");
assert(throws(() => dmWaitMs("soon", undefined), /--wait-for must be a number/), "garbage --wait-for fails loud");
assert(throws(() => dmWaitMs(undefined, "-1"), /PAW_DM_WAIT must be a number/), "negative PAW_DM_WAIT fails loud");
assert(throws(() => dmWaitMs("", undefined), /--wait-for/), "an empty --wait-for fails loud");

// ── messages ───────────────────────────────────────────────────────────────────────────────────
assert(unknownAgentMessage("zzz") === 'paw: no agent "zzz" present or known (`paw ps` for live names)', "unknown keeps today's wording");
const offline = waitExpiredMessage({ name: "evals", server: "tls://b:4222", budgetMs: 20_000, meshUp: true });
assert(/"evals" stayed offline/.test(offline) && /mesh is up/.test(offline) && /20s/.test(offline) && /nothing was sent/.test(offline), "expiry on a live mesh names the AGENT as the problem", offline);
const down = waitExpiredMessage({ name: "evals", server: "tls://b:4222", budgetMs: 20_000, meshUp: false, lastError: "connection refused" });
assert(/mesh unreachable/.test(down) && /tls:\/\/b:4222/.test(down) && /connection refused/.test(down) && /20s/.test(down), "expiry with the mesh down names the MESH", down);
assert(!/stayed offline/.test(down), "…and doesn't blame the agent");
assert(/nothing was sent$|nothing was sent \(/.test(waitExpiredMessage({ server: "s", budgetMs: 1000, meshUp: false })), "connect expiry before any target is resolved");

// ── retryUntil: the connect / gate wait ────────────────────────────────────────────────────────
{
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  let calls = 0;
  let waits = 0;
  const flaky = async () => {
    if (++calls < 4) throw new Error("connection refused");
    return "up";
  };
  const r = await retryUntil(flaky, { deadline: 20_000, retryable: (e) => /refused/.test(e.message), onWait: () => waits++, expired: (e) => e, ...clock });
  assert(r === "up" && calls === 4, "mesh back within the budget → the call succeeds", `${r} after ${calls}`);
  assert(waits === 1, "…saying 'waiting' exactly once", `${waits}`);

  t = 0;
  calls = 0;
  let expiredErr = "";
  try {
    await retryUntil(async () => (calls++, Promise.reject(new Error("connection refused"))), {
      deadline: 5000,
      retryable: () => true,
      onWait: () => {},
      expired: (e) => new Error(`EXPIRED: ${e.message}`),
      ...clock,
    });
  } catch (e) {
    expiredErr = (e as Error).message;
  }
  assert(expiredErr === "EXPIRED: connection refused" && t === 5000, "mesh stays down → the expiry error, at the deadline", `${expiredErr} at ${t}`);

  t = 0;
  calls = 0;
  let authErr = "";
  try {
    await retryUntil(async () => (calls++, Promise.reject(new Error("Authorization Violation"))), { deadline: 20_000, retryable: (e) => /refused/.test(e.message), onWait: () => {}, expired: (e) => e, ...clock });
  } catch (e) {
    authErr = (e as Error).message;
  }
  assert(authErr === "Authorization Violation" && calls === 1 && t === 0, "a non-retryable error (auth) throws at once, no wait");
}

// ── #96: the usage names every target form; a live-but-unready seat says the DM was NOT sent ─────
{
  const { DM_TARGETS, notSentMessage, shellQuote } = await import("../src/dm.ts");
  const { SeatAliveError } = await import("../src/addressing.ts");
  const { registry } = await import("@cotal-ai/core");
  const cmd = registry.all<{ kind: "command"; name: string; usage?: string }>("command").find((c) => c.name === "dm");
  for (const form of ["github:owner/repo", "owner/repo@branch", "folder@branch", "folder", "name"])
    assert(DM_TARGETS.includes(form) && !!cmd?.usage?.includes(form), `dm usage lists ${form}`, cmd?.usage ?? "no dm command registered");
  assert(shellQuote("hi") === "hi" && shellQuote("it's done") === `'it'\\''s done'`, "shellQuote: bare word as is, an apostrophe survives", shellQuote("it's done"));
  const e = new SeatAliveError('paw: "canary" was launched as pid 49934 and its process is alive', { name: "canary", space: "team2027", pids: [49934] });
  const m = notSentMessage(e, "hi there");
  console.log(`    → ${m.replace(/\n/g, " ⏎ ")}`);
  assert(m.includes("alive (pid 49934)") && m.includes("the DM was NOT sent") && m.endsWith("paw dm canary#team2027 'hi there'"), "not sent: alive, NOT sent, the exact retry command", m);
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ncheck:dm passed");

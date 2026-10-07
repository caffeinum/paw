/** Hermetic checks for the peer ledger and the stale-id forwarder's decisions (no mesh, no claude). */
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "pawstalechk-"));
const L = await import("../src/peer-ledger.ts");
const F = await import("../src/stale-forward.ts");
const { nameReplyTargets } = await import("../src/log.ts");
const { standInActor } = await import("../src/sleep-state.ts");
const { ADDRESSING_BRIEF } = await import("../src/brief.ts");
const { meshBrief } = await import("../src/connector.ts");
const { kitBrief } = await import("../src/kit.ts");

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

const OLD = "local.UDWRH5U4HBQTZ2LSYPM2AMFOQ2E33UPXYJCSYYGK7QNZK5H3KMHTLHHJ";
const NEW = "local.UA7YYP5MJQDFQEFZGDCGEVRBSO2L7VD3HN475X7QHH2YZBCGX3TITX4X";
const QEA = "local.QUEUEEA";

// ── ledger ──────────────────────────────────────────────────────────────────────────────────────
const led: Record<string, { name: string; first: number; last: number }> = {};
ok("observe records a new id", L.observe(led, OLD, "evals", 1000) && led[OLD].name === "evals");
ok("observe of the same heartbeat is no change", !L.observe(led, OLD, "evals", 1000));
ok("observe widens last", L.observe(led, OLD, "evals", 2000) && led[OLD].last === 2000 && led[OLD].first === 1000);
L.observe(led, NEW, "evals", 5000);
L.observe(led, QEA, "queue-ea", 900);
ok("newest incarnation is the later first-seen", L.newestIdFor(led, "evals") === NEW);
ok("old id is an old instance", L.isOldInstance(led, OLD) && !L.isOldInstance(led, NEW));
ok("label: old id → 'evals (old instance)'", L.peerLabel(led, OLD) === "evals (old instance)");
ok("label: current id → 'evals'", L.peerLabel(led, NEW) === "evals");
ok("label: a name passes through", L.peerLabel(led, "evals") === "evals");
ok("label: an unknown id stays the raw id (never guessed)", L.peerLabel(led, "local.NOPE") === "local.NOPE");
ok("ledgerName has no suffix", L.ledgerName(led, OLD) === "evals");

const pr = { a: { name: "x", first: 0, last: 0 }, b: { name: "y", first: 0, last: 100 }, c: { name: "z", first: 0, last: 200 } };
L.pruneLedger(pr, 1000, 950, 10);
ok("prune drops entries unseen past max age", !("a" in pr) && "b" in pr && "c" in pr);
L.pruneLedger(pr, 1000, 10_000, 1);
ok("prune keeps the newest under the cap", Object.keys(pr).join() === "c");

ok("missing ledger file reads as empty", Object.keys(L.readLedger("s1")).length === 0);
L.writeLedger("s1", led);
ok("ledger round-trips through disk", L.readLedger("s1")[OLD].name === "evals" && existsSync(L.ledgerPath("s1")));
ok("labelPeer reads the on-disk ledger", L.labelPeer("s1", OLD) === "evals (old instance)");
mkdirSync(join(process.env.PAW_HOME!, "spaces", "bad"), { recursive: true });
writeFileSync(L.ledgerPath("bad"), "{nope");
ok("a corrupt ledger fails loud", throws(() => L.readLedger("bad")));

// ── transcript reply naming ─────────────────────────────────────────────────────────────────────
const blocks = nameReplyTargets("s1", [
  { kind: "reply", to: OLD, text: "hi" },
  { kind: "reply", to: "global", text: "wake x" },
  { kind: "reply", to: "local.UNKNOWN", text: "?" },
  { kind: "text", text: "plain" },
] as never);
ok("↩ old id renders as 'evals (old instance)'", (blocks[0] as { to: string }).to === "evals (old instance)");
ok("↩ a name is untouched", (blocks[1] as { to: string }).to === "global");
ok("↩ an unknown id stays the id", (blocks[2] as { to: string }).to === "local.UNKNOWN");
ok("non-reply blocks pass through", blocks[3].kind === "text");

// ── forwarder decisions ─────────────────────────────────────────────────────────────────────────
const base = {
  recipient: OLD,
  sender: QEA,
  ledger: { [OLD]: { name: "evals", first: 1000, last: 2000 }, [NEW]: { name: "evals", first: 5000, last: 9000 }, [QEA]: { name: "queue-ea", first: 1, last: 9000 } },
  live: [{ id: NEW, name: "evals" }, { id: QEA, name: "queue-ea" }],
  rosterFresh: true,
  asleep: () => false,
  alreadyForwarded: false,
  sentAt: 8000,
};
const d0 = F.decideForward(base);
ok("the incident: DM to evals' old id → forward to its live instance", d0.action === "forward" && d0.to === NEW && d0.name === "evals", JSON.stringify(d0));
ok("a live recipient is left alone", F.decideForward({ ...base, recipient: NEW }).action === "skip");
ok("an id the ledger doesn't know is never guessed", F.decideForward({ ...base, recipient: "local.WHO" }).action === "skip");
ok("never forwarded twice", F.decideForward({ ...base, alreadyForwarded: true }).action === "skip");
ok("recipient seen alive at/after send (catch-up) → skip", F.decideForward({ ...base, sentAt: 1500 }).action === "skip");
ok("a sleeping/waking name belongs to the sleep host", F.decideForward({ ...base, asleep: (n) => n === "evals" }).action === "skip");
ok("a stand-in recipient belongs to the sleep host", F.decideForward({ ...base, recipient: `local.${standInActor("s1", "evals")}` }).action === "skip");
ok("no live instance yet → hold", F.decideForward({ ...base, live: [{ id: QEA, name: "queue-ea" }] }).action === "hold");
ok("roster not current → hold", F.decideForward({ ...base, rosterFresh: false }).action === "hold");
ok("two live instances → ambiguous skip", F.decideForward({ ...base, live: [...base.live, { id: "local.OTHER", name: "evals" }] }).action === "skip");
ok("never forwards to a different name", F.decideForward({ ...base, live: [{ id: "local.X", name: "evals-reviewer" }] }).action === "hold");
ok("a forward (addressed to the live id) is never re-forwarded — no loop", F.decideForward({ ...base, recipient: NEW, sender: QEA }).action === "skip");

const now = 100_000;
const roster = [
  { card: { id: NEW, name: "evals" }, status: "idle", ts: now - 1000 },
  { card: { id: OLD, name: "evals" }, status: "idle", ts: now - 60_000 },
  { card: { id: `local.${standInActor("s1", "sleepy")}`, name: "sleepy" }, status: "idle", ts: now - 500 },
  { card: { id: "local.OFF", name: "off" }, status: "offline", ts: now - 100 },
];
const lp = F.livePeers("s1", roster as never, now);
ok("livePeers: fresh heartbeat only, no stand-ins, no offline", lp.length === 1 && lp[0].id === NEW, JSON.stringify(lp));

ok("forwardId is deterministic (broker msgID dedup on retry)", F.forwardId("m1", NEW) === F.forwardId("m1", NEW) && F.forwardId("m1", NEW) !== F.forwardId("m2", NEW));
const env = F.forwardEnvelope({ id: "m1", ts: 8000, space: "s1", from: { id: QEA, name: "queue-ea" }, to: OLD, parts: [{ kind: "text", text: "the ask" }], replyTo: "r9" }, "m1", OLD, NEW);
const parts = env.parts as Array<{ kind: string; text: string }>;
ok("forward keeps sender, body and replyTo", (env.from as { id: string }).id === QEA && parts[1].text === "the ask" && env.replyTo === "r9");
ok("forward is re-addressed with a fresh id", env.to === NEW && env.id === F.forwardId("m1", NEW));
ok("forward is marked, naming the old instance", parts[0].text.includes("forwarded") && parts[0].text.includes(OLD));

// ── brief ───────────────────────────────────────────────────────────────────────────────────────
const line = ADDRESSING_BRIEF.join(" ");
ok("brief: address by name, ids change on restart (one sentence)", ADDRESSING_BRIEF.length === 1 && /by NAME/.test(line) && /change on every restart/.test(line));
ok("claude brief carries it", meshBrief("evals").includes(line));
ok("kit brief carries it", kitBrief("evals").includes(line));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

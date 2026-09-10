/**
 * Hermetic unit check for `paw chat`'s pure `@`-mention completer (src/chat.ts → completeMention).
 * No mesh, no manager, no readline — just the [matches, substringToReplace] contract node's readline
 * expects. Isolated PAW_HOME/PAW_SPACE so real paw state is untouched. Run: pnpm check:chat
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-chat-home-"));
process.env.PAW_SPACE = "chattest";

const { completeMention, shouldFollowDm, parseChatTarget, passesFilter } = await import("../src/chat.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const names = ["team2027-research", "web", "Telegram", "team-alpha"];

// @te → every name starting "te" (case-insensitive: team*, Telegram), sorted; substring is "@te".
{
  const [hits, sub] = completeMention("@te", names);
  assert(eq(hits, ["@team-alpha", "@team2027-research", "@Telegram"]), `@te lists all te* names sorted (got ${JSON.stringify(hits)})`);
  assert(sub === "@te", "@te → substring-to-replace is @te");
}

// @team2027- → unique → single match (readline auto-completes it).
{
  const [hits] = completeMention("@team2027-", names);
  assert(eq(hits, ["@team2027-research"]), "@team2027- → unique single match");
}

// @ (empty prefix) → ALL names, formatted + sorted.
{
  const [hits] = completeMention("@", names);
  assert(eq(hits, ["@team-alpha", "@team2027-research", "@Telegram", "@web"]), `@ lists all names sorted (got ${JSON.stringify(hits)})`);
}

// @x (no match) → [].
{
  const [hits, sub] = completeMention("@x", names);
  assert(eq(hits, []), "@x (no match) → []");
  assert(sub === "@x", "@x → substring-to-replace is @x");
}

// case-insensitive: @TE matches team*, @tel matches Telegram, and typed case is preserved in the sub.
{
  const [hits, sub] = completeMention("@TE", names);
  assert(eq(hits, ["@team-alpha", "@team2027-research", "@Telegram"]), "@TE (uppercase) matches te* case-insensitively");
  assert(sub === "@TE", "@TE → substring preserves typed case");
  const [tel] = completeMention("@tel", names);
  assert(eq(tel, ["@Telegram"]), "@tel matches @Telegram case-insensitively (candidate is capitalized)");
}

// mid-line: "hey @te" completes the trailing @te token, not the whole line.
{
  const [hits, sub] = completeMention("hey @te", names);
  assert(eq(hits, ["@team-alpha", "@team2027-research", "@Telegram"]), "mid-line 'hey @te' completes the @te token");
  assert(sub === "@te", "mid-line → substring-to-replace is just @te");
}

// a plain word (no @) → no completions, line untouched.
{
  const [hits, sub] = completeMention("hello world", names);
  assert(eq(hits, []), "plain word (no @) → no completions");
  assert(sub === "hello world", "plain word → substring is the whole line (readline no-op)");
}

// an @ that isn't at the cursor/line-end (text after it) → no completion (readline passes text up to cursor).
{
  const [hits] = completeMention("@team then more", names);
  assert(eq(hits, []), "@token followed by more text → no completion (not trailing)");
}

// de-dupe: duplicate names (roster + registry overlap) collapse to one entry.
{
  const [hits] = completeMention("@web", ["web", "web", "webhook"]);
  assert(eq(hits, ["@web", "@webhook"]), `duplicate 'web' de-duped (got ${JSON.stringify(hits)})`);
}

// ---- shouldFollowDm: an arriving DM takes the sticky target only when your hands are off ----
const base = { from: "research", curName: "queue", typed: "", held: 0, staged: 0, historical: false, ageMs: 500 };
assert(shouldFollowDm(base), "fresh DM + empty input → follow the sender");
assert(!shouldFollowDm({ ...base, typed: "hey qu" }), "mid-typing → keep the target you were typing to");
assert(shouldFollowDm({ ...base, typed: "   " }), "whitespace only isn't composition → still follows");
assert(!shouldFollowDm({ ...base, held: 1 }), "a held continuation line is a message mid-compose → no switch");
assert(!shouldFollowDm({ ...base, staged: 1 }), "staged image/paste is composed input → no switch (the misdirection bug)");
assert(!shouldFollowDm({ ...base, from: "queue" }), "sender IS the target → nothing to switch, no noise");
assert(shouldFollowDm({ ...base, from: "QUEUE", curName: "queue" }) === false, "same-target check is case-insensitive");
assert(!shouldFollowDm({ ...base, historical: true }), "backlog replay on join → never steals the target");
assert(!shouldFollowDm({ ...base, ageMs: 60_000 }), "stale redelivery (>=60s, shown age-tagged) → no switch");
assert(shouldFollowDm({ ...base, ageMs: 59_999 }), "just inside the freshness line → follows");
assert(shouldFollowDm({ ...base, curName: undefined }), "broadcast mode → an incoming DM latches a target");
assert(!shouldFollowDm({ ...base, from: "" }), "a nameless sender can't become a target");

// ---- parseChatTarget: the sigil picks the mode ----
const threw = (f: () => unknown): boolean => { try { f(); return false; } catch { return true; } };
assert(parseChatTarget(undefined).mode === "global", "no positional → global (every conversation)");
assert(parseChatTarget("evals").mode === "global", "a BARE name stays global — no existing invocation changes meaning");
assert(parseChatTarget("evals").target === "evals", "…with the agent preselected");
assert(parseChatTarget("@research").mode === "agent" && parseChatTarget("@research").target === "research", "@name → filtered to that agent, sigil stripped");
assert(parseChatTarget("#general").mode === "channel" && parseChatTarget("#general").target === "general", "#chan → channel mode, sigil stripped");
assert(parseChatTarget("~/Github/paw").mode === "global", "a path is a folder, not a sigil");
assert(parseChatTarget("paw@feature").mode === "global", "a repo@branch worktree is NOT an @-filter (the sigil must LEAD)");
assert(threw(() => parseChatTarget("@")), "a bare @ fails loud rather than silently meaning global");
assert(threw(() => parseChatTarget("#")), "a bare # fails loud too");

// ---- passesFilter: what is shown is what is marked read ----
const agentF = { kind: "agent" as const, name: "research" };
const chanF = { kind: "channel" as const, name: "team2027" };
assert(passesFilter(undefined, { kind: "dm", from: "anyone" }), "no filter → everything shows");
assert(passesFilter(agentF, { kind: "dm", from: "research" }), "agent filter: that agent's DM shows");
assert(passesFilter(agentF, { kind: "dm", from: "RESEARCH" }), "…case-insensitively");
assert(!passesFilter(agentF, { kind: "dm", from: "queue" }), "agent filter: another agent's DM is hidden (and so not marked read)");
assert(!passesFilter(agentF, { kind: "channel", channel: "general" }), "agent filter: channel traffic is hidden");
assert(!passesFilter(agentF, { kind: "anycast", from: "research" }), "agent filter: an anycast is not a DM");
assert(passesFilter(chanF, { kind: "channel", channel: "team2027" }), "channel filter: that channel shows");
assert(!passesFilter(chanF, { kind: "channel", channel: "general" }), "channel filter: another channel is hidden");
assert(!passesFilter(chanF, { kind: "dm", from: "research" }), "channel filter: DMs are hidden (they stay in `paw inbox`)");

// The cross-session ECHO rides the space tap, not the message handler, so it must be filtered by the
// same predicate — otherwise `paw chat @a` shows everything you typed to @b in another window.
assert(passesFilter(agentF, { kind: "dm", from: "research" }), "echo: your own send TO the filtered agent still shows");
assert(!passesFilter(agentF, { kind: "dm", from: "queue-ea" }), "echo: your send to ANOTHER agent is hidden in a filtered session (it can carry anything, incl. secrets)");
assert(!passesFilter(agentF, { kind: "channel", channel: "general" }), "echo: a channel post is hidden in an agent-filtered session");
assert(passesFilter(chanF, { kind: "channel", channel: "team2027" }), "echo: your own post to the filtered channel shows");
assert(passesFilter(undefined, { kind: "dm", from: "anyone" }), "echo: unfiltered sessions still show everything");

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw chat check(s) failed`);
  process.exit(1);
}
console.log("\nall paw chat checks passed 🐾");

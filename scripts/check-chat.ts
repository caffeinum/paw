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

const { completeMention, shouldFollowDm, parseChatTarget, passesFilter, presenceVisible, activityLine, elsewhereBadge } = await import("../src/chat.js");

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
{
  const { chatTargetArg } = await import("../src/chat.js");
  assert(chatTargetArg(undefined, false) === ".", "bare `paw chat` targets this folder, like `paw attach`");
  assert(chatTargetArg("research", false) === "research", "a given target is kept");
  assert(chatTargetArg(undefined, true) === undefined, "--all is every conversation, nothing preselected");
  assert(threw(() => chatTargetArg("research", true)), "--all with a target fails loud rather than picking one");
}
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
assert(presenceVisible(undefined, "canary"), "no filter → every presence change shows");
assert(elsewhereBadge(0) === "" && elsewhereBadge(3) === "3 elsewhere", "hidden traffic is one prompt badge, empty when nothing is hidden");
assert(presenceVisible({ kind: "agent", name: "Queue-EA" }, "queue-ea"), "agent filter: that agent's presence shows");
assert(!presenceVisible({ kind: "agent", name: "queue-ea" }, "research"), "agent filter: another agent's presence is hidden");
assert(!presenceVisible({ kind: "channel", name: "general" }, "research"), "channel filter: no agent presence");
assert(activityLine("Bash: SC=/tmp; rm -rf x\n  for j in a b") === "Bash: SC=/tmp; rm -rf x for j in a b", "multi-line activity collapses to one line");
assert(activityLine("x".repeat(150)).length === 100 && activityLine("x".repeat(150)).endsWith("…"), "long activity is cut at 100");
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

// ── views: logs · logs + chat · chat, the keys, the hint and the picker window (2026-09-23) ─────
{
  const { stepView, navKey, hintFor, pickerWindow, logBlockVisible, showsLogs, showsChat, arrowRun } = await import("../src/chat-views.js");
  assert(arrowRun("\x1b[B") === 1 && arrowRun("\x1b[A") === -1, "arrows: a single ↓/↑ is one step");
  assert(arrowRun("\x1b[B".repeat(20)) === 20, "arrows: a held ↓ read as ONE chunk is 20 steps, not typing (the collapse-to-1/1 bug)");
  assert(arrowRun("\x1b[B\x1b[A\x1b[B") === 1 && arrowRun("\x1bOB\x1bOB") === 2, "arrows: mixed runs net out; SS3 encodings count");
  assert(arrowRun("\x1b[Ba") === undefined && arrowRun("ab") === undefined && arrowRun("\x1b[D") === undefined, "arrows: anything else in the chunk is typing, not a run");
  assert(stepView("chat", -1) === "both" && stepView("both", -1) === "logs", "view: ← steps chat → logs+chat → logs");
  assert(stepView("logs", -1) === "logs" && stepView("chat", 1) === "chat", "view: the ends CLAMP — a wrap would read as the key misfiring");
  assert(showsLogs("logs") && showsLogs("both") && !showsLogs("chat"), "view: logs and both follow the transcript, chat doesn't");
  assert(showsChat("both") && showsChat("chat") && !showsChat("logs"), "view: both and chat print the conversation, logs doesn't");

  for (const k of ["\x1b[D", "\x1bOD", "\x1b[1;3D", "\x1b[1;9D", "\x1bb"]) assert(navKey(k) === "left", `keys: ${JSON.stringify(k)} is ← (plain, Option as CSI, Cmd/super, Option as Meta)`);
  for (const k of ["\x1b[C", "\x1b[1;3C", "\x1b[1;9C", "\x1bf"]) assert(navKey(k) === "right", `keys: ${JSON.stringify(k)} is →`);
  assert(navKey("\x1b[1;3B") === "down" && navKey("\x1b[B") === "down", "keys: plain and Option+↓ both open the picker");
  assert(navKey("a") === undefined && navKey("\x1b[A") === undefined, "keys: letters and ↑ are not navigation");

  assert(hintFor({ view: "both", picking: false, hasTarget: true, bang: false }) === "logs + chat  │  ← logs   ↓ mention   chat →", "hint: the middle view offers both ways and names where you are");
  assert(!hintFor({ view: "logs", picking: false, hasTarget: true, bang: false }).includes("←"), "hint: at the left end there is no ←");
  assert(!hintFor({ view: "chat", picking: false, hasTarget: true, bang: false }).includes("→"), "hint: at the right end there is no →");
  assert(hintFor({ view: "chat", picking: false, hasTarget: false, bang: false }) === "↓ mention an agent", "hint: with no target the views don't apply — only the picker is offered");
  assert(hintFor({ view: "chat", picking: true, hasTarget: true, bang: false }).startsWith("↑↓ select"), "hint: the picker's own keys while it is open");

  assert(JSON.stringify(pickerWindow(5, 2, 12)) === JSON.stringify({ start: 0, end: 5 }), "picker: a short list shows whole");
  assert(JSON.stringify(pickerWindow(118, 0, 12)) === JSON.stringify({ start: 0, end: 12 }), "picker: the top of a long list");
  const mid = pickerWindow(118, 60, 12);
  assert(mid.start <= 60 && 60 < mid.end && mid.end - mid.start === 12, "picker: the SELECTION stays inside the window (the bug: it scrolled off the top)");
  assert(JSON.stringify(pickerWindow(118, 117, 12)) === JSON.stringify({ start: 106, end: 118 }), "picker: the bottom clamps — no blank rows past the list");

  const reply = { kind: "reply", to: "you", text: "done" } as const;
  const replyOther = { kind: "reply", to: "evals", text: "hi" } as const;
  const wakeYou = { kind: "wake", from: "you", via: "dm" } as const;
  const wakeOther = { kind: "wake", from: "evals", via: "dm" } as const;
  const tool = { kind: "tool", name: "Bash", display: "Bash", arg: "ls" } as const;
  assert([reply, wakeYou, tool].every((b) => logBlockVisible("logs", b, "you")), "dedup: the logs view is the raw trace — everything prints");
  assert(!logBlockVisible("both", reply, "you") && !logBlockVisible("both", wakeYou, "you"), "dedup: in logs + chat, the transcript's copy of YOUR conversation is dropped (the DM and your typed line already show it)");
  assert(logBlockVisible("both", replyOther, "you") && logBlockVisible("both", wakeOther, "you") && logBlockVisible("both", tool, "you"), "dedup: traffic with OTHER agents and the agent's own work still print — that's what the logs are for");
  assert(!logBlockVisible("chat", tool, "you"), "dedup: the chat view prints no transcript at all");
}

// ── LogFollower: the transcript feed behind the logs views ──────────────────────────────────────
{
  const { LogFollower } = await import("../src/chat-views.js");
  type B = import("../src/transcript.js").Block;
  const render = (b: B) => (b.kind === "tool" ? `TOOL ${b.arg}` : b.kind === "reply" ? `REPLY→${b.to}` : b.kind === "wake" ? `WAKE←${b.from}` : b.kind);
  const tool = (arg: string): B => ({ kind: "tool", name: "Bash", display: "Bash", arg });
  const mkSrc = (history: B[]) => {
    const queue: B[][] = [];
    return { src: { blocks: (n: number) => history.slice(-n), pull: () => queue.shift() ?? [] }, queue };
  };
  const out: string[] = [];
  const a = mkSrc([...Array.from({ length: 30 }, (_, i) => tool(`old${i}`)), { kind: "reply", to: "you", text: "x" }]);
  const b = mkSrc([tool("b-history")]);
  let opens = 0;
  const f = new LogFollower((n) => { opens++; if (n === "a") return a.src; if (n === "b") return b.src; throw new Error(`paw: ${n} isn't registered to a folder`); }, (t) => out.push(t), render, "you", 5);

  f.pump("a", "both");
  assert(out.length === 1 && out[0].startsWith("── a · recent activity ──"), "follow: first pump backfills under a divider");
  assert(out[0].split("\n").length === 6 && out[0].includes("TOOL old29") && !out[0].includes("TOOL old24"), "follow: the backfill is the last N VISIBLE blocks");
  assert(!out[0].includes("REPLY→you"), "follow: the backfill respects the view's dedup (your own reply isn't doubled in logs + chat)");

  out.length = 0;
  a.queue.push([tool("n1"), tool("n2"), { kind: "wake", from: "you", via: "dm" }]);
  f.pump("a", "both");
  assert(out.length === 1 && out[0] === "TOOL n1\nTOOL n2", "follow: new blocks print as ONE batch (one prompt redraw), deduped");
  f.pump("a", "both");
  assert(out.length === 1, "follow: nothing new → nothing printed");

  a.queue.push([{ kind: "reply", to: "you", text: "y" }]);
  f.pump("a", "logs");
  assert(out[1] === "REPLY→you", "follow: the logs view prints the reply — it's the only place the answer shows there");

  out.length = 0;
  f.pump("b", "both");
  assert(out[0].startsWith("── b · recent activity ──") && out[0].includes("TOOL b-history"), "follow: a target change re-points with a fresh backfill (caught lazily, on the next pump)");

  out.length = 0;
  f.pump("ghost", "both");
  f.pump("ghost", "both");
  f.pump("ghost", "both");
  assert(out.length === 1 && out[0].includes("no logs for ghost") && !out[0].includes("paw:"), "follow: an agent with no readable log is reported ONCE, not every second");

  out.length = 0;
  f.pump("a", "chat");
  assert(out.length === 0, "follow: the chat view prints no transcript");
  const before = opens;
  f.pump("a", "both");
  assert(opens === before + 1 && out[0].startsWith("── a"), "follow: coming back from the chat view re-opens and backfills, rather than dumping everything missed");
  f.pump(undefined, "both");
  assert(out.length === 1, "follow: no target → nothing to follow, silently");
}

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw chat check(s) failed`);
  process.exit(1);
}
console.log("\nall paw chat checks passed 🐾");

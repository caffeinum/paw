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

// ── history / painter / follower: the redraw model behind the views (2026-09-23) ────────────────
{
  const { LogFollower, History, Painter, entryVisible, CLEAR_ALL } = await import("../src/chat-views.js");
  type B = import("../src/transcript.js").Block;
  type E = import("../src/chat-views.js").Entry;
  const render = (b: B) => (b.kind === "tool" ? `TOOL ${b.arg}` : b.kind === "reply" ? `REPLY→${b.to}` : b.kind === "wake" ? `WAKE←${b.from}` : b.kind);
  const tool = (arg: string): B => ({ kind: "tool", name: "Bash", display: "Bash", arg });

  // entryVisible — each view is a filter over one history
  const dmT: E = { kind: "chat", text: "hi", side: "peer", tight: false, from: "a" };
  const dmO: E = { kind: "chat", text: "yo", side: "peer", tight: false, from: "other" };
  const sys: E = { kind: "chat", text: "joined", side: "sys", tight: false };
  const echo: E = { kind: "echo", text: "you → a> hello" };
  const logA: E = { kind: "log", agent: "a", blocks: [tool("x")], backfill: false };
  const logB: E = { kind: "log", agent: "b", blocks: [tool("y")], backfill: false };
  const note: E = { kind: "chat", text: "(no logs for a)", side: "sys", tight: true, onlyLogs: true };
  const vis = (e: E, v: "logs" | "both" | "chat", readable = true) => entryVisible(e, v, "a", readable);
  assert([dmT, dmO, sys, echo].every((e) => vis(e, "chat")) && !vis(logA, "chat"), "visible: chat = the conversation, no transcript");
  assert([dmT, dmO, sys, echo, logA].every((e) => vis(e, "both")), "visible: logs + chat = both");
  assert(vis(logA, "logs") && !vis(logB, "logs") && !vis(logB, "both"), "visible: transcript blocks only for the CURRENT target");
  assert(!vis(echo, "logs"), "visible: logs hides your typed lines (the `wake from you` blocks stand for them)");
  const err: E = { kind: "chat", text: 'no peer named "nobody"', side: "sys", tight: false };
  const chan: E = { kind: "chat", text: "#general x: hi", side: "peer", tight: false };
  assert(vis(sys, "logs") && vis(err, "logs") && vis(chan, "logs"), "visible: logs KEEPS errors, receipts and channel posts — `@nobody hi` used to print nothing at all (critic, reproduced)");
  assert(vis(dmO, "logs"), "visible: logs keeps ANOTHER agent's DM — it's in no transcript of the target's, hiding it would hide mail");
  assert(!vis(dmT, "logs") && vis(dmT, "logs", false), "visible: the target's own DM shows in logs only if its transcript can't be read (else the ↩ you block is it)");
  assert(vis(note, "logs") && vis(note, "both") && !vis(note, "chat"), "visible: a note about the logs stays out of the chat view");
  assert(entryVisible({ kind: "banner", text: "B\n\n" }, "logs", undefined, false), "visible: the banner shows in every view");

  // Painter — the live path and a redraw must produce the SAME text
  const P = () => new Painter(render, "you");
  const seq: E[] = [{ kind: "banner", text: "BANNER\n\n" }, echo, { kind: "chat", text: "⏳ waiting", side: "you", tight: false }, logA, dmT, { kind: "chat", text: "line1\nline2", side: "peer", tight: false }];
  const live = P();
  const liveText = seq.map((e) => live.paint(e, "both")).join("");
  const again = P();
  assert(seq.map((e) => again.paint(e, "both")).join("") === liveText, "painter: replaying the history reproduces the live screen exactly");
  assert(liveText.includes("\n  line2"), "painter: continuation lines keep their indent (moved from emit unchanged)");
  const both = P().paint({ kind: "log", agent: "a", blocks: [{ kind: "reply", to: "you", text: "x" }], backfill: false }, "both");
  assert(both === "", "painter: a log batch the view filters to nothing prints NOTHING — not a stray blank line");
  const back = P().paint({ kind: "log", agent: "a", blocks: [tool("z")], backfill: true }, "logs");
  assert(back.includes("── a · earlier ──") && back.includes("TOOL z"), "painter: a backfill is labelled as earlier activity");
  const pr = P();
  pr.paint({ kind: "chat", text: "reply", side: "peer", tight: false }, "chat");
  assert(pr.paint({ kind: "chat", text: "joined", side: "sys", tight: false }, "chat") === "joined\n", "painter: after a trailing blank, a side change adds no second blank");

  // History — bounded, banner survives
  const h = new History(3);
  h.push({ kind: "banner", text: "B" });
  for (let i = 0; i < 5; i++) h.push({ kind: "chat", text: `m${i}`, side: "sys", tight: true });
  assert(h.entries.length === 3 && h.entries[0].kind === "banner" && (h.entries[2] as { text: string }).text === "m4", "history: capped, oldest non-banner dropped, the banner kept");

  // LogFollower — hands over RAW blocks as log entries
  const mkSrc = (history: B[]) => {
    const queue: B[][] = [];
    return { src: { blocks: (n: number) => history.slice(-n), pull: () => queue.shift() ?? [] }, queue };
  };
  const got: Array<{ agent: string; blocks: B[]; backfill: boolean }> = [];
  const errs: string[] = [];
  const a = mkSrc(Array.from({ length: 30 }, (_, i) => tool(`old${i}`)));
  const b = mkSrc([tool("b-history")]);
  const f = new LogFollower((n) => { if (n === "a") return a.src; if (n === "b") return b.src; throw new Error(`paw: ${n} isn't registered to a folder`); }, (e) => got.push(e), (n, m) => errs.push(`${n}: ${m}`), 5);
  assert(f.pump("a") === true && got.length === 1 && got[0].backfill && got[0].blocks.length === 5 && got[0].blocks[4].kind === "tool", "follow: a new target re-points (returns true) and backfills its last N blocks");
  a.queue.push([tool("n1"), tool("n2")]);
  assert(f.pump("a") === false && got.length === 2 && !got[1].backfill && got[1].blocks.length === 2, "follow: new blocks arrive as ONE entry, not re-pointed");
  f.pump("a");
  assert(got.length === 2, "follow: nothing new → no entry");
  assert(f.pump("b") === true && got[2].agent === "b" && got[2].backfill, "follow: a target change is caught lazily and reported (the caller redraws)");
  f.pump("ghost"); f.pump("ghost"); f.pump("ghost");
  assert(errs.length === 1 && errs[0] === "ghost: ghost isn't registered to a folder", "follow: an unreadable target is reported ONCE, without the `paw:` prefix");
  assert(!f.readable("ghost") && f.readable("a") && !f.readable(undefined), "follow: readable() says whether the target's trace exists — the logs view's fallback for its DMs");
  f.pump(undefined);
  assert(f.readable("ghost"), "follow: dropping the target forgets the failure, so it is retried later");

  assert(CLEAR_ALL === "\x1b[H\x1b[2J\x1b[3J", "redraw: clears the screen, THEN the scrollback (2J can push into scrollback)");

  // Critic findings, each pinned
  const g = mkSrc([tool("g0")]);
  const h2 = mkSrc([tool("h0")]);
  const got2: Array<{ agent: string; blocks: B[]; backfill: boolean }> = [];
  const f2 = new LogFollower((n) => (n === "g" ? g.src : h2.src), (e) => got2.push(e), () => {}, 5);
  f2.pump("g"); f2.pump("h");
  g.queue.push([tool("g-while-away")]);
  f2.pump("g");
  assert(got2.filter((e) => e.agent === "g" && e.backfill && !(e as { note?: string }).note).length === 1, "follow: A → B → A backfills A ONCE (it printed every line twice)");
  const last = got2[got2.length - 1] as { agent: string; blocks: B[]; backfill: boolean; note?: string };
  assert(last.agent === "g" && last.note === "while you were away" && (last.blocks[0] as { arg: string }).arg === "g-while-away", "follow: …and returning to A pulls only what it wrote while you were away, labelled");

  // A long absence is capped and says so, rather than a wall of old trace
  const k = mkSrc([tool("k0")]);
  const got3: Array<{ blocks: B[]; note?: string }> = [];
  const f3 = new LogFollower((n) => (n === "k" ? k.src : h2.src), (e) => got3.push(e), () => {}, 5);
  f3.pump("k"); f3.pump("h");
  k.queue.push(Array.from({ length: 300 }, (_, i) => tool(`k${i}`)));
  f3.pump("k");
  const away = got3[got3.length - 1];
  assert(away.blocks.length === 5 && (away.blocks[4] as { arg: string }).arg === "k299" && away.note === "while you were away · 295 older skipped (paw log for all)", "follow: 300 blocks missed → the last 5, and a label saying 295 were skipped");

  // An unreadable agent's note shows once per session, even across A → B → A
  const errs3: string[] = [];
  const f4 = new LogFollower((n) => { if (n === "bad") throw new Error("paw: nope"); return h2.src; }, () => {}, (n) => errs3.push(n), 5);
  f4.pump("bad"); f4.pump("h"); f4.pump("bad"); f4.pump("h"); f4.pump("bad");
  assert(errs3.length === 1, "follow: the '(no logs for x)' note is shown ONCE per session, not on every return");
}
{
  const { dropSender, logBlockFor, displayWidth } = await import("../src/chat-views.js");
  const drain = "2 messages:\n[DM from you] do this\n[DM from evals] heads up:\nline two of evals";
  assert(dropSender(drain, "you") === "[DM from evals] heads up:\nline two of evals", "drain: drop YOUR messages (and the stale count), keep another agent's — multi-line bodies included");
  assert(dropSender("1 message:\n[DM from you] only mine", "you") === "", "drain: nothing left → empty");
  assert(dropSender("some format we don't know", "you") === "some format we don't know", "drain: an unknown format is left UNTOUCHED rather than risk eating mail");
  const inc = (t: string) => ({ kind: "incoming", text: t }) as const;
  assert(logBlockFor("both", inc("1 message:\n[DM from you] x"), "you") === undefined, "drain: in logs + chat, a drain of only YOUR messages disappears (they're your typed lines)");
  assert((logBlockFor("both", inc(drain), "you") as { text: string }).text.startsWith("[DM from evals]"), "drain: in logs + chat, agent-to-agent mail to the target now shows (it was dropped whole)");
  assert(logBlockFor("logs", inc(drain), "you")!.kind === "incoming" && (logBlockFor("logs", inc(drain), "you") as { text: string }).text === drain, "drain: the logs view shows the drain as-is");
  const mixed = "4 messages:\n[DM from you] mine\n[#general research] channel post by research\n[#general you] my own post\n[DM from evals] theirs";
  assert(dropSender(mixed, "you") === "[#general research] channel post by research\n[DM from evals] theirs", "drain: MIXED DM + channel items — yours dropped in both forms, theirs kept (the critic's second pass)");
  assert(dropSender("1 message:\n[#general you] only my post", "you") === "", "drain: a channel-only drain is understood too (it used to pass through whole and double your post)");
  const { fitWidth } = await import("../src/chat-views.js");
  assert(fitWidth("日本語テキスト", 7) === "日本語…" && fitWidth("short", 20) === "short", "width: the hint is cut by display columns, not code units");
  assert(displayWidth("abc") === 3 && displayWidth("日本語") === 6 && displayWidth("🐾") === 2 && displayWidth("\x1b") === 0, "width: CJK and emoji take two columns (the hint sat on wrapped CJK input)");

}

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw chat check(s) failed`);
  process.exit(1);
}
console.log("\nall paw chat checks passed 🐾");

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

const { completeMention, shouldFollowDm, parseChatTarget, passesFilter, presenceVisible, activityLine, elsewhereBadge } = await import("../src/chat.ts");

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
  const { chatTargetArg } = await import("../src/chat.ts");
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

// ── views: logs · chat · tasks, the keys, the hint and the picker window (2026-09-23, tasks 2026-10-07) ─
{
  const { stepView, navKey, hintFor, pickerWindow, logBlockVisible, showsLogs, showsChat, arrowRun, VIEWS, VIEW_LABEL, viewNeedsTarget } = await import("../src/chat-views.ts");
  assert(arrowRun("\x1b[B") === 1 && arrowRun("\x1b[A") === -1, "arrows: a single ↓/↑ is one step");
  assert(arrowRun("\x1b[B".repeat(20)) === 20, "arrows: a held ↓ read as ONE chunk is 20 steps, not typing (the collapse-to-1/1 bug)");
  assert(arrowRun("\x1b[B\x1b[A\x1b[B") === 1 && arrowRun("\x1bOB\x1bOB") === 2, "arrows: mixed runs net out; SS3 encodings count");
  assert(arrowRun("\x1b[Ba") === undefined && arrowRun("ab") === undefined && arrowRun("\x1b[D") === undefined, "arrows: anything else in the chunk is typing, not a run");
  assert(eq(VIEWS, ["logs", "chat", "tasks"]), "view: exactly three views, logs · chat · tasks");
  assert(!Object.values(VIEW_LABEL).some((l) => l.includes("+")) && Object.keys(VIEW_LABEL).length === 3, "view: no `logs + chat` label survives");
  assert(stepView("chat", -1) === "logs" && stepView("chat", 1) === "tasks", "view: ← from chat is logs, → is tasks");
  assert(stepView("tasks", -1) === "chat" && stepView("logs", 1) === "chat", "view: tasks ← chat, logs → chat");
  assert(stepView("logs", -1) === "logs" && stepView("tasks", 1) === "tasks", "view: the ends CLAMP — a wrap would read as the key misfiring");
  const cycled = new Set<string>();
  let v: import("../src/chat-views.ts").ChatView = "logs";
  for (let i = 0; i < 6; i++) { cycled.add(v); v = stepView(v, 1); }
  assert(cycled.size === 3, "view: stepping → from the left end visits exactly 3 views");
  assert(showsLogs("logs") && !showsLogs("chat") && !showsLogs("tasks"), "view: only logs follows the transcript");
  assert(showsChat("chat") && !showsChat("logs") && !showsChat("tasks"), "view: only chat prints the conversation (tasks is its own dashboard)");
  assert(viewNeedsTarget("logs") && !viewNeedsTarget("chat") && !viewNeedsTarget("tasks"), "view: only logs needs a target — tasks shows your own beads without one");

  for (const k of ["\x1b[D", "\x1bOD", "\x1b[1;3D", "\x1b[1;9D", "\x1bb"]) assert(navKey(k) === "left", `keys: ${JSON.stringify(k)} is ← (plain, Option as CSI, Cmd/super, Option as Meta)`);
  for (const k of ["\x1b[C", "\x1b[1;3C", "\x1b[1;9C", "\x1bf"]) assert(navKey(k) === "right", `keys: ${JSON.stringify(k)} is →`);
  assert(navKey("\x1b[1;3B") === "down" && navKey("\x1b[B") === "down", "keys: plain and Option+↓ both open the picker");
  assert(navKey("a") === undefined && navKey("\x1b[A") === undefined, "keys: letters and ↑ are not navigation");

  assert(hintFor({ view: "chat", picking: false, hasTarget: true, bang: false }) === "chat  │  ← logs   ↓ mention   tasks →", "hint: the middle view offers both ways and names where you are");
  assert(!hintFor({ view: "logs", picking: false, hasTarget: true, bang: false }).includes("←"), "hint: at the left end there is no ←");
  assert(!hintFor({ view: "tasks", picking: false, hasTarget: true, bang: false }).includes("→"), "hint: at the right end there is no →");
  assert(hintFor({ view: "chat", picking: false, hasTarget: false, bang: false }) === "chat  │  ↓ mention an agent   tasks →", "hint: with no target, logs isn't offered — tasks (your own beads) is");
  assert(hintFor({ view: "tasks", picking: false, hasTarget: false, bang: false }) === "tasks  │  ← chat   ↓ mention an agent", "hint: tasks with no target goes back to chat");
  assert(hintFor({ view: "chat", picking: true, hasTarget: true, bang: false }).startsWith("↑↓ select"), "hint: the picker's own keys while it is open");

  assert(JSON.stringify(pickerWindow(5, 2, 12)) === JSON.stringify({ start: 0, end: 5 }), "picker: a short list shows whole");
  assert(JSON.stringify(pickerWindow(118, 0, 12)) === JSON.stringify({ start: 0, end: 12 }), "picker: the top of a long list");
  const mid = pickerWindow(118, 60, 12);
  assert(mid.start <= 60 && 60 < mid.end && mid.end - mid.start === 12, "picker: the SELECTION stays inside the window (the bug: it scrolled off the top)");
  assert(JSON.stringify(pickerWindow(118, 117, 12)) === JSON.stringify({ start: 106, end: 118 }), "picker: the bottom clamps — no blank rows past the list");

  const reply = { kind: "reply", to: "you", text: "done" } as const;
  const wakeYou = { kind: "wake", from: "you", via: "dm" } as const;
  const tool = { kind: "tool", name: "Bash", display: "Bash", arg: "ls" } as const;
  assert([reply, wakeYou, tool].every((b) => logBlockVisible("logs", b)), "blocks: the logs view is the raw trace — everything prints");
  assert(!logBlockVisible("chat", tool) && !logBlockVisible("tasks", tool), "blocks: chat and tasks print no transcript at all");
}

// ── history / painter / follower: the redraw model behind the views (2026-09-23) ────────────────
{
  const { LogFollower, History, Painter, entryVisible, CLEAR_ALL } = await import("../src/chat-views.ts");
  type B = import("../src/transcript.ts").Block;
  type E = import("../src/chat-views.ts").Entry;
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
  const vis = (e: E, v: "logs" | "chat" | "tasks", readable = true) => entryVisible(e, v, "a", readable);
  assert([dmT, dmO, sys, echo].every((e) => vis(e, "chat")) && !vis(logA, "chat"), "visible: chat = the conversation, no transcript");
  assert(![dmT, dmO, sys, echo, logA, { kind: "banner", text: "B" } as E].some((e) => vis(e, "tasks")), "visible: tasks paints from its own model — nothing from the history");
  assert(vis(logA, "logs") && !vis(logB, "logs"), "visible: transcript blocks only for the CURRENT target");
  assert(!vis(echo, "logs"), "visible: logs hides your typed lines (the `wake from you` blocks stand for them)");
  const err: E = { kind: "chat", text: 'no peer named "nobody"', side: "sys", tight: false };
  const chan: E = { kind: "chat", text: "#general x: hi", side: "peer", tight: false };
  assert(vis(sys, "logs") && vis(err, "logs") && vis(chan, "logs"), "visible: logs KEEPS errors, receipts and channel posts — `@nobody hi` used to print nothing at all (critic, reproduced)");
  assert(vis(dmO, "logs"), "visible: logs keeps ANOTHER agent's DM — it's in no transcript of the target's, hiding it would hide mail");
  assert(!vis(dmT, "logs") && vis(dmT, "logs", false), "visible: the target's own DM shows in logs only if its transcript can't be read (else the ↩ you block is it)");
  assert(vis(note, "logs") && !vis(note, "chat"), "visible: a note about the logs stays out of the chat view");
  assert(entryVisible({ kind: "banner", text: "B\n\n" }, "logs", undefined, false) && entryVisible({ kind: "banner", text: "B\n\n" }, "chat", undefined, false), "visible: the banner shows in logs and chat");

  // Painter — the live path and a redraw must produce the SAME text
  const P = () => new Painter(render);
  const seq: E[] = [{ kind: "banner", text: "BANNER\n\n" }, echo, { kind: "chat", text: "⏳ waiting", side: "you", tight: false }, logA, dmT, { kind: "chat", text: "line1\nline2", side: "peer", tight: false }];
  const live = P();
  const liveText = seq.map((e) => live.paint(e, "chat")).join("");
  const again = P();
  assert(seq.map((e) => again.paint(e, "chat")).join("") === liveText, "painter: replaying the history reproduces the live screen exactly");
  assert(liveText.includes("\n  line2"), "painter: continuation lines keep their indent (moved from emit unchanged)");
  const none = P().paint({ kind: "log", agent: "a", blocks: [{ kind: "reply", to: "you", text: "x" }], backfill: false }, "chat");
  assert(none === "", "painter: a log batch the view filters to nothing prints NOTHING — not a stray blank line");
  const back = P().paint({ kind: "log", agent: "a", blocks: [tool("z")], backfill: true }, "logs");
  assert(back.includes("── a · earlier ──") && back.includes("TOOL z"), "painter: a backfill is labelled as earlier activity");
  const pr = P();
  pr.paint({ kind: "chat", text: "reply", side: "peer", tight: false }, "chat");
  assert(pr.paint({ kind: "chat", text: "joined", side: "sys", tight: false }, "chat") === "joined\n", "painter: after a trailing blank, a side change adds no second blank");

  // History — conversation kept forever, only trace (log) entries bounded
  const h = new History(2);
  h.push({ kind: "banner", text: "B" });
  for (let i = 0; i < 5; i++) {
    h.push({ kind: "chat", text: `m${i}`, side: "peer", tight: true });
    h.push({ kind: "log", agent: "a", blocks: [], backfill: false, note: `l${i}` });
  }
  const kinds = h.entries.map((e) => e.kind);
  const notes = h.entries.filter((e) => e.kind === "log").map((e) => (e as { note?: string }).note);
  assert(kinds.filter((k) => k === "chat").length === 5 && kinds[0] === "banner", "history: every message and the banner kept");
  assert(notes.join() === "l3,l4", "history: only the newest trace entries kept, oldest trace dropped");

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
  const { logBlockFor, displayWidth } = await import("../src/chat-views.ts");
  const drain = "2 messages:\n[DM from you] do this\n[DM from evals] heads up:\nline two of evals";
  const inc = (t: string) => ({ kind: "incoming", text: t }) as const;
  assert((logBlockFor("logs", inc(drain)) as { text: string }).text === drain, "drain: the logs view shows the drain as-is");
  // Log spacing = paw log's: blank before each turn, a ⎿ result stays glued to its call (screenshot, 2026-09-23)
  {
    const { Painter: P2 } = await import("../src/chat-views.ts");
    const { attachesAbove } = await import("../src/log.ts");
    const r = (b: import("../src/transcript.ts").Block) => (b.kind === "tool" ? `● Bash(${b.arg})` : b.kind === "result" ? `  ⎿  ${b.lines[0]}` : "?");
    const t = (arg: string) => ({ kind: "tool", name: "Bash", display: "Bash", arg }) as const;
    const res = (x: string): import("../src/transcript.ts").Block => ({ kind: "result", lines: [x], isError: false });
    const pp = new P2(r, (x) => x, "  ", attachesAbove);
    const a = pp.paint({ kind: "log", agent: "a", blocks: [t("one"), res("ok"), t("two"), res("ok2")], backfill: false }, "logs");
    assert(a === "● Bash(one)\n  ⎿  ok\n\n● Bash(two)\n  ⎿  ok2\n", "spacing: a blank line between turns, none between a call and its ⎿ result");
    const b = pp.paint({ kind: "log", agent: "a", blocks: [t("three")], backfill: false }, "logs");
    assert(b === "\n● Bash(three)\n", "spacing: the next 1s batch still opens with its blank — the poll splits the trace, not the rhythm");
    const c2 = pp.paint({ kind: "log", agent: "a", blocks: [res("late")], backfill: false }, "logs");
    assert(c2 === "  ⎿  late\n", "spacing: a result that lands in the NEXT batch stays glued to its call");
  }
  {
    const { renderBlock } = await import("../src/log.ts");
    const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
    const one = plain(renderBlock({ kind: "reply", to: "you", text: "done", full: "done" }));
    assert(one === "↩ you done", "dm render: a one-liner stays on the header line, NO ● bullet");
    const body = "short answer: no. " + "y".repeat(300) + "\n\n- **point** one\n- point two";
    const many = plain(renderBlock({ kind: "reply", to: "you", text: "short answer: no. yyy…", full: body }));
    assert(!many.startsWith("●") && many.startsWith("↩ you\n") && many.includes("y".repeat(300)) && !many.includes("…"), "dm render: a long DM prints in FULL under its header, like paw chat — no bullet, no cut-off");
    assert(many.includes("point one") && !many.includes("**"), "dm render: …as markdown (bullets, bold rendered)");
    assert(plain(renderBlock({ kind: "reply", to: "you", text: "gist only" })) === "↩ you gist only", "dm render: an older block with no `full` falls back to the gist");
  }
  const { fitWidth } = await import("../src/chat-views.ts");
  assert(fitWidth("日本語テキスト", 7) === "日本語…" && fitWidth("short", 20) === "short", "width: the hint is cut by display columns, not code units");
  assert(displayWidth("abc") === 3 && displayWidth("日本語") === 6 && displayWidth("🐾") === 2 && displayWidth("\x1b") === 0, "width: CJK and emoji take two columns (the hint sat on wrapped CJK input)");

}

// ── plain `paw chat` connects, never creates (operator, 2026-09-24) ─────────────────────────────────
{
  const { noAgentMessage } = await import("../src/chat.ts");
  const m = noAgentMessage("/Users/x/.paw/web/getslash.co", "@getslash.co", ["getslash-co", "evals", "queue"]);
  assert(m.includes("paw chat --fresh @getslash.co") && m.includes("did you mean @getslash-co"), "no agent: points at --fresh AND at the registered name it looks like");
  assert(noAgentMessage("/tmp/new", ".", ["evals"]).includes("`paw status` lists your agents"), "no agent: nothing close → points at paw status, no invented suggestion");
  assert(!noAgentMessage("/tmp/q", "q", ["queue", "queue-ea"]).includes("did you mean"), "no agent: a 1-2 char token suggests nothing (it would match everything)");
}

// AwaitTracker: one pending entry per sent message (the 2026-10-06 "message 2 looked lost" bug).
{
  const { AwaitTracker } = await import("../src/chat-awaiting.ts");

  // The reported sequence: msg1 to an idle agent, it starts working, msg2 sent mid-turn.
  const t = new AwaitTracker();
  assert(!t.sent("kit", "m1", 1000, "idle").queued, "send to an idle agent is not queued");
  assert(eq(t.presence("kit", "working").map((p) => p.id), ["m1"]), "idle→working picks up the message sent before it");
  assert(eq(t.presence("Kit", "working"), []), "an activity update inside the same turn picks nothing (case-insensitive name)");
  assert(t.sent("kit", "m2", 5000, "working").queued, "send to a working agent is queued");
  assert(t.pendingFor("kit").length === 2, "both messages pending — the second did not overwrite the first");
  assert(eq(t.presence("kit", "working"), []), "the CURRENT turn's next update does not claim the queued message");
  const r1 = t.reply("kit", undefined);
  assert(r1.answered?.id === "m1" && r1.answered.at === 1000, "a reply with no replyTo answers the OLDEST, timed from its own send");
  assert(r1.remaining === 1, "one message still pending after the first reply");
  assert(eq(t.presence("kit", "idle"), []), "going idle picks nothing");
  assert(eq(t.presence("kit", "working").map((p) => p.id), ["m2"]), "the next turn picks up the queued message");
  const r2 = t.reply("kit", undefined);
  assert(r2.answered?.id === "m2" && r2.answered.at === 5000 && r2.remaining === 0, "second reply answers m2, timed from m2's send");
  assert(t.reply("kit", undefined).answered === undefined, "an unsolicited DM answers nothing");
}
{
  const { AwaitTracker } = await import("../src/chat-awaiting.ts");
  const t = new AwaitTracker();
  t.sent("a", "x1", 1, "idle");
  t.sent("a", "x2", 2, "idle");
  t.sent("b", "y1", 3, "idle");
  const r = t.reply("a", "x2");
  assert(r.answered?.id === "x2" && r.remaining === 1, "replyTo naming one of ours answers THAT message, not the oldest");
  assert(t.reply("a", "not-ours").answered?.id === "x1", "an unknown replyTo falls back to the oldest");
  assert(eq(t.presence("b", "working").map((p) => p.id), ["y1"]), "pending is per agent — a's replies never touch b's");
  t.sent("c", "z1", 1, "working");
  t.sent("c", "z2", 2, "working");
  assert(eq(t.presence("c", "waiting"), []) && eq(t.presence("c", "working").map((p) => p.id), ["z1", "z2"]), "a new turn picks up every queued message, oldest first");
  t.sent("d", "w1", 1, "idle");
  t.presence("d", "offline");
  assert(eq(t.presence("d", "working").map((p) => p.id), ["w1"]), "offline→working (a restart) also starts a turn");
}

// ── the tasks view model (src/chat-tasks.ts, 2026-10-07) ─────────────────────────────────────────
{
  const { agentBeads, lastExchange, renderTasksView, wrapAnsi, age, CLOSED_MAX } = await import("../src/chat-tasks.ts");
  const { displayWidth } = await import("../src/width.ts");
  type T = import("../src/tasks.ts").Task;
  const now = Date.parse("2026-10-07T12:00:00Z");
  const iso = (hAgo: number) => new Date(now - hAgo * 3_600_000).toISOString();
  const bead = (id: string, status: string, extra: Partial<T> = {}): T => ({ id, title: `title ${id}`, status, assignee: "kit", updatedAt: iso(1), ...extra });
  const tasks: T[] = [
    bead("o1", "open", { priority: 2 }),
    bead("b1", "blocked"),
    bead("ip1", "in_progress", { priority: 3 }),
    bead("o0", "open", { priority: 1 }),
    bead("ip0", "in_progress", { priority: 1 }),
    bead("x1", "open", { assignee: "someone-else" }),
    bead("c1", "closed", { closedAt: iso(2) }),
    bead("c2", "closed", { closedAt: iso(30) }),
    bead("c3", "closed", { closedAt: iso(1) }),
    bead("c4", "closed", { closedAt: iso(3) }),
    bead("c5", "closed", { closedAt: iso(5) }),
  ];
  const order = agentBeads(tasks, "kit", now).map((t) => t.id);
  assert(eq(order.slice(0, 5), ["ip0", "ip1", "b1", "o0", "o1"]), `beads: in_progress first, then blocked, then open; priority within (got ${order.join(",")})`);
  assert(!order.includes("x1"), "beads: only the agent's own (assignee) beads");
  assert(eq(order.slice(5), ["c3", "c1", "c4"]) && CLOSED_MAX === 3, "beads: closed within 24h only, newest first, at most 3");
  assert(!order.includes("c2"), "beads: a bead closed 30h ago is gone");

  const conv = [
    { from: "kit", text: "first reply", ts: 1, dir: "in" as const },
    { from: "you", text: "to kit", ts: 2, dir: "out" as const, to: "kit" },
    { from: "you", text: "to evals", ts: 3, dir: "out" as const, to: "evals" },
    { from: "Kit", text: "last reply", ts: 4, dir: "in" as const },
    { from: "evals", text: "evals reply", ts: 5, dir: "in" as const },
    { from: "you", text: "to an id", ts: 6, dir: "out" as const, to: "abc123" },
  ];
  const ex = lastExchange(conv, "kit");
  assert(ex.lastIn?.text === "last reply" && ex.lastOut?.text === "to kit", "messages: the agent's LAST message in, and your last message TO it (case-insensitive names)");
  assert(lastExchange(conv, "nobody").lastIn === undefined && lastExchange(conv, "nobody").lastOut === undefined, "messages: none for an agent you never talked to");
  assert(age(now - 90_000, now) === "1m" && age(now - 5_000, now) === "now" && age(NaN, now) === "—", "age: compact, minute resolution (a seconds counter would repaint every refresh), — (not 0) when unknown");

  const red = "\x1b[31m" + "x".repeat(25) + "\x1b[39m";
  const w = wrapAnsi(red, 10);
  assert(w.length === 3 && w.every((l) => displayWidth(l) <= 10) && w[1].startsWith("\x1b[31m") && w[0].endsWith("\x1b[0m"), "wrap: by columns, styles reset at the break and reopened");

  const long = Array.from({ length: 40 }, (_, i) => `reply line ${i}`).join("\n");
  const model = {
    agent: "kit",
    operator: "op",
    beads: agentBeads(tasks, "kit", now),
    lastIn: { text: long, ts: now - 60_000 },
    lastOut: { text: "please fix it", ts: now - 120_000 },
  };
  for (const height of [8, 12, 20, 60]) {
    const rows = renderTasksView(model, { width: 60, height, now });
    assert(rows.length <= height && rows.every((r) => displayWidth(r) <= 60), `render: fits ${height} rows × 60 cols (${rows.length} rows)`);
    assert(rows.some((r) => r.includes("reply line 39")), `render: at ${height} rows the agent's message keeps its LAST line`);
  }
  const tall = renderTasksView(model, { width: 60, height: 60, now });
  assert(tall.filter((r) => /^[◐⊘○◌✓]/.test(r)).length === 8 && !tall.some((r) => r.includes("⋮")), "render: with room, every bead and the whole message show");
  assert(tall.findIndex((r) => r.startsWith("you → kit")) < tall.findIndex((r) => r.startsWith("kit ·")), "render: messages oldest first — the newer one sits by the prompt");
  const short = renderTasksView(model, { width: 60, height: 14, now });
  assert(short.some((r) => r.includes("… +")) && short.some((r) => r.includes("⋮")), "render: when short, beads clip (… +N more) and the long message drops its OLDEST lines (⋮)");
  assert(short.filter((r) => /^[◐⊘○◌✓]/.test(r)).length === 2, "render: beads clip to 3 rows first (2 beads + the +N line)");
  assert(short.some((r) => r.includes("please fix it")), "render: your last message survives the squeeze");
  const glued = renderTasksView({ ...model, lastIn: { text: "short reply", ts: now - 60_000 }, notice: "✓ kit picked it up — working…", status: "● working" }, { width: 60, height: 30, now });
  assert(glued.length === 30, "render: fills the height, so the bottom sits by the prompt");
  assert(glued[0].includes("● working") && /^[◐⊘○◌✓]/.test(glued[1]), "render: the title carries the live status, beads hug the top");
  assert(glued[29].includes("picked it up") && glued[28].includes("short reply"), "render: the receipt is the last row, the newest message right above it");
  assert(glued.slice(9, 20).every((r) => r === ""), "render: blank filler between the beads and the conversation");
  const err = renderTasksView({ agent: "kit", operator: "op", beadsError: "bd list: boom" }, { width: 60, height: 20, now });
  assert(err.some((r) => r.includes("! beads: bd list: boom")) && !err.some((r) => r.includes("no beads")), "render: a failed read is shown, never as 'no beads'");
  const mine = renderTasksView({ operator: "op", beads: [] }, { width: 60, height: 20, now });
  assert(mine[0].includes("yours") && mine.some((r) => r.includes("no beads assigned to op")) && mine.some((r) => r.includes("pick an agent with ↓")), "render: no target → the operator's own beads + how to pick an agent");
  assert(renderTasksView({ agent: "kit", operator: "op" }, { width: 60, height: 20, now }).some((r) => r.includes("reading beads")), "render: before the first read it says so");
}

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw chat check(s) failed`);
  process.exit(1);
}
console.log("\nall paw chat checks passed 🐾");

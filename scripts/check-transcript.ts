/**
 * Checks for the transcript parser (src/transcript.ts) — the half of `paw log` that walks a claude
 * `.jsonl` and returns structured blocks. Pure: no mesh, no manager, no agent, no tty. paw is a mesh
 * CLIENT and a transcript is a local file, so nothing here needs a broker running.
 *
 * The contract these defend is that a SECOND consumer (a browser, a status summary) can have the same
 * walk the terminal gets, and that blocks carry SOURCE rather than presentation — an `assistant` block
 * holds raw markdown, so rendering it as ANSI or HTML is the caller's business.
 *
 * Run: pnpm check:transcript
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptParser, primaryArg, resultSummary, tailRead, type Block } from "../src/transcript.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const rec = (o: unknown): string => JSON.stringify(o);
const feedAll = (lines: string[]): Block[] => {
  const p = new TranscriptParser();
  return lines.flatMap((l) => p.feed(l));
};

// ── a tool call and its result are separate RECORDS and must be reunited ────────────────────────
const paired = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b/BUILD.gn" } }] } }),
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "line\nline\nline" }] } }),
]);
assert(paired.length === 2, "a tool call and its result produce two blocks");
assert(paired[0].kind === "tool" && paired[0].display === "Read" && paired[0].arg === "BUILD.gn", "the call carries display name + primary arg");
assert(paired[1].kind === "result" && paired[1].lines[0] === "Read 3 lines", "the result is summarized and paired to its call");

// A result whose call was never seen (hidden/mesh tool) yields NOTHING rather than an orphan rail.
assert(
  feedAll([rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] } })]).length === 0,
  "an unpaired tool_result is dropped, not rendered as an orphan",
);

// ── mesh plumbing is noise; the agent's own outgoing DM is signal ───────────────────────────────
const mesh = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "m1", name: "cotal_roster", input: {} },
    { type: "tool_use", id: "m2", name: "cotal_dm", input: { to: "helium", text: "on it" } },
    { type: "tool_use", id: "m3", name: "ToolSearch", input: { query: "x" } },
  ] } }),
]);
assert(mesh.length === 1 && mesh[0].kind === "reply", "cotal_* discovery and ToolSearch are hidden; an outgoing DM survives");
assert(mesh[0].kind === "reply" && mesh[0].to === "helium" && mesh[0].text === "on it", "the reply carries recipient and text");

// ── the rules must fire on the name agents ACTUALLY call ───────────────────────────────────────
// An agent never calls a bare `cotal_dm`; it calls `mcp__cotal__cotal_dm`. Keying the mesh rules on a
// `cotal_` prefix meant they silently never fired on a real transcript — replies rendered as ordinary
// tool calls and the discovery plumbing meant to be hidden was printed in full.
const mcpMesh = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "m4", name: "mcp__cotal__cotal_roster", input: {} },
    { type: "tool_use", id: "m5", name: "mcp__cotal__cotal_dm", input: { to: "via", text: "ack" } },
  ] } }),
]);
assert(mcpMesh.length === 1, "mcp-namespaced cotal discovery is hidden like the bare form");
assert(mcpMesh[0].kind === "reply" && mcpMesh[0].to === "via", "an mcp-namespaced outgoing DM renders as a reply");

// Routed by the field the call CARRIES, not by tool name: cotal_send addresses a channel, anycast a
// role. Keying on the name alone printed "↩ ?" for every tool whose recipient lives under another key.
const routed = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "r1", name: "mcp__cotal__cotal_send", input: { channel: "general", text: "hi all" } },
    { type: "tool_use", id: "r2", name: "mcp__cotal__cotal_anycast", input: { role: "reviewer", text: "who's free" } },
  ] } }),
]);
assert(routed[0].kind === "channelReply" && routed[0].channel === "general", "cotal_send with a channel is a channel post");
assert(routed[1].kind === "reply" && routed[1].to === "@reviewer", "cotal_anycast surfaces the role it addressed");

// A DIFFERENT mcp server that happens to expose a same-named tool is not cotal and stays a tool call.
const foreign = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "f1", name: "mcp__other__cotal_dm", input: { to: "x" } }] } }),
]);
assert(foreign.length === 1 && foreign[0].kind === "tool", "another server's cotal_dm is not read as a mesh reply");

// ── what a peer SAID must survive, in full ─────────────────────────────────────────────────────
// The wake marker announces that mail arrived; the words themselves only ever appear as the RESULT of
// the agent draining its inbox. Hiding the whole cotal_* family once hid that too, leaving a log with
// every reply the agent sent and nothing anyone said to it.
const incoming = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "i1", name: "mcp__cotal__cotal_inbox", input: {} }] } }),
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "i1", content: "1 message:\n[DM from you] ship it, and here is a very long instruction that must not be summarized away" } ] } }),
]);
assert(incoming.length === 1 && incoming[0].kind === "incoming", "the inbox CALL is hidden but its body survives as one incoming block");
assert(incoming[0].kind === "incoming" && incoming[0].text.includes("must not be summarized away"), "the body is kept in FULL, not summarized to a line");

// An empty drain is an empty envelope, not something a peer said.
const emptyDrain = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "i2", name: "mcp__cotal__cotal_inbox", input: {} }] } }),
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "i2", content: "No new messages." }] } }),
]);
assert(emptyDrain.length === 0, "a drain that found nothing renders nothing");

// ── the wake prompt is reduced to who woke it, not the XML wrapper ──────────────────────────────
const wake = feedAll([
  rec({ type: "user", message: { role: "user", content: '<channel source="cotal" kind="dm" from="you">📨 New dm</channel>' } }),
]);
assert(wake.length === 1 && wake[0].kind === "wake", "a cotal wake prompt becomes a wake block");
assert(wake[0].kind === "wake" && wake[0].from === "you" && wake[0].via === "dm", "the wake block carries sender and kind");

// ── blocks carry SOURCE, not presentation ──────────────────────────────────────────────────────
const asst = feedAll([rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "**bold** and `code`" }] } })]);
assert(asst.length === 1 && asst[0].kind === "assistant", "assistant text becomes one block");
assert(asst[0].kind === "assistant" && asst[0].markdown === "**bold** and `code`", "it holds RAW markdown — rendering is the caller's job");
assert(!JSON.stringify(asst).includes(""), "no ANSI escape ever reaches a block");

// ── a truncated final line is normal, not an error ──────────────────────────────────────────────
// The tail read cuts mid-record and an agent mid-write leaves a partial one. Skipping is correct;
// a lenient parse would invent a turn that never happened.
const truncated = feedAll([
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "complete" }] } }),
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","te',
]);
assert(truncated.length === 1, "a truncated last line is skipped, and the complete records before it survive");

// ── pure helpers ───────────────────────────────────────────────────────────────────────────────
assert(primaryArg("Bash", { command: "ls -la\nsecond line" }) === "ls -la", "Bash shows only its first command line");
assert(primaryArg("Read", { file_path: "/x/y/z.ts" }) === "z.ts", "file tools show the basename");
assert(resultSummary("Write", { content: "a\nb\nc", file_path: "/p/q.txt" }, "", false)[0] === "Wrote 3 lines to q.txt", "Write reports lines written");
assert(resultSummary("Bash", {}, "", true)[0] === "error", "an error with no text still says something rather than nothing");
assert(resultSummary("Bash", {}, "one\ntwo\nthree\nfour", false).length === 3, "Bash output is capped at three lines");

// ── turnInFlight: is a turn running RIGHT NOW ──────────────────────────────────────────────────
// Both fixtures are the real record shapes observed in a live transcript. Claude closes a completed
// turn with system/turn_duration; a running one ends on a tool_use + its tool_result with no closer.
// This is exact where the mtime heuristic it replaces only meant "wrote something in the last 10s" —
// which went dark on an agent sitting inside a 45-second command.
const { turnInFlight } = await import("../src/transcript.js");
const finished = [
  rec({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }),
  rec({ type: "user", message: { role: "user", content: [] } }),
  rec({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } }),
  rec({ type: "attachment" }),
  rec({ type: "system", subtype: "stop_hook_summary" }),
  rec({ type: "system", subtype: "turn_duration" }),
].join("\n");
const running = [
  rec({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }),
  rec({ type: "user", message: { role: "user", content: [] } }),
  rec({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }),
  rec({ type: "user", message: { role: "user", content: [] } }),
].join("\n");
assert(turnInFlight(finished) === false, "a transcript ending in turn_duration is a FINISHED turn");
assert(turnInFlight(running) === true, "a transcript ending mid tool_use/tool_result is a RUNNING turn");

// `turn_duration` is NOT always written — a real transcript was found with a completed turn and none
// anywhere in the file. So `stop_reason` has to decide too, or a finished session reads as working
// forever in any environment that doesn't emit the marker.
const finishedNoMarker = [
  rec({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }),
  rec({ type: "user", message: { role: "user", content: [] } }),
  rec({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } }),
  rec({ type: "attachment" }),
  rec({ type: "last-prompt" }),
].join("\n");
assert(turnInFlight(finishedNoMarker) === false, "end_turn closes a turn even with no turn_duration in the file");
assert(
  turnInFlight(rec({ type: "assistant", message: { role: "assistant", stop_reason: "stop_sequence", content: [] } })) === false,
  "stop_sequence also closes a turn",
);
assert(
  turnInFlight(rec({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } })) === true,
  "a bare tool_use with nothing after it is a step still in flight",
);

// A new turn after a completed one reads as running — the marker must be the LAST thing, not merely present.
assert(turnInFlight(finished + "\n" + running) === true, "a turn started after a completed one reads as running");

// No completion marker anywhere → "cannot tell", so the caller falls back instead of asserting.
assert(turnInFlight(rec({ type: "system", subtype: "something_else" })) === undefined, "no marker at all → undefined, never a guess");
assert(turnInFlight("") === undefined, "an empty tail tells us nothing");
// A truncated final line proves nothing either way and must not decide the answer.
assert(turnInFlight(finished + '\n{"type":"assist') === false, "a truncated last line is skipped, not read as activity");

// ── tailRead drops the partial leading line ────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "paw-transcript-"));
const file = join(dir, "t.jsonl");
writeFileSync(file, "AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\n");
const tail = tailRead(file, 18); // lands mid-way through the B line
assert(!tail.includes("AAAA"), "an earlier line outside the window isn't read");
assert(tail.startsWith("CCCCCCCCCC") || tail.startsWith("BBBBBBBBBB"), "the read starts at a line boundary, never mid-record");
assert(tailRead(file, 10_000).split("\n")[0] === "AAAAAAAAAA", "a window larger than the file keeps the true first line");


// ---- task-notification: render a monitor wake the way Claude Code does ----
{
  const { parseTaskNotification } = await import("../src/transcript.js");
  // The exact envelope from the operator's trace (2026-08-20).
  const raw = [
    "<task-notification>",
    "<task-id>b44y2hnzp</task-id>",
    '<summary>Monitor event: "Exact prod repro: openai/gpt-5.6 openclaw run"</summary>',
    "<event>[21:33] clerk-dev-test  ✗ agent exit 1 (exit 1) after 13m59s</event>",
    "If this event is something the user would act on, send a PushNotification. Routine or benign output doesn't need one.",
    "</task-notification>",
  ].join("\n");
  const n = parseTaskNotification(raw);
  assert(n?.kind === "notification", "notification: a <task-notification> turn is reduced, not dumped");
  assert(!!n?.summary.includes("Exact prod repro"), "notification: the SUMMARY is the headline (what Claude Code shows)");
  assert(!!n?.event?.includes("agent exit 1"), "notification: the event body is KEPT — it is the only part saying what happened");
  assert(!JSON.stringify(n).includes("task-id"), "notification: the task id is machinery and is dropped");
  assert(!JSON.stringify(n).includes("PushNotification"), "notification: the standing instruction to the model is dropped");
  assert(!JSON.stringify(n).includes("</summary>"), "notification: no XML tags survive into the rendered block");

  // Never reduce something we don't understand to nothing.
  assert(parseTaskNotification("<task-notification>\n<task-id>x</task-id>\n</task-notification>") === undefined, "notification: NO summary ⇒ undefined, so the raw turn renders in full instead of vanishing");
  assert(parseTaskNotification("just a normal message") === undefined, "notification: an ordinary turn is untouched");
  assert(parseTaskNotification('<summary>bare</summary>') === undefined, "notification: a stray <summary> outside the envelope is not a notification");
  const noEvent = parseTaskNotification("<task-notification><summary>s</summary></task-notification>");
  assert(noEvent?.event === undefined, "notification: a missing event is absent, not an empty string");
}


// ---- failureText: a runtime failure is coloured, not printed as prose ----
{
  const { failureText } = await import("../src/transcript.js");
  assert(failureText("API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)") !== undefined, "failure: an API error is a failure, not something the agent said");
  assert(failureText('Background command "Wait for build" failed with exit code 144') !== undefined, "failure: a failed background command too");
  // The direction that matters: mis-flagging real writing is worse than missing one.
  assert(failureText("The API Error we saw earlier was a cert problem — here is why") === undefined, "failure: an agent DISCUSSING an error is prose, not a failure line");
  assert(failureText("I ran a background command and it failed with exit code 144, so:") === undefined, "failure: …and so is prose that merely mentions one");
  assert(failureText("Everything worked.") === undefined, "failure: ordinary prose is untouched");
}

if (failures > 0) {
  console.error(`\n${failures} paw transcript check(s) failed`);
  process.exit(1);
}
console.log("\nall paw transcript checks passed 🐾");


// ── runtime failures the model never produced (recordFailure / lastFailure) ─────────────────────
{
  const { recordFailure, lastFailure, failureText } = await import("../src/transcript.js");
  const synth = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "assistant", timestamp: "2026-09-04T00:00:00Z", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text }] }, ...extra });
  const real = (text: string) => JSON.stringify({ type: "assistant", timestamp: "2026-09-04T00:01:00Z", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] } });
  const limit = "You've hit your session limit · resets 2:50am (America/Los_Angeles)\n/usage-credits to finish what you're working on.";
  const f = recordFailure(JSON.parse(synth(limit, { isApiErrorMessage: true })));
  assert(!!f && f.text.startsWith("You've hit your session limit") && f.ts === Date.parse("2026-09-04T00:00:00Z"), "isApiErrorMessage marks the turn a failure, first line kept, ts parsed");
  assert(recordFailure(JSON.parse(synth("Login expired · Please run /login"))) !== undefined, "a synthetic turn matching the text family is a failure even without the flag");
  assert(recordFailure(JSON.parse(synth("No response requested."))) === undefined, "'No response requested.' is synthetic but NOT a failure");
  assert(recordFailure(JSON.parse(real("API Error: looks like one but the model wrote it"))) === undefined, "a REAL model turn is never a failure, whatever it says");
  assert(recordFailure(JSON.parse(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }))) === undefined, "only assistant turns count");
  assert(lastFailure([synth(limit, { isApiErrorMessage: true }), real("all good now")]) === undefined, "a failure followed by a real reply is recovery — not reported");
  assert(!!lastFailure([real("earlier"), synth(limit, { isApiErrorMessage: true }), JSON.stringify({ type: "user", message: { role: "user", content: "wake" } })])?.text.startsWith("You've hit"), "the NEWEST assistant turn decides, user records in between are skipped");
  assert(lastFailure(["not json", ""]) === undefined, "garbage lines are skipped, never a throw");
  for (const l of ["Request timed out", "Please run /login · API Error: 403", "Login expired · Please run /login"]) assert(failureText(l) === l, `failureText recognises: ${l}`);
  console.log("✓ runtime failures");
}

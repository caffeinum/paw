/**
 * Hermetic checks for `paw chat`'s multi-line paste capture (src/paste.ts): the bracketed-paste
 * scanner (including chunk- and marker-split feeds), the line-count arithmetic the swallow handshake
 * depends on, the collapse threshold, and the preview/compose rendering. No mesh, no daemons, no tty.
 * Run: pnpm check:paste
 */
import {
  composePastes,
  countLines,
  makeBlock,
  normalizeNewlines,
  PASTE_END,
  PASTE_START,
  PasteScanner,
  shouldCollapse,
  submittedLineCount,
} from "../src/paste.ts";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const paste = (s: string) => `${PASTE_START}${s}${PASTE_END}`;

// --- the scanner ---------------------------------------------------------------------------------
{
  const s = new PasteScanner();
  assert(JSON.stringify(s.feed("hello")) === "[]", "scanner: ordinary typing yields no paste");
  assert(!s.pasting, "scanner: not mid-paste after plain text");
}
{
  const s = new PasteScanner();
  const got = s.feed(`pre ${paste("a\nb\nc")}`);
  assert(got.length === 1 && got[0] === "a\nb\nc", "scanner: a whole paste in one chunk, text before it ignored (readline has it)");
  assert(!s.pasting, "scanner: closed after the end marker");
}
{
  // The real pty case: payload arrives across several reads.
  const s = new PasteScanner();
  assert(s.feed(PASTE_START + "line one\n").length === 0, "scanner: start marker alone completes nothing");
  assert(s.pasting, "scanner: reports mid-paste while the payload streams");
  assert(s.feed("line two\n").length === 0, "scanner: still mid-paste");
  const got = s.feed("line three" + PASTE_END);
  assert(got.length === 1 && got[0] === "line one\nline two\nline three", "scanner: payload reassembled across three chunks");
}
{
  // A 6-byte escape sequence is not atomic on a pty read — it can split anywhere.
  const s = new PasteScanner();
  const whole = paste("x\ny");
  for (let cut = 1; cut < whole.length; cut++) {
    const sc = new PasteScanner();
    const first = sc.feed(whole.slice(0, cut));
    const second = sc.feed(whole.slice(cut));
    const all = [...first, ...second];
    if (!(all.length === 1 && all[0] === "x\ny")) {
      assert(false, `scanner: split at byte ${cut} reassembles`);
      break;
    }
    if (cut === whole.length - 1) assert(true, "scanner: reassembles at EVERY possible split point of both markers");
  }
  assert(s.feed("").length === 0, "scanner: an empty chunk is a no-op");
}
{
  const s = new PasteScanner();
  const got = s.feed(paste("one") + paste("two"));
  assert(got.length === 2 && got[0] === "one" && got[1] === "two", "scanner: two pastes in one chunk are returned in order");
}
{
  // A lone `\x1b[200` tail must NOT be treated as payload — it may complete next chunk.
  const s = new PasteScanner();
  s.feed("\x1b[200");
  const got = s.feed("~body" + PASTE_END);
  assert(got.length === 1 && got[0] === "body", "scanner: a held partial marker completes on the next chunk without polluting the payload");
}
{
  // Terminals send \r (or \r\n) for newlines inside a paste.
  const s = new PasteScanner();
  const got = s.feed(paste("a\r\nb\rc"));
  assert(got[0] === "a\nb\nc", "scanner: \\r and \\r\\n newlines normalize to \\n");
}

// --- line arithmetic (the swallow handshake depends on this being exact) --------------------------
assert(submittedLineCount("a\nb\nc") === 2, "submittedLineCount: 3 lines, no trailing newline → 2 line events (the tail stays in rl.line)");
assert(submittedLineCount("a\nb\n") === 2, "submittedLineCount: a trailing newline still means 2 line events");
assert(submittedLineCount("single") === 0, "submittedLineCount: no newline → readline submits nothing");
assert(submittedLineCount("\n") === 1, "submittedLineCount: a lone newline is one submitted (empty) line");
assert(countLines("a\nb\nc") === 3, "countLines: counts as a human does");
assert(countLines("a\nb\n") === 2, "countLines: a trailing newline does not invent an empty last line");
assert(countLines("solo") === 1, "countLines: one line");
assert(countLines("") === 0, "countLines: empty text has no lines");
assert(normalizeNewlines("a\r\nb") === "a\nb", "normalizeNewlines: CRLF → LF");

// --- collapse threshold ---------------------------------------------------------------------------
assert(shouldCollapse("a\nb"), "shouldCollapse: two lines collapse");
assert(!shouldCollapse("just one short line"), "shouldCollapse: a short single-line paste is indistinguishable from typing — left alone");
assert(shouldCollapse("x".repeat(800)), "shouldCollapse: a single line long enough to swamp the prompt collapses");
assert(!shouldCollapse("x".repeat(799)), "shouldCollapse: just under the char threshold stays inline");

// --- block + preview ------------------------------------------------------------------------------
const block = makeBlock(2, "alpha\nbeta\ngamma\ndelta\nepsilon");
assert(block.placeholder === "[Pasted text #2]", "makeBlock: placeholder carries the index");
assert(block.lines === 5 && block.chars === "alpha\nbeta\ngamma\ndelta\nepsilon".length, "makeBlock: line + char counts");

// --- compose-view: how a draft / sent message is SHOWN (src/compose-view.ts) ------------------------
{
  const { foldBlanks, parseComposed, pasteRows, RAIL, railLine, railMessage, railPastes, wrapLine } = await import("../src/compose-view.ts");
  const opts = { width: 40 };
  assert(JSON.stringify(foldBlanks(["", "a", "", "", " ", "b", "", ""])) === '["a","","b"]', "foldBlanks: leading/trailing blanks dropped, a run of blanks becomes one");
  const w = wrapLine("the quick brown fox jumps over the lazy dog", 16);
  assert(w.every((r) => r.length <= 16) && w.join(" ") === "the quick brown fox jumps over the lazy dog", "wrapLine: wraps at spaces, loses nothing");
  assert(wrapLine("x".repeat(30), 10).join("") === "x".repeat(30), "wrapLine: a word longer than the row is split, not clipped");
  const code = wrapLine("    return someFunction(argumentOne, argumentTwo)", 24);
  assert(code.length > 1 && code.every((r) => r.startsWith("    ")), "wrapLine: a wrapped code line keeps its indentation on every row");
  assert(wrapLine("a\tb", 20)[0] === "a  b" && !/[\x00-\x1f]/.test(wrapLine("a\x1b[2Jb", 20)[0]), "wrapLine: tabs expand, control chars are stripped (a row must not move the cursor)");

  const big = makeBlock(1, Array.from({ length: 25 }, (_, i) => `row ${i + 1}`).join("\n"));
  const rows = pasteRows(big, opts);
  assert(rows[0] === "📋 [Pasted text #1] 25 lines, 165 B", "pasteRows: a 📋 header naming the placeholder, its lines and size");
  assert(rows.length === 12 && rows[1] === "  row 1" && rows[10] === "  row 10", "pasteRows: up to 10 rows shown (not 3)");
  assert(rows[11] === "  … +15 more lines", "pasteRows: the rest is counted, never silently dropped");
  const long = pasteRows(makeBlock(1, `${"word ".repeat(30).trim()}\nnext`), opts);
  assert(!long.some((r) => r.includes("…")) && long.slice(1).every((r) => r.length <= 40 - RAIL.length), "pasteRows: a long line WRAPS to the width instead of ending in …");
  assert(pasteRows(makeBlock(1, "a\n\n\n\nb"), opts).length === 4, "pasteRows: blank runs inside a paste fold to one row");

  const p1 = makeBlock(1, "err\ntrace");
  const only = railLine("[Pasted text #1]", [p1], opts);
  assert(only.length === 3 && only[0] === `${RAIL}📋 [Pasted text #1] 2 lines, 9 B` && only[1] === `${RAIL}  err`, "railLine: a line that is only a placeholder BECOMES the paste — no dangling placeholder line");
  const mixed = railLine("look at [Pasted text #1] please", [p1], opts);
  assert(mixed[0] === `${RAIL}look at [Pasted text #1] please` && mixed[1].includes("📋"), "railLine: a line mentioning a paste is kept, the paste shown right under it");
  assert(railLine("plain", [p1], opts).length === 1, "railLine: a line that mentions no paste shows no paste");
  assert(railPastes("hello", [p1], opts).length === 0 && railPastes("[Pasted text #1] fix", [p1], opts).length === 3, "railPastes: only the pastes the line mentions");

  // The screenshot (2026-11-06): blank runs and a placeholder on its own line, around a paste.
  const body = "/now\nresearch and test and open a PR:\n\n\n[Pasted text #1]\n\n\n\ncolaborate with @harbor";
  const msg = railMessage(body, [big], opts);
  assert(msg[0] === `${RAIL}/now` && msg[2] === RAIL.trimEnd() && msg[3].includes("📋 [Pasted text #1]"), "railMessage: on the rail, blank run folded, the paste INLINE at its placeholder");
  assert(msg.filter((r) => r.trim() === "│").length === 2, "railMessage: each blank run is one rail row");
  assert(msg[msg.length - 1] === `${RAIL}colaborate with @harbor` && !msg.some((r) => r.endsWith("[Pasted text #1]")), "railMessage: the text after the paste follows it; the placeholder never dangles on its own");
  const unmentioned = railMessage("fix it", [p1], opts);
  assert(unmentioned[0] === `${RAIL}fix it` && unmentioned[1].includes("📋"), "railMessage: a paste the text never mentions goes at the end, as it does on the wire");
  assert(railMessage("a\nb", [], { width: 40, rail: "│ " })[0] === "│ a", "railMessage: the rail is the caller's (the echo's painter indents for it)");

  // An echo of a SENT message reads the wire text back: the fences become pastes again.
  const wire = composeMessageLike(composePastes(body, [big]));
  const back = parseComposed(wire);
  assert(back.body === `${body}\n📷 [Image #1] /tmp/x.png`, "parseComposed: the typed body comes back exactly, image lines kept in order");
  assert(back.blocks.length === 1 && back.blocks[0].text === big.text && back.blocks[0].lines === 25 && back.blocks[0].placeholder === "[Pasted text #1]", "parseComposed: the paste comes back whole");
  const two = parseComposed(composePastes("a [Pasted text #1] b [Pasted text #2]", [p1, makeBlock(2, "x\n--- not a fence ---\ny")]));
  assert(two.body === "a [Pasted text #1] b [Pasted text #2]" && two.blocks[1].text === "x\n--- not a fence ---\ny", "parseComposed: several pastes, each payload intact");
  assert(parseComposed("just text\n--- x ---").body === "just text\n--- x ---" && parseComposed("just text").blocks.length === 0, "parseComposed: text without fences passes through untouched");
}
function composeMessageLike(s: string): string {
  return `${s}\n📷 [Image #1] /tmp/x.png`; // what composeMessage appends after the pastes
}

// --- compose --------------------------------------------------------------------------------------
assert(composePastes("hi", []) === "hi", "composePastes: no pastes → body untouched");
const composed = composePastes("look at [Pasted text #1]", [makeBlock(1, "err\ntrace")]);
assert(composed.startsWith("look at [Pasted text #1]"), "composePastes: the body keeps the placeholder where you pasted it");
assert(composed.includes("--- [Pasted text #1] (2 lines) ---\nerr\ntrace\n--- end [Pasted text #1] ---"), "composePastes: the payload follows in a fence naming the same placeholder");
const two = composePastes("a", [makeBlock(1, "one"), makeBlock(2, "two")]);
assert(two.includes("[Pasted text #1]") && two.includes("[Pasted text #2]"), "composePastes: several pastes are individually addressable");
assert(composePastes("", [makeBlock(1, "solo")]).startsWith("--- [Pasted text #1]"), "composePastes: a bodyless send is just the block");

// ── a paste ARRIVES IN CHUNKS ────────────────────────────────────────────────────────────────────
// The regression behind "multiline paste stopped working": a pty hands stdin ~1KB at a time, so a 3KB
// paste is four `data` events and the END marker only lands in the last. `feed` rightly yields nothing
// until then — but readline processes each chunk as it arrives and submits its lines, so chat cannot
// wait for the payload before it starts suppressing. `pasting` is the signal it suppresses on, and it
// must be true from the START marker right through the gap. Measured live: 38 messages before, 1 after.
{
  // Sized like the real one: 40 lines of build log, ~3KB — three full chunks and a short fourth.
  const big = Array.from(
    { length: 40 },
    (_, i) => `12:02:${String(i).padStart(2, "0")}.000 build output line ${i} - long enough to be realistic padding here`,
  ).join("\n");
  const stream = paste(big);
  const sc = new PasteScanner();
  const size = 1022; // what the pty actually delivered
  let yielded: string[] = [];
  const sawPastingMidStream: boolean[] = [];
  for (let i = 0; i < stream.length; i += size) {
    yielded = yielded.concat(sc.feed(stream.slice(i, i + size)));
    if (i + size < stream.length) sawPastingMidStream.push(sc.pasting);
  }
  assert(sawPastingMidStream.length > 1, "chunked: the fixture really does span several chunks");
  assert(sawPastingMidStream.every(Boolean), "chunked: `pasting` stays true across every chunk before the end marker");
  assert(yielded.length === 1 && yielded[0] === big, "chunked: the payload still reassembles exactly once, whole");
  assert(!sc.pasting, "chunked: the end marker closes it");
  assert(shouldCollapse(big), "chunked: a payload this size collapses (it is the case that was sending 38 messages)");
  assert(submittedLineCount(big) === 39, "chunked: the line count is the payload's newlines, whatever the chunking");
}

// ── typing a multi-line message (src/multiline.ts) ───────────────────────────────────────────────
// The other half of paste: pasting several lines was handled, TYPING them had no answer at all — you
// got one line, or you sent three messages.
{
  const { isContinueKey, peelContinuation, joinLines, CONTINUE_KEYS } = await import("../src/multiline.ts");
  const ESC = String.fromCharCode(27);

  // Measured under a real pty before being relied on: readline DROPS all of these as unrecognised
  // escapes — no line event, nothing inserted — which is what makes them free to define.
  assert(isContinueKey(`${ESC}\r`), "alt+enter (ESC CR) continues");
  assert(isContinueKey(`${ESC}\n`), "alt+enter (ESC LF) continues");
  assert(isContinueKey(`${ESC}[13;2u`), "shift+enter (kitty CSI-u) continues");
  assert(isContinueKey(`${ESC}[13;5u`), "ctrl+enter (kitty CSI-u) continues");
  // Checked at the END because the chunk usually carries the character typed just before it.
  assert(isContinueKey(`abc${ESC}\r`), "a key arriving with preceding typed text still counts");
  assert(!isContinueKey("\r"), "a plain Enter is a SEND, not a continuation");
  assert(!isContinueKey("hello"), "ordinary typing is not a continuation");
  assert(!isContinueKey(`${ESC}[13;2u tail`), "a sequence in the MIDDLE isn't the last keystroke");
  // cmux/ghostty: xterm modifyOtherKeys for Shift/Cmd+Enter, and CSI-u with the super (Cmd) modifier.
  const { leaksTail, LEAKED_TAIL } = await import("../src/multiline.ts");
  assert(isContinueKey(`meow${ESC}[27;2;13~`), "shift+enter (modifyOtherKeys) continues");
  assert(isContinueKey(`${ESC}[27;9;13~`), "cmd+enter (modifyOtherKeys) continues");
  assert(isContinueKey(`${ESC}[13;9u`), "cmd+enter (CSI-u super) continues");
  assert(leaksTail(`${ESC}[27;2;13~`) && !leaksTail(`${ESC}[13;2u`), "only the modifyOtherKeys form leaks a tail");
  assert(LEAKED_TAIL === "13~", "the leaked tail is what readline inserts");
  assert(!isContinueKey(`${ESC}[27;2;9~`), "a modifyOtherKeys key that isn't Enter is not a continuation");
  assert(CONTINUE_KEYS.length >= 4, "several encodings, because terminals disagree about what they send");

  // The universal fallback. ODD trailing backslashes continue: `C:\\path\\\\` ends in an ESCAPED
  // backslash and is finished, so counting wrong would swallow the Enter on any path or regex.
  assert(peelContinuation("foo \\").continues && peelContinuation("foo \\").text === "foo ", "one trailing backslash continues, and is stripped");
  assert(!peelContinuation("C:\\\\").continues, "TWO trailing backslashes are an escaped backslash — a finished line");
  assert(peelContinuation("a\\\\\\").continues, "three continue again");
  assert(!peelContinuation("plain").continues, "no backslash, no continuation");
  assert(!peelContinuation("a \\ b").continues, "a backslash mid-line is just text");
  assert(peelContinuation("").continues === false, "an empty line is not a continuation");

  assert(joinLines(["ALPHA", "BETA"], "GAMMA") === "ALPHA\nBETA\nGAMMA", "held lines join the final one with real newlines");
  assert(joinLines([], "solo") === "solo", "nothing held ⇒ the line is the message");
}

if (failures > 0) {
  console.error(`\n${failures} paste check(s) failed`);
  process.exit(1);
}
console.log("\nall paste checks passed 🐾");

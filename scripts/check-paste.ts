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
  const { foldBlanks, parseComposed, pasteRows, RAIL, railLine, railMessage, railPastes, saidRows, strayPastes, wrapLine } = await import("../src/compose-view.ts");
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
  assert(strayPastes("fix it", [p1], opts).length === 3 && strayPastes("[Pasted text #1] fix", [p1], opts).length === 0, "strayPastes: only the pastes the text never mentions (they ride along all the same)");
  // A message read back (the earlier block, the cross-session echo) is laid out at the width it is painted
  // at: stored laid out, a redraw after a resize wrapped its rows off the rail (2026-11-18).
  const words = `two ${Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, "0")}`).join(" ")} end`;
  const said = (width: number) => saidRows("you → echoer:", { body: `one\n${words}`, blocks: [] }, { width: width - 2, rail: "│ " });
  assert(said(120).length === 4 && said(60).length > 4 && said(60).slice(1).every((r) => r.startsWith("│ ") && r.length <= 58) && said(60).slice(1).map((r) => r.slice(2)).join(" ") === `one ${words}`, "saidRows: the header, then the message on the rail wrapped at the width given — words whole");
  assert(JSON.stringify(saidRows("you → echoer:", { body: "hi", blocks: [] }, opts)) === '["you → echoer: hi"]' && saidRows("you → echoer:", { body: "hi", blocks: [p1] }, opts).length === 5, "saidRows: one short line with no paste is one row; a paste puts it on the rail");

  // An echo of a SENT message reads the wire text back: the fences become pastes again.
  const wire = composeMessageLike(composePastes(body, [big]));
  const back = parseComposed(wire);
  assert(back.body === `${body}\n📷 [Image #1] /tmp/x.png`, "parseComposed: the typed body comes back exactly, image lines kept in order");
  assert(back.blocks.length === 1 && back.blocks[0].text === big.text && back.blocks[0].lines === 25 && back.blocks[0].placeholder === "[Pasted text #1]", "parseComposed: the paste comes back whole");
  const two = parseComposed(composePastes("a [Pasted text #1] b [Pasted text #2]", [p1, makeBlock(2, "x\n--- not a fence ---\ny")]));
  assert(two.body === "a [Pasted text #1] b [Pasted text #2]" && two.blocks[1].text === "x\n--- not a fence ---\ny", "parseComposed: several pastes, each payload intact");
  assert(parseComposed("just text\n--- x ---").body === "just text\n--- x ---" && parseComposed("just text").blocks.length === 0, "parseComposed: text without fences passes through untouched");
}

// --- the draft is INPUT: laid out whole on every paint, capped to the screen (2026-11-17) -----------------
{
  const { draftRows, fitRows, RAIL } = await import("../src/compose-view.ts");
  const { displayPos, echoRows, fitPainted, rowsAt, wrappedWidth } = await import("../src/width.ts");
  const opts = { width: 40 };
  const p1 = makeBlock(1, "pasted row one\npasted row two\npasted row three");
  const head = "you → echoer> ";
  const lines = ["1. corrcet", "2. looks good", "3. okay but [Pasted text #1] ", "4. the las"];
  const rows = draftRows(head, lines, [p1], opts);
  assert(rows[0] === `${head}1. corrcet` && rows[1] === `${RAIL}2. looks good`, "draftRows: the head row reads like readline's echo (prompt + first line), later lines on the rail");
  assert(rows[2] === `${RAIL}3. okay but [Pasted text #1] ` && rows[3] === `${RAIL}📋 [Pasted text #1] 3 lines, 46 B` && rows[4] === `${RAIL}  pasted row one`, "draftRows: a paste sits inline, right under the line that mentions it (the operator's screenshot)");
  assert(rows[rows.length - 1] === `${RAIL}4. the las` && rows.length === 8, "draftRows: the last line closes the block");
  const onlyPaste = draftRows(head, ["a", "[Pasted text #1]"], [p1], opts);
  assert(onlyPaste[1] === `${RAIL}📋 [Pasted text #1] 3 lines, 46 B` && !onlyPaste.some((r) => r.endsWith("│ [Pasted text #1]")), "draftRows: a later line that is only a placeholder becomes its 📋 block");
  const headPaste = draftRows(head, ["[Pasted text #1] fix", "b"], [p1], opts);
  assert(headPaste[0] === `${head}[Pasted text #1] fix` && headPaste[1]!.includes("📋") && headPaste[headPaste.length - 1] === `${RAIL}b`, "draftRows: the head line's paste goes right under the head row");
  const live = draftRows(head, lines.slice(0, 3), [p1], opts);
  const sent = draftRows(head, [...lines.slice(0, 3), "4. the last line"], [p1], opts);
  assert(JSON.stringify(sent.slice(0, live.length)) === JSON.stringify(live), "draftRows: the live draft is a prefix of the echo it becomes — the scrollback shows what was composed");
  let threw = "";
  try { draftRows(head, [], [], opts); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("at least one line"), "draftRows: an empty draft fails loud");

  assert(rowsAt("x".repeat(40), 40) === 1 && rowsAt("x".repeat(41), 40) === 2 && rowsAt("", 40) === 1 && rowsAt("\x1b[2mab\x1b[0m", 1) === 2, "rowsAt: rows the terminal wraps a row onto (ANSI takes none, an empty row still one)");
  // A wide glyph that would start in the last column wraps whole, leaving that column empty (the S25
  // head row: 14-col prompt + `a` + 52×界 + `b` at 60 cols is THREE rows, not ceil(120/60) = 2).
  const cjk = `${head}a${"界".repeat(52)}b`;
  assert(wrappedWidth("x" + "界".repeat(2), 4) === 6 && wrappedWidth("界".repeat(2), 4) === 4 && rowsAt(cjk, 60) === 3, "rowsAt: a wide glyph starting in the last column wraps whole onto the next row");
  // readline gives a line that ends exactly at the edge a row of its own for the caret (kRefreshLine's
  // forced space) — its echo is one row taller than the text (the S12/S24 doubled head row).
  assert(echoRows("x".repeat(59), 60) === 1 && echoRows("x".repeat(60), 60) === 2 && echoRows("x".repeat(61), 60) === 2 && echoRows("", 60) === 1, "echoRows: readline's echo of a line exactly the width takes the extra caret row");
  assert(echoRows(`${head}${"x".repeat(44)}A\\`, 60) === 2 && echoRows(`${RAIL}${"y".repeat(54)}B\\`, 60) === 2 && echoRows(`${cjk}\\`, 60) === 3, "echoRows: the exact-width `\\` lines and the wide head row of the adversarial runs");
  const ten = Array.from({ length: 10 }, (_, i) => `${RAIL}row ${i + 1}`);
  assert(JSON.stringify(fitRows(ten, 10, opts)) === JSON.stringify(ten), "fitRows: a draft that fits is shown whole");
  const capped = fitRows(ten, 4, opts);
  assert(capped.length === 4 && capped[0] === `${RAIL}… +7 more rows above` && capped[3] === `${RAIL}row 10` && capped[1] === `${RAIL}row 8`, "fitRows: taller than the room → its LAST rows under one `… +N more rows above` row");
  const wrapped = [`${head}${"w".repeat(60)}`, `${RAIL}b`, `${RAIL}c`];
  const fitW = fitRows(wrapped, 3, opts);
  assert(fitW.length === 3 && fitW[0] === `${RAIL}… +2 more rows above` && fitW[2] === `${RAIL}c`, "fitRows: a wrapped head row counts every terminal row it takes");
  assert(fitW.reduce((n, r) => n + rowsAt(r, 40), 0) <= 3, "fitRows: what it returns fits in the room");
  const wide = fitRows([cjk, `${RAIL}s25 two`], 3, { width: 60 });
  assert(wide.length === 2 && wide[0] === `${RAIL}… +3 more rows above`, "fitRows: a wide glyph wrapping at the edge counts its extra row");
  const one = fitRows(ten, 1, opts);
  assert(one.length === 1 && one[0] === `${RAIL}… +10 more rows above`, "fitRows: room for one row → the count alone");
  assert(fitRows(["only"], 1, { width: 40, dim: (s) => `<${s}>` })[0] === "only" && fitRows(ten, 2, { width: 40, dim: (s) => `<${s}>` })[0] === `<${RAIL}><… +9 more rows above>`, "fitRows: the count row is dimmed like the rail");
  threw = "";
  try { fitRows(ten, 0, opts); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("room for 0 rows"), "fitRows: no room at all fails loud (the caller keeps one)");

  // A tab moves to the next multiple of 8, as readline counts it (2026-11-18: counted as 0 columns, a
  // 120-column `\t`-filled line was one row to paw and two to readline — the erase left a stale head row).
  // Measured in tmux 3.8 at 60 columns (cursor after 59 × `x` + the glyph): a glyph wide only by its VS16
  // is placed narrow, then widened — in the last column it stays (60); one wide by itself wraps whole (62).
  const tmux59 = (g: string) => wrappedWidth(`${"x".repeat(59)}${g}`, 60);
  assert(tmux59("⚠️") === 60 && tmux59("❤️") === 60 && wrappedWidth(`${"x".repeat(58)}⚠️`, 60) === 60 && tmux59("✅") === 62 && tmux59("界") === 62 && tmux59("👩‍💻") === 62 && wrappedWidth(`${"x".repeat(59)}⚠️y`, 60) === 61, "wrappedWidth: a VS16 glyph in the last column stays there; an emoji or CJK glyph wraps whole (tmux's own layout)");
  assert(wrappedWidth("a\tb", 120) === 9 && wrappedWidth("\t", 120) === 8 && rowsAt(`${RAIL}${"a\t".repeat(15)}end`, 120) === 2, "wrappedWidth: a tab advances to the next tab stop");
  // readline lays the line out by paw's count (chat hands it displayPos as its _getDisplayPos): its own put
  // `❤️` at 1 column and `👩‍💻` at 4, so on a row of them its refresh climbed too few rows, left stale rows
  // and the hint row in the line, and put the caret short of the text (2026-11-18). With the hook, readline
  // agrees with the terminal everywhere — VS16/ZWJ/flags/keycaps/marks — and echoRows with readline.
  const { createInterface } = await import("node:readline");
  const { PassThrough, Writable } = await import("node:stream");
  const emoji = ["❤️", "⚠️ warn", "👩‍💻 ok", "🏳️‍🌈", "👍🏽", "🇺🇸", "1️⃣", "e\u0301", "a\u200bb", "\u00ad", "ｱ한"];
  for (const cols of [60, 120]) {
    const out = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { isTTY: true, columns: cols, rows: 40 });
    const r = createInterface({ input: new PassThrough(), output: out, terminal: true });
    const hooked = r as unknown as { _getDisplayPos: (s: string) => { cols: number; rows: number } };
    hooked._getDisplayPos = (s) => displayPos(s, cols);
    const at = (l: string): { rows: number; cols: number } => {
      r.setPrompt(l);
      return r.getCursorPos();
    };
    const edges = emoji.flatMap((e) => [e, `${"x".repeat(cols - 2)}${e}`, `${"x".repeat(cols - 1)}${e}`, `${"x".repeat(cols - 4)}${e}`]);
    const lines = [`${RAIL}${"a\t".repeat(15)}end`, `${head}a${"界".repeat(52)}b`, "x".repeat(cols), "x".repeat(cols - 1), `${head}\tx\t${"y".repeat(70)}\t`, ...edges];
    const off = lines.filter((l) => echoRows(l, cols) !== at(l).rows + 1 || wrappedWidth(l, cols) !== at(l).rows * cols + at(l).cols);
    assert(off.length === 0, `displayPos: readline, given it, lays every line out as the terminal does, and echoRows agrees at ${cols} columns (off: ${JSON.stringify(off)})`);
    r.close();
  }
  assert(JSON.stringify(displayPos("ab\ncd", 60)) === '{"cols":2,"rows":1}' && JSON.stringify(displayPos(`${"x".repeat(60)}\nab`, 60)) === '{"cols":2,"rows":1}' && JSON.stringify(displayPos("\n", 60)) === '{"cols":0,"rows":1}', "displayPos: a newline ends a row as readline's own count has it (a full row before it adds none)");
  assert(JSON.stringify(displayPos("x".repeat(70), Infinity)) === '{"cols":70,"rows":0}', "displayPos: no width known (readline's Infinity) → one row");
  // The caret row: readline writes one for any line ending exactly at the edge — now by the terminal's count.
  // A `\` line on a 60-column rail ending in `❤️` fills the row (tmux draws it 2 wide): two rows, the caret's
  // included. `👩‍💻` is 2 columns: 58, one row.
  const heart = `${RAIL}${"y".repeat(53)}❤️\\`;
  assert(wrappedWidth(heart, 60) === 60 && echoRows(heart, 60) === 2, "echoRows: a `❤️` that fills the row takes the caret row, like any line ending at the edge");
  const zwj = `${"x".repeat(56)}👩‍💻`;
  assert(wrappedWidth(zwj, 60) === 58 && echoRows(zwj, 60) === 1, "echoRows: a ZWJ emoji is one glyph, two columns: short of the edge, one row");
  assert(echoRows(`${"x".repeat(58)}界`, 60) === 2 && echoRows(`${"x".repeat(59)}界`, 60) === 2, "echoRows: a wide glyph ending at the edge gets the caret row; one wrapped whole gets none");

  // A painted row cut to one terminal row (the ↓ picker at a narrow width: a wrapped row made the area
  // taller than the room the draft left for it).
  const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;
  const row = `  ▸ \x1b[1m\x1b[36mlong-agent-name-x0\x1b[0m ${dim("○ offline — a message wakes it")}`;
  const cut = fitPainted(row, 44);
  assert(wrappedWidth(cut, 44) === 44 && cut.endsWith("…\x1b[0m") && cut.includes("\x1b[1m\x1b[36mlong-agent-name-x0\x1b[0m"), "fitPainted: a painted row too wide is cut to the width, its colours intact, `…` at the cut, the colour reset");
  assert(fitPainted("short", 44) === "short" && fitPainted(row, 120) === row, "fitPainted: a row that fits is left as it is");
  assert(wrappedWidth(fitPainted(`${"x".repeat(43)}界`, 44), 44) <= 44 && wrappedWidth(fitPainted("a👩‍💻bcdef", 5), 5) <= 5 && fitPainted("a👩‍💻bcdef", 5).includes("👩‍💻"), "fitPainted: a wide glyph at the edge and a ZWJ sequence are cut whole, within the width");
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

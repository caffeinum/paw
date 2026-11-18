/**
 * How many terminal COLUMNS a string takes — zero-dep, shared by every renderer that pads or wraps:
 * the markdown tables, `paw status`, and `paw chat`'s hint line.
 *
 * `.length` counts UTF-16 code units, which a terminal doesn't: an emoji or a CJK character takes two
 * columns, a combining mark or a variation selector takes none. Padding a table cell on `.length`
 * shifted its right border one column left per ✅/❌ in the row — the misaligned table the operator
 * screenshotted (2026-09-23), where some cells' borders drifted and others didn't.
 *
 * Wide = Unicode's own Emoji_Presentation property (✅ ❌ 🐾 — they render as emoji by default),
 * anything followed by VS16 (U+FE0F: `⚠️` is `⚠` asking for emoji presentation), and the East Asian
 * Wide/Fullwidth blocks. ANSI escape sequences are stripped first — they take no columns.
 */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const EMOJI = /\p{Emoji_Presentation}/u;
const ZERO = /[\p{Mn}\p{Me}​-‏⁠︀-️]/u;

function wideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Columns one character takes, given the character after it (for VS16). */
function charWidth(ch: string, next: string | undefined): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO.test(ch)) return 0;
  if (next === "️" || EMOJI.test(ch) || wideCodePoint(cp)) return 2;
  return 1;
}

export function displayWidth(s: string): number {
  const chars = Array.from(s.replace(ANSI, ""));
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    // A zero-width joiner sequence (👩‍💻) draws as ONE glyph: count its first part only.
    if (chars[i] === "‍") {
      i++;
      continue;
    }
    w += charWidth(chars[i], chars[i + 1]);
  }
  return w;
}

/** readline's tab stop (its default `tabSize`; chat never sets another). */
const TAB = 8;

/**
 * The columns `s` moves the cursor when written from column 0 of a `cols`-wide terminal: its display
 * width, plus one for every wide glyph that would start in the last column — the terminal wraps it whole
 * onto the next row and leaves that column empty (readline's own _getDisplayPos counts it the same way,
 * and a tab the same way too).
 */
export function wrappedWidth(s: string, cols: number): number {
  const w = Math.max(1, cols);
  const chars = Array.from(s.replace(ANSI, ""));
  let at = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "‍") {
      i++;
      continue;
    }
    // A tab moves to the next multiple of 8 — readline's own count (its tabSize), which the erase follows.
    if (chars[i] === "\t") {
      at += TAB - (at % TAB);
      continue;
    }
    const cw = charWidth(chars[i], chars[i + 1]);
    if (cw === 2 && (at + 1) % w === 0) at++;
    at += cw;
  }
  return at;
}

/** Terminal rows one line (no newline in it) takes once written from column 0 and wrapped: at least one. */
export const rowsAt = (line: string, cols: number): number => Math.max(1, Math.ceil(wrappedWidth(line, cols) / Math.max(1, cols)));

const READLINE_ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** Columns readline gives one code point (node's getStringWidth, char by char): it has no VS16 look-ahead
 *  and joins no ZWJ sequence — `❤️` is 1 column to readline and 2 on screen, `👩‍💻` 4 and 2. */
function readlineCharWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (EMOJI.test(ch) || wideCodePoint(cp)) return 2;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (READLINE_ZERO.test(ch) && cp !== 0xad)) return 0;
  return 1;
}

/** The columns readline's own count (_getDisplayPos) moves the cursor for `s` — where it decides whether
 *  the caret needs a row of its own. It disagrees with the terminal ({@link wrappedWidth}) on VS16 and
 *  ZWJ emoji only. */
export function readlineWidth(s: string, cols: number): number {
  const w = Math.max(1, cols);
  let at = 0;
  for (const ch of s.replace(ANSI, "")) {
    if (ch === "\t") {
      at += TAB - (at % TAB);
      continue;
    }
    const cw = readlineCharWidth(ch);
    if (cw === 2 && (at + 1) % w === 0) at++;
    at += cw;
  }
  return at;
}

/**
 * Rows readline's prompt + line takes — live, and as the echo it leaves on Enter (the cursor then sits on
 * the row under it): the rows the terminal wraps it onto, and one more for the caret when it ends exactly
 * at the right edge. That row is readline's: it writes a space to make the terminal give the caret a row
 * of its own (kRefreshLine) only when ITS count ends at the edge too — a `❤️` filling the row is two
 * columns on screen but one to readline, which then writes no space and the echo is one row.
 */
export function echoRows(line: string, cols: number): number {
  const w = Math.max(1, cols);
  const at = wrappedWidth(line, w);
  const caret = at > 0 && at % w === 0 && readlineWidth(line, w) % w === 0;
  return Math.max(1, Math.ceil(at / w)) + (caret ? 1 : 0);
}

/** The longest prefix of `s` (plain text, no ANSI) that fits in `cols` columns. */
export function sliceWidth(s: string, cols: number): string {
  const chars = Array.from(s);
  let out = "";
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const cw = charWidth(chars[i], chars[i + 1]);
    if (w + cw > cols) break;
    out += chars[i];
    w += cw;
  }
  return out;
}

/** Cut `s` to at most `cols` columns, marking the cut with `…`. */
export function fitWidth(s: string, cols: number): string {
  if (displayWidth(s) <= cols) return s;
  return sliceWidth(s, Math.max(0, cols - 1)) + "…";
}

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

/** Wide whatever follows it: an emoji by default, or an East Asian wide character. */
const wideAlone = (ch: string): boolean => EMOJI.test(ch) || wideCodePoint(ch.codePointAt(0)!);

/** Columns one character takes, given the character after it (for VS16). */
function charWidth(ch: string, next: string | undefined): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO.test(ch)) return 0;
  if (next === "️" || wideAlone(ch)) return 2;
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
 * onto the next row and leaves that column empty (a tab moves to the next tab stop). A glyph that is wide
 * only by its VS16 (`⚠️`, `❤️`) is placed narrow first and widened after: in the last column it stays,
 * and the row ends there (tmux 3.8: 59 × `x` + `⚠️` leaves the cursor at 60, + `✅` at 62).
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
    // In the last column: a glyph wide only by its VS16 stays there, ending the row; any other wraps whole.
    if (cw === 2 && (at + 1) % w === 0) at += wideAlone(chars[i]) ? 3 : 1;
    else at += cw;
  }
  return at;
}

/** Terminal rows one line (no newline in it) takes once written from column 0 and wrapped: at least one. */
export const rowsAt = (line: string, cols: number): number => Math.max(1, Math.ceil(wrappedWidth(line, cols) / Math.max(1, cols)));

/**
 * Where the cursor ends once `s` is written from column 0 — readline's `_getDisplayPos` shape (its "\n"
 * rule too) with the terminal's count ({@link wrappedWidth}). chat hands readline this count: its own
 * (node's width per code point, no VS16 look-ahead, no ZWJ joining) put `❤️` at 1 column and `👩‍💻` at 4,
 * so on a row of such emoji its refresh climbed too few rows, left the caret in the wrong column and the
 * hint row's old copy on screen.
 */
export function displayPos(s: string, cols: number): { cols: number; rows: number } {
  const w = Math.max(1, cols);
  const parts = s.split("\n");
  let rows = 0;
  for (const p of parts.slice(0, -1)) rows += Math.ceil(wrappedWidth(p, w) / w) || 1;
  const at = wrappedWidth(parts[parts.length - 1]!, w);
  const col = at % w;
  return { cols: col, rows: rows + (at - col) / w };
}

/**
 * Rows readline's prompt + line takes — live, and as the echo it leaves on Enter (the cursor then sits on
 * the row under it): the rows the terminal wraps it onto, and one more for the caret when it ends exactly
 * at the right edge — readline writes a space there (kRefreshLine) so the terminal gives the caret a row
 * of its own. readline counts with {@link displayPos}, so it decides that edge as the terminal does.
 */
export function echoRows(line: string, cols: number): number {
  const w = Math.max(1, cols);
  const at = wrappedWidth(line, w);
  return Math.max(1, Math.ceil(at / w)) + (at > 0 && at % w === 0 ? 1 : 0);
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

/**
 * Cut a PAINTED row (ANSI kept intact, taking no columns) so the terminal draws it on one row of `cols`:
 * as it is when it fits, else its first columns and `…`, the colour reset after the cut.
 */
export function fitPainted(s: string, cols: number): string {
  const w = Math.max(1, cols);
  if (wrappedWidth(s, w) <= w) return s;
  let out = "";
  let used = 0;
  let painted = false;
  const tokens = s.match(new RegExp(`${ANSI.source}|[\\s\\S]`, "gu")) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length > 1 && t.startsWith("\u001b")) {
      out += t;
      painted = true;
      continue;
    }
    // A zero-width joiner sequence (👩‍💻) draws as ONE glyph: what it joins takes no columns of its own.
    if (t === "\u200d") {
      out += t + (tokens[++i] ?? "");
      continue;
    }
    const cw = charWidth(t, tokens[i + 1]);
    if (used + cw > w - 1) break;
    out += t;
    used += cw;
  }
  return `${out}…${painted ? "\u001b[0m" : ""}`;
}

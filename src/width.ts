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

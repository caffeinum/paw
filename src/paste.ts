/**
 * Multi-line paste capture for `paw chat` — the `[Pasted text #1]` flow, sibling to `[Image #1]`
 * (src/images.ts).
 *
 * THE PROBLEM: readline is line-oriented. Paste 40 lines of a stack trace and it fires 40 `line`
 * events, so paw sent 40 separate messages — each a fragment, each waking the agent, the last one
 * arriving before the first was read. There is no "the user pasted" signal in a line event.
 *
 * THE SIGNAL: bracketed paste (DEC mode 2004). With `\x1b[?2004h` set, the terminal wraps pasted
 * content in `\x1b[200~` … `\x1b[201~`, which is the ONLY trustworthy way to tell a paste from
 * fast typing — a debounce would be a guess, and paw doesn't guess.
 *
 * WHY A RAW LISTENER RATHER THAN READLINE: verified under a real pty (node 26) —
 *   1. a `prependListener("data")` sees the chunk WITH both markers, BEFORE readline processes it;
 *   2. readline's key decoder silently DROPS the markers (they decode as unknown CSI sequences),
 *      so they never reach `rl.line` and can't be recovered there;
 *   3. the paste then fires exactly ONE line event per newline in the payload, and the trailing
 *      segment (after the last newline) is left sitting in `rl.line`.
 * That gives chat.ts everything it needs: flag the paste from the raw chunk, swallow exactly N line
 * events, then rewrite the buffer to the placeholder — the same Ctrl-U/Ctrl-K rewrite the image swap
 * already uses. Nothing here touches readline, so line editing, history and completion are untouched.
 *
 * WHY THE TEXT RIDES IN THE MESSAGE (unlike an image): an image is a FILE the agent opens with Read,
 * so `[Image #1]` announces a path. Pasted text has no file — it only exists in the terminal — so the
 * body carries the placeholder where it belongs and the full text follows in a fenced block. Same
 * reason images use plain text and not a data part: the claude connector flattens every inbound
 * message to one string, and that string is all the model ever sees (see src/images.ts).
 */

/** DEC mode 2004 bracketed-paste markers, and the enable/disable sequences chat.ts writes. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

export interface PasteBlock {
  n: number;
  /** What replaces the pasted text in the line you're editing — `[Pasted text #1]`. */
  placeholder: string;
  /** The payload, newlines normalized to `\n`. */
  text: string;
  lines: number;
  chars: number;
}

/**
 * Stateful scanner over raw stdin chunks: returns each COMPLETED paste payload.
 *
 * A paste can straddle chunk boundaries anywhere — including mid-marker, since a 6-byte escape
 * sequence is not atomic on a pty read. So a trailing partial marker is carried into the next chunk
 * (`tail`) rather than being mistaken for payload. Detection only; the bytes still reach readline
 * independently, which is why discarding non-paste text here is correct rather than lossy.
 */
export class PasteScanner {
  private inside = false;
  private buf = "";
  private tail = "";

  feed(chunk: string): string[] {
    const done: string[] = [];
    let s = this.tail + chunk;
    this.tail = "";
    for (;;) {
      const marker = this.inside ? PASTE_END : PASTE_START;
      const at = s.indexOf(marker);
      if (at === -1) break;
      if (this.inside) {
        this.buf += s.slice(0, at);
        done.push(normalizeNewlines(this.buf));
        this.buf = "";
        this.inside = false;
      } else {
        this.inside = true; // text before the start marker is ordinary typing — readline has it
      }
      s = s.slice(at + marker.length);
    }
    // No complete marker left. Whatever trails could still be the START of one — hold it back.
    const held = partialMarkerLength(s, this.inside ? PASTE_END : PASTE_START);
    if (this.inside) this.buf += s.slice(0, s.length - held);
    this.tail = held ? s.slice(s.length - held) : "";
    return done;
  }

  /** Mid-paste — used so a shutdown doesn't strand a half-read payload silently. */
  get pasting(): boolean {
    return this.inside;
  }
}

/** Longest suffix of `s` that is a proper prefix of `marker` (0 when none). */
function partialMarkerLength(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length);
  for (let k = max; k > 0; k--) if (s.endsWith(marker.slice(0, k))) return k;
  return 0;
}

/** A terminal sends `\r` (or `\r\n`) for newlines inside a paste; readline ends a line on either,
 *  so normalizing first makes the line count and the payload agree. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** How many `line` events readline will fire for this payload — one per newline SEPARATOR. The
 *  segment after the last newline isn't submitted; it stays in `rl.line`. */
export function submittedLineCount(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

/** Collapse a paste into a block only when it's genuinely bulk: multi-line, or a single line long
 *  enough to swamp the prompt. A short single-line paste is indistinguishable from typing and MUST
 *  behave exactly as before — collapsing it would be a surprise, not a feature. */
export const PASTE_MIN_LINES = 2;
export const PASTE_MIN_CHARS = 800;
export function shouldCollapse(text: string): boolean {
  return countLines(text) >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS;
}

/** Lines as a human counts them: a trailing newline doesn't add an empty one. */
export function countLines(text: string): number {
  if (!text) return 0;
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return submittedLineCount(t) + 1;
}

export function makeBlock(n: number, text: string): PasteBlock {
  return { n, placeholder: `[Pasted text #${n}]`, text, lines: countLines(text), chars: text.length };
}

/** The one-line summary shown where the text used to be: `📋 [Pasted text #1] 42 lines, 3.1 KB`. */
export const PASTE_ICON = "📋";

/** First few lines, each clipped to the terminal width, as the "is this what I meant to paste?"
 *  preview — the text equivalent of the image path echo. */
export function pastePreview(block: PasteBlock, maxLines = 3, width = 72): string[] {
  const all = block.text.split("\n");
  const shown = all.slice(0, maxLines).map((l) => {
    const flat = l.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  });
  const rest = all.length - shown.length;
  if (rest > 0) shown.push(`… +${rest} more line${rest === 1 ? "" : "s"}`);
  return shown;
}

/**
 * The outgoing message: the body keeps `[Pasted text #N]` exactly where you pasted it, and each
 * payload follows in a fenced block that names the same placeholder — so the agent can tell which
 * blob goes with which mention even when several ride along.
 */
export function composePastes(body: string, blocks: PasteBlock[]): string {
  if (!blocks.length) return body;
  const parts = blocks.map((b) => `--- ${b.placeholder} (${b.lines} line${b.lines === 1 ? "" : "s"}) ---\n${b.text}\n--- end ${b.placeholder} ---`);
  return body ? `${body}\n\n${parts.join("\n\n")}` : parts.join("\n\n");
}

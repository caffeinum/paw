/**
 * How `paw chat` SHOWS a multi-line message — while you compose it, and once it is sent. Pure: text in,
 * screen rows out. The wire text is never touched here; this only decides what the operator reads.
 *
 * One look for both: the message sits on a rail (`  │ `), the same rail the continuation prompt draws,
 * so a draft, the line you're typing and the sent echo read as ONE block. A paste is shown INLINE at its
 * placeholder (`📋 [Pasted text #1] 25 lines, 2 KB` + its first rows, wrapped, never clipped mid-line),
 * runs of blank lines fold to one, and a long paste is capped with a `… +N more lines` footer.
 */
import { formatBytes } from "./images.ts";
import { PASTE_ICON, type PasteBlock } from "./paste.ts";
import { displayWidth, sliceWidth } from "./width.ts";

/** The message rail, and the continuation prompt that draws the same rail for the line being typed. */
export const RAIL = "  │ ";
/** A paste's rows sit one step further in, under their `📋` header. */
const PASTE_INDENT = "  ";
/** Rows of a paste shown inline before the `… +N more lines` footer. */
export const PASTE_ROWS = 10;

type Paint = (s: string) => string;
const plain: Paint = (s) => s;

export interface ViewOpts {
  /** Terminal columns. Rows are wrapped to fit after the rail. */
  width: number;
  dim?: Paint;
  /** Rows of each paste shown inline (default {@link PASTE_ROWS}). */
  pasteRows?: number;
  /** The rail (default {@link RAIL}); a caller whose painter already indents continuation rows passes
   *  it without the leading spaces. */
  rail?: string;
}

/** Hard-wrap one line to `cols` columns, keeping its leading indentation on every row (pastes are often
 *  code). Breaks at the last space that fits, else mid-word. Never drops a character. */
export function wrapLine(line: string, cols: number): string[] {
  const flat = line.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const width = Math.max(8, cols);
  if (displayWidth(flat) <= width) return [flat];
  const indent = /^ */.exec(flat)![0].slice(0, Math.floor(width / 2));
  const rows: string[] = [];
  let rest = flat;
  let lead = "";
  while (displayWidth(lead + rest) > width) {
    const room = width - displayWidth(lead);
    let head = sliceWidth(rest, room) || Array.from(rest)[0];
    const space = head.lastIndexOf(" ");
    if (space > 0 && head.length < rest.length && rest[head.length] !== " ") head = head.slice(0, space + 1);
    rows.push((lead + head).trimEnd());
    rest = rest.slice(head.length).replace(/^ +/, "");
    lead = indent;
  }
  if (rest) rows.push(lead + rest);
  return rows;
}

/** Drop leading/trailing blank lines and fold every run of blanks into one. Display only. */
export function foldBlanks(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const blank = l.trim() === "";
    if (blank && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(blank ? "" : l);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** One paste, inline: its `📋` header, then its first rows wrapped (blank runs folded), then a footer
 *  counting the SOURCE lines not shown. Rows are relative — the caller puts them on the rail. */
export function pasteRows(block: PasteBlock, opts: ViewOpts): string[] {
  const dim = opts.dim ?? plain;
  const max = opts.pasteRows ?? PASTE_ROWS;
  const cols = opts.width - (opts.rail ?? RAIL).length - PASTE_INDENT.length;
  const head = `${PASTE_ICON} ${block.placeholder} ${dim(`${block.lines} line${block.lines === 1 ? "" : "s"}, ${formatBytes(block.chars)}`)}`;
  const src = foldBlanks(block.text.split("\n"));
  const rows: string[] = [];
  let used = 0;
  for (const line of src) {
    const wrapped = line === "" ? [""] : wrapLine(line, cols);
    if (rows.length + wrapped.length > max && rows.length) break;
    rows.push(...wrapped.slice(0, max));
    if (wrapped.length <= max) used++; // a line cut off by the cap still counts as "more"
    if (rows.length >= max) break;
  }
  const rest = src.length - used;
  const out = [head, ...rows.map((r) => (r ? `${PASTE_INDENT}${dim(r)}` : ""))];
  if (rest > 0) out.push(`${PASTE_INDENT}${dim(`… +${rest} more line${rest === 1 ? "" : "s"}`)}`);
  return out;
}

/**
 * One line of a message, on the rail: wrapped to the width, and — when it mentions a staged paste — the
 * paste shown right under it. A line that is ONLY the placeholder becomes the paste itself, so a lone
 * `[Pasted text #1]` never dangles above or below its own preview.
 */
export function railLine(line: string, blocks: readonly PasteBlock[], opts: ViewOpts): string[] {
  const rail = railOf(opts);
  const mentioned = blocks.filter((b) => line.includes(b.placeholder));
  const rest = mentioned.reduce((s, b) => s.split(b.placeholder).join(""), line).trim();
  const own = rest || !mentioned.length ? wrapLine(line, opts.width - (opts.rail ?? RAIL).length).map((r) => (r ? rail + r : rail.trimEnd())) : [];
  return [...own, ...railPastes(line, blocks, opts)];
}

/** The rail rows of every staged paste `line` mentions — shown under a line that is echoed some other
 *  way (readline's own echo of the line you just submitted, or the first line of a draft). */
export function railPastes(line: string, blocks: readonly PasteBlock[], opts: ViewOpts): string[] {
  const rail = railOf(opts);
  return blocks.filter((b) => line.includes(b.placeholder)).flatMap((b) => pasteRows(b, opts).map((r) => rail + r));
}

const railOf = (opts: ViewOpts): string => (opts.dim ?? plain)(opts.rail ?? RAIL);

/**
 * A whole message on the rail, as the agent receives it: blank runs folded, each paste inline at its
 * placeholder (one never mentioned in the text — pasted onto a line that was otherwise empty — goes at
 * the end, as it does on the wire).
 */
export function railMessage(body: string, blocks: readonly PasteBlock[], opts: ViewOpts): string[] {
  const out: string[] = [];
  for (const line of foldBlanks(body.split("\n"))) out.push(...railLine(line, blocks, opts));
  for (const b of blocks) if (!body.includes(b.placeholder)) out.push(...pasteRows(b, opts).map((r) => railOf(opts) + r));
  return out;
}

/** The fence {@link composePastes} writes around each payload — read back so an echo of a SENT message
 *  (another session's, or a re-published one) can show the paste inline instead of as raw fences. */
const FENCE = /\n*--- (\[Pasted text #\d+\]) \((\d+) lines?\) ---\n([\s\S]*?)\n--- end \1 ---/g;

/** Split a composed message back into its typed body and its pastes. Text outside the fences (the
 *  image lines composeMessage appends) stays in the body, in order. Non-paste text passes through. */
export function parseComposed(text: string): { body: string; blocks: PasteBlock[] } {
  const blocks: PasteBlock[] = [];
  const body = text.replace(FENCE, (_all, placeholder: string, lines: string, payload: string) => {
    const n = Number(/#(\d+)/.exec(placeholder)![1]);
    blocks.push({ n, placeholder, text: payload, lines: Number(lines), chars: payload.length });
    return "";
  });
  return { body, blocks };
}

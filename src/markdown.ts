/**
 * Markdown → ANSI for the terminal (the "glow" pass), shared by `paw log` and `paw chat`.
 *
 * Agents write markdown — headings, bullets, fenced code — because that's how they write everywhere
 * else. Printed raw it's noise: `**this**` and a wall of un-delimited code. This renders the subset
 * that actually shows up in agent prose, and nothing more: it is a RENDERER, not a parser, and it
 * must never mangle text it doesn't understand.
 *
 * Two rules keep it honest:
 *  - **Never lose content.** Fence DELIMITERS are consumed (they become the rail) and nothing else is:
 *    every other input line yields an output line, an unterminated fence renders its lines as code
 *    rather than swallowing them, and an unrecognised construct passes through as-is.
 *  - **Never eat paw's own placeholders.** `[Image #1]` / `[Pasted text #1]` are bracket-shaped, so
 *    the link rule requires `](` immediately after the label — a bare `[…]` is left alone.
 *
 * Colors are tty-gated at the wrapper, so piping `paw log`/`paw chat` gives clean, ANSI-free text.
 */
const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  italic: wrap("3"),
  strike: wrap("9"),
  underline: wrap("4"),
  cyan: wrap("36"),
  yellow: wrap("33"),
};

/**
 * Inline markdown → ANSI: code spans, bold, italic, strikethrough, links.
 *
 * ORDER IS LOAD-BEARING: code spans are replaced FIRST so their contents are shielded from the
 * emphasis passes (`` `a*b*c` `` must not italicise), and the ANSI they leave behind contains no
 * `*`/`_`/`~` for a later pass to trip on. Bold precedes italic for the same reason — `**x**` would
 * otherwise be read as an empty italic wrapping `*x*`.
 */
export function inlineMd(s: string): string {
  let out = s.replace(/`([^`]+)`/g, (_, x: string) => c.yellow(x));
  // A link's label only counts when `](` follows immediately — otherwise `[Image #1] (2 lines)`
  // would be swallowed as a link with "2 lines" as its href.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => `${c.underline(label)} ${c.dim(href)}`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, x: string) => c.bold(x));
  out = out.replace(/__([^_]+)__/g, (_, x: string) => c.bold(x));
  out = out.replace(/~~([^~]+)~~/g, (_, x: string) => c.strike(x));
  // Emphasis may not open or close on whitespace — otherwise arithmetic prose ("2 * 3 * 4") and
  // shell globs italicise the text between them.
  out = out.replace(/(^|[^*\w])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*(?![*\w])/g, (_, pre: string, x: string) => pre + c.italic(x));
  return out;
}

/** A fence opener/closer: ``` or ~~~ (three or more), with an optional language on the opener. */
const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
/** `---`, `***`, `___` on their own line. */
const RULE = /^\s*([-*_])\1{2,}\s*$/;

/**
 * Block markdown → ANSI, one output line per input line except a fence delimiter, which becomes the rail.
 *
 * Fenced code is rendered verbatim behind a `│` rail with NO inline pass — the whole point of a code
 * block is that its contents are not markdown. The fence delimiters themselves become the rail, and
 * an info string (```ts) becomes a dim label, so nothing is silently dropped.
 */
/**
 * A table row's cells. `\|` is an ESCAPED pipe and belongs inside a cell — splitting on it would tear
 * one cell in two and shift every column after it. Outer pipes are delimiters, not empty cells.
 * Mirrors `web/app/md.js`'s `splitRow`: the RULES are shared, the code cannot be (that file ships to a
 * browser with no build step), so they are kept in step by documentation.
 */
export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The alignment row (`|---|:-:|--:|`) → per-column alignment, or undefined if this isn't one. THIS is
 *  what makes a table a table: a line with pipes is ordinary prose, and only the delimiter beneath a
 *  header says otherwise. */
export function parseAlign(line: string | undefined): ("" | "left" | "center" | "right")[] | undefined {
  if (!line || !line.includes("-")) return undefined;
  const cells = splitRow(line);
  if (!cells.length || !cells.every((x) => /^:?-+:?$/.test(x))) return undefined;
  return cells.map((x) => (x.startsWith(":") && x.endsWith(":") ? "center" : x.endsWith(":") ? "right" : x.startsWith(":") ? "left" : ""));
}

/** Printable width, ignoring the ANSI a cell picks up from {@link inlineMd}. Padding on `.length`
 *  would count the escape bytes and shift every styled cell — the classic table-alignment bug. */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/**
 * Render a markdown table as an ALIGNED terminal table.
 *
 * Why this is needed even in a monospace terminal: alignment only comes free if the SOURCE is already
 * padded, and an agent writes compact markdown (`| c3f77a4d | opus-5 | 69.3 C |`). One cell of a
 * different length — `opus-5` vs `sonnet-5` — shifts every column after it on that row, so the columns
 * do not line up at all. Monospace preserves whatever alignment exists; it does not create any.
 *
 * Cells are NOT truncated to fit. This renderer's rule is that it never loses content, and a table wide
 * enough to wrap is still more readable padded than not — the columns line up until the wrap.
 */
function renderTable(head: string[], rows: string[][], align: ("" | "left" | "center" | "right")[]): string[] {
  const cells = [head, ...rows].map((r) => r.map(inlineMd));
  const cols = Math.max(...cells.map((r) => r.length));
  const width: number[] = [];
  for (let n = 0; n < cols; n++) width[n] = Math.max(...cells.map((r) => visibleWidth(r[n] ?? "")));
  const pad = (cell: string, n: number): string => {
    const gap = Math.max(0, width[n] - visibleWidth(cell));
    if (align[n] === "right") return " ".repeat(gap) + cell;
    if (align[n] === "center") return " ".repeat(Math.floor(gap / 2)) + cell + " ".repeat(Math.ceil(gap / 2));
    return cell + " ".repeat(gap);
  };
  const line = (r: string[], bold: boolean) =>
    `${c.dim("│")} ${r.map((cell, n) => (bold ? c.bold(pad(cell, n)) : pad(cell, n))).join(` ${c.dim("│")} `)} ${c.dim("│")}`;
  // The delimiter row becomes a RULE — it is markup, not content, and printing `|---|---|` in a
  // rendered table is the noise this whole function exists to remove.
  const rule = c.dim(`├${width.map((w) => "─".repeat(w + 2)).join("┼")}┤`);
  return [line(cells[0], true), rule, ...cells.slice(1).map((r) => line(r, false))];
}

export function renderMarkdown(text: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(FENCE);
    if (fence !== undefined) {
      // Only a fence of the SAME kind closes the block, so ``` inside a ~~~ block stays code.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
        fence = undefined;
        continue;
      }
      out.push(`${c.dim("│")} ${c.yellow(raw)}`);
      continue;
    }
    if (f) {
      fence = f[1];
      if (f[2]) out.push(c.dim(`│ ${f[2]}`));
      continue;
    }
    // A TABLE. Checked before the rule/list cases: `|---|---|` would otherwise be read as something
    // else entirely, and the rows below it as ordinary prose.
    const align = raw.includes("|") ? parseAlign(lines[i + 1]) : undefined;
    if (align) {
      const head = splitRow(raw);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      i--; // the loop's own i++ consumes the terminator
      out.push(...renderTable(head, rows, align));
      continue;
    }
    if (RULE.test(raw)) {
      out.push(c.dim("─".repeat(40)));
      continue;
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      // h1/h2 are section headers in agent prose — give them the accent; deeper ones just bold.
      const inner = inlineMd(h[2]);
      out.push(h[1].length <= 2 ? c.cyan(c.bold(inner)) : c.bold(inner));
      continue;
    }
    const ol = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      out.push(`${ol[1]}${c.cyan(`${ol[2]}.`)} ${inlineMd(ol[3])}`);
      continue;
    }
    const ul = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      out.push(`${ul[1]}${c.cyan("•")} ${inlineMd(ul[2])}`);
      continue;
    }
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) {
      out.push(c.dim(`▏${inlineMd(bq[1])}`));
      continue;
    }
    out.push(inlineMd(raw));
  }
  return out;
}

/** Convenience for the common "render a message body into one printable string" case. */
export function renderMarkdownBlock(text: string): string {
  return renderMarkdown(text).join("\n");
}

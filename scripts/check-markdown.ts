/**
 * Hermetic checks for the shared markdown→ANSI renderer (src/markdown.ts), used by `paw log` and
 * `paw chat`. Colors are tty-gated and these run piped, so every assertion is on CONTENT — which is
 * exactly the property that matters: piping paw must give clean text, and nothing may be lost or
 * mangled on the way through. Run: pnpm check:markdown
 */
import { inlineMd, renderMarkdown, renderMarkdownBlock } from "../src/markdown.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const r = (s: string) => renderMarkdown(s);

// --- the contract: nothing is ever lost --------------------------------------------------------
assert(r("a\nb\nc").length === 3, "one output line per input line");
assert(r("").length === 1 && r("")[0] === "", "empty text stays a single empty line");
assert(r("plain prose here")[0] === "plain prose here", "text with no markdown passes through byte-identical");
assert(renderMarkdownBlock("a\nb") === "a\nb", "renderMarkdownBlock rejoins with newlines");

// --- inline ------------------------------------------------------------------------------------
assert(inlineMd("**bold**") === "bold", "bold: markers stripped (piped → no ANSI)");
assert(inlineMd("__bold__") === "bold", "bold: underscore form");
assert(inlineMd("*it*") === "it", "italic");
assert(inlineMd("~~gone~~") === "gone", "strikethrough");
assert(inlineMd("`code`") === "code", "code span");
assert(inlineMd("a `x*y*z` b") === "a x*y*z b", "code spans SHIELD their contents from the emphasis pass");
assert(inlineMd("**a** and *b*") === "a and b", "bold runs before italic, so **x** is not read as an empty italic");
assert(inlineMd("2 * 3 * 4") === "2 * 3 * 4", "bare asterisks in prose are not emphasis");
assert(inlineMd("snake_case_name") === "snake_case_name", "underscores inside a word are not emphasis");

// --- links, and paw's own placeholders ---------------------------------------------------------
assert(inlineMd("[docs](http://x/y)") === "docs http://x/y", "a link renders label + href");
assert(inlineMd("[Image #1]") === "[Image #1]", "a bare bracket label is NOT a link — paw's image placeholder survives");
assert(inlineMd("[Pasted text #1] (4 lines)") === "[Pasted text #1] (4 lines)", "the paste placeholder + a following paren group is not swallowed as a link");
assert(r("📷 [Image #1] /Users/a/b.png")[0] === "📷 [Image #1] /Users/a/b.png", "an image announcement line is untouched end to end");

// --- blocks ------------------------------------------------------------------------------------
assert(r("# Title")[0] === "Title", "h1: hashes stripped");
assert(r("### Deep")[0] === "Deep", "h3: hashes stripped");
assert(r("#nospace")[0] === "#nospace", "a hash with no space is not a heading (e.g. #general)");
assert(r("- one")[0] === "• one", "unordered list → bullet");
assert(r("  - nested")[0] === "  • nested", "list indentation is preserved");
assert(r("+ plus")[0] === "• plus", "the + list marker");
assert(r("1. first")[0] === "1. first", "ordered list keeps its number");
assert(r("2) paren")[0] === "2. paren", "the paren ordered form normalizes");
assert(r("> quoted")[0] === "▏quoted", "blockquote gets a rail");
assert(r("---")[0].startsWith("─"), "horizontal rule");
assert(r("- - -")[0] === "• - -", "a spaced dash list is a list, not a rule");

// --- fenced code -------------------------------------------------------------------------------
const fenced = r("before\n```ts\nconst x = **1**;\n```\nafter");
assert(fenced[0] === "before" && fenced[fenced.length - 1] === "after", "text around a fence is rendered normally");
assert(fenced.some((l) => l.includes("const x = **1**;")), "code inside a fence is VERBATIM — no inline pass");
assert(fenced.some((l) => l.includes("ts")), "the info string is kept as a label, never silently dropped");
const unterminated = r("```\nline one\nline two");
assert(unterminated.length === 2 && unterminated[1].includes("line two"), "an UNTERMINATED fence still renders its lines (never swallows content)");
const tilde = r("~~~\n```\n~~~");
assert(tilde.length === 1 && tilde[0].includes("```"), "a ``` inside a ~~~ block is code, not a closing fence");
const twoFences = r("```\na\n```\nb\n```\nc\n```");
assert(twoFences.length === 3 && twoFences[1] === "b", "consecutive fenced blocks close and reopen (delimiters are consumed, content is not)");
assert(twoFences[0].includes("a") && twoFences[2].includes("c"), "both fenced bodies survive");

// ── tables ───────────────────────────────────────────────────────────────────────────────────────
// Alignment is NOT free in a monospace terminal: it only comes free if the SOURCE is padded, and an
// agent writes compact markdown. One cell of a different length (`opus-5` vs `sonnet-5`) shifts every
// column after it on that row. Monospace preserves whatever alignment exists; it creates none.
{
  const { splitRow, parseAlign, visibleWidth } = await import("../src/markdown.js");

  assert(splitRow("| a | b |").join(",") === "a,b", "outer pipes are delimiters, not empty cells");
  assert(splitRow("| a \\| b | c |").join(",") === "a | b,c", "an escaped pipe stays inside its cell");
  assert(parseAlign("|---|:-:|--:|")?.join(",") === ",center,right", "alignment is read per column");
  assert(parseAlign("| a | b |") === undefined, "a content row is not a delimiter row");
  assert(parseAlign(undefined) === undefined, "no next line ⇒ no table");

  // THE one that makes padding correct: a styled cell carries ANSI, and padding on `.length` would
  // count the escape bytes and shift every styled row. Measured on the VISIBLE text instead.
  const styled = "\u001b[1mopus-5\u001b[0m";
  assert(styled.length > 6 && visibleWidth(styled) === 6, "visibleWidth ignores ANSI (the classic alignment bug)");
  assert(visibleWidth("plain") === 5, "plain text measures as itself");

  const table = renderMarkdownBlock(
    "| run | model |\n|---|---|\n| c3f77a4d | **opus-5** |\n| 0f93c9d1 | sonnet-5 |\n\nafter",
  ).split("\n");
  // Every rendered row must be the SAME visible width — that is what "aligned" means, and it is the
  // property a ragged source destroys.
  const widths = table.slice(0, 4).map(visibleWidth);
  assert(new Set(widths).size === 1, `every row is the same visible width (got ${widths.join(",")})`);
  assert(table[0].includes("run") && table[0].includes("model"), "the header row is the header");
  // The delimiter row is MARKUP, not content: printing `|---|---|` is the noise this removes.
  assert(!table.join("\n").includes("---|"), "the delimiter row becomes a rule, not literal dashes");
  assert(table.some((l) => l.includes("─")), "a rule is drawn under the header");
  assert(table[table.length - 1] === "after", "text after the table is not swallowed into it");
  // Prose containing pipes must stay prose.
  assert(!renderMarkdownBlock("this | that | the other").includes("│"), "a sentence with pipes is not a table");
}

if (failures > 0) {
  console.error(`\n${failures} markdown check(s) failed`);
  process.exit(1);
}
console.log("\nall markdown checks passed 🐾");

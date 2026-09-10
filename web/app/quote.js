/**
 * Quote reply: select text in a message, quote it into the composer.
 *
 * Replying to a specific line of a long agent message otherwise means retyping or describing it ("the
 * bit about the lease"), which is both work and ambiguous. A quote is the cheapest way to say WHICH
 * part you mean.
 */

/**
 * Markdown-quote a selection.
 *
 * Every line gets `>` — including blank ones, because a blank line inside a quote block ENDS it in
 * markdown, and a half-quoted paragraph renders as quote-then-body, silently attributing the rest to
 * you. That is the one way this can misrepresent who said what, so it is the case to get right.
 *
 * Trailing whitespace goes; the leading indentation of the selection does not, because in a code block
 * it is the meaning.
 */
export function quoteText(selection) {
  const text = String(selection ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text.trim()) return "";
  return text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
}

/**
 * What the composer should contain after quoting.
 *
 * The quote goes ABOVE what is already there and is followed by a blank line, so the caret lands in
 * open space below it — you quote in order to write underneath, and a draft you had already started is
 * never destroyed by the quote landing on top of it.
 */
export function composeQuote(draft, selection) {
  const quoted = quoteText(selection);
  if (!quoted) return draft ?? "";
  const existing = (draft ?? "").trim();
  return existing ? `${quoted}\n\n${existing}` : `${quoted}\n\n`;
}

/**
 * Is this selection worth offering to quote?
 *
 * A stray click produces an empty or one-character selection, and popping a button up for it turns
 * ordinary reading into a flinch. It also must be INSIDE a message: selecting a sidebar agent name is
 * not a quote.
 */
export function quotable({ text, insideMessage, minChars = 2 }) {
  return !!insideMessage && String(text ?? "").trim().length >= minChars;
}

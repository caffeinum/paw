/**
 * Typing a multi-line message in `paw chat`.
 *
 * `paw chat` is readline-based, and readline submits on Enter — that is the whole obstacle. Pasting
 * several lines is already handled (src/paste.ts, via bracketed paste); this is the other half, TYPING
 * one, which had no answer at all: you got one line, or you sent three messages.
 *
 * TWO WAYS IN, deliberately, because terminals disagree about what they send:
 *
 *  - **A continuation KEY** — Alt+Enter, and the CSI-u encodings of Shift/Ctrl+Enter that terminals
 *    with the kitty keyboard protocol emit. Measured under a real pty before relying on it: node's
 *    readline treats all four as unrecognised escape sequences and DROPS them — no line event, nothing
 *    inserted. That is what makes them usable: they are inert, so paw can define them without fighting
 *    readline for a key it already binds.
 *  - **A trailing backslash** — the universal fallback. A key sequence only works if your terminal
 *    sends it, and there is no way to find that out except by trying; `\` at the end of a line works in
 *    every terminal there is, and is the same continuation shells have used forever.
 */

const ESC = "\u001b";

/**
 * The sequences a terminal sends for a modified Enter.
 *
 * Alt+Enter arrives as ESC-prefixed CR or LF (the classic meta encoding). Shift+Enter and Ctrl+Enter
 * have no legacy encoding at all — an unmodified terminal sends plain CR for both, which is why they
 * cannot be bound there — but a terminal speaking the kitty keyboard protocol disambiguates them as
 * CSI-u with a modifier: 2 = shift, 5 = ctrl, 3 = alt.
 */
export const CONTINUE_KEYS = [`${ESC}\r`, `${ESC}\n`, `${ESC}[13;2u`, `${ESC}[13;3u`, `${ESC}[13;5u`];

/** Does this stdin chunk end with a continuation key? Checked at the END because the chunk usually
 *  carries the character typed just before it, and it is the LAST keystroke that says "new line". */
export function isContinueKey(chunk: string): boolean {
  return CONTINUE_KEYS.some((k) => chunk.endsWith(k));
}

/**
 * Does this submitted line end in a continuation backslash, and what is the text without it?
 *
 * Only an ODD number of trailing backslashes continues: `C:\path\\` ends in an escaped backslash and is
 * a finished line, while `foo \` is asking for another. Getting that wrong would swallow the Enter on
 * any line that legitimately ends in a backslash — a Windows path, a regex, a LaTeX macro.
 */
export function peelContinuation(line: string): { continues: boolean; text: string } {
  const m = /(\\+)$/.exec(line);
  if (!m || m[1].length % 2 === 0) return { continues: false, text: line };
  return { continues: true, text: line.slice(0, -1) };
}

/** Join the held lines with the final one into the message that actually gets sent. */
export function joinLines(held: readonly string[], last: string): string {
  return [...held, last].join("\n");
}

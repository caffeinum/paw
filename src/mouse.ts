/**
 * Mouse input for `paw chat`'s beads view (2026-10-10 as opt-in click mode; ON BY DEFAULT in the view
 * since 2026-11-06). While the beads view is on screen chat turns SGR mouse reporting on, so the wheel
 * scrolls the bead list and a click on a parent's icon folds/unfolds it. ctrl+o hands the mouse back to
 * the terminal (SELECT mode: drag-select works, the wheel doesn't scroll the list); ctrl+o again takes it
 * back. Every other view never has mouse reporting on.
 *
 * Why only there: terminals can't capture clicks for part of the screen — with reporting on, plain
 * drag-select of text is gone (always-on capture across chat, 7b39ffe, was reverted for exactly that).
 * The beads view is a dashboard with nothing to select but ids; the conversation views keep selection.
 * Most terminals still select with a modifier held while reporting is on (shift in iTerm2/kitty/
 * ghostty/xterm, fn/option in Terminal.app) — ctrl+o is for the rest.
 *
 * SGR mouse mode (`?1000h` clicks + wheel, `?1006h` SGR encoding) makes the terminal report each button
 * press as `\x1b[<b;x;yM` (release: `…m`), 1-based column and row. readline does NOT drop these — it
 * decodes the CSI and inserts the rest (`0;10;5M`) into the line you're typing (probed under node 26).
 * So the reports are cut out of every stdin chunk before any listener sees it ({@link stripMouse}).
 *
 * Off on every way out: leaving the view, ctrl+o, shutdown (ctrl+c/EOF/SIGINT/SIGTERM) and a
 * synchronous `process.on("exit")` write for the crash path — a terminal left reporting is the worst
 * failure here.
 *
 * Pure except {@link MOUSE_ON}/{@link MOUSE_OFF}, which chat.ts writes.
 */

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

/** ctrl+o toggles select mode in the beads view: readline binds nothing to it (probed: it inserts nothing and moves
 *  nothing), unlike ctrl+f (forward-char), ctrl+u/w/k/y (kill/yank), ctrl+a/e/b/n/p/t/l. */
export const SELECT_MODE_KEY = "\x0f";

export interface MouseEvent {
  /** left/middle/right press, wheel up/down; anything else is "other". */
  kind: "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "other";
  press: boolean;
  /** 1-based, as the terminal reports. */
  col: number;
  row: number;
}

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function kindOf(b: number): MouseEvent["kind"] {
  if (b & 64) return (b & 3) === 0 ? "wheelUp" : (b & 3) === 1 ? "wheelDown" : "other";
  if (b & 32) return "other"; // motion
  return (["left", "middle", "right", "other"] as const)[b & 3];
}

/** Cut every SGR mouse report out of `chunk`: what's left for readline, and the events in order. */
export function stripMouse(chunk: string): { rest: string; events: MouseEvent[] } {
  if (!chunk.includes("\x1b[<")) return { rest: chunk, events: [] };
  const events: MouseEvent[] = [];
  const rest = chunk.replace(SGR, (_, b: string, x: string, y: string, m: string) => {
    events.push({ kind: kindOf(Number(b)), press: m === "M", col: Number(x), row: Number(y) });
    return "";
  });
  return { rest, events };
}

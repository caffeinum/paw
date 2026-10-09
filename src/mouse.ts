/**
 * Mouse input for `paw chat`'s tasks view (2026-10-08): click a bead to fold/unfold it, the wheel
 * scrolls the list.
 *
 * SGR mouse mode (`?1000h` clicks + `?1006h` SGR encoding) makes the terminal report each button
 * press as `\x1b[<b;x;yM` (release: `…m`), 1-based column and row. readline does NOT drop these — it
 * decodes the CSI and inserts the rest (`0;10;5M`) into the line you're typing (probed under node 26).
 * So the reports are cut out of every stdin chunk before any listener sees it ({@link stripMouse}),
 * and the mode is on only while the tasks view is: text selection elsewhere stays the terminal's.
 *
 * Pure except {@link MOUSE_ON}/{@link MOUSE_OFF}, which chat.ts writes.
 */

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

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

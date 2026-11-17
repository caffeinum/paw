/**
 * Message times in paw chat (2026-11-16, the operator picked "time in the gap row" from four drawn
 * options): a message's local time sits right-aligned on the blank row above it, so it costs no row
 * and moves no text. The day is named on the first stamp and whenever it changes
 * (`sun 15 nov 09:41`, then `09:44`, …, `today 13:29`).
 *
 * Pure: the Painter (src/chat-views.ts) decides WHERE a stamp goes; this file decides what it says and
 * how it is drawn.
 */
import { displayWidth } from "./width.ts";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Up one row and clear it: a stamp drawn over the blank row the previous entry already left. Such a
 *  line adds no row to the screen (chat-banner.ts paintedRows counts it as none). */
export const OVER_BLANK = "\u001b[1A\u001b[2K";

const two = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of `ts`, as a comparable key. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** What the stamp says: `HH:MM`, with the day in front when it differs from `prevDay` — `today`, or
 *  `sun 15 nov` for any other day. Returns the day it stamped, for the next call. */
export function stampText(ts: number, prevDay: string | undefined, now: number): { text: string; day: string } {
  if (!Number.isFinite(ts)) throw new Error(`paw: a message time must be a finite epoch ms, got ${ts}`);
  const d = new Date(ts);
  const day = dayKey(ts);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (day === prevDay) return { text: hm, day };
  const label = day === dayKey(now) ? "today" : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return { text: `${label} ${hm}`, day };
}

/** The stamp at the right edge of a `cols`-wide row. The cursor is moved there (CHA) rather than padded
 *  with spaces, so a copied line carries no run of blanks. */
export function stampRow(text: string, cols: number, dim: (s: string) => string): string {
  const col = Math.max(1, cols - displayWidth(text) + 1);
  return `\u001b[${col}G${dim(text)}`;
}

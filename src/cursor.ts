/**
 * The human's single "have I seen this DM?" marker — one local file per space, the source of truth for
 * what `paw inbox` treats as already-read. Shared (zero-dependency, like names.ts) so BOTH readers
 * advance it: `paw inbox` when it shows you new mail, and `paw chat` when it displays a DM live. That
 * way reading a DM in chat means `paw inbox` won't re-surface it, and vice-versa — one unread state
 * across both surfaces. (cotal's durable consumer is the delivery mechanism; THIS is the human-facing
 * "seen" cursor, kept separate so inbox never has to bind that single-active-consumer slot.)
 *
 * Value is a millisecond epoch — the ts of the newest DM the human has seen. Monotonic forward only,
 * so two readers racing can't rewind each other.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function pawHome(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

/**
 * `which` names the cursor. The default ("inbox") is THE shared one every terminal surface advances.
 *
 * A surface that DISPLAYS without consuming needs its own, because the shared cursor answers "have I
 * seen this anywhere" and every surface moves it as a side effect of PRINTING — so a `paw chat` left
 * open in another window walks it past the newest message and a GUI reading it shows nothing unread,
 * forever. That is not a bug in the shared cursor; it is the wrong question for a surface that must
 * track what IT has shown. (Raycast hit exactly this and had to keep its own read state.)
 */
export function cursorPath(space: string, which = "inbox"): string {
  return join(pawHome(), "spaces", space, `${which}.cursor`);
}

export function readCursor(space: string, which = "inbox"): number {
  try {
    return Number(readFileSync(cursorPath(space, which), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** Advance the cursor to `ts`, but only ever FORWARD — never rewind past what another reader (the live
 *  chat, or a prior inbox) has already marked seen. No-op if `ts` isn't newer. */
export function advanceCursor(space: string, ts: number, which = "inbox"): void {
  if (!Number.isFinite(ts) || ts <= readCursor(space, which)) return;
  const p = cursorPath(space, which);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(ts));
}

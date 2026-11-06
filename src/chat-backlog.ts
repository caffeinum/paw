/**
 * `paw chat`'s EARLIER block: the messages exchanged with the target before this chat started (operator,
 * 2026-11-06: "paw chat @agent should show the messages exchanged with that agent before the chat
 * started, not start from an empty screen"). Shown on open and on every `@name` switch (the ↓ picker
 * goes through `@name`), between `── earlier ──` and `── now ──`, dimmed.
 *
 * Rules this module holds (the chat.ts wiring only places what it picks):
 *  - HISTORY IS NEVER NEWS. It is read from the DM stream (src/chat-own.ts readOwnConversation — on a
 *    remote space only "you"'s own mail, through the narrow `chat-history` cred), never delivered
 *    through the message handler: it can't follow/retarget, answer an await, or mark anything read.
 *  - DEDUP BY ID against everything this chat already showed (live DMs, your sends, the cross-session
 *    echo, earlier blocks), so a message that also arrives live is on screen once.
 *  - The default is the last {@link BACKLOG_DEFAULT} within {@link BACKLOG_WINDOW_MS}, whichever is
 *    fewer; `--history N` = the last N with no time window (0 = off); `/more [N]` = N older ones.
 *
 * Pure: no mesh, no tty. check:chat asserts it.
 */
import type { Entry as FeedEntry } from "./feed.ts";

export const BACKLOG_DEFAULT = 20;
export const BACKLOG_WINDOW_MS = 24 * 60 * 60_000;

/** How the earlier block is sized. `windowMs` undefined = no time window. `limit` 0 = off. */
export interface BacklogSize {
  limit: number;
  windowMs?: number;
}

/** `--history N` (or its absence) → the size. A value that isn't a whole number ≥ 0 fails loud. */
export function backlogSize(flag: string | undefined): BacklogSize {
  if (flag === undefined) return { limit: BACKLOG_DEFAULT, windowMs: BACKLOG_WINDOW_MS };
  return { limit: wholeCount("--history", flag) };
}

/** `/more [N]` → how many older messages to load. */
export function moreCount(arg: string): number {
  const a = arg.trim();
  if (!a) return BACKLOG_DEFAULT;
  const n = wholeCount("/more", a);
  if (n === 0) throw new Error("paw: /more 0 loads nothing — /more [N], N ≥ 1");
  return n;
}

function wholeCount(what: string, v: string): number {
  if (!/^\d+$/.test(v.trim())) throw new Error(`paw: ${what} takes a whole number of messages (got "${v}")`);
  return Number(v.trim());
}

/** Is this feed entry part of the conversation with `agent`? In = it wrote to you; out = you wrote to
 *  it — by name, or by one of its ids when the stream could not name the recipient (feed.ts `to`). */
export function withAgent(e: FeedEntry, agent: string, ids: ReadonlySet<string> = new Set()): boolean {
  const key = agent.toLowerCase();
  if (e.dir === "out") return !!e.to && (e.to.toLowerCase() === key || ids.has(e.to));
  return e.from.toLowerCase() === key;
}

export interface BacklogPick {
  /** Oldest first — the order they print in. */
  entries: FeedEntry[];
  /** Messages of this conversation, not shown, older than the oldest picked one (or than `before`):
   *  what `/more` would find. */
  older: number;
}

/**
 * The slice of `conv` to show for `agent`. `shown(id)` = already on screen (live or an earlier block).
 * `before` = only messages strictly older than this ts (`/more` reaches back past the oldest shown).
 * An entry without an id can't be deduped and fails loud — never shown twice by guess.
 */
export function pickBacklog(
  conv: FeedEntry[],
  agent: string,
  o: BacklogSize & { now: number; shown: (id: string) => boolean; before?: number; ids?: ReadonlySet<string> },
): BacklogPick {
  if (o.limit <= 0) return { entries: [], older: 0 };
  const mine = conv
    .filter((e) => withAgent(e, agent, o.ids))
    .filter((e) => {
      if (!e.id) throw new Error(`paw: a DM history row from ${e.from} at ${e.ts} has no id — can't dedup it against the live chat`);
      return !o.shown(e.id);
    })
    .filter((e) => o.before === undefined || e.ts < o.before)
    .sort((a, b) => a.ts - b.ts);
  const inWindow = o.windowMs === undefined ? mine : mine.filter((e) => e.ts >= o.now - o.windowMs!);
  const entries = inWindow.slice(-o.limit);
  return { entries, older: mine.length - entries.length };
}

/** The divider above a block. Says what the block is and how to reach further back. */
export function earlierDivider(agent: string, count: number, older: number, windowed: boolean): string {
  const what = count === 0 ? "nothing" : `${count} message${count === 1 ? "" : "s"}`;
  const span = windowed ? " in the last 24h" : "";
  const more = older > 0 ? ` · ${older} older · /more` : "";
  return `── earlier with ${agent} · ${what}${span}${more} ──`;
}

export const NOW_DIVIDER = "── now ──";

/** What a block says when there is nothing to put in it — said once, never an empty pair of rules. */
export function nothingEarlier(agent: string, older: number): string {
  if (older > 0) return `(nothing with ${agent} in the last 24h — ${older} older · /more shows them)`;
  return `(no earlier messages with ${agent})`;
}

/**
 * Where a `/more` block goes: right under the FIRST earlier-divider this chat drew for `agent` (the
 * older messages sit above the ones already shown), or undefined when there is none yet.
 */
export function moreInsertAt<T>(entries: readonly T[], isDividerFor: (e: T) => boolean): number | undefined {
  const i = entries.findIndex(isDividerFor);
  return i < 0 ? undefined : i + 1;
}

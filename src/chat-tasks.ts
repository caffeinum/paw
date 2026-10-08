/**
 * `paw chat`'s `tasks` view (2026-10-07): what the targeted agent is ON, and the last word each way.
 *
 *   top    — glued to the top: a title row (with the agent's live status) and the agent's beads
 *            (assignee = the agent): in_progress, then blocked, then open, then the last day's closed
 *            ones dimmed (at most a few). One line each: glyph, id, title, age.
 *   bottom — glued to the prompt: the agent's LAST message to you and YOUR last message to it, oldest
 *            first (so the newer one sits by the prompt), markdown-rendered like chat entries, each
 *            with how long ago; then the newest receipt (⏳ queued, ✓ picked it up…) right above the
 *            prompt, where chat prints it. Blank rows fill the gap between the two (operator, 2026-10-07).
 *
 * It is a DASHBOARD, not a filter over the chat history: chat.ts repaints it in place (cursor home,
 * overwrite, clear below) and only when the painted text changed, so a background refresh that found
 * nothing new costs zero bytes and never flickers. It always fits the terminal: the bead list clips
 * first, then the message bodies — each keeping its LAST lines, where the point of a reply usually is.
 *
 * Pure: no tty, no bd, no mesh — chat.ts wires these in; check:chat asserts them.
 */
import type { Task } from "./tasks.ts";
import type { Entry as FeedEntry } from "./feed.ts";
import { displayWidth, fitWidth } from "./width.ts";

/** One message as the view shows it. */
export interface Said {
  text: string;
  ts: number;
}

/** How long a closed bead stays in the list, and how many of them at most. */
export const CLOSED_RECENT_MS = 24 * 3_600_000;
export const CLOSED_MAX = 3;

/** in_progress (it is ON it) → blocked (it is stuck) → open → deferred; unknown statuses last. */
const RANK: Record<string, number> = { in_progress: 0, blocked: 1, open: 2, deferred: 3 };

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * The beads the view lists for `assignee`, in display order. Open work by status, then priority, then
 * most recently touched; closed beads only when closed within {@link CLOSED_RECENT_MS}, newest first,
 * at most {@link CLOSED_MAX}. Beads assigned to anyone else are dropped even if the read returned them.
 */
export function agentBeads(tasks: Task[], assignee: string, now: number): Task[] {
  const mine = tasks.filter((t) => t.assignee === assignee);
  const open = mine
    .filter((t) => t.status !== "closed")
    .sort(
      (a, b) =>
        (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
        (a.priority ?? 9) - (b.priority ?? 9) ||
        (time(b.updatedAt) || 0) - (time(a.updatedAt) || 0),
    );
  const closed = mine
    .filter((t) => t.status === "closed" && now - time(t.closedAt) <= CLOSED_RECENT_MS)
    .sort((a, b) => time(b.closedAt) - time(a.closedAt))
    .slice(0, CLOSED_MAX);
  return [...open, ...closed];
}

/** The newer of two messages (either may be missing). */
export function newer(a: Said | undefined, b: Said | undefined): Said | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.ts > a.ts ? b : a;
}

/**
 * From a both-directions conversation (feed.ts readConversation `withSent`), the last message the
 * agent sent you (`lastIn`) and the last one you sent it (`lastOut`). Names compare case-insensitively,
 * like `@name` does; a message to an unresolved id never matches a name.
 */
export function lastExchange(conv: FeedEntry[], agent: string): { lastIn?: Said; lastOut?: Said } {
  const key = agent.toLowerCase();
  let lastIn: Said | undefined;
  let lastOut: Said | undefined;
  for (const e of conv) {
    if (e.dir === "out" && e.to?.toLowerCase() === key) lastOut = newer(lastOut, { text: e.text, ts: e.ts });
    else if (e.dir !== "out" && e.from.toLowerCase() === key) lastIn = newer(lastIn, { text: e.text, ts: e.ts });
  }
  return { ...(lastIn ? { lastIn } : {}), ...(lastOut ? { lastOut } : {}) };
}

/** Compact "how long ago" (m/h/d); `—` when the time is unknown rather than a made-up 0. Minute
 *  resolution on purpose: a seconds counter would change the painted text on every refresh, and the
 *  view only repaints when its text changes — under a minute is `now`. */
export function age(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const ago = (ms: number, now: number): string => {
  const a = age(ms, now);
  return a === "now" || a === "—" ? a : `${a} ago`;
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

/**
 * Hard-wrap one rendered (ANSI-styled) line to `cols` display columns. Escapes take no columns; a
 * style open at a break is reset at the end of the row and reopened on the next, so a wrap never
 * bleeds colour into the hint or the prompt. Needed because a row the TERMINAL wraps is a row the
 * height arithmetic didn't count.
 */
export function wrapAnsi(line: string, cols: number): string[] {
  if (cols < 1 || displayWidth(line) <= cols) return [line];
  const rows: string[] = [];
  let cur = "";
  let w = 0;
  let active: string[] = [];
  let i = 0;
  while (i < line.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(line);
    if (m) {
      cur += m[0];
      if (/^\x1b\[0?m$/.test(m[0])) active = [];
      else if (m[0].endsWith("m")) active.push(m[0]);
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const cw = displayWidth(ch);
    if (w + cw > cols && w > 0) {
      rows.push(active.length ? cur + "\x1b[0m" : cur);
      cur = active.join("");
      w = 0;
    }
    cur += ch;
    w += cw;
    i += ch.length;
  }
  rows.push(cur);
  return rows;
}

export interface TasksModel {
  /** The targeted agent; undefined = no target, so the view lists the operator's own beads. */
  agent?: string;
  /** Whose beads are listed when there is no agent (src/company.ts operatorName). */
  operator: string;
  /** undefined = not read yet. */
  beads?: Task[];
  /** The last bead read failed — shown as is, never as "no beads". */
  beadsError?: string;
  lastIn?: Said;
  lastOut?: Said;
  /** The newest receipt / error line (⏳ waiting…, ✓ picked it up, ! …) — the tasks view has no
   *  scrolling conversation to put them in, and a send that failed silently is the worst outcome. */
  notice?: string;
  /** The agent's live presence, pre-styled (● working — activity); undefined when it isn't on the mesh. */
  status?: string;
}

export interface TasksStyle {
  dim(s: string): string;
  bold(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  green(s: string): string;
  /** An agent's name as chat tags it (persona emoji + hue). */
  tag(name: string): string;
  /** Markdown → rendered lines at a width (src/markdown.ts renderMarkdown). */
  md(text: string, width: number): string[];
}

export const plainStyle: TasksStyle = {
  dim: (s) => s,
  bold: (s) => s,
  yellow: (s) => s,
  red: (s) => s,
  green: (s) => s,
  tag: (s) => s,
  md: (t) => t.split("\n"),
};

const GLYPH: Record<string, string> = { in_progress: "◐", blocked: "⊘", open: "○", deferred: "◌", closed: "✓" };

function beadLine(t: Task, now: number, width: number, st: TasksStyle): string {
  const when = t.status === "closed" ? t.closedAt : t.status === "in_progress" ? (t.startedAt ?? t.updatedAt) : t.updatedAt;
  const right = ` ${age(time(when), now)}`;
  const left = `${GLYPH[t.status] ?? "·"} ${t.id}  `;
  const room = Math.max(1, width - displayWidth(left) - displayWidth(right));
  const title = fitWidth(t.title.replace(/\s+/g, " "), room);
  const pad = " ".repeat(Math.max(0, room - displayWidth(title)));
  const glyph = GLYPH[t.status] ?? "·";
  if (t.status === "closed") return st.dim(left + title + pad + right);
  const g = t.status === "in_progress" ? st.yellow(glyph) : t.status === "blocked" ? st.red(glyph) : glyph;
  return `${g} ${st.dim(t.id)}  ${title}${pad}${st.dim(right)}`;
}

interface MsgBlock {
  ts: number;
  head: string;
  body: string[];
}

/**
 * The view as rows — exactly `height` of them, none wider than `width`. Layout, top to bottom: a title
 * row, the bead rows, blank filler, then the messages and an optional notice — so the beads hug the top
 * and the conversation hugs the prompt. When it doesn't fit, the beads
 * shrink first (down to 3 rows, the last saying how many more), then the longer message body loses its
 * OLDEST lines (a `⋮` in the indent marks the cut), then the beads go down to one row; a terminal too small even for
 * that gets the top `height` rows.
 */
export function renderTasksView(m: TasksModel, opts: { width: number; height: number; now: number; style?: TasksStyle }): string[] {
  const st = opts.style ?? plainStyle;
  const width = Math.max(10, opts.width);
  const height = Math.max(1, opts.height);
  const now = opts.now;
  const who = m.agent ?? m.operator;

  const head: string[] = [];
  const count = m.beads ? ` ${st.dim(`· ${m.beads.filter((t) => t.status !== "closed").length} open`)}` : "";
  const status = m.status ? ` ${st.dim("·")} ${m.status}` : "";
  head.push(fitWidth(`${st.bold("tasks")} ${st.dim("·")} ${m.agent ? st.tag(m.agent) : `yours ${st.dim(`(${m.operator})`)}`}${count}${status}`, width));

  let beadRows: string[];
  if (m.beadsError) beadRows = [st.red(fitWidth(`! beads: ${m.beadsError}`, width))];
  else if (!m.beads) beadRows = [st.dim("reading beads…")];
  else if (!m.beads.length) beadRows = [st.dim(`no beads assigned to ${who}`)];
  else beadRows = m.beads.map((t) => beadLine(t, now, width, st));

  const msgs: MsgBlock[] = [];
  if (m.agent) {
    const body = (s: Said): string[] => st.md(s.text, width - 2).flatMap((l) => wrapAnsi(l, width - 2)).map((l) => `  ${l}`);
    if (m.lastIn) msgs.push({ ts: m.lastIn.ts, head: `${st.tag(m.agent)} ${st.dim(`· ${ago(m.lastIn.ts, now)}`)}`, body: body(m.lastIn) });
    if (m.lastOut) msgs.push({ ts: m.lastOut.ts, head: `${st.bold("you")} ${st.dim(`→ ${m.agent} · ${ago(m.lastOut.ts, now)}`)}`, body: body(m.lastOut) });
    msgs.sort((a, b) => a.ts - b.ts);
  }
  const tail: string[] = m.agent ? [] : [st.dim("pick an agent with ↓ to see its beads and its last messages")];
  if (m.agent && !msgs.length) tail.push(st.dim(`no messages between you and ${m.agent} yet`));
  if (m.notice) tail.push(st.dim(fitWidth(m.notice.split("\n")[0], width)));

  // Rows that are always there: the title, the blank before the lower section, each message's
  // header, one blank between messages, and the tail lines.
  const fixed = head.length + 1 + msgs.length + Math.max(0, msgs.length - 1) + tail.length;
  const bodies = msgs.map((b) => b.body.length);
  const bodyTotal = (): number => bodies.reduce((a, b) => a + b, 0);
  let beadBudget = Math.max(0, height - fixed - bodyTotal());
  const minBeads = Math.min(beadRows.length, 3);
  if (beadBudget < minBeads) {
    beadBudget = minBeads;
    let room = Math.max(0, height - fixed - beadBudget);
    if (room < msgs.length) {
      beadBudget = Math.min(beadRows.length, 1);
      room = Math.max(0, height - fixed - beadBudget);
    }
    // Take lines from the longest body until the bodies fit the room.
    while (bodyTotal() > room) {
      let k = 0;
      for (let j = 1; j < bodies.length; j++) if (bodies[j] > bodies[k]) k = j;
      if (bodies[k] === 0) break;
      bodies[k]--;
    }
  }

  const out = [...head];
  if (beadRows.length <= beadBudget) out.push(...beadRows);
  else if (beadBudget > 0) {
    const shown = beadRows.slice(0, beadBudget - 1);
    out.push(...shown, st.dim(`  … +${beadRows.length - shown.length} more`));
  }
  const lower: string[] = [];
  msgs.forEach((b, j) => {
    if (j) lower.push("");
    lower.push(fitWidth(b.head, width));
    const keep = bodies[j];
    if (keep >= b.body.length) lower.push(...b.body);
    else if (keep > 0) {
      // The cut is marked in the indent of the first kept row, so even a 1-row budget keeps a line.
      const kept = b.body.slice(b.body.length - keep);
      lower.push(st.dim("⋮ ") + kept[0].slice(2), ...kept.slice(1));
    }
  });
  lower.push(...tail);
  const gap = Math.max(1, height - out.length - lower.length);
  out.push(...Array<string>(gap).fill(""), ...lower);
  return out.slice(0, height);
}

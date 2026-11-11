/**
 * `paw chat`'s `beads` view (2026-10-07 as `tasks`; fullscreen 2026-11-06): what the targeted agent is ON.
 *
 * A title row (with the agent's live status), the `paw status` facts, then the agent's beads (assignee
 * = the agent): in_progress, then blocked, then open, then the last day's closed ones dimmed (at most a
 * few). One line each: glyph, id, title, age — plus a `↳ <url>` row under it for each linked PR. The
 * newest receipt (⏳ queued, ✓ picked it up, ! …) sits at the bottom, by the prompt.
 *
 * FULLSCREEN (operator, 2026-11-06: "not a split view anymore"): the last message each way that used to
 * be glued to the bottom is gone — the conversation is the chat/messages views' job — so the bead list
 * gets every row between the title and the prompt. The mouse wheel scrolls it (chat.ts turns SGR mouse
 * reporting on while this view is on screen, src/mouse.ts).
 *
 * It is a DASHBOARD, not a filter over the chat history: chat.ts repaints it in place (cursor home,
 * overwrite, clear below) and only when the painted text changed, so a background refresh that found
 * nothing new costs zero bytes and never flickers. It always fits the terminal: the bead list clips.
 *
 * Pure: no tty, no bd, no mesh — chat.ts wires these in; check:chat asserts them.
 */
import type { Task } from "./tasks.ts";
import { displayWidth, fitWidth } from "./width.ts";
import { prUrls } from "../web/app/company-model.js";

/** How long a closed bead stays in the list, and how many of them at most. */
export const CLOSED_RECENT_MS = 24 * 3_600_000;
export const CLOSED_MAX = 3;

/** in_progress (it is ON it) → blocked (it is stuck) → open → deferred; unknown statuses last. */

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
/** Natural id order: beads-x.2 before beads-x.10. */
const byId = (a: Task, b: Task): number => a.id.localeCompare(b.id, "en", { numeric: true });

/** When a bead last changed: `updatedAt`, else `createdAt`; -Infinity (sorts last) when bd gave neither. */
const touched = (t: Task): number => {
  const at = time(t.updatedAt ?? t.createdAt);
  return Number.isNaN(at) ? -Infinity : at;
};

/**
 * The beads the view lists for `assignee`, in display order. Open work most recently touched first
 * (operator, 2026-11-10: "the latest beads on top"); closed beads only when closed within
 * {@link CLOSED_RECENT_MS}, newest first, at most {@link CLOSED_MAX}. Beads assigned to anyone else are
 * dropped even if the read returned them.
 */
export function agentBeads(tasks: Task[], assignee: string, now: number): Task[] {
  const mine = tasks.filter((t) => t.assignee === assignee);
  const open = mine.filter((t) => t.status !== "closed").sort((a, b) => touched(b) - touched(a) || byId(a, b));
  const closed = mine
    .filter((t) => t.status === "closed" && now - time(t.closedAt) <= CLOSED_RECENT_MS)
    .sort((a, b) => time(b.closedAt) - time(a.closedAt))
    .slice(0, CLOSED_MAX);
  return [...open, ...closed];
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
  /** The newest receipt / error line (⏳ waiting…, ✓ picked it up, ! …) — the beads view has no
   *  scrolling conversation to put them in, and a send that failed silently is the worst outcome. */
  notice?: string;
  /** The agent's live presence, pre-styled (● working — activity); undefined when it isn't on the mesh. */
  status?: string;
  /** What `paw status` says about it, pre-styled (see {@link agentInfo}) — a row under the title. */
  info?: string;
  /** Select mode is on (chat.ts, ctrl+o): the mouse is handed back to the terminal for selecting text,
   *  so the wheel doesn't scroll the list meanwhile — the view says so. */
  selectMode?: boolean;
}

/** The row shown while select mode is on. */
export const SELECT_MODE_HINT = "select mode · mouse is the terminal's (select text) · wheel doesn't scroll · ctrl+o gives it back";

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

/** The `paw status` facts the info row shows — a structural subset of status.ts's AgentStatus, so this
 *  module stays free of status.ts's mesh/manager imports. */
export interface InfoFacts {
  live: boolean;
  mesh: string;
  busy?: boolean;
  /** pre-formatted by status.ts (contextText / inboxText) with its share for the colour */
  ctx: string;
  ctxShare?: number;
  inbox: string;
  activeMs?: number;
  failure?: { text: string };
  tool?: string;
}

/** The info row: online or not, context fill, inbox, last active, and a failure when the last turn
 *  failed — the same words `paw status` uses, so the two never disagree. */
export function agentInfo(f: InfoFacts, now: number, st: Pick<TasksStyle, "dim" | "green" | "yellow" | "red">): string {
  const bits: string[] = [];
  bits.push(f.live ? st.green("online") : st.dim("offline"));
  if (f.busy && f.mesh !== "working") bits.push(st.yellow("busy"));
  if (f.tool) bits.push(st.dim(`in ${f.tool}`));
  const ctx = `ctx ${f.ctx}`;
  bits.push(f.ctxShare === undefined ? st.dim(ctx) : f.ctxShare >= 0.9 ? st.red(ctx) : f.ctxShare >= 0.75 ? st.yellow(ctx) : st.dim(ctx));
  bits.push(f.inbox === "✓" || f.inbox === "—" ? st.dim(`inbox ${f.inbox}`) : st.yellow(`inbox ${f.inbox}`));
  if (f.activeMs !== undefined) bits.push(st.dim(`active ${ago(f.activeMs, now)}`));
  if (f.failure) bits.push(st.red(`⚠ ${f.failure.text.replace(/\s+/g, " ")}`));
  return bits.join(st.dim(" · "));
}

const GLYPH: Record<string, string> = { in_progress: "◐", blocked: "⊘", open: "○", deferred: "◌", closed: "✓" };

/** One row of the bead tree: a bead at a depth. A parent knows its listed children (`kids`); a folded
 *  one (the operator clicked its icon in click mode, 2026-10-10) also how many beads it hides. A
 *  hidden bead is no row at all, so the scroll only ever counts what is painted. */
export type TreeRow = { t: Task; depth: number; kids?: number; folded?: boolean; hidden?: number };


/**
 * The open beads as a tree, in display order: a bead whose parent is also listed sits under it (the
 * parent first — never below its children). Siblings, roots included, go newest first by their branch's
 * latest change, so an epic whose child moved an hour ago sits above one untouched for weeks (operator,
 * 2026-11-10: "the latest beads on top"); ties fall back to natural id order. Closed beads follow
 * flat, as {@link agentBeads} ordered them. Pure.
 */
export function beadTree(beads: Task[], folded: ReadonlySet<string> = new Set()): TreeRow[] {
  const open = beads.filter((t) => t.status !== "closed");
  const ids = new Set(open.map((t) => t.id));
  const kids = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of open) {
    if (t.parent && t.parent !== t.id && ids.has(t.parent)) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);
    else roots.push(t);
  }
  const memo = new Map<string, number>();
  const latest = (t: Task, seen = new Set<string>()): number => {
    const hit = memo.get(t.id);
    if (hit !== undefined) return hit;
    if (seen.has(t.id)) return touched(t);
    seen.add(t.id);
    const at = Math.max(touched(t), ...(kids.get(t.id) ?? []).map((k) => latest(k, seen)));
    memo.set(t.id, at);
    return at;
  };
  const newestFirst = (a: Task, b: Task): number => latest(b) - latest(a) || byId(a, b);
  roots.sort(newestFirst);
  const rows: TreeRow[] = [];
  const placed = new Set<string>();
  const walk = (t: Task, depth: number): void => {
    if (placed.has(t.id)) return;
    placed.add(t.id);
    const ch = (kids.get(t.id) ?? []).slice().sort(newestFirst);
    if (!ch.length) return void rows.push({ t, depth });
    if (!folded.has(t.id)) {
      rows.push({ t, depth, kids: ch.length });
      for (const c of ch) walk(c, depth + 1);
      return;
    }
    // Folded: every descendant is placed (so the cycle sweep below never resurrects one) and counted.
    let hidden = 0;
    const hide = (x: Task): void => {
      if (placed.has(x.id)) return;
      placed.add(x.id);
      hidden++;
      for (const k of kids.get(x.id) ?? []) hide(k);
    };
    for (const c of ch) hide(c);
    rows.push({ t, depth, kids: ch.length, folded: true, hidden });
  };
  for (const r of roots) walk(r, 0);
  for (const t of open) walk(t, 0); // anything a cycle kept out of the walk still shows
  for (const t of beads) if (t.status === "closed") rows.push({ t, depth: 0 });
  return rows;
}

/** A parent's twisty: ▾ open, ▸ folded — the click target in click mode, with the status glyph after it. */
const twistyOf = (r: TreeRow): string => (r.kids ? `${r.folded ? "▸" : "▾"} ` : "");

function beadLine(r: TreeRow, now: number, width: number, st: TasksStyle): string {
  const { t, depth } = r;
  const when = t.status === "closed" ? t.closedAt : t.status === "in_progress" ? (t.startedAt ?? t.updatedAt) : t.updatedAt;
  const right = ` ${age(time(when), now)}`;
  const indent = "  ".repeat(depth) + twistyOf(r);
  // Under its parent a child shows only its own suffix (.15) — the parent's id is right above it.
  const id = (depth && t.parent && t.id.startsWith(t.parent) ? t.id.slice(t.parent.length) : t.id) + (r.folded ? ` (+${r.hidden})` : "");
  const left = `${indent}${GLYPH[t.status] ?? "·"} ${id}  `;
  const room = Math.max(1, width - displayWidth(left) - displayWidth(right));
  const title = fitWidth(t.title.replace(/\s+/g, " "), room);
  const pad = " ".repeat(Math.max(0, room - displayWidth(title)));
  const glyph = GLYPH[t.status] ?? "·";
  if (t.status === "closed") return st.dim(left + title + pad + right);
  const g = t.status === "in_progress" ? st.yellow(glyph) : t.status === "blocked" ? st.red(glyph) : glyph;
  return `${indent}${g} ${st.dim(id)}  ${title}${pad}${st.dim(right)}`;
}

/** A clickable cell on a painted row: the parent bead `id` folds/unfolds from a click in columns
 *  [col, col + span) (0-based) — its twisty and its status glyph. */
export interface TasksHit {
  id: string;
  col: number;
  span: number;
}

interface Group {
  rows: string[];
  hits: (TasksHit | undefined)[];
}

/** A bead's rows: its line, then one `↳ <PR url>` row per linked PR (plain text, so the terminal
 *  links it; cut to the width like every row). */
function beadGroup(r: TreeRow, now: number, width: number, st: TasksStyle): Group {
  const indent = "  ".repeat(r.depth);
  const links = prUrls(r.t).map((u) => `${indent}  ${st.dim("↳")} ${fitWidth(u, Math.max(8, width - 4 - indent.length))}`);
  const hit = r.kids ? { id: r.t.id, col: displayWidth(indent), span: 3 } : undefined;
  return { rows: [beadLine(r, now, width, st), ...links], hits: [hit, ...links.map(() => undefined)] };
}

/** Which bead a click at a 0-based (row, col) of the panel folds/unfolds — undefined off every icon. */
export function hitAt(hits: readonly (TasksHit | undefined)[], row: number, col: number): string | undefined {
  const h = hits[row];
  return h && col >= h.col && col < h.col + h.span ? h.id : undefined;
}

/**
 * The view as rows — exactly `height` of them, none wider than `width`. Layout, top to bottom: a title
 * row (+ the info row, + the select-mode row), the bead rows, blank filler, then the tail (the no-target
 * hint, the newest notice) by the prompt. When the beads don't fit they scroll (`↑ N above` / `… +N
 * more`, whole beads only); a terminal too small even for the head gets the top `height` rows.
 */
export function renderTasksView(m: TasksModel, opts: TasksViewOpts): string[] {
  return renderTasksPanel(m, opts).rows;
}

export interface TasksViewOpts {
  width: number;
  height: number;
  now: number;
  style?: TasksStyle;
  /** first bead (tree row) shown; clamped */
  scroll?: number;
  /** told the scroll actually used */
  onScroll?: (start: number) => void;
  /** parents the operator folded (a click on a parent's icon) */
  folded?: ReadonlySet<string>;
}

/** {@link renderTasksView}'s rows plus the hit map: `hits[i]` is the clickable icon on `rows[i]`. */
export function renderTasksPanel(m: TasksModel, opts: TasksViewOpts): { rows: string[]; hits: (TasksHit | undefined)[] } {
  const st = opts.style ?? plainStyle;
  const width = Math.max(10, opts.width);
  const height = Math.max(1, opts.height);
  const now = opts.now;
  const who = m.agent ?? m.operator;

  const head: string[] = [];
  const count = m.beads ? ` ${st.dim(`· ${m.beads.filter((t) => t.status !== "closed").length} open`)}` : "";
  const status = m.status ? ` ${st.dim("·")} ${m.status}` : "";
  head.push(fitWidth(`${st.bold("beads")} ${st.dim("·")} ${m.agent ? st.tag(m.agent) : `yours ${st.dim(`(${m.operator})`)}`}${count}${status}`, width));
  if (m.info) head.push(fitWidth(m.info, width));
  if (m.selectMode) head.push(st.yellow(fitWidth(SELECT_MODE_HINT, width)));

  const note = (row: string): Group[] => [{ rows: [row], hits: [undefined] }];
  let groups: Group[];
  if (m.beadsError) groups = note(st.red(fitWidth(`✕ beads: ${m.beadsError}`, width)));
  else if (!m.beads) groups = note(st.dim("reading beads…"));
  else if (!m.beads.length) groups = note(st.dim(`no beads assigned to ${who}`));
  else groups = beadTree(m.beads, opts.folded).map((r) => beadGroup(r, now, width, st));
  const beadRows = groups.flatMap((g) => g.rows);

  const tail: string[] = m.agent ? [] : [st.dim("pick an agent with ↓ to see its beads")];
  if (m.notice) tail.push(st.dim(fitWidth(m.notice.split("\n")[0], width)));

  // Everything between the head and the tail is the bead list's — fullscreen, no conversation pane.
  const beadBudget = Math.max(0, height - head.length - tail.length);

  const out = [...head];
  // The clickable icon on each row of `out`, kept in step with every push.
  const hits: (TasksHit | undefined)[] = head.map(() => undefined);
  const put = (g: Group[]): void => {
    for (const x of g) {
      out.push(...x.rows);
      hits.push(...x.hits);
    }
  };
  const plain = (row: string): void => {
    out.push(row);
    hits.push(undefined);
  };
  const rowsFrom = (i: number): number => groups.slice(i).reduce((a, g) => a + g.rows.length, 0);
  let start = Math.min(Math.max(0, opts.scroll ?? 0), Math.max(0, groups.length - 1));
  // Never scroll into blank space: pull back while the bead above still fits under the "↑" row.
  while (start > 0 && rowsFrom(start - 1) + (start - 1 > 0 ? 1 : 0) <= beadBudget) start--;
  opts.onScroll?.(start);
  if (start === 0 && beadRows.length <= beadBudget) put(groups);
  else if (beadBudget > 0) {
    // Whole beads only (a bead never loses its PR row to the cut); the counts are in beads, not rows.
    const above = start > 0 && beadBudget > 1 ? 1 : 0;
    const room = beadBudget - above;
    const cap = rowsFrom(start) <= room ? room : room - 1;
    let used = 0;
    let n = start;
    while (n < groups.length && used + groups[n].rows.length <= cap) used += groups[n++].rows.length;
    if (above) plain(st.dim(`  ↑ ${start} above · wheel/PgUp`));
    if (n === start && cap > 0) {
      put([{ rows: [groups[start].rows[0]], hits: [groups[start].hits[0]] }]);
      n = start + 1;
    } else put(groups.slice(start, n));
    if (n < groups.length) plain(st.dim(`  … +${groups.length - n} more · wheel/PgDn`));
  }
  const lower = tail;
  const gap = Math.max(0, height - out.length - lower.length);
  out.push(...Array<string>(gap).fill(""), ...lower);
  const rows = out.slice(0, height);
  // Filler and tail rows carry no icon.
  return { rows, hits: rows.map((_, i) => hits[i]) };
}

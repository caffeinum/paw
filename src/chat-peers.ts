/**
 * `paw chat`'s MESSAGES view (2026-11-06): the chat view PLUS what the target said to and heard from
 * OTHER peers — other agents, the channels it posted in, cron, the office bridge. Operator: those rows
 * are "indented/tabulated to the RIGHT … so they don't distract from my own conversation, which stays
 * left-aligned and normal". Screen (80 cols):
 *
 *     you → kit: rebase #104 please
 *     🐈 kit: on it
 *                         kit → bob (2m ago): can you review #104 after CI?
 *                         bob → kit (1m ago): lgtm, merging
 *                         kit → #general: #104 merged
 *     🐈 kit: done — pushed, CI green
 *
 * Where the rows come from (chat.ts wires it; src/chat-own.ts reads):
 *  - LOCAL space: the DM stream holds every DM, so the earlier rows are the target's DMs with anyone but
 *    "you" (plus its channel posts), and live ones come off chat-own's space-wide tap.
 *  - REMOTE space: chat holds only narrow creds for "you"'s own subjects (docs/notes/remote-mesh.md);
 *    another agent's DMs are NOT readable with them, and paw has no narrow observer cred for that (paw
 *    history / paw web use the space-wide `admin` cred). The view says so loudly
 *    ({@link remotePeersNote}) instead of silently showing only your chat.
 *
 * Pure: no tty, no mesh. check:chat asserts it.
 */
import { displayWidth } from "./width.ts";

/** One message between the target and someone else, in the shape the view renders. */
export interface PeerMsg {
  id: string;
  ts: number;
  /** sender's name */
  from: string;
  /** recipient: a peer's name, `#channel`, or a raw id when nothing names it (never a guess) */
  to: string;
  text: string;
}

/** What a raw message must carry to be classified. */
export interface RawMsg {
  id?: string;
  ts?: number;
  from?: { id?: string; name?: string };
  to?: string;
  channel?: string;
  toService?: string;
}

/**
 * Is `m` other-peer traffic of `agent`? DMs the agent sent to anyone but "you", DMs anyone but "you"
 * sent to the agent (`agentIds` = every id it has had — a restart changes it), and the agent's channel
 * posts. Anything involving "you" (`me`) is the chat view's, not this. Returns the from/to labels, or
 * undefined. `nameOf` names an id from what the stream/ledger knows; an unnamed id stays an id.
 */
export function classifyPeer(
  m: RawMsg,
  o: { agent: string; agentIds: ReadonlySet<string>; me: string; nameOf: (id: string) => string | undefined },
): { from: string; to: string } | undefined {
  if (!m.from?.name || !m.id) return undefined;
  if (m.from.id === o.me || m.to === o.me) return undefined;
  const key = o.agent.toLowerCase();
  const fromAgent = m.from.name.toLowerCase() === key || (!!m.from.id && o.agentIds.has(m.from.id));
  if (m.channel) return fromAgent ? { from: m.from.name, to: `#${m.channel}` } : undefined;
  if (m.toService) return fromAgent ? { from: m.from.name, to: `@${m.toService}` } : undefined;
  if (!m.to) return undefined;
  const toAgent = o.agentIds.has(m.to) || o.nameOf(m.to)?.toLowerCase() === key;
  if (fromAgent && toAgent) return undefined; // to itself — nothing to show
  if (fromAgent) return { from: m.from.name, to: o.nameOf(m.to) ?? m.to.slice(0, 8) };
  if (toAgent) return { from: m.from.name, to: o.agent };
  return undefined;
}

/** How far right the other-peer rows sit: a quarter of the width, at most 24 columns, at least 4. */
export function peerIndent(cols: number): number {
  return Math.max(4, Math.min(24, Math.floor(cols / 4)));
}

/**
 * One other-peer message as screen rows: `from → to (age): text`, the body on the label row when it is
 * one short line, else a block under it — every row indented by {@link peerIndent} and passed through
 * `dim`. `md` renders the body at a width (markdown, like every chat body). Rows never pass `cols - 1`.
 */
export function peerRows(
  p: PeerMsg,
  o: { cols: number; age: string; dim: (s: string) => string; md: (text: string, width: number) => string[]; strip: (s: string) => string },
): string[] {
  const ind = peerIndent(o.cols);
  const pad = " ".repeat(ind);
  const room = Math.max(10, o.cols - 1 - ind);
  const label = `${p.from} → ${p.to}${o.age}:`;
  const body = o.md(p.text, room - 2).map((l) => o.strip(l));
  const oneLine = body.length <= 1 && displayWidth(label) + 1 + displayWidth(body[0] ?? "") <= room;
  const rows = oneLine ? [`${label} ${body[0] ?? ""}`] : [label, ...body.map((l) => `  ${l}`)];
  return rows.flatMap((r) => hardWrap(r, room)).map((r) => o.dim(pad + r));
}

/** Plain-text wrap at `cols` display columns (the rows are stripped of escapes before this). */
function hardWrap(s: string, cols: number): string[] {
  if (displayWidth(s) <= cols) return [s];
  const out: string[] = [];
  let cur = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > cols && w > 0) {
      out.push(cur);
      cur = "  ";
      w = 2;
    }
    cur += ch;
    w += cw;
  }
  out.push(cur);
  return out;
}

/** The view's sizing is the earlier block's (src/chat-backlog.ts): last N within a window, or the last N. */
export interface PeerPick {
  /** oldest first */
  entries: PeerMsg[];
  /** other-peer messages not shown, older than the oldest picked one */
  older: number;
}

/** The slice of `msgs` (already the target's other-peer traffic) to show. `shown(id)` = on screen. */
export function pickPeers(msgs: PeerMsg[], o: { limit: number; windowMs?: number; now: number; shown: (id: string) => boolean }): PeerPick {
  if (o.limit <= 0) return { entries: [], older: 0 };
  const fresh = msgs.filter((m) => !o.shown(m.id)).sort((a, b) => a.ts - b.ts);
  const inWindow = o.windowMs === undefined ? fresh : fresh.filter((m) => m.ts >= o.now - o.windowMs!);
  const entries = inWindow.slice(-o.limit);
  return { entries, older: fresh.length - entries.length };
}

/** The line that replaces the loader once the other-peer history landed. */
export function peerSummary(agent: string, count: number, older: number, windowed: boolean): string {
  const span = windowed ? " in the last 24h" : "";
  const more = older > 0 ? ` · ${older} older not shown` : "";
  if (!count) return `(no messages between ${agent} and other peers${span}${more})`;
  return `── ${count} message${count === 1 ? "" : "s"} between ${agent} and other peers${span}, indented right${more} ──`;
}

/** The loud line the messages view shows on a remote space, where chat's creds can't read them. */
export function remotePeersNote(space: string): string {
  return `! other-peer messages aren't readable with this chat's credentials on a remote space (${space}) — this view shows only your conversation with the agent and channel posts you receive`;
}

/**
 * Merge `adds` (each with a ts) into `entries[from, to)` by time — the other-peer history goes between
 * the earlier block's rows (which carry their message ts) rather than in a lump. Rows in the range
 * without a ts keep their place; an add lands before the first row in the range whose ts is later.
 * Returns the new array. Pure.
 */
export function mergeByTs<T>(entries: readonly T[], from: number, to: number, adds: readonly T[], tsOf: (e: T) => number | undefined): T[] {
  if (from < 0 || to > entries.length || from > to) throw new Error(`mergeByTs: range [${from}, ${to}) out of bounds`);
  const out = entries.slice(0, from);
  const range = entries.slice(from, to);
  const queue = adds.slice().sort((a, b) => tsOf(a)! - tsOf(b)!);
  for (const e of range) {
    const t = tsOf(e);
    while (t !== undefined && queue.length && tsOf(queue[0]!)! < t) out.push(queue.shift()!);
    out.push(e);
  }
  out.push(...queue, ...entries.slice(to));
  return out;
}

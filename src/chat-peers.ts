/**
 * `paw chat`'s MESSAGES view (2026-11-06): the chat view PLUS what the target said to and heard from
 * OTHER peers — other agents, the channels it posted in, cron, the office bridge. Operator: those rows
 * are "indented/tabulated to the RIGHT … so they don't distract from my own conversation, which stays
 * left-aligned and normal" — drawn like a chat message, shifted 4 and muted (see peerRows). Screen:
 *
 *     you → kit: rebase #104 please
 *     🐈 kit: on it
 *         🐈 kit → 🦊 bob (2m ago): can you review #104 after CI?
 *         🦊 bob → 🐈 kit (1m ago): lgtm, merging
 *         🐈 kit → #general: #104 merged
 *     🐈 kit: done — pushed, CI green
 *
 * Where the rows come from (chat.ts wires it; src/chat-own.ts reads):
 *  - LOCAL space: the DM stream holds every DM, so the earlier rows are the target's DMs with anyone but
 *    "you" (plus its channel posts), and live ones come off chat-own's space-wide tap.
 *  - REMOTE space: the operator-only `chat-peers` cred, scoped to the target's own DM subjects (every id
 *    it had, both directions) and its own channel posts — signed per read for the earlier rows, and one
 *    live tap on the current target renewed before it expires (docs/notes/remote-mesh.md).
 *
 * Pure: no tty, no mesh. check:chat asserts it.
 */
import { forwardId } from "./forward-mark.ts";
import { displayWidth, sliceWidth } from "./width.ts";

/** One message between the target and someone else, in the shape the view renders. */
export interface PeerMsg {
  id: string;
  ts: number;
  /** sender's name */
  from: string;
  /** recipient: a peer's name, `#channel`, or a raw id when nothing names it (never a guess) */
  to: string;
  /** the message as the sender wrote it (a stale-id forward's note removed) */
  text: string;
  /** wire ids, DMs only — what a stale-id forward is paired against */
  fromId?: string;
  toId?: string;
  /** set on a stale-id forward (src/forward-mark.ts): the dead id the original was sent to */
  forwardOf?: string;
}

/**
 * Is `fwd` paw's stale-id forward of `orig` (src/forward-mark.ts)? Exact, by id: same sender, the
 * original went to the dead id the forward names, and the forward's id is forwardId(orig, live id).
 * An agent's dead ids count as its own, so both copies classify as its traffic — show one.
 */
export function isPeerForwardOf(fwd: PeerMsg, orig: PeerMsg): boolean {
  return (
    fwd.forwardOf !== undefined &&
    fwd.toId !== undefined &&
    fwd.fromId !== undefined &&
    fwd.fromId === orig.fromId &&
    orig.toId === fwd.forwardOf &&
    fwd.id === forwardId(orig.id, fwd.toId)
  );
}

/** `msgs` minus every forward whose original is also in it. */
export function dropPairedPeerForwards(msgs: PeerMsg[]): PeerMsg[] {
  const originals = msgs.filter((m) => m.forwardOf === undefined);
  return msgs.filter((m) => m.forwardOf === undefined || !originals.some((o) => isPeerForwardOf(m, o)));
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
  // `events.*` channels carry the agent's machine frames (ag-ui JSON per turn), not speech — same rule as the office bridge.
  if (m.channel?.startsWith("events.")) return undefined;
  if (m.channel) return fromAgent ? { from: m.from.name, to: `#${m.channel}` } : undefined;
  if (m.toService) return fromAgent ? { from: m.from.name, to: `@${m.toService}` } : undefined;
  if (!m.to) return undefined;
  const toAgent = o.agentIds.has(m.to) || o.nameOf(m.to)?.toLowerCase() === key;
  if (fromAgent && toAgent) return undefined; // to itself — nothing to show
  if (fromAgent) return { from: m.from.name, to: o.nameOf(m.to) ?? m.to.slice(0, 8) };
  if (toAgent) return { from: m.from.name, to: o.agent };
  return undefined;
}

/** How far right the other-peer rows sit: a fixed 4-column shift (operator, 2026-11-06: a quarter of
 *  the width read as a separate column, not a nudge). `cols` stays in the signature for callers. */
export const PEER_INDENT = 4;
export function peerIndent(_cols: number): number {
  return PEER_INDENT;
}

/**
 * One other-peer message as screen rows, drawn the way the chat view draws a message (chat.ts `said`),
 * then shifted right and muted. Operator, 2026-11-10: "it's fine that they're muted, but … it should be
 * identical between if I've been chatting with the agent or if it's the background message". So:
 *  - the label carries the agents' tags (`🐈 kit → 🦊 bob (2m ago):`) like a chat header;
 *  - the body is the same markdown render, on the label row when it is one line, else a block under it
 *    indented 2 (the chat view's continuation pad);
 *  - rows word-wrap inside the shift, keeping each row's own indent (a bullet's continuation stays under
 *    its text). The old character wrap split words ("bef|ore") and ran to the last column.
 * Every row is shifted by {@link peerIndent} and passed through `dim`; rows never pass `cols - 1`.
 */
export function peerRows(
  p: PeerMsg,
  o: {
    cols: number;
    age: string;
    dim: (s: string) => string;
    md: (text: string, width: number) => string[];
    strip: (s: string) => string;
    /** An agent's tag as the chat header shows it (emoji + name); a `#channel`/`@service` stays as is. */
    tag?: (name: string) => string;
  },
): string[] {
  const pad = " ".repeat(peerIndent(o.cols));
  const room = Math.max(10, o.cols - 1 - pad.length);
  const tag = (n: string): string => o.strip(o.tag && !/^[#@]/.test(n) ? o.tag(n) : n);
  const label = `${tag(p.from)} → ${tag(p.to)}${o.age}:`;
  const body = o.md(p.text, room - BODY_PAD.length).map((l) => o.strip(l));
  const rows = body.length <= 1 ? [`${label} ${body[0] ?? ""}`.trimEnd()] : [label, ...body.map((l) => (l ? BODY_PAD + l : l))];
  return rows.flatMap((r, i) => wrapHanging(r, room, i === 0 ? BODY_PAD : hangOf(r))).map((r) => o.dim(pad + r));
}

/** The chat view's continuation pad (Painter's `pad`): a body block sits this far under its label. */
const BODY_PAD = "  ";

/** Where a wrapped row's continuation starts: under a list item's text (`• `, `- `, `1. `), else at the
 *  row's own indent. */
function hangOf(row: string): string {
  const m = /^(\s*)(?:[•*+-]|\d+[.)])\s+/.exec(row);
  return " ".repeat(m ? displayWidth(m[0]) : /^ */.exec(row)![0].length);
}

/**
 * Word-wrap one plain row to `cols` columns; continuation rows start with `hang`. Breaks at the last
 * space that fits (never inside the row's leading indent), else mid-word for a word longer than a row.
 * Never drops a character.
 */
function wrapHanging(row: string, cols: number, hang: string): string[] {
  if (displayWidth(row) <= cols) return [row];
  const out: string[] = [];
  let rest = row;
  let lead = "";
  while (displayWidth(lead + rest) > cols) {
    const room = Math.max(1, cols - displayWidth(lead));
    let head = sliceWidth(rest, room) || Array.from(rest)[0]!;
    const indent = /^ */.exec(head)![0].length;
    const space = head.lastIndexOf(" ");
    if (space > indent && head.length < rest.length && rest[head.length] !== " ") head = head.slice(0, space + 1);
    out.push((lead + head).trimEnd());
    rest = rest.slice(head.length).replace(/^ +/, "");
    lead = hang;
  }
  if (rest) out.push(lead + rest);
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

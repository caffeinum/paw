/**
 * `paw web [--port N] [--space s] [--no-open]` — the mesh as a browser tab.
 *
 * ONE PROCESS HOLDS ONE MESH CONNECTION AND FANS IT OUT TO N SOCKETS. That is the whole architecture,
 * and it exists because of a constraint that rules out the obvious designs: the human is a single mesh
 * peer ("you") with a SINGLE durable DM consumer, and cotal allows exactly one active consumer per
 * durable. `paw chat` binds it. So a browser that joined the mesh as "you" — or a server here that
 * consumed on "you"'s behalf — would STARVE a live `paw chat`. The Raycast extension refuses to join
 * the mesh at all for this reason and shells out to the CLI instead.
 *
 * The way through is that READING is contended and WRITING is not. The durable exists for acked
 * delivery; publishing needs no consumer at all. So:
 *
 *   - the read path is an OBSERVER (src/feed.ts `observerEndpoint`: registerPresence:false,
 *     consume:false) — it never binds the durable, so `paw chat` is undisturbed;
 *   - live latency comes from `ep.tap`, a plain NATS subscribe, ephemeral, no durable, already used by
 *     `paw chat` for cross-session echo — it does not contend either;
 *   - the composer SENDS through `sendAsYou` (src/dm.ts), the same path `paw dm` uses, because a send
 *     needs no consumer.
 *
 * The browser never speaks NATS. That is deliberate and structural, not stylistic: keeping mesh access
 * out of the tab means there is no code path in the client that COULD bind a durable by accident.
 *
 * NOT A SECOND `cotal web`. cotal web (port 7799) renders the mesh, and if that were all this did it
 * should not exist. What it serves that cotal structurally cannot see is paw-local: the per-folder
 * agent roster (`collectStatus`), the unread cursor, and agent TRACES — turns and tool calls read from
 * the claude transcript on disk, which never crosses the mesh at all.
 *
 * THE SEAM: {@link startWebServer} is the http/ws half and takes its dependencies as arguments — the
 * conversation, a roster read, a trace read, a send. It knows nothing about the mesh, which is why
 * `check:web` can exercise the entire contract a browser sees with nothing else alive. `web()` is then
 * just: parse args, ensure the daemons, build the real dependencies, hand them over.
 *
 * LOCALHOST ONLY. It binds 127.0.0.1, checks `Origin` and `Host`, and has NO token (the operator's
 * call). Residual, stated once: any process on this machine can read your DMs and send as "you". The
 * Origin/Host checks stop a drive-by page and DNS rebinding — a browser attaches `Origin` to every
 * cross-origin fetch AND to every WebSocket handshake, and CORS does not cover a WebSocket at all, so
 * the refusal is server-side on both. They do not stop a local process. A token is the fix if that
 * ever matters.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER, registry, type Command, type CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { controlCreds, folderForName, personaFilePath } from "./addressing.js";
import { claudeProjectDir } from "./adopt.js";
import { advanceCursor, cursorPath, readCursor } from "./cursor.js";

/**
 * The browser reads its OWN cursor, not the shared one.
 *
 * Every TERMINAL surface advances `inbox.cursor` as a side effect of PRINTING a DM — that is correct
 * for them, and it is why one unread state spans `paw inbox` and `paw chat`. But a `paw chat` left
 * running in another window then walks the shared cursor past the newest message within seconds, so a
 * browser reading it shows "0 unread" no matter what has arrived. Reported live, with the cause
 * correctly guessed: "unread marker doesnt seem to work (maybe cause i have paw chat running)". It was.
 *
 * A surface must own the state of what IT has shown you. Raycast reached the same place and had to
 * keep its own; this is the same conclusion, one file instead of a per-message set.
 *
 * The write stays symmetric-ish ON PURPOSE: marking read in the browser advances BOTH cursors, because
 * "I have read these" is true everywhere, while "the browser displayed these" is only true here.
 */
const WEB_CURSOR = "web";

/**
 * The browser's cursor, SEEDED from the shared one the first time it is asked for.
 *
 * A fresh file reads 0, which would declare the entire history unread — every DM you have ever
 * received, lit up as new. That is not "we don't know yet", it is a wrong answer with a badge on it.
 * The shared cursor is the best available statement of what the human has already seen, so the browser
 * adopts it once and owns its own from then on.
 */
function webCursor(space: string): number {
  if (existsSync(cursorPath(space, WEB_CURSOR))) return readCursor(space, WEB_CURSOR);
  const shared = readCursor(space);
  if (shared > 0) advanceCursor(space, shared, WEB_CURSOR);
  return shared;
}
import { sendAsYou } from "./dm.js";
import { FETCH_CAP, messageText, observerEndpoint, pollLoop, readConversation, type Entry } from "./feed.js";
import { ensure, resolveSpace, reexecUnderNode } from "./lifecycle.js";
import { blocksForAgent, chooseTranscriptId } from "./log.js";
import { HUMAN_PEER } from "./names.js";
import { readAgentType, readResumeId } from "./session.js";
import { searchEntries, searchTranscript, snippet, type MessageHit, type TranscriptHit } from "./search.js";
import { collectStatus, type AgentStatus } from "./status.js";
import { dropSharedManagerControl, sharedManagerControl } from "./control.js";
import { closeTask, commentTask, createTaskGetId, listComments, listTasks, taskPrRows, updateTask } from "./tasks.js";
import { gitToplevel, listWorktrees } from "./worktree.js";
import type { Block } from "./transcript.js";
import { randomBytes } from "node:crypto";
import { imagesDir } from "./images.js";
import { prInfo, prInfoMany } from "./git.js";
import { bashMessage, runBash } from "./bash.js";

/** 7788, NOT 7799 — `cotal web` owns 7799 and running both at once is the normal case, not a clash. */
const DEFAULT_PORT = 7788;
/** How often the roster is re-collected. Slower than the message feed on purpose: presence changes on
 *  a human timescale, and each collect costs a control round-trip plus a JetStream query per agent. */
const STATUS_MS = 10_000;
/**
 * How often the conversation is re-read from `dmHistory`.
 *
 * The tap is an OPTIMISATION for latency; THIS is the correctness backstop. `ep.tap` is ephemeral — it
 * has no durable behind it, so anything published while the connection is down is not replayed, and
 * core exposes no reconnect event to hang a targeted re-read off. A periodic full re-read is therefore
 * the honest way to close a gap we cannot be notified about: worst case a message is late by this
 * interval, never lost.
 */
const RECONCILE_MS = 30_000;
/** Matches `paw log` — transcripts reach hundreds of MB, so a trace read only touches the end. */
const TRACE_TAIL_BYTES = 512 * 1024;
/**
 * The furthest back a single request may read.
 *
 * The byte window, not `tail`, is what actually bounds a trace: transcripts here reach 50MB+ and a
 * single message can be tens of KB, so 512KB of one of them held **24 blocks** — asking for 5000
 * returned the same 24. Raising the window is therefore the only thing that reaches older turns, and
 * it has to be bounded, because reading is O(bytes) on a file that keeps growing.
 */
const TRACE_MAX_BYTES = 16 * 1024 * 1024;
const TRACE_DEFAULT_BLOCKS = 200;
const INBOX_DEFAULT_LIMIT = 200;
/** A socket this far behind is not caught up by buffering harder. See the broadcast in startWebServer. */
/** Attachment types served inline — exactly the set claude's own Read renders, so the browser never
 *  promises a picture that the rest of paw could not have shown. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** An attachment past this is refused rather than streamed: this is a chat pane, not a file transfer. */
const FILE_CAP = 25 * 1024 * 1024;

const SOCKET_BACKLOG_CAP = 4 * 1024 * 1024;

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), cyan: wrap("36"), red: wrap("31") };

/* ── args ─────────────────────────────────────────────────────────────────────────────────────── */

export interface Args {
  port: number;
  space?: string;
  server?: string;
  open: boolean;
}

/** Exported so the flags can be checked without standing anything up. A bad `--port` THROWS rather
 *  than falling back to the default: a port the operator did not choose is a fabricated value, and the
 *  daemon it silently lands on is one they will debug for an hour. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { port: DEFAULT_PORT, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--no-open") out.open = false;
    else if (a === "--port" || a === "-p") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("paw: --port needs a port number (1-65535)");
      out.port = n;
    } else throw new Error(`paw: unknown argument "${a}" — web takes [--port N] [--space s] [--server url] [--no-open]`);
  }
  return out;
}

/* ── origin and host ──────────────────────────────────────────────────────────────────────────── */

/**
 * May a request carrying this `Origin` reach the API?
 *
 * EXACT equality against the three spellings of this server, and nothing looser. A `startsWith` or
 * `includes` check passes `http://127.0.0.1:7788.evil.example` (a hostile HOST that merely begins with
 * ours), `http://evil.example/http://127.0.0.1:7788` (ours in the PATH) and
 * `http://127.0.0.1:7788@evil.example` (ours as USERINFO) — three different ways to hand a page the
 * ability to read your DMs and send as you. The port is part of the identity too: another daemon on
 * 7789 is not this one.
 *
 * An ABSENT Origin is allowed: browsers attach one to every cross-origin request, so no Origin means a
 * non-browser caller (curl, a script), which has no ambient credential to abuse. The literal string
 * "null" is NOT absent — it is what a sandboxed iframe or a `data:` URL sends, and it is refused.
 */
export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
}

/**
 * `Host` must be loopback too — the DNS-rebinding half. Binding to 127.0.0.1 does NOT stop a hostile
 * name that resolves to 127.0.0.1: the request reaches this server carrying its own Host, and the page
 * is then same-origin with whatever answers. Compared case-insensitively, as DNS is.
 */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/* ── the conversation ─────────────────────────────────────────────────────────────────────────── */

/** The separator in {@link keyOf}. NUL, because no message body or agent name can contain one — a
 *  printable separator lets a sender forge a collision from CONTENT ("a"+"b c" vs "a b"+"c" under a
 *  space), and a forged collision silently drops somebody's message out of the feed. */
const KEY_SEP = "\u0000";

/** The identity of a message as this API can observe it. See {@link Conversation} on why not `id`. */
export function keyOf(e: Entry): string {
  return `${e.ts}${KEY_SEP}${e.from}${KEY_SEP}${e.text}`;
}

/**
 * How many messages are unread: addressed to YOU, and newer than the cursor.
 *
 * TWO EXCLUSIONS, both load-bearing. Your own sends are never unread. And agent↔agent traffic is never
 * counted — the observer sees the whole space, so counting everything would light the badge on day one
 * and the signal would be dead before anyone used it. `dir !== "out"` rather than `dir === "in"`
 * because the inbox-only read shape omits `dir` entirely (src/feed.ts adds it only when both
 * directions were asked for), and everything in THAT shape is by definition addressed to you.
 *
 * It lives SERVER-side for the reason paw's Raycast read-state notes give at length: when each surface
 * computes "unread" for itself, two surfaces disagree about what you have read. That shipped twice
 * there before landing on per-message state, and the daemon is the one place all surfaces share.
 */
export function unreadCount(entries: Entry[], cursor: number): number {
  // The `channel` exclusion is belt-and-braces, and it is the one that would kill the feature. Channel
  // entries carry no `dir` (nobody addressed them to you), so `dir !== "out"` alone would COUNT them —
  // and agents chatter on #general far more than the human does, so the badge would read "247" on day
  // one and never come down. The DM store and the channel store are separate objects precisely so they
  // cannot mix, but a future caller concatenating them must not be able to resurrect that bug.
  return entries.filter((e) => !("channel" in e) && e.dir !== "out" && e.ts > cursor).length;
}

/**
 * The human's DM stream, held in memory: a periodically re-read HISTORY plus the LIVE tail the tap has
 * delivered since that read.
 *
 * The split is what makes dedupe tractable. `readConversation` is authoritative for everything up to
 * the moment it ran, so a reconcile can replace history wholesale and drop the live entries it now
 * covers — rather than merging two streams that overlap arbitrarily.
 *
 * DEDUPE, honestly: live entries dedupe against each other by the message `id` the tap carries, which
 * is exact. Live-vs-history matches on {@link keyOf}, because `Entry` (src/feed.ts — not this file's to
 * change) drops the id when it flattens a message. Two DISTINCT messages identical in timestamp, sender
 * AND text would collapse into one; they are also indistinguishable to every consumer of this API, so
 * nothing downstream could have told them apart either. Carrying `id` on `Entry` would make it exact
 * AND give the client a stable render key — a one-line change in feed.ts, worth making.
 */
export class Conversation {
  private history: Entry[] = [];
  private live: Entry[] = [];
  private liveIds = new Set<string>();
  /** keyOf(entry) → the tapped message id, so `liveIds` can be pruned when a reconcile absorbs an entry. */
  private idByKey = new Map<string, string>();
  /** Learned id→name, so an OUTGOING DM renders with the recipient's name rather than its raw id. The
   *  roster is asked first; this remembers peers that have since gone offline. Never guessed — an id
   *  never seen as a sender stays an id (see Entry.to). */
  private names = new Map<string, string>();
  /** Outgoing entries whose recipient was still a raw id when accepted → that id. Re-resolved on
   *  every read: after a fleet restart every agent carries a NEW id, and the roster can lag or be
   *  gone, so an entry named at accept time only would keep its id until the daemon restarted —
   *  and the client's optimistic row, which matches on the NAME, would show "waiting" until the
   *  agent happened to reply (2026-09-08). */
  private unnamed = new Map<Entry, string>();

  constructor(private readonly ep: CotalEndpoint) {}

  entries(): Entry[] {
    for (const [entry, id] of this.unnamed) {
      const name = this.nameFor(id);
      if (name === id) continue;
      entry.to = name;
      this.unnamed.delete(entry);
    }
    return [...this.history, ...this.live];
  }

  /** Re-read the whole conversation and drop the live entries it now covers. */
  async reconcile(): Promise<void> {
    const fresh = await readConversation(this.ep, { withSent: true });
    const covered = new Set(fresh.map(keyOf));
    this.history = fresh;
    for (const e of this.live) this.unnamed.delete(e);
    this.unnamed.clear();
    // readConversation names a recipient only from ids it saw SENDING; anything else is a raw id.
    for (const e of fresh) if (e.dir === "out" && e.to && looksLikeId(e.to)) this.unnamed.set(e, e.to);
    this.live = this.live.filter((e) => !covered.has(keyOf(e)));
    const stillLive = new Set(this.live.map(keyOf));
    for (const [key, id] of this.idByKey) {
      if (!stillLive.has(key)) {
        this.idByKey.delete(key);
        this.liveIds.delete(id);
      }
    }
  }

  /**
   * A tapped frame → a new entry, or undefined.
   *
   * TWO JOBS, and the second one protects the feature. First, survive the traffic: the tap sees the
   * WHOLE space, including control replies that carry no `from` at all, and core does not try/catch tap
   * handlers — an unguarded deref here kills the feed permanently.
   *
   * Second, admit ONLY the human's own mail. Channel posts and agent↔agent DMs cross this tap
   * constantly; if they entered the human's conversation then every unread count would be lit from day
   * one and the signal would be dead before anyone used it.
   */
  accept(m: CotalMessage | undefined): Entry | undefined {
    if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.from) return undefined;
    if (m.from.id && m.from.name) this.names.set(m.from.id, m.from.name);
    if (typeof m.id !== "string" || !m.id || this.liveIds.has(m.id)) return undefined;

    const me = this.ep.card.id;
    let entry: Entry | undefined;
    if (m.to === me) entry = { from: m.from.name, text: messageText(m), ts: m.ts, dir: "in" };
    else if (m.from.id === me && m.to) {
      entry = { from: HUMAN_PEER, text: messageText(m), ts: m.ts, dir: "out", to: this.nameFor(m.to) };
      if (entry.to === m.to) this.unnamed.set(entry, m.to);
    } else return undefined; // channel traffic, or a DM between two agents — not the human's conversation

    const key = keyOf(entry);
    if (this.history.some((h) => keyOf(h) === key)) return undefined; // the tap and the last reconcile overlap

    this.liveIds.add(m.id);
    this.idByKey.set(key, m.id);
    this.live.push(entry);
    return entry;
  }

  private nameFor(id: string): string {
    return this.names.get(id) ?? this.ep.getRoster().find((p) => p.card.id === id)?.card.name ?? id;
  }
}

/** A wire principal (`<owner>.<actor>`, NATS-safe tokens) as opposed to an agent name. Names may
 *  carry dashes and never a dot; a principal always carries exactly one dot. */
function looksLikeId(s: string): boolean {
  return /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(s);
}

/** A channel message. The `channel` field is what routes it in the client — and what keeps it OUT of
 *  {@link unreadCount}, which refuses anything carrying one. */
export type ChannelEntry = Entry & { channel: string };

/** How much per-channel live tail to hold. This daemon runs for days and `#general` never stops, so an
 *  uncapped tail is a slow memory leak with a plausible-looking cause. The BACKFILL is the deep history
 *  (fetched per request); this is only the window since the last fetch, so a small cap loses nothing. */
const CHANNEL_LIVE_CAP = 500;

/**
 * Channel traffic, kept in a SEPARATE store from the human's DMs — deliberately, and not merely for
 * tidiness.
 *
 * {@link Conversation.accept} admits only mail addressed to (or sent by) the human, and that scoping is
 * what stops the unread badge from being lit forever by agent chatter. Teaching it about channels would
 * mean one method deciding two different questions, and the day someone loosens it for a channel
 * feature is the day DM scoping quietly breaks. Two admitters, neither able to widen the other.
 *
 * This holds only the LIVE tail seen since the process started; deep history comes from
 * `ep.channelHistory` per request. A channel the operator never opens therefore costs one small array.
 */
/** A message entry a village edge/last-message tracker records. Only DMs (has `to`, no `channel`)
 *  build edges; channel traffic is not pairwise. */
export interface VillageEdge { a: string; b: string; count: number; lastTs: number }
export interface VillageData { edges: VillageEdge[]; last: Record<string, { text: string; ts: number }>; generatedAt: number }

/**
 * The VILLAGE tracker (2026-09-09): who talks to whom, from the same whole-space tap the rest of the
 * daemon rides. It answers the two questions the village view asks and cotal's open mesh cannot: the
 * DM edges between agents (and between an agent and "you"), and each agent's last spoken line for the
 * hover card. Live-accumulated — an edge appears the first time a pair exchanges a DM and its weight
 * grows — because paw has no historical agent↔agent store (the delivery daemon owns that, which paw
 * doesn't run); the you-edges also seed from `Conversation` which already reads dmHistory.
 *
 * Names, not ids, are the node identity (the village renders names): `m.from.name` is always present,
 * but `m.to` is an ID, so an edge is only counted once BOTH ends resolve to a name — the sender end is
 * free, the recipient end is learned when that peer itself later sends. An unresolved recipient is
 * dropped rather than drawn as a raw id, the same honesty rule as the status rows.
 */
export class Village {
  private names = new Map<string, string>(); // id -> name, learned from any sender
  private edges = new Map<string, { count: number; lastTs: number }>(); // "a\u0000b" (names sorted) -> weight
  private last = new Map<string, { text: string; ts: number }>(); // sender name -> last line
  private seenIds = new Set<string>();
  private readonly meName: string;
  constructor(private readonly me: string) {
    this.meName = HUMAN_PEER;
    this.names.set(me, HUMAN_PEER);
  }

  /** A tapped frame → record a DM edge + the sender's last line. Same shape guard as the others (the
   *  tap carries control frames with no `from`; core does not try/catch the handler). */
  note(m: CotalMessage | undefined): void {
    if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.from) return;
    if (m.from.id && m.from.name) this.names.set(m.from.id, m.from.name);
    if (typeof m.id !== "string" || !m.id || this.seenIds.has(m.id)) return;
    this.seenIds.add(m.id);
    if (this.seenIds.size > FETCH_CAP * 4) this.seenIds.clear(); // bounded; a re-counted frame only nudges a weight
    const fromName = m.from.id === this.me ? this.meName : m.from.name;
    // The last-spoken line is whatever the agent last said ANYWHERE — a channel post counts, it is
    // still "what they last said" for the hover card. Recorded before the channel short-circuit below.
    if (fromName) this.last.set(fromName, { text: messageText(m).slice(0, 400), ts: m.ts });
    if (typeof m.channel === "string" && m.channel) return; // channels aren't pairwise — no edge, but the line above stands
    const to = typeof m.to === "string" ? m.to : undefined;
    if (!to || !fromName) return; // an anycast / control frame has no single recipient
    const toName = to === this.me ? this.meName : this.names.get(to);
    if (!toName || toName === fromName) return; // recipient not yet resolved to a name, or a self-loop
    const key = [fromName, toName].sort().join("\u0000");
    const cur = this.edges.get(key) ?? { count: 0, lastTs: 0 };
    this.edges.set(key, { count: cur.count + 1, lastTs: Math.max(cur.lastTs, m.ts) });
  }

  /** Seed the last-spoken line for a name from history the daemon already holds (Conversation entries),
   *  so an agent that DM'd you before the daemon started still has a hover line. Idempotent-ish: only
   *  overwrites when the seeded stamp is newer. */
  seedLast(name: string, text: string, ts: number): void {
    const cur = this.last.get(name);
    if (!cur || ts > cur.ts) this.last.set(name, { text: text.slice(0, 400), ts });
  }

  snapshot(): VillageData {
    return {
      edges: [...this.edges].map(([k, v]) => { const [a, b] = k.split("\u0000"); return { a, b, count: v.count, lastTs: v.lastTs }; }),
      last: Object.fromEntries(this.last),
      generatedAt: Date.now(),
    };
  }
}

export class Channels {
  private live = new Map<string, ChannelEntry[]>();
  private seenIds = new Set<string>();
  /** Who has been SEEN posting in each channel — the only membership an OPEN mesh lets paw know
   *  (`channelMembers()`/`readMembership()` both answer empty here; probed live 2026-09-03). Fed by
   *  the tap and by a one-time backlog scan per channel (see `noteAuthors`). */
  private authors = new Map<string, Set<string>>();
  /** Every message timestamp seen per channel (backlog scan + tap, deduped by the entry key) — what
   *  "unread since you last looked" is counted against. Bounded by FETCH_CAP per channel like the
   *  backlog itself; older stamps fall off the front, which can only UNDERcount a very stale channel. */
  private stamps = new Map<string, number[]>();

  /** A tapped frame → a channel entry, or undefined for anything that is not channel traffic.
   *
   *  Same shape guard as {@link Conversation.accept}, for the same reason: the space tap also carries
   *  control replies with no `from`, core does not try/catch the handler, and one unguarded deref kills
   *  the feed permanently rather than just dropping a frame. */
  accept(m: CotalMessage | undefined): ChannelEntry | undefined {
    if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.from) return undefined;
    if (typeof m.channel !== "string" || !m.channel) return undefined; // a DM, an anycast, or a control frame
    if (typeof m.id !== "string" || !m.id || this.seenIds.has(m.id)) return undefined;
    this.seenIds.add(m.id);

    const entry: ChannelEntry = { from: m.from.name, text: messageText(m), ts: m.ts, channel: m.channel };
    this.noteAuthors(m.channel, [m.from.name]);
    this.noteStamps(m.channel, [m.ts]);
    const tail = this.live.get(m.channel) ?? [];
    tail.push(entry);
    if (tail.length > CHANNEL_LIVE_CAP) tail.splice(0, tail.length - CHANNEL_LIVE_CAP);
    this.live.set(m.channel, tail);
    return entry;
  }

  /** Record authors seen in a channel (tap or backlog). Idempotent; names only, never ids. */
  noteAuthors(channel: string, names: Iterable<string>): void {
    const set = this.authors.get(channel) ?? new Set<string>();
    for (const n of names) if (n) set.add(n);
    this.authors.set(channel, set);
  }

  /** Record message timestamps for a channel (idempotent per stamp; kept sorted, capped). */
  noteStamps(channel: string, stamps: Iterable<number>): void {
    const cur = new Set(this.stamps.get(channel) ?? []);
    for (const t of stamps) if (Number.isFinite(t)) cur.add(t);
    const arr = [...cur].sort((a, b) => a - b);
    this.stamps.set(channel, arr.length > FETCH_CAP ? arr.slice(arr.length - FETCH_CAP) : arr);
  }

  /** Per channel: the newest stamp and how many messages arrived AFTER `seen[channel]` (0 when the
   *  channel has never been looked at → everything counts; that is the honest reading of "never seen"). */
  activity(seen: Record<string, number>): Record<string, { latest: number; unread: number }> {
    const out: Record<string, { latest: number; unread: number }> = {};
    for (const [ch, arr] of this.stamps) {
      if (!arr.length) continue;
      const since = seen[ch] ?? 0;
      let i = arr.length;
      while (i > 0 && arr[i - 1] > since) i--;
      out[ch] = { latest: arr[arr.length - 1], unread: arr.length - i };
    }
    return out;
  }

  /** channel → authors seen, for the sidebar's "agents in this channel" unfold. */
  members(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [ch, set] of this.authors) out[ch] = [...set].sort();
    return out;
  }

  /** The live tail for one channel, oldest first. */
  tail(channel: string): ChannelEntry[] {
    return [...(this.live.get(channel) ?? [])];
  }

  /** Channels this process has actually SEEN traffic on. Unioned with `listChannels()` rather than
   *  replacing it: the registry knows about configured-but-quiet channels, and the tap knows about ones
   *  created since the last refresh. Neither is complete alone. */
  seen(): string[] {
    return [...this.live.keys()];
  }
}

/** What `/api/channel/<name>` answers. `historyError` is present ONLY when the backfill could not be
 *  trusted — an empty `messages` with no error means the channel really is empty. */
export interface ChannelPayload {
  channel: string;
  messages: ChannelEntry[];
  historyError?: string;
}

/**
 * One channel's traffic: the JetStream backfill, merged with the live tail this process has tapped.
 *
 * WHY BOTH. The backfill is deep but ends the moment it was fetched; the tail is shallow but current.
 * Neither alone is the channel. They are merged on {@link keyOf} — the same NUL-separated identity the
 * DM path dedupes on, so a message present in both appears once.
 *
 * AUTHED MESH, stated rather than hidden: on `PAW_AUTH=1` an observer cred may be denied the throwaway
 * consumer this read needs, and the failure mode is an EMPTY LIST rather than a throw — which renders
 * as "this channel is quiet" when the truth is "paw was not allowed to look". So an empty backfill on
 * an authed mesh reports `historyError` instead of silence, exactly as `paw history` already warns and
 * as `/api/status` treats an unqueryable inbox lag. UNVERIFIED against a live authed mesh (this box
 * runs open) — the guard is deliberately shaped so that being wrong shows a spurious note, never
 * silent data loss.
 */
export async function channelMessages(
  ep: CotalEndpoint,
  channels: Channels,
  channel: string,
  limit: number,
  authed: boolean,
): Promise<ChannelPayload> {
  let backfill: ChannelEntry[] = [];
  let historyError: string | undefined;
  try {
    const raw = await ep.channelHistory(channel, { limit: FETCH_CAP });
    backfill = raw
      .filter((m) => Array.isArray(m.parts) && m.from)
      .map((m): ChannelEntry => ({ from: m.from.name, text: messageText(m), ts: m.ts, channel }));
    if (!backfill.length && authed) {
      historyError = `paw: no channel backlog returned for "${channel}" on an authed mesh — an observer cred may be denied the read, so this may be a permission, not an empty channel. Live traffic is unaffected.`;
    }
  } catch (e) {
    historyError = `paw: couldn't read the backlog for "${channel}" — ${(e as Error).message}`;
  }

  const seen = new Set(backfill.map(keyOf));
  const merged = [...backfill, ...channels.tail(channel).filter((e) => !seen.has(keyOf(e)))].sort((a, b) => a.ts - b.ts);
  return { channel, messages: merged.slice(-limit), ...(historyError ? { historyError } : {}) };
}

/** Blocks for one agent's ACTIVE transcript. Mirrors `paw log`'s resolution exactly — including its
 *  fail-loud on a pinned agent with no transcript yet, which must NOT degrade into showing some other
 *  session's turns (the `paw log aleks` bug). */
export interface SearchPayload {
  q: string;
  messages: MessageHit[];
  transcripts: TranscriptHit[];
  truncated: boolean;
  errors: string[];
}

/** The transcript file behind a registered agent, resolved exactly as the trace does (pinned wins). */
function transcriptFileFor(space: string, name: string): string | undefined {
  const folder = folderForName(space, name);
  if (!folder) return undefined;
  const persona = personaFilePath(space, name);
  const pinned = existsSync(persona) ? readResumeId(persona) : undefined;
  const agentType = existsSync(persona) ? readAgentType(persona) : undefined;
  const dir = claudeProjectDir(folder);
  try {
    return join(dir, `${chooseTranscriptId(name, dir, pinned, agentType)}.jsonl`);
  } catch {
    return undefined; // no transcript yet — an agent with nothing to search, not an error
  }
}

export function traceBlocks(space: string, name: string, tail: number, bytes = TRACE_TAIL_BYTES): Block[] {
  const folder = folderForName(space, name);
  if (!folder) {
    throw new Error(
      `paw: "${name}" isn't registered with paw in space "${space}" — paw's trace needs a folder to find the session; ` +
        `watch an unregistered peer with \`cotal attach --name ${name}\``,
    );
  }
  const window = Math.min(Math.max(bytes, TRACE_TAIL_BYTES), TRACE_MAX_BYTES);
  return blocksForAgent(space, name, folder, { tail, bytes: window }).blocks;
}

/* ── http ─────────────────────────────────────────────────────────────────────────────────────── */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Minimal response surface, so the pure-ish handlers can be driven without a socket. */
interface Responder {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: unknown): unknown;
}

function sendJson(res: Responder, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * The built client, if design-web has produced one.
 *
 * Resolved by walking up from this MODULE rather than from the cwd, because `paw web` runs from
 * wherever the operator happens to be. Two candidates cover both layouts: `src/web.ts` under tsx and
 * `dist/src/web.js` after a build.
 */
export function findClientRoot(): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of ["../web/app", "../../web/app"]) {
    const candidate = resolve(here, up);
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

/**
 * Serve a file from the client bundle.
 *
 * Traversal is blocked by CONTAINMENT, not by pattern-matching the path: the request is resolved
 * against the root and refused if it lands outside, so `../`, a percent-encoded `..%2f`, and anything
 * else that has not been invented yet all fail the same way. Matching on what an escape LOOKS like is
 * how the next encoding gets through.
 */
/**
 * What an invited agent is asked to do.
 *
 * An invite is a REQUEST, and the wording has to carry that honestly, because cotal has no "add
 * someone else to a channel": membership is an agent's own act (`cotal_join`), so the only thing paw
 * can do is ask. The message names the exact call rather than describing it, since the recipient is a
 * model that has to act on this with no other context — and asking it to say hello gives the channel
 * visible proof the join worked, instead of a silent membership nobody can see.
 */
export function inviteText(channel: string): string {
  return `you've been invited to #${channel} — join it with cotal_join("${channel}"), then say hello there so the channel knows you're in.`;
}

export function serveStatic(root: string | undefined, urlPath: string, res: Responder): void {
  if (!root) {
    sendJson(res, 503, {
      error: "paw: no client bundle — web/app/index.html doesn't exist yet. The API is up; the UI is built into web/app/.",
    });
    return;
  }
  const base = resolve(root);
  let rel: string;
  try {
    rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  } catch {
    sendJson(res, 400, { error: "paw: undecodable path" });
    return;
  }
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) {
    sendJson(res, 403, { error: "paw: path escapes the client root" });
    return;
  }
  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // A single-page client owns its own routing, so an extensionless unknown path falls back to the
    // shell. A path that LOOKS like an asset 404s instead — a missing bundle file must be visible as
    // missing, not answered with HTML that then fails to parse as JS.
    if (extname(rel)) {
      sendJson(res, 404, { error: `paw: no such file "${rel}"` });
      return;
    }
    file = join(base, "index.html");
    if (!existsSync(file)) {
      sendJson(res, 503, { error: "paw: no client bundle — web/app/index.html doesn't exist yet." });
      return;
    }
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(body.length),
    "cache-control": "no-store", // the bundle is rebuilt in place; a cached shell against a new API is a support call
  });
  res.end(body);
}

/** Which PRs the sidebar shows: an OPEN PR from anywhere (drafts included — a draft is still work),
 *  or whatever the agent's OWN folder is on, even merged/closed (it says what the agent last did).
 *  A merged PR on a sibling worktree is a dead branch nobody is working on — 12 of 25 rows on the
 *  first sweep — and would bury the live ones. Pure. */
export function keepSidebarPr(state: string | undefined, ownFolder: boolean): boolean {
  return ownFolder || state === "OPEN";
}

/**
 * Expand live agents' folders to every worktree of their repo. Pure over injected git fns so it is
 * testable without a checkout. A folder that isn't a git repo is SKIPPED (no toplevel → nothing);
 * two agents in the same repo each keep their rows (PR dedupe by url happens later, and the first
 * agent listed wins the label). Never throws on one bad repo.
 */
export function expandAgentWorktrees(
  rows: ReadonlyArray<{ name: string; folder: string }>,
  git: { toplevel: (dir: string) => string | undefined; worktrees: (root: string) => string[] },
): Array<{ agent: string; folder: string }> {
  const out: Array<{ agent: string; folder: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let paths: string[];
    try {
      const root = git.toplevel(r.folder);
      paths = root ? git.worktrees(root) : [];
    } catch {
      paths = [];
    }
    for (const folder of paths) {
      if (seen.has(folder)) continue; // the same worktree reached via two agents is one target
      seen.add(folder);
      out.push({ agent: r.name, folder });
    }
  }
  return out;
}

async function readBody(req: IncomingMessage, cap = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > cap) throw new Error("paw: request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ── websocket ────────────────────────────────────────────────────────────────────────────────── */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Server→client text frame. Never masked (RFC 6455 §5.1: a server must not mask). */
function textFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function controlFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/**
 * Consume whole frames from a client, returning the unparsed remainder.
 *
 * The contract has no client→server messages, so data frames are discarded — but they still have to be
 * PARSED, because a frame left unconsumed leaves the stream misaligned and every later frame is
 * garbage. Ping is answered (a browser's keepalive) and close ends the socket.
 */
function readClientFrames(input: Buffer, socket: Socket): Buffer {
  let buf = input;
  for (;;) {
    if (buf.length < 2) return buf;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      const big = buf.readBigUInt64BE(2);
      // A client announcing a frame bigger than anything we would ever buffer is not a client we serve.
      if (big > BigInt(SOCKET_BACKLOG_CAP)) {
        socket.destroy();
        return Buffer.alloc(0);
      }
      len = Number(big);
      offset = 10;
    }
    // A control frame (close/ping/pong) MUST carry ≤125 bytes and MUST NOT be fragmented (RFC 6455
    // §5.5). Enforced rather than trusted, because the pong echo below writes its length into a SINGLE
    // byte: a client sending a "ping" that declares 300 bytes would have that length truncated on the
    // way back out, desynchronising the stream so every subsequent frame is garbage. Refusing a frame
    // the spec already forbids is cheaper than parsing a stream that has silently lost its alignment.
    if (opcode >= 0x8 && (len > 125 || (buf[0] & 0x80) === 0)) {
      socket.destroy();
      return Buffer.alloc(0);
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return buf;
    const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
    const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    buf = buf.subarray(offset + maskLen + len);

    if (opcode === 0x8) {
      socket.end(controlFrame(0x8, Buffer.alloc(0)));
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) socket.write(controlFrame(0xa, payload));
    // 0x0/0x1/0x2 (client data) and 0xa (pong) carry nothing this API consumes.
  }
}

/* ── the server ───────────────────────────────────────────────────────────────────────────────── */

/** What the http/ws half needs, none of which it builds. Each is the narrowest thing that answers one
 *  endpoint, so the whole contract a browser sees can be exercised without a mesh. */
export interface WebDeps {
  port: number;
  space: string;
  convo: { entries(): Entry[] };
  status: () => Promise<{ rows: unknown[]; errors: string[] }>;
  trace: (name: string, tail: number, bytes?: number) => unknown[];
  dm: (to: string, text: string) => Promise<{ name: string }>;
  /** Multicast to a channel. Doubles as channel CREATION — cotal has no separate create step.
   *  OPTIONAL so a fixture that predates it still satisfies WebDeps (same courtesy the channel deps
   *  were added with) — a server without it answers 501 rather than pretending to post. */
  post?: (channel: string, text: string) => Promise<void>;
  /**
   * The channels worth showing in a sidebar. SYNCHRONOUS on purpose: it is stamped onto every status
   * frame at send time (like `cursor`), so it must be a cached local read — a mesh round-trip per
   * broadcast would put a network call on the hot path of a timer.
   *
   * OPTIONAL, so a server can be stood up without one; the field is then omitted from the payload
   * rather than sent as `[]`, because "no channel source configured" and "no channels exist" are
   * different facts and only one of them should render as an empty sidebar.
   */
  channels?: () => string[];
  /** channel → agent names seen posting there (the open-mesh notion of membership; see Channels.authors). */
  channelMembers?: () => Record<string, string[]>;
  /** Per-channel unread: newest stamp + count after the client's `seen` map (client-side state, like read-state). */
  channelActivity?: (seen: Record<string, number>) => Record<string, { latest: number; unread: number }>;
  /** Search: `scope` "messages" (DMs + channel backlogs) or "transcripts" (the agents' claude jsonl);
   *  `agents` narrows the transcript pass. See src/search.ts. */
  search?: (q: string, scope: "messages" | "transcripts", agents: string[]) => Promise<SearchPayload>;
  /** One channel's traffic. Optional for the same reason; without it `/api/channel/<name>` fail-louds
   *  rather than answering with an empty list that reads as a quiet channel. */
  channel?: (name: string, limit: number) => Promise<ChannelPayload>;
  /** Run a shell command in an agent's folder (`!cmd` from the composer). OPTIONAL so a server can be
   *  stood up without the capability at all — without it the route answers 501 rather than pretending. */
  bash?: (agent: string, command: string) => Promise<{ command: string; cwd: string; output: string; code: number | null; timedOut: boolean }>;
  /** The village snapshot: DM edges + last-spoken lines (see Village). OPTIONAL — a server without it
   *  answers 501 and the Village tab renders stations from status alone, no wires. */
  village?: () => VillageData;
  clientRoot?: string;
}

export interface WebServer {
  port: number;
  /** Push one frame to every open socket. The caller decides what is worth pushing; this half only
   *  knows how to deliver it. */
  broadcast(payload: unknown): void;
  close(): Promise<void>;
}

/**
 * Bind the http+ws server on 127.0.0.1 and serve `deps` through it.
 *
 * THROWS on a busy port and never picks another. Auto-incrementing is the failure that looks like
 * success: the operator opens the port they asked for, finds this morning's stale daemon, and debugs
 * the wrong process. A port is a value, and paw does not fabricate a fallback value.
 */
export async function startWebServer(deps: WebDeps): Promise<WebServer> {
  const { port, space, convo, status, trace, dm, post, bash } = deps;
  const clientRoot = deps.clientRoot ?? findClientRoot();
  const sockets = new Set<Socket>();
  /** Paths this daemon wrote for the operator (see /api/upload) — servable without waiting for the
   *  mesh echo that would otherwise be the only evidence. */
  const uploaded = new Set<string>();
  /** The newest status frame, replayed to a socket the moment it connects so a freshly-opened tab
   *  renders populated instead of blank-until-the-next-tick. */
  let lastStatus: unknown;

  const http: Server = createServer((req, res: ServerResponse) => {
    void (async () => {
      try {
        if (!allowedHost(req.headers.host, port)) return sendJson(res, 403, { error: "paw: this server answers on loopback only" });
        if (!allowedOrigin(req.headers.origin, port)) return sendJson(res, 403, { error: "paw: cross-origin request refused" });

        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const path = url.pathname;

        if (path === "/api/status") {
          const { rows, errors } = await status();
          // rows and errors travel TOGETHER: an error means some agent's inbox lag is unknown, and a
          // client given the rows alone would render "—" as though it were a measured zero.
          // `channels` is present only when a source is configured — see WebDeps.channels.
          return sendJson(res, 200, { space, rows, errors, ...(deps.channels ? { channels: deps.channels() } : {}), ...(deps.channelMembers ? { channelMembers: deps.channelMembers() } : {}) });
        }

        if (path === "/api/village") {
          if (!deps.village) return sendJson(res, 501, { error: "paw: this server was started without the village tracker" });
          return sendJson(res, 200, deps.village());
        }

        if (path.startsWith("/api/channel/") && req.method !== "POST") {
          const name = decodeURIComponent(path.slice("/api/channel/".length)).replace(/^#/, "");
          if (!name) return sendJson(res, 400, { error: "paw: channel needs a name" });
          if (!deps.channel) return sendJson(res, 501, { error: "paw: this server was started without a channel reader" });
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam === null ? INBOX_DEFAULT_LIMIT : Number(limitParam);
          if (!Number.isInteger(limit) || limit < 1) return sendJson(res, 400, { error: "paw: limit needs a positive integer" });
          return sendJson(res, 200, await deps.channel(name, limit));
        }

        if (path === "/api/inbox") {
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam === null ? INBOX_DEFAULT_LIMIT : Number(limitParam);
          if (!Number.isInteger(limit) || limit < 1) return sendJson(res, 400, { error: "paw: limit needs a positive integer" });
          const all = convo.entries();
          // The default is your INBOX; `sent=1` widens to both directions, which is what a chat needs —
          // a transcript of only the other side is half a conversation.
          const messages = (url.searchParams.get("sent") === "1" ? all : all.filter((e) => e.dir !== "out")).slice(-limit);
          const cursor = webCursor(space);
          // `unread` counts the WHOLE conversation, not the page just sliced: a count that shrank
          // because the client asked for fewer messages would be a different number for every caller,
          // which is precisely the disagreement computing it server-side exists to prevent.
          return sendJson(res, 200, { space, cursor, messages, unread: unreadCount(all, cursor) });
        }

        // Take an image the operator dropped or pasted into the page and put it where an AGENT can
        // read it.
        //
        // paw's attachment convention is a `📷 [Image #N] <absolute path>` line in the message text —
        // the bytes never cross the mesh, the agent opens the path with Read. A browser has bytes and
        // no path, so this is the step that gives them one, writing into the same staging directory
        // `paw chat` and `paw dm` already use (src/images.ts) rather than inventing a second place.
        //
        // Bounded deliberately: image types only, a size cap, and a GENERATED name — the client never
        // chooses where this lands, so a hostile filename has nothing to steer.
        if (path === "/api/upload" && req.method === "POST") {
          const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          const ext = Object.entries(IMAGE_TYPES).find(([, mime]) => mime === type)?.[0];
          if (!ext) return sendJson(res, 415, { error: "paw: only image uploads are accepted" });
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) {
            size += (c as Buffer).length;
            if (size > FILE_CAP) return sendJson(res, 413, { error: `paw: image larger than ${FILE_CAP} bytes` });
            chunks.push(c as Buffer);
          }
          if (!size) return sendJson(res, 400, { error: "paw: empty upload" });
          const dir = imagesDir(space);
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `web-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`);
          writeFileSync(file, Buffer.concat(chunks));
          // Servable IMMEDIATELY, without waiting for the message to come back round the mesh.
          // The allowlist is otherwise "a path this conversation mentions", and an image you just
          // uploaded is only mentioned once your own send has echoed through the tap — a second or
          // two later. In that window the picture you just attached 403s in your own chat, and an
          // agent that fetches it gets told it was never sent to it. We wrote the file; that is
          // better evidence than the echo.
          uploaded.add(file);
          return sendJson(res, 200, { path: file, bytes: size });
        }

        // Serve a file an agent attached — but ONLY one this conversation actually mentions.
        //
        // paw's attachment convention carries an ABSOLUTE local path in the message text (see
        // src/images.ts on why the carrier is text and not a data part). A browser can't open a
        // `file://` from an http page, so the daemon has to hand the bytes over — and a localhost
        // endpoint that serves any absolute path on request is a file-disclosure hole, no matter how
        // narrow the origin checks are.
        //
        // So the ALLOWLIST IS THE CONVERSATION: a path is servable only if it literally appears in a
        // message in the human's own DM stream. That needs no new trust and no new configuration —
        // the operator already received the path — and it cannot be widened by asking differently,
        // because the check is "did someone send you this", not "does it look safe".
        if (path === "/api/file") {
          const want = url.searchParams.get("path");
          if (!want) return sendJson(res, 400, { error: "paw: /api/file needs a path" });
          const mentioned = uploaded.has(want) || convo.entries().some((e) => e.text.includes(want));
          if (!mentioned) return sendJson(res, 403, { error: "paw: that path was never sent to you — only attachments in your conversation are served" });
          const type = IMAGE_TYPES[extname(want).toLowerCase()];
          // Only image types claude's own Read can render. Serving arbitrary bytes back as a download
          // would turn a chat pane into a file browser, which is not what was asked for.
          if (!type) return sendJson(res, 415, { error: "paw: only image attachments are served" });
          let stat;
          try {
            stat = statSync(want);
          } catch {
            return sendJson(res, 404, { error: "paw: that attachment is no longer on disk" });
          }
          if (stat.size > FILE_CAP) return sendJson(res, 413, { error: `paw: attachment is larger than ${FILE_CAP} bytes` });
          res.writeHead(200, { "content-type": type, "content-length": String(stat.size), "cache-control": "no-store" });
          return void res.end(readFileSync(want));
        }

        // The PR for ONE agent's branch. Deliberately its own endpoint rather than a field on the
        // status rows: `gh pr view` is a network call, and putting it in the roster payload would mean
        // one call per agent on every poll — 38 requests to GitHub every few seconds for a decoration.
        // The client asks only for the agent whose header is on screen.
        if (path.startsWith("/api/pr/")) {
          const name = decodeURIComponent(path.slice("/api/pr/".length));
          if (!name) return sendJson(res, 400, { error: "paw: pr needs an agent name" });
          const folder = folderForName(space, name);
          if (!folder) return sendJson(res, 404, { error: `paw: no agent "${name}" is registered` });
          // A missing PR, a missing `gh`, and an unauthenticated `gh` are the same answer to the UI —
          // there is nothing to link to — so `pr: null` rather than an error the header would render.
          return sendJson(res, 200, { name, pr: prInfo(folder) ?? null });
        }

        // Every open PR across the agents that are actually RUNNING. One endpoint, asked for rarely:
        // each entry is a `gh` network call, so this leans entirely on git.ts's 60s cache (which caches
        // MISSES too — the common case is an agent whose branch has no PR, and re-asking GitHub about
        // those on every sweep is exactly the traffic worth avoiding).
        //
        // LIVE agents only, which is what "active agents' cwds" means: a stopped agent's branch is not
        // work in progress, and including 40 of them would turn a decoration into a rate limit.
        if (path === "/api/tasks") {
          // The fleet's shared task list (bd's machine-wide db — the same one every agent's BEADS_DIR
          // pins). GET lists open work; POST files a task from the composer. Errors pass through
          // verbatim: "bd: command not found" is a real answer the operator can act on, an empty list
          // is not.
          try {
            if (req.method === "POST") {
              let body: { op?: unknown; id?: unknown; title?: unknown; description?: unknown; status?: unknown; reason?: unknown; parent?: unknown; text?: unknown; assignee?: unknown };
              try {
                body = JSON.parse(await readBody(req)) as typeof body;
              } catch {
                return sendJson(res, 400, { error: "paw: body must be JSON" });
              }
              const op = typeof body.op === "string" ? body.op : "create"; // bare {title} stays a create (the /task command)
              const id = typeof body.id === "string" ? body.id.trim() : "";
              const title = typeof body.title === "string" ? body.title.trim() : "";
              const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : undefined;
              const parent = typeof body.parent === "string" ? body.parent : undefined; // "" is meaningful: it clears the parent
              const assignee = typeof body.assignee === "string" && body.assignee.trim() ? body.assignee.trim() : undefined;
              if (op === "create") {
                if (!title) return sendJson(res, 400, { error: "paw: a task needs a title" });
                const newId = await createTaskGetId(title, description, parent || undefined, assignee);
                // The /task composer path still wants the fresh list; the pad only needs the id.
                const wantList = body.op === undefined; // bare {title} = the composer command
                return sendJson(res, 200, wantList ? { id: newId, tasks: await listTasks() } : { id: newId });
              }
              if (!id) return sendJson(res, 400, { error: `paw: op "${op}" needs an id` });
              if (op === "update") {
                const status = typeof body.status === "string" && body.status.trim() ? body.status.trim() : undefined;
                await updateTask(id, { title: title || undefined, description, status, parent, assignee });
                return sendJson(res, 200, { ok: true }); // no re-list: a write already costs a dolt engine boot, and the pad's DOM is the truth mid-edit
              }
              if (op === "comments") return sendJson(res, 200, { comments: await listComments(id) });
              if (op === "comment") {
                const text = typeof body.text === "string" ? body.text.trim() : "";
                if (!text) return sendJson(res, 400, { error: "paw: a comment needs text" });
                await commentTask(id, text);
                return sendJson(res, 200, { ok: true });
              }
              if (op === "close") {
                await closeTask(id, typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined);
                return sendJson(res, 200, { ok: true });
              }
              return sendJson(res, 400, { error: `paw: unknown op "${op}"` });
            }
            return sendJson(res, 200, { tasks: await listTasks() });
          } catch (e) {
            return sendJson(res, 502, { error: (e as Error).message });
          }
        }

        if (path === "/api/prs") {
          const rows = ((await deps.status()).rows as AgentStatus[]).filter((r) => r.live && !!r.folder);
          // EVERY worktree of each live agent's repo, not just the folder the agent sits in (operator's
          // ask, 2026-08-27): an agent's work is its repo's branches, and those live in sibling
          // worktrees. A plain folder (not a repo) contributes nothing.
          const targets = expandAgentWorktrees(rows, { toplevel: gitToplevel, worktrees: (root) => listWorktrees(root).map((x) => x.path) });
          const byFolder = await prInfoMany(targets.map((t) => t.folder));
          const ownFolders = new Set(rows.map((r) => r.folder));
          const agentPrs = targets
            .map((r) => ({ agent: r.agent, folder: r.folder, pr: byFolder.get(r.folder), task: undefined as string | undefined }))
            .filter((x): x is { agent: string; folder: string; pr: NonNullable<ReturnType<typeof prInfo>>; task: undefined } => x.pr !== undefined)
            .filter((x) => keepSidebarPr(x.pr.state, ownFolders.has(x.folder)));
          // PR-type beads join the same section (operator's ask, 2026-08-26): a review someone filed
          // as a task IS work in progress on a PR. Deduped by url — an agent's folder PR that also has
          // a review bead shows once, keeping the bead id (the richer row).
          let taskPrs: ReturnType<typeof taskPrRows> = [];
          try {
            taskPrs = taskPrRows(await listTasks());
          } catch {
            /* bd unavailable → the agents' PRs still render */
          }
          const seen = new Set(taskPrs.map((x) => x.pr.url));
          const prs = [...taskPrs, ...agentPrs.filter((x) => !seen.has(x.pr.url))]
            // Newest PR first: the number IS the chronology, and an agent list order would put the
            // thing you opened five minutes ago wherever its name happens to sort.
            .sort((a, b) => b.pr.number - a.pr.number);
          return sendJson(res, 200, { prs });
        }

        if (path === "/api/channel-unread") {
          if (req.method !== "POST") return sendJson(res, 405, { error: "paw: /api/channel-unread is POST {seen}" });
          if (!deps.channelActivity) return sendJson(res, 404, { error: "paw: channel activity is not wired on this daemon" });
          let body: { seen?: unknown };
          try { body = JSON.parse(await readBody(req)) as { seen?: unknown }; } catch { return sendJson(res, 400, { error: "paw: body must be JSON {seen}" }); }
          const seen: Record<string, number> = {};
          if (body.seen && typeof body.seen === "object") for (const [k, v] of Object.entries(body.seen as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) seen[k] = v;
          return sendJson(res, 200, { activity: deps.channelActivity(seen) });
        }

        if (path === "/api/search") {
          if (!deps.search) return sendJson(res, 404, { error: "paw: search is not wired on this daemon" });
          const q = (url.searchParams.get("q") ?? "").trim();
          if (!q) return sendJson(res, 400, { error: "paw: search needs q" });
          const scope = url.searchParams.get("scope") === "transcripts" ? "transcripts" : "messages";
          const agents = (url.searchParams.get("agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          try {
            return sendJson(res, 200, await deps.search(q, scope, agents));
          } catch (e) {
            return sendJson(res, 500, { error: (e as Error).message });
          }
        }

        if (path.startsWith("/api/trace/")) {
          const name = decodeURIComponent(path.slice("/api/trace/".length));
          if (!name) return sendJson(res, 400, { error: "paw: trace needs an agent name" });
          const bytesParam = url.searchParams.get("bytes");
          const bytes = bytesParam === null ? TRACE_TAIL_BYTES : Number(bytesParam);
          if (!Number.isInteger(bytes) || bytes < 1) return sendJson(res, 400, { error: "paw: bytes needs a positive integer" });
          const tailParam = url.searchParams.get("tail");
          const tail = tailParam === null ? TRACE_DEFAULT_BLOCKS : Number(tailParam);
          if (!Number.isInteger(tail) || tail < 1) return sendJson(res, 400, { error: "paw: tail needs a positive integer" });
          try {
            const blocks = trace(name, tail, bytes);
            // `readAt` is not decoration. A trace is a SNAPSHOT and the socket pushes only `message`
            // and `status`, so this pane ages silently while the agent keeps working — and a stale
            // pane that looks live is worse than no pane, because the reader trusts it. Stamping the
            // read lets the client say "as of 19:44" instead of implying "now". (Live deltas are the
            // refcounted tailer, phase 3; this is the honest interim.)
            return sendJson(res, 200, { name, blocks, readAt: Date.now() });
          } catch (e) {
            // "no such agent" / "pinned but no transcript yet" are real answers ABOUT this agent, not
            // server faults — pass the message through verbatim so the UI shows what paw would say.
            // Never an empty block list: that reads as a quiet agent, which is a different fact.
            return sendJson(res, 404, { error: (e as Error).message });
          }
        }

        if (path === "/api/read") {
          if (req.method !== "POST") return sendJson(res, 405, { error: "paw: /api/read is POST — marking mail read is not something a link can do" });
          let body: { ts?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as { ts?: unknown };
          } catch {
            return sendJson(res, 400, { error: "paw: body must be JSON {ts}" });
          }
          const ts = body.ts;
          // Rejected rather than coerced: `advanceCursor` silently no-ops on NaN, so a bad `ts` would
          // leave the badge stuck with no error anywhere — the exact class of failure this endpoint is
          // being added to fix.
          if (typeof ts !== "number" || !Number.isFinite(ts)) {
            return sendJson(res, 400, { error: "paw: {ts} must be a finite epoch-ms number — the newest message you DISPLAYED" });
          }
          // The ceiling stops a client marking to the WALL CLOCK, which would swallow a message that
          // arrived between the render and this request. A legitimate caller cannot trip it: every ts
          // it could have displayed came from this server, so it is never ahead of what the server
          // knows. (Skipped while the conversation is empty — nothing to be ahead of.)
          const newest = convo.entries().reduce((max, e) => (e.ts > max ? e.ts : max), Number.NEGATIVE_INFINITY);
          if (Number.isFinite(newest) && ts > newest) {
            return sendJson(res, 400, {
              error: `paw: {ts} ${ts} is ahead of the newest message paw knows about (${newest}) — mark to the newest DISPLAYED message's ts, not the clock`,
            });
          }
          // FORWARD-ONLY, and BOTH cursors: the browser's own (what this surface has shown) and the
          // shared one (reading is reading, wherever you did it — so `paw inbox` won't re-surface what
          // you just read here). advanceCursor refuses to rewind, so two tabs racing cannot un-read.
          advanceCursor(space, ts, WEB_CURSOR);
          advanceCursor(space, ts);
          // The RESULTING cursor, so the client re-syncs from the server instead of assuming its write
          // landed — it may not have, if another surface was already further ahead.
          return sendJson(res, 200, { cursor: readCursor(space, WEB_CURSOR) });
        }

        // Post to a channel. There is no "create a channel" on cotal — a channel exists because
        // something posted to it, so this endpoint is both the send AND the create, and the UI's
        // "new channel" is just this with a name nobody has used yet.
        if (path.startsWith("/api/channel/") && req.method === "POST") {
          const channel = decodeURIComponent(path.slice("/api/channel/".length)).replace(/^#/, "");
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(channel))
            return sendJson(res, 400, { error: "paw: a channel name is letters, digits, dash or underscore" });
          let body: { text?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as { text?: unknown };
          } catch {
            return sendJson(res, 400, { error: "paw: body must be JSON {text}" });
          }
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return sendJson(res, 400, { error: "paw: nothing to post" });
          if (!post) return sendJson(res, 501, { error: "paw: this server was built without a channel sender" });
          try {
            await post(channel, text);
            return sendJson(res, 200, { channel });
          } catch (e) {
            return sendJson(res, 502, { error: (e as Error).message });
          }
        }

        if (path === "/api/bash") {
          if (req.method !== "POST") return sendJson(res, 405, { error: "paw: /api/bash is POST — running a command is not something a link can do" });
          let body: { agent?: unknown; command?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as { agent?: unknown; command?: unknown };
          } catch {
            return sendJson(res, 400, { error: "paw: body must be JSON {agent, command}" });
          }
          const agent = typeof body.agent === "string" ? body.agent.trim() : "";
          const command = typeof body.command === "string" ? body.command.trim() : "";
          if (!agent || !command) return sendJson(res, 400, { error: "paw: {agent, command} are both required" });
          if (!bash) return sendJson(res, 501, { error: "paw: this server was built without a command runner" });
          try {
            // Run it, then TELL THE AGENT — the point of `!` is that the answer becomes the agent's
            // context, not that a browser gets a terminal. The result still comes back either way, so a
            // command whose delivery fails is not also lost to the operator who ran it.
            const result = await bash(agent, command);
            let delivered = true;
            try {
              await dm(agent, bashMessage(result));
            } catch {
              delivered = false;
            }
            return sendJson(res, 200, { ...result, delivered });
          } catch (e) {
            return sendJson(res, 400, { error: (e as Error).message });
          }
        }

        if (path === "/api/invite") {
          if (req.method !== "POST") return sendJson(res, 405, { error: "paw: /api/invite is POST — an invite is not something a link can do" });
          let body: { channel?: unknown; names?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as { channel?: unknown; names?: unknown };
          } catch {
            return sendJson(res, 400, { error: "paw: body must be JSON {channel, names}" });
          }
          const channel = typeof body.channel === "string" ? body.channel.trim().replace(/^#/, "") : "";
          const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string" && n.trim() !== "") : [];
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(channel))
            return sendJson(res, 400, { error: "paw: a channel name is letters, digits, dash or underscore" });
          if (!names.length) return sendJson(res, 400, { error: "paw: {names} must list at least one agent" });
          if (!post) return sendJson(res, 501, { error: "paw: this server was built without a channel sender" });

          // Sequential, not Promise.all: each DM may SPAWN a sleeping agent, and firing a dozen cold
          // starts at once is how the manager gets a thundering herd for a decoration.
          const invited: string[] = [];
          const failed: { name: string; error: string }[] = [];
          for (const name of names) {
            try {
              await dm(name, inviteText(channel));
              invited.push(name);
            } catch (e) {
              // One unreachable agent must not lose the others — an invite to four agents where the
              // third is gone should still reach the fourth, and say so.
              failed.push({ name, error: (e as Error).message });
            }
          }
          // Record the ask in the channel itself, so the channel shows what was requested rather than
          // the invite being invisible until (or unless) an agent acts on it. Only the ones actually
          // reached: naming an agent we could not DM would claim something that did not happen.
          if (invited.length) {
            try {
              await post(channel, `invited ${invited.map((n) => "@" + n).join(", ")} to this channel`);
            } catch {
              /* the DMs are what matter; a failed notice must not turn a delivered invite into an error */
            }
          }
          return sendJson(res, 200, { channel, invited, failed });
        }

        if (path === "/api/dm") {
          if (req.method !== "POST") return sendJson(res, 405, { error: "paw: /api/dm is POST — a send is not something a link can do" });
          let body: { to?: unknown; text?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as { to?: unknown; text?: unknown };
          } catch {
            return sendJson(res, 400, { error: "paw: body must be JSON {to, text}" });
          }
          const to = typeof body.to === "string" ? body.to.trim() : "";
          const text = typeof body.text === "string" ? body.text : "";
          if (!to || !text.trim()) return sendJson(res, 400, { error: "paw: {to, text} are both required" });
          try {
            const result = await dm(to, text);
            // `name` is the RESOLVED agent — a folder path and a worktree handle both land here, and
            // only the send path knows which agent they became. Echoed back unresolved it would be a
            // guess, so it is reported only when the sender actually returned one.
            return sendJson(res, 200, result?.name ? { ok: true, name: result.name } : { ok: true });
          } catch (e) {
            return sendJson(res, 400, { error: (e as Error).message });
          }
        }

        if (path.startsWith("/api/")) return sendJson(res, 404, { error: `paw: no such endpoint "${path}"` });
        return serveStatic(clientRoot, path, res);
      } catch (e) {
        console.error(c.red("! " + (e as Error).message));
        if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
        else res.end();
      }
    })();
  });

  http.on("upgrade", (req, socket: Socket, head: Buffer) => {
    const refuse = (line: string): void => void socket.end(`HTTP/1.1 ${line}\r\nconnection: close\r\n\r\n`);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/ws") return refuse("404 Not Found");
    // The same two checks as the http side, because CORS does not cover a WebSocket handshake — the
    // browser completes it and hands the page a live feed of everything unless the server refuses.
    if (!allowedHost(req.headers.host, port) || !allowedOrigin(req.headers.origin, port)) return refuse("403 Forbidden");
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return refuse("400 Bad Request");

    const accept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);

    let pending: Buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = readClientFrames(Buffer.concat([pending, chunk]), socket);
    });
    const drop = (): void => void sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
    sockets.add(socket);
    if (lastStatus !== undefined) socket.write(textFrame(JSON.stringify(lastStatus)));
  });

  await new Promise<void>((ready, fail) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      if (e.code === "EADDRINUSE") {
        fail(
          new Error(
            `paw: port ${port} is already in use — another \`paw web\` is probably running (\`paw web --port N\` picks another). Note 7799 is \`cotal web\`, not this.`,
          ),
        );
      } else fail(e);
    };
    http.once("error", onError);
    http.listen(port, "127.0.0.1", () => {
      http.removeListener("error", onError);
      ready();
    });
  });

  return {
    port,
    /**
     * BOUNDED, not buffered: node queues writes for a socket that has stopped reading until the process
     * runs out of memory, and the reader that stops reading is a laptop that closed its lid. A socket
     * past the cap is destroyed — the client reconnects and re-reads `/api/inbox`, which is the
     * authoritative history anyway. Dropping it loudly beats holding the whole feed for a dead tab.
     */
    broadcast(payload: unknown): void {
      // The cursor is stamped HERE, at send time, on any status frame — not by whoever composed it.
      //
      // Two reasons, and the second is the one that bites. (1) Composition happens outside this
      // function, so a contract living there is outside the tested seam and would regress unnoticed.
      // (2) `lastStatus` is replayed VERBATIM to every newly-connected socket, so a tab opening late in
      // a tick would receive a cursor up to STATUS_MS old — the "badge for mail already read" case
      // arriving through the replay path. A client applying cursors forward-only survives that, but
      // then the server is knowingly emitting a stale number and relying on every future client to
      // discard it. Stamping at send time makes the replayed frame TRUE rather than merely survivable.
      if ((payload as { type?: string })?.type === "status") {
        // `channels` is stamped here for the same reason `cursor` is: composed at the call site it
        // would sit outside the tested seam AND go stale in the frame replayed to a late-joining
        // socket. Both are cheap local reads, so send time is the right time. Omitted, never `[]`,
        // when no source is configured.
        payload = { ...(payload as Record<string, unknown>), cursor: webCursor(space), ...(deps.channels ? { channels: deps.channels() } : {}), ...(deps.channelMembers ? { channelMembers: deps.channelMembers() } : {}) };
        lastStatus = payload;
      }
      const frame = textFrame(JSON.stringify(payload));
      for (const s of sockets) {
        if (s.destroyed) {
          sockets.delete(s);
          continue;
        }
        if (s.writableLength > SOCKET_BACKLOG_CAP) {
          console.error(c.red(`! dropping a websocket client that stopped reading (${s.writableLength} bytes queued)`));
          sockets.delete(s);
          s.destroy();
          continue;
        }
        s.write(frame);
      }
    },
    async close(): Promise<void> {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

/* ── the command ──────────────────────────────────────────────────────────────────────────────── */

async function web(argv: string[]): Promise<void> {
  // BEFORE anything else, and before the mesh is touched: under bun this process cannot serve a
  // WebSocket at all (node:http never emits `upgrade`), so hand the whole command to node+tsx and
  // become a passthrough. Parse-then-reexec would do the work twice; ensure() twice would be worse.
  if (reexecUnderNode(["web", ...argv])) return;
  const { port, space: spaceArg, server: serverArg, open } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  // Self-ensuring (like `paw start`/`paw global`) rather than sitting in bin's NEEDS_* gating: this is
  // a long-lived server and it needs BOTH — the mesh for the observer, the manager for the roster.
  const { server: ensured } = await ensure({ needMesh: true, needManager: true, space });
  const server = serverArg ?? ensured ?? DEFAULT_SERVER;

  // watchPresence:true only to name DM RECIPIENTS: a unicast carries the sender's name but the
  // recipient's bare id. Still never registers presence and never consumes — see src/feed.ts.
  const ep = await observerEndpoint(space, server, { watchPresence: true });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();

  const convo = new Conversation(ep);
  const channels = new Channels();
  const village = new Village(ep.card.id);
  /** Whether this mesh is AUTHED. Read once at startup because it decides how to interpret an empty
   *  channel backlog — see {@link channelMessages}. */
  const authed = (await controlCreds(space)) !== undefined;
  /** The last successful roster collect. A FAILED refresh keeps these rows and SAYS so — replacing them
   *  with `[]` renders as "no agents" (a dead mesh), and serving them silently renders stale as live.
   *  Never let a reader mistake old data for current data. */
  let rows: AgentStatus[] = [];
  let errors: string[] = [];
  let collectedAt = 0;
  /** Channel names for the sidebar, refreshed on the roster tick. The REGISTRY view (`listChannels`,
   *  which works on an observer endpoint) unioned with what the tap has actually seen: the registry
   *  knows configured-but-quiet channels, the tap knows ones created since the last refresh, and
   *  neither is complete on its own. Sorted by traffic then name so the sidebar has a stable, useful
   *  order — the payload is a bare `string[]`, so the client cannot re-derive one. */
  let channelNames: string[] = [];
  const authorsScanned = new Set<string>();
  const refreshStatus = async (): Promise<void> => {
    // One resolved control handle for the daemon's lifetime (see sharedManagerControl): re-resolving
    // per poll recompiled every contract validator each tick and spammed cotal's schema advisory.
    // A failed refresh drops the handle too: `stale` covers what the handle can classify, this
    // covers what it cannot — the daemon must never sit on one resolved handle through a day of
    // refusals (2026-09-08: epoch 45 → 46, rows frozen at 10:02 AM for nine hours).
    let fresh: Awaited<ReturnType<typeof collectStatus>>;
    try {
      fresh = await collectStatus(space, await sharedManagerControl(space, server));
    } catch (e) {
      await dropSharedManagerControl(space, server);
      throw e;
    }
    rows = fresh.rows;
    errors = fresh.errors;
    collectedAt = Date.now();
    try {
      const listed = await ep.listChannels();
      const ranked = new Map(listed.map((ch) => [ch.channel, ch.messages ?? 0]));
      for (const name of channels.seen()) if (!ranked.has(name)) ranked.set(name, 0);
      channelNames = [...ranked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
      // Seed each channel's author set from its backlog ONCE; the tap keeps it current after that. A
      // channel that fails to read is retried next tick rather than marked scanned — silence here would
      // render as "nobody is in this channel", which is a claim, not an absence of data.
      for (const name of channelNames) {
        if (authorsScanned.has(name)) continue;
        try {
          const raw = await ep.channelHistory(name, { limit: FETCH_CAP });
          channels.noteAuthors(name, raw.filter((m) => m && m.from).map((m) => m.from.name));
          channels.noteStamps(name, raw.filter((m) => m && m.from).map((m) => m.ts));
          authorsScanned.add(name);
        } catch (e) {
          errors = [...errors, `paw: couldn't scan #${name} for members (${(e as Error).message})`];
        }
      }
    } catch (e) {
      // A channel list paw could not read is reported, not silently emptied — the previous list stands.
      errors = [...errors, `paw: couldn't list channels (${(e as Error).message})`];
    }
  };

  let served: WebServer | undefined;
  try {
    await convo.reconcile(); // the backlog, before the first client can ask for it
    served = await startWebServer({
      port,
      space,
      convo,
      // The poller's snapshot, not a fresh collect: a page refresh must not cost a control round-trip
      // per tab. Before the first tick lands, collect once so the first client sees real rows.
      status: async () => {
        if (!collectedAt) await refreshStatus();
        return { rows, errors };
      },
      trace: (name, tail, bytes) => traceBlocks(space, name, tail, bytes),
      dm: (to, text) => sendAsYou({ space, server, target: to, text }),
      // The observer endpoint publishes; posting needs no consumer, so this does not touch the durable.
      post: async (channel, text) => { await ep.multicast(text, { channel }); },
      channels: () => channelNames,
      channelMembers: () => channels.members(),
      village: () => village.snapshot(),
      channelActivity: (seen) => channels.activity(seen),
      channel: (name, limit) => channelMessages(ep, channels, name, limit, authed),
      search: async (q, scope, agents) => {
        const errors: string[] = [];
        if (scope === "messages") {
          const messages = searchEntries(convo.entries(), q);
          // Channel backlogs are read per channel; a channel that refuses stays an error line, not silence.
          for (const name of channelNames) {
            try {
              const { messages: ms, historyError } = await channelMessages(ep, channels, name, FETCH_CAP, authed);
              if (historyError) errors.push(historyError);
              for (const m of ms) {
                if (!m.text.toLowerCase().includes(q.toLowerCase())) continue;
                messages.push({ kind: "channel", target: name, from: m.from, ts: m.ts, snippet: snippet(m.text, q) });
              }
            } catch (e) {
              errors.push(`paw: couldn't search #${name} (${(e as Error).message})`);
            }
          }
          messages.sort((a, b) => b.ts - a.ts);
          return { q, messages: messages.slice(0, 300), transcripts: [], truncated: messages.length > 300, errors };
        }
        // Transcripts: one time budget across the chosen agents, so one huge file can't starve the rest.
        const names = agents.length ? agents : rows.map((r) => r.name);
        const deadline = Date.now() + 12_000;
        const transcripts: TranscriptHit[] = [];
        let truncated = false;
        for (const name of names) {
          const file = transcriptFileFor(space, name);
          if (!file) continue;
          const r = await searchTranscript(file, q, 20, deadline);
          if (r.error) errors.push(`paw: ${name}: ${r.error}`);
          if (r.truncated) truncated = true;
          for (const h of r.hits) transcripts.push({ ...h, agent: name });
          if (Date.now() > deadline) { truncated = true; break; }
        }
        transcripts.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
        return { q, messages: [], transcripts, truncated, errors };
      },
      // `!cmd` runs in the AGENT'S folder — the whole point is that the answer is about the thing that
      // agent is working on. An unregistered name fails loud rather than falling back to some default
      // directory, which would run the command somewhere the operator never named.
      bash: async (agent, command) => {
        const cwd = folderForName(space, agent);
        if (!cwd) throw new Error(`paw: no agent named "${agent}" — \`paw status\` lists them`);
        if (!existsSync(cwd)) throw new Error(`paw: "${agent}" is registered at ${cwd}, which no longer exists`);
        return runBash(command, cwd);
      },
    });
  } catch (e) {
    await ep.stop().catch(() => {});
    throw e;
  }
  const push = served;

  // Live path: instant, ephemeral, non-contending — and wrapped, because core does not try/catch this
  // handler and one throw would kill the feed for the life of the process.
  ep.tap((_subject, m) => {
    try {
      // TWO admitters, one frame. Each answers its own question and neither can widen the other: a DM
      // can never be a channel message, so at most one of these returns an entry. The channel entry
      // carries `channel`, which is how the client routes it — and what keeps it out of `unreadCount`.
      const dmEntry = convo.accept(m);
      if (dmEntry) push.broadcast({ type: "message", entry: dmEntry });
      const chEntry = channels.accept(m);
      if (chEntry) push.broadcast({ type: "message", entry: chEntry });
      village.note(m); // record DM edges + last-spoken lines for the Village view
    } catch (e) {
      console.error(c.red("! " + (e as Error).message));
    }
  });

  const stopReconcile = pollLoop(
    async () => {
      await convo.reconcile();
      // Seed the hover line for any agent that has DM'd you (edges stay live-tap-only so a re-read
      // can't inflate a count; `last` is idempotent — newer stamp wins).
      for (const e of convo.entries()) if (e.dir === "in" && e.from) village.seedLast(e.from, e.text, e.ts);
    },
    RECONCILE_MS,
    (e) => console.error(c.red("! conversation re-read failed: " + e.message)),
  );
  /**
   * The roster tick. It does NOT compose the read cursor — `broadcast` stamps that onto every status
   * frame at send time, which is both inside the tested seam and correct for the replay path.
   *
   * Nothing here passes a `cursor`, deliberately: a value composed here would be silently overwritten
   * a moment later, and a field two places appear to decide is a field the next person changes in the
   * wrong one. The cursor rides the status frame at all (rather than a `{type:"cursor"}` frame of its
   * own) because tab A marking mail read must reach tab B, and a THIRD frame type would break every
   * client and check that reasonably assumes there are two.
   */
  const stopStatus = pollLoop(
    async () => {
      await refreshStatus();
      push.broadcast({ type: "status", rows, errors });
    },
    STATUS_MS,
    (e) => {
      const note = `paw: roster refresh failed (${e.message})${collectedAt ? ` — rows are from ${new Date(collectedAt).toLocaleTimeString()}` : ""}`;
      console.error(c.red("! " + note));
      push.broadcast({ type: "status", rows, errors: [...errors, note] });
    },
  );

  const url = `http://127.0.0.1:${port}`;
  console.log(`${c.bold("paw web")} ${c.dim("·")} ${c.cyan(url)} ${c.dim(`· space "${space}" · Ctrl-C to stop`)}`);
  if (!findClientRoot()) console.log(c.dim("no client bundle at web/app/ yet — the API is live, the UI 503s until it's built"));
  if (open) {
    try {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    } catch {
      // Failing to launch a browser is not a reason to take the server down — the URL is printed above.
      console.log(c.dim(`(couldn't launch a browser — open ${url} yourself)`));
    }
  }

  try {
    await new Promise<void>(() => {}); // park; Ctrl-C exits the process
  } finally {
    stopReconcile();
    stopStatus();
    await push.close();
    await ep.stop().catch(() => {});
  }
}

const webCommand: Command = {
  kind: "command",
  name: "web",
  group: "Mesh",
  summary: "serve the mesh in a browser — agent roster, live DMs, a composer and agent traces (localhost only)",
  usage: "web [--port N] [--space s] [--server url] [--no-open]   (default port 7788; 7799 is `cotal web`)",
  run: (a) => web([...a.raw]),
};

registry.register(webCommand);

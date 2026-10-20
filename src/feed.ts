/**
 * The shared read path: how paw looks at the mesh on the human's behalf.
 *
 * WHY THIS EXISTS: `paw inbox`, `paw inbox --watch`, `paw chat`, `paw watch` and `paw history` each
 * built their own connection and their own copy of "flatten a message, fetch the backlog, poll for
 * new ones". Five copies of one idea is five places to fix a bug and four places to forget. This
 * module owns the pieces that are genuinely the same, so a new surface (a web UI) is a consumer
 * rather than a sixth copy.
 *
 * It does NOT own `paw chat`'s connection. chat joins as a PARTICIPANT — it registers presence and
 * consumes, because it is a peer others must be able to reach — whereas everything here is an
 * OBSERVER that reads without ever binding a durable. Those are different things, and flattening
 * them into one "connection factory" would hide the distinction that matters most.
 */
import { CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { humanEndpointAuth, stableHumanId } from "./addressing.ts";
import { HUMAN_PEER, humanPeer } from "./names.ts";
import { cachedLedger } from "./peer-ledger.ts";

/** How deep to read a backlog. cotal's dmHistory returns the OLDEST N, so to surface the NEWEST we
 *  fetch up to this many and take the tail. Bounds the read on a busy mesh; a history deeper than this
 *  needs a tail-read API cotal doesn't expose yet (upstreamable). */
export const FETCH_CAP = 10_000;

/**
 * A message's text, as every paw surface renders it.
 *
 * THE ONE COPY. This flattener existed independently in chat.ts, inbox.ts, watch.ts and history.ts,
 * which is why paw's own notes warn that a new part kind would "silently vanish or leak JSON in three
 * of them". It also decides something load-bearing: a non-text part is JSON-stringified, which is
 * exactly why paw's image and paste attachments ride as TEXT rather than as a new part kind — an
 * extension kind flattens to the empty string here, i.e. simultaneously valid on the wire and
 * invisible on screen.
 */
export function messageText(m: CotalMessage): string {
  // cotal 0.25 widened MessagePart with shapes that carry no `data` (artifacts), so reaching for it
  // unconditionally no longer type-checks — and would have printed `undefined` for those. Read it only
  // where it exists and fall back to the WHOLE part, which at least shows what arrived rather than a
  // confident "undefined" standing in for content this build doesn't understand.
  return m.parts
    .map((p) => (p.kind === "text" ? p.text : JSON.stringify("data" in p ? (p as { data: unknown }).data : p)))
    .join(" ");
}

/**
 * Connect as "you", but only to LOOK.
 *
 * `registerPresence:false` — the mailbox beacon (src/mailbox.ts) holds "you" present; a reader
 * announcing itself would make presence flap every time you ran a command.
 * `consume:false` — never bind the durable inbox. Reading through `dmHistory` instead keeps every
 * observer free of the acking path, so none of them can interfere with a live `paw chat`.
 *
 * `watchPresence` is opt-in: a roster costs a subscription, and a one-shot backlog read has no use
 * for one.
 */
export async function observerEndpoint(space: string, server: string, opts: { watchPresence?: boolean } = {}): Promise<CotalEndpoint> {
  const humanAuth = await humanEndpointAuth(space, "admin");
  const creds = humanAuth.creds;
  const card = creds
    ? { name: humanPeer(space), kind: "endpoint" as const }
    : { name: humanPeer(space), kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...humanAuth,
    card,
    registerPresence: false,
    consume: false,
    watchPresence: opts.watchPresence === true,
  });
  return ep;
}

/** One message in the human's conversation, in the shape every surface renders. */
export interface Entry {
  from: string;
  text: string;
  ts: number;
  /** "in" = an agent DM'd you; "out" = you DM'd an agent. Only present when both directions were
   *  asked for, so the default payload keeps its shape. */
  dir?: "in" | "out";
  /** For an OUTGOING message, who it went to — the agent's NAME when the stream reveals it, else its
   *  raw id. Never a guess: an id you can still match on is honest, a wrong name is not. */
  to?: string;
}

/**
 * Read the DM stream. By default this is the INBOX — messages addressed to "you".
 *
 * `withSent` widens it to the whole conversation, both directions, which is what a chat UI needs: a
 * transcript of only the other side is half a conversation, and reopening one would lose everything
 * you had said. The recipient of an outgoing message is an ID on the wire, so names are resolved from
 * the stream itself (any agent you have talked to has almost certainly replied at some point, and its
 * reply carries `from.name`). An id that never appears as a sender stays an id — see {@link Entry.to}.
 */
export async function readConversation(ep: CotalEndpoint, opts: { withSent?: boolean } = {}): Promise<Entry[]> {
  const me = ep.card.id;
  const all = (await ep.dmHistory({ limit: FETCH_CAP })).map((m) => dmRow(m, me));
  return conversationEntries(all, me, ep.space, opts);
}

/** One DM-stream row reduced to what a conversation reads. `text` is flattened only for the human's
 *  own mail — an agent↔agent row is kept for its sender name, never rendered. */
export interface DmRow {
  id: string;
  ts: number;
  to?: string;
  from: { id?: string; name: string };
  text: string;
}

export function dmRow(m: CotalMessage, me: string): DmRow {
  const mine = m.to === me || m.from.id === me;
  return { id: m.id, ts: m.ts, to: m.to, from: { id: m.from.id, name: m.from.name }, text: mine ? messageText(m) : "" };
}

/** The human's conversation from DM rows — THE mapping {@link readConversation} and {@link DmWindow}
 *  share, so an incremental read cannot drift from a full one. */
export function conversationEntries(all: DmRow[], me: string, space: string, opts: { withSent?: boolean } = {}): Entry[] {
  if (!opts.withSent) {
    return all
      .filter((m) => m.to === me)
      .sort((a, b) => a.ts - b.ts)
      .map((m): Entry => ({ from: m.from.name, text: m.text, ts: m.ts }));
  }
  // The stream's own senders first, then paw's peer ledger (src/peer-ledger.ts), which also knows ids
  // that only ever RECEIVED — a restarted agent's previous incarnation, say. The plain name, no
  // "(old instance)": `to` is the conversation key every surface groups and filters on.
  const ledger = cachedLedger(space);
  const nameById = new Map<string, string>();
  for (const [id, e] of Object.entries(ledger)) nameById.set(id, e.name);
  for (const m of all) if (m.from.id && m.from.name) nameById.set(m.from.id, m.from.name);
  return all
    .filter((m) => m.to === me || m.from.id === me)
    .sort((a, b) => a.ts - b.ts)
    .map((m): Entry =>
      m.from.id === me
        ? { from: HUMAN_PEER, text: m.text, ts: m.ts, dir: "out", to: (m.to && nameById.get(m.to)) ?? m.to }
        : { from: m.from.name, text: m.text, ts: m.ts, dir: "in" },
    );
}

/** First page an incremental read asks for. A reconcile tick sees a handful of new DMs, not 64. */
const DM_WINDOW_FIRST_PAGE = 64;

/**
 * The newest {@link FETCH_CAP} rows of the DM stream, kept current by reading only what is NEW.
 *
 * A full `dmHistory(FETCH_CAP)` moved the whole backlog (~7.5k messages, RSS swinging 82–258MB) every
 * 30s to find the one or two that arrived. cotal returns the NEWEST `limit` rows, oldest-first, as one
 * contiguous window, and exposes no stream sequence publicly — so the cursor is message ids: read a
 * small page; if its OLDEST row is one already held, every unknown row in it is everything new. If not,
 * widen (×4) until it overlaps. Two answers are taken whole: a page SHORTER than asked is the stream's
 * entire content (cotal widens to the subject's first match before returning short), and reaching
 * FETCH_CAP is exactly the old full read. The first refresh is always that full read. A row without an
 * id cannot be placed and throws — never guessed into position.
 */
export class DmWindow {
  private rows: DmRow[] = [];
  private ids = new Set<string>();
  private loaded = false;
  private readonly read: (limit: number) => Promise<CotalMessage[]>;
  private readonly me: string;
  private readonly cap: number;
  private readonly firstPage: number;
  constructor(read: (limit: number) => Promise<CotalMessage[]>, me: string, cap = FETCH_CAP, firstPage = DM_WINDOW_FIRST_PAGE) {
    this.read = read;
    this.me = me;
    this.cap = cap;
    this.firstPage = firstPage;
  }

  all(): DmRow[] {
    return this.rows;
  }

  /** Bring the window up to date. Returns how many rows were read in (a full reload counts them all). */
  async refresh(): Promise<number> {
    if (!this.loaded) return this.replace(await this.page(this.cap));
    for (let limit = this.firstPage; limit < this.cap; limit *= 4) {
      const page = await this.page(limit);
      if (page.length < limit) return this.replace(page);
      if (!this.ids.has(page[0].id)) continue; // more arrived than this page holds — widen
      const fresh = page.filter((m) => !this.ids.has(m.id));
      this.rows = this.rows.concat(fresh);
      for (const m of fresh) this.ids.add(m.id);
      if (this.rows.length > this.cap) {
        for (const m of this.rows.slice(0, this.rows.length - this.cap)) this.ids.delete(m.id);
        this.rows = this.rows.slice(-this.cap);
      }
      return fresh.length;
    }
    return this.replace(await this.page(this.cap));
  }

  private async page(limit: number): Promise<DmRow[]> {
    return (await this.read(limit)).map((m) => {
      if (typeof m.id !== "string" || !m.id) throw new Error(`paw: a DM history row from ${m.from?.name ?? "?"} at ${m.ts} has no id — cannot place it in the conversation`);
      return dmRow(m, this.me);
    });
  }

  private replace(rows: DmRow[]): number {
    this.rows = rows;
    this.ids = new Set(rows.map((m) => m.id));
    this.loaded = true;
    return rows.length;
  }
}

/**
 * Run `tick` every `ms`, never twice at once, until the returned stop() is called.
 *
 * The re-entrancy guard is the point, not a detail: a tick that outlasts the interval would otherwise
 * start again against state the first one hasn't finished updating — for the cursor-driven readers
 * that means reading the same pre-advance cursor and printing the same messages twice.
 */
export function pollLoop(tick: () => Promise<void>, ms: number, onError: (e: Error) => void): () => void {
  const loop = pausableLoop(tick, ms, onError);
  loop.resume(); // drain immediately, then settle into the interval
  return () => loop.pause();
}

/** A {@link pollLoop} that can be parked and woken — `paw web` runs its roster and conversation loops
 *  only while a browser is connected (an idle daemon re-collecting for nobody was ~200ms CPU per tick). */
export interface PausableLoop {
  /** Start ticking: one tick NOW, then every `ms`. A no-op while already ticking. */
  resume(): void;
  /** Stop ticking. A tick already in flight finishes. */
  pause(): void;
  active(): boolean;
  /** One tick now, sharing the re-entrancy guard: resolves when the tick in flight (this one or an
   *  earlier one) settles. For an on-demand read while paused. */
  runNow(): Promise<void>;
}

/** Created PAUSED. Same never-twice-at-once guard as {@link pollLoop}. */
export function pausableLoop(tick: () => Promise<void>, ms: number, onError: (e: Error) => void): PausableLoop {
  let inflight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const runNow = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await tick();
      } catch (e) {
        onError(e as Error);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
  return {
    resume() {
      if (timer) return;
      void runNow();
      timer = setInterval(() => void runNow(), ms);
    },
    pause() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    active: () => timer !== undefined,
    runNow,
  };
}

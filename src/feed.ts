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
import { controlCreds, stableHumanId } from "./addressing.js";
import { HUMAN_PEER } from "./names.js";

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
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
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
  const all = await ep.dmHistory({ limit: FETCH_CAP });
  if (!opts.withSent) {
    return all
      .filter((m) => m.to === me)
      .sort((a, b) => a.ts - b.ts)
      .map((m): Entry => ({ from: m.from.name, text: messageText(m), ts: m.ts }));
  }
  const nameById = new Map<string, string>();
  for (const m of all) if (m.from.id && m.from.name) nameById.set(m.from.id, m.from.name);
  return all
    .filter((m) => m.to === me || m.from.id === me)
    .sort((a, b) => a.ts - b.ts)
    .map((m): Entry =>
      m.from.id === me
        ? { from: HUMAN_PEER, text: messageText(m), ts: m.ts, dir: "out", to: (m.to && nameById.get(m.to)) ?? m.to }
        : { from: m.from.name, text: messageText(m), ts: m.ts, dir: "in" },
    );
}

/**
 * Run `tick` every `ms`, never twice at once, until the returned stop() is called.
 *
 * The re-entrancy guard is the point, not a detail: a tick that outlasts the interval would otherwise
 * start again against state the first one hasn't finished updating — for the cursor-driven readers
 * that means reading the same pre-advance cursor and printing the same messages twice.
 */
export function pollLoop(tick: () => Promise<void>, ms: number, onError: (e: Error) => void): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      onError(e as Error);
    } finally {
      running = false;
    }
  };
  void run(); // drain immediately, then settle into the interval
  const timer = setInterval(() => void run(), ms);
  return () => clearInterval(timer);
}

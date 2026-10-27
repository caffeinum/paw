/**
 * Which peer joins and departures a long-lived transcript (paw chat) prints.
 *
 * A slow remote broker makes presence flap: heartbeats time out, the observer's view goes stale, and
 * cotal emits `offline` then `join` for the same live peer every minute or so (team2027, 2026-10-27:
 * `→ queue joined` / `← queue went offline` pairs under a footer that already said "degraded"). Each
 * event is real, but a pair that nets to nothing is noise. So:
 *
 * - while the view is QUIET (connection not `connected`, presence view stale, our presence writes
 *   stuck) nothing prints; the latest state per peer is held, and when the view is live again only the
 *   NET change prints — a peer that left and came back prints nothing, one really gone prints once;
 * - even when healthy, an `offline` waits {@link OFFLINE_DEBOUNCE_MS} (two presence TTLs) before it
 *   prints, and a `join` inside that wait cancels it — one missed heartbeat prints nothing;
 * - a join prints at once when the view is live (fresh news, and a real arrival).
 *
 * Nothing is fabricated: a line names a transition the endpoint reported and the transcript has not
 * yet said. A peer gone longer than the debounce with the view live always prints. Pure: time and the
 * quiet verdict are passed in.
 */

/** cotal's presence TTL (the 6000ms in its presence-write-stuck message) × 2. */
export const OFFLINE_DEBOUNCE_MS = 12_000;

export interface PresenceLine<C, S extends string = string> {
  type: "join" | "offline";
  id: string;
  card: C;
  status: S;
}

interface Peer<C, S extends string> {
  online: boolean;
  card: C;
  status: S;
  /** When the current offline began being due to print (live view), for the debounce. */
  offlineDueSince?: number;
}

export class PresenceHold<C, S extends string = string> {
  /** Peers the transcript last showed as present. */
  private readonly said = new Set<string>();
  private readonly cur = new Map<string, Peer<C, S>>();
  private held = 0;

  private readonly debounceMs: number;

  constructor(debounceMs = OFFLINE_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  /** Peers already present before the listener attached: the transcript treats them as said-present,
   *  so a later real departure prints. */
  seed(peers: { id: string; card: C; status: S }[]): void {
    for (const p of peers) {
      if (p.status === "offline") continue;
      this.said.add(p.id);
      this.cur.set(p.id, { online: true, card: p.card, status: p.status });
    }
  }

  feed(ev: { type: "join" | "offline"; id: string; card: C; status: S }, quiet: boolean, now: number): PresenceLine<C, S>[] {
    const prev = this.cur.get(ev.id);
    const online = ev.type === "join";
    this.cur.set(ev.id, { online, card: ev.card, status: ev.status, offlineDueSince: online ? undefined : prev?.offlineDueSince });
    if (quiet) {
      this.held++;
      return [];
    }
    return this.resolve(ev.id, now);
  }

  /** Called every second: prints debounced departures, and the net diff once a quiet spell ends. */
  tick(quiet: boolean, now: number): PresenceLine<C, S>[] {
    if (quiet) return [];
    this.held = 0;
    return [...this.cur.keys()].flatMap((id) => this.resolve(id, now));
  }

  /** Events received while quiet and not yet resolved (for `/conn`). */
  heldCount(): number {
    return this.held;
  }

  /** A departed peer the transcript no longer shows needs no record (ids are per lifecycle). */
  private forget(id: string): [] {
    this.cur.delete(id);
    this.said.delete(id);
    return [];
  }

  private resolve(id: string, now: number): PresenceLine<C, S>[] {
    const p = this.cur.get(id)!;
    const said = this.said.has(id);
    if (p.online) {
      p.offlineDueSince = undefined;
      if (said) return [];
      this.said.add(id);
      return [{ type: "join", id, card: p.card, status: p.status }];
    }
    if (!said) return this.forget(id);
    p.offlineDueSince ??= now;
    if (now - p.offlineDueSince < this.debounceMs) return [];
    this.forget(id);
    return [{ type: "offline", id, card: p.card, status: p.status }];
  }
}

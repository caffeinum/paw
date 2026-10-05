/**
 * One poller per kind, shared by every mounted view, with ADAPTIVE cadence.
 *
 * Raycast keeps pushed-behind views MOUNTED, so the moment the chat stacked a focused view on top of
 * the full transcript there were two components each polling on their own timer — two `paw` processes
 * every two seconds, each spawning a runtime and connecting to NATS. Per-component intervals do not
 * compose: the cost is O(views), and the views are exactly what the operator adds by navigating.
 *
 * So the timer lives here, refcounted. N subscribers share ONE schedule and ONE `paw` invocation, and
 * the last unsubscribe stops it. New subscribers get the last payload immediately rather than waiting
 * out a tick, so pushing a view renders populated instead of blank-then-filled.
 *
 * The schedule is a setTimeout CHAIN, not an interval: the next poll is scheduled only after the
 * previous one settles, so at most one `paw` process per kind can ever exist — a slow mesh stretches
 * the cadence instead of stacking processes.
 *
 * Raycast also keeps a command mounted after its window CLOSES (until pop-to-root, or forever if that
 * is set to "never"), and the API has no visibility signal. A fixed 2s poll therefore burned a bun
 * process every two seconds behind a hidden window — the "Raycast is hot" report. So the cadence
 * BACKS OFF: fast while something is happening (new data, a keystroke, a send awaiting its reply), and
 * stretching toward `maxMs` once nothing has changed for a while. `poke()` is the activity signal.
 * An unchanged payload is also not re-delivered: re-rendering a list of identical rows every tick is
 * pure Backend CPU (Raycast logged "rendering a lot without any changes").
 */
import { fetchInbox, fetchStatus, type InboxMessage, type StatusPayload } from "./paw";

interface Cadence {
  /** Poll interval while the feed is "hot". */
  minMs: number;
  /** Ceiling once nothing has changed for a while. */
  maxMs: number;
  /** How long new data keeps the feed hot. 0 = changes alone never do (the roster's `activeMs`
   *  moves on every read of a busy fleet, so "it changed" says nothing about anyone looking). */
  hotAfterChangeMs: number;
}

interface Feed<T> {
  subs: Set<(value: T) => void>;
  fails: Set<(err: Error) => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  last: T | undefined;
  lastJson: string | undefined;
  inFlight: boolean;
  delay: number;
  hotUntil: number;
}

const BACKOFF = 1.5;
const OPEN_HOLD_MS = 60_000;
const pokers = new Set<(holdMs: number) => void>();

/**
 * Activity: keep every feed at its fast cadence for `holdMs`, and poll NOW if it had backed off.
 * Called on keystrokes, selection changes and sends — the only signals that a human is looking.
 */
export function poke(holdMs = 60_000): void {
  for (const p of pokers) p(holdMs);
}

function makeFeed<T>(load: () => Promise<T>, cadence: Cadence) {
  const f: Feed<T> = {
    subs: new Set(),
    fails: new Set(),
    timer: undefined,
    last: undefined,
    lastJson: undefined,
    inFlight: false,
    delay: cadence.minMs,
    hotUntil: 0,
  };

  const active = () => f.subs.size > 0;

  const schedule = () => {
    if (f.timer) clearTimeout(f.timer);
    f.timer = active() ? setTimeout(() => void tick(), f.delay) : undefined;
  };

  const tick = async () => {
    f.timer = undefined;
    if (f.inFlight || !active()) return;
    f.inFlight = true;
    try {
      const value = await load();
      const json = JSON.stringify(value);
      if (json !== f.lastJson) {
        f.lastJson = json;
        f.last = value;
        if (cadence.hotAfterChangeMs) f.hotUntil = Math.max(f.hotUntil, Date.now() + cadence.hotAfterChangeMs);
        for (const s of f.subs) s(value);
      }
    } catch (e) {
      f.lastJson = undefined; // the next success must be delivered, or subscribers stay stuck in "failing"
      for (const s of f.fails) s(e as Error);
    } finally {
      f.inFlight = false;
      f.delay = Date.now() < f.hotUntil ? cadence.minMs : Math.min(cadence.maxMs, Math.round(f.delay * BACKOFF));
      schedule();
    }
  };

  pokers.add((holdMs) => {
    f.hotUntil = Math.max(f.hotUntil, Date.now() + holdMs);
    if (f.delay === cadence.minMs) return; // already fast: the running schedule is fine
    f.delay = cadence.minMs;
    if (active() && !f.inFlight) schedule();
  });

  return function subscribe(onValue: (value: T) => void, onError?: (err: Error) => void): () => void {
    const first = !active();
    f.subs.add(onValue);
    if (onError) f.fails.add(onError);
    if (f.last !== undefined) onValue(f.last); // don't make a new view wait out a tick to show anything
    if (first && !f.inFlight) {
      f.delay = cadence.minMs;
      f.hotUntil = Date.now() + OPEN_HOLD_MS; // a view just opened: someone is looking
      void tick();
    }
    return () => {
      f.subs.delete(onValue);
      if (onError) f.fails.delete(onError);
      if (!active() && f.timer) {
        clearTimeout(f.timer);
        f.timer = undefined;
      }
    };
  };
}

/** Messages: fast while a conversation is live, because a reply arriving is what you wait for. */
export const subscribeInbox = makeFeed<{ cursor: number; messages: InboxMessage[] }>(() => fetchInbox(), {
  minMs: 2_000,
  maxMs: 30_000,
  hotAfterChangeMs: 60_000,
});

/**
 * Presence: slow, because an agent going offline is not something you need to know within 2s, and a
 * stale-but-recent roster is only decoration — `paw status` is the most expensive call paw has (a
 * control round-trip, a JetStream query per agent, git per folder), so it must not run at the message
 * cadence or keep running behind a hidden window.
 *
 * Yields the WHOLE payload, not just the rows: `errors` carries paw's inbox-lag query failures, which
 * paw reports rather than fabricating a zero for. Dropping them here to keep the type tidy would throw
 * away the one signal that says the lag column is unknown instead of fine.
 */
export const subscribeRoster = makeFeed<StatusPayload>(() => fetchStatus(), {
  minMs: 15_000,
  maxMs: 120_000,
  hotAfterChangeMs: 0,
});

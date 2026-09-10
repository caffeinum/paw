/**
 * One poller per kind, shared by every mounted view.
 *
 * Raycast keeps pushed-behind views MOUNTED, so the moment the chat stacked a focused view on top of
 * the full transcript there were two components each polling on their own timer — two `paw` processes
 * every two seconds, each spawning a runtime and connecting to NATS. Per-component intervals do not
 * compose: the cost is O(views), and the views are exactly what the operator adds by navigating.
 *
 * So the timer lives here, refcounted. N subscribers share ONE interval and ONE `paw` invocation, and
 * the last unsubscribe stops it — nothing keeps polling behind a closed window. New subscribers get
 * the last payload immediately rather than waiting out a tick, so pushing a view renders populated
 * instead of blank-then-filled.
 */
import { fetchInbox, fetchStatus, type InboxMessage, type StatusPayload } from "./paw";

interface Feed<T> {
  subs: Set<(value: T) => void>;
  fails: Set<(err: Error) => void>;
  timer: ReturnType<typeof setInterval> | undefined;
  last: T | undefined;
  inFlight: boolean;
}

function makeFeed<T>(load: () => Promise<T>, intervalMs: number) {
  const f: Feed<T> = { subs: new Set(), fails: new Set(), timer: undefined, last: undefined, inFlight: false };

  const tick = async () => {
    // A fetch that outlives the interval would stack `paw` processes on a slow mesh — skip, don't queue.
    if (f.inFlight) return;
    f.inFlight = true;
    try {
      const value = await load();
      f.last = value;
      for (const s of f.subs) s(value);
    } catch (e) {
      for (const s of f.fails) s(e as Error);
    } finally {
      f.inFlight = false;
    }
  };

  return function subscribe(onValue: (value: T) => void, onError?: (err: Error) => void): () => void {
    f.subs.add(onValue);
    if (onError) f.fails.add(onError);
    if (f.last !== undefined) onValue(f.last); // don't make a new view wait out a tick to show anything
    if (!f.timer) {
      void tick();
      f.timer = setInterval(() => void tick(), intervalMs);
    }
    return () => {
      f.subs.delete(onValue);
      if (onError) f.fails.delete(onError);
      if (f.subs.size === 0 && f.timer) {
        clearInterval(f.timer);
        f.timer = undefined;
      }
    };
  };
}

/** Messages: fast, because a reply arriving is the thing you are waiting for. */
export const subscribeInbox = makeFeed<{ cursor: number; messages: InboxMessage[] }>(() => fetchInbox(), 2000);

/**
 * Presence: slow, because an agent going offline is not something you need to know within 2s, and a
 * stale-but-recent roster is only decoration — it must not cost a process at the message cadence.
 *
 * Yields the WHOLE payload, not just the rows: `errors` carries paw's inbox-lag query failures, which
 * paw reports rather than fabricating a zero for. Dropping them here to keep the type tidy would throw
 * away the one signal that says the lag column is unknown instead of fine.
 */
export const subscribeRoster = makeFeed<StatusPayload>(() => fetchStatus(), 15_000);

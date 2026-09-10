/**
 * Raycast's OWN read state, tracked PER MESSAGE.
 *
 * Two designs failed before this one, both instructive:
 *
 * 1. Sharing paw's `inbox.cursor`. Every paw surface advances that marker as a side effect of
 *    DISPLAYING, so with `paw chat` open in a terminal it is already past the newest message before
 *    Raycast renders — nothing is ever unread.
 * 2. A Raycast-local CURSOR. Still one number for the whole inbox, so reading anything from agent B
 *    silently marked agent A's older messages read too: the state was per-inbox when the thing you
 *    actually read is a message. And it only moved on an explicit keystroke, so in practice it never
 *    moved at all and everything stayed unread forever.
 *
 * So: a SET of message keys, and a message is marked read when you select it — which is what a mail
 * client does and what makes the state maintain itself instead of depending on a shortcut nobody
 * presses. Bounded, because this grows with every message ever read and LocalStorage is not a database:
 * the oldest keys fall off past {@link CAP}, which can only ever resurface an old message as unread —
 * never hide a new one.
 *
 * Keyed per space, since two spaces are two different inboxes.
 *
 * SHARED, not per-component. Raycast keeps pushed-behind views mounted, and the chat stacks a focused
 * view on top of the unfocused one — so two components each held their own copy loaded at mount, and
 * marking a message read in one never reached the other. The filtered and unfiltered views disagreed
 * about what you had read. Same shape as src/feed.ts: one store, subscribers notified on every write.
 */
import { LocalStorage } from "@raycast/api";

/** The one in-memory copy every view reads from, per space. */
const cache = new Map<string, Set<string>>();
// Subscribers and the in-flight load are keyed BY SPACE. One extension session only ever talks to one
// space today, but a flat set would quietly deliver space A's read state to a view showing space B —
// the kind of latent cross-tenant mixing that is free to prevent and miserable to find later.
const subs = new Map<string, Set<(ids: Set<string>) => void>>();
const loading = new Map<string, Promise<Set<string>>>();

function publish(space: string, ids: Set<string>): void {
  cache.set(space, ids);
  for (const s of subs.get(space) ?? []) s(ids);
}

/**
 * Subscribe to the read set. Returns an unsubscribe. The first subscriber triggers the load; later
 * ones get the cached set immediately, so a pushed view never renders against an empty set and
 * momentarily shows everything as unread.
 */
export function subscribeReadIds(space: string, cb: (ids: Set<string>) => void): () => void {
  let forSpace = subs.get(space);
  if (!forSpace) {
    forSpace = new Set();
    subs.set(space, forSpace);
  }
  forSpace.add(cb);
  const cached = cache.get(space);
  if (cached) cb(cached);
  else if (!loading.has(space)) {
    // One load even if several views mount at once — they share the promise rather than racing reads.
    loading.set(
      space,
      getReadIds(space).then((ids) => {
        publish(space, ids);
        return ids;
      }),
    );
    void loading.get(space)?.catch((e: Error) => console.error(`paw: could not read stored read-state — ${e.message}`));
  }
  return () => {
    forSpace.delete(cb);
  };
}

const KEY = "paw.readIds";
/** Keep the most recent N. Generous enough that nothing you can still scroll to falls off. */
const CAP = 2000;

function key(space: string): string {
  return `${KEY}.${space || "default"}`;
}

/** A message's identity across polls. `ts` alone collides when two agents send in the same
 *  millisecond, which is exactly when a wrong dedupe would be most confusing. */
export function messageKey(ts: number, from: string): string {
  return `${ts}:${from}`;
}

export async function getReadIds(space: string): Promise<Set<string>> {
  const raw = await LocalStorage.getItem<string>(key(space));
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    // Anything unparseable means "nothing known read", never "all read": a storage glitch should show
    // you too much mail, not silently hide it.
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Add `ids` to the read set and persist. Returns the new set so the caller can render from it without
 * a re-read. Insertion order is preserved, so trimming to {@link CAP} drops the oldest keys.
 */
export async function addReadIds(space: string, ids: string[]): Promise<Set<string>> {
  const current = cache.get(space) ?? (await getReadIds(space));
  const fresh = ids.filter((id) => !current.has(id));
  if (fresh.length === 0) return current; // nothing changed — don't churn storage on every keypress
  const next = new Set(current);
  for (const id of fresh) next.add(id);
  const trimmed = next.size > CAP ? new Set([...next].slice(next.size - CAP)) : next;
  publish(space, trimmed); // every mounted view, not just the one that marked it
  await LocalStorage.setItem(key(space), JSON.stringify([...trimmed]));
  return trimmed;
}

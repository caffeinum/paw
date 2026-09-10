/**
 * Which individual messages have been read.
 *
 * WHY THIS EXISTS, and why a cursor is not enough: paw's shared unread marker (`inbox.cursor`) is ONE
 * timestamp for the WHOLE inbox. That can express "I have read everything up to here", and nothing
 * else. So opening one agent's chat cannot mark just that conversation read — advancing the cursor to
 * its newest message would also bury older, genuinely unread mail from every other agent.
 *
 * That is exactly why the web UI only ever marked read from Activity, where everything IS on screen.
 * The cost was that reading a specific chat cleared nothing: the badge and the "new" divider stayed
 * forever, which is what the operator reported (2026-08-07).
 *
 * paw's Raycast extension hit this first and landed here after two failed designs — sharing paw's
 * cursor, then keeping a second cursor of its own. Both fail for the same reason: the unit of reading
 * is a MESSAGE, so the state has to be per message.
 *
 * The server cursor remains the BASELINE (it carries reads from the CLI and other surfaces); this is an
 * overlay on top of it, never a replacement.
 */

/** The separator, matching the server's `keyOf`. NUL, because no message body or agent name can
 *  contain one — a printable separator would let a sender forge a collision from CONTENT, and a forged
 *  collision silently drops somebody's message out of the feed. */
const SEP = "\u0000";

/** A message's identity as this API can observe it: `Entry` carries no wire id, so the key is the
 *  triple that a sender cannot vary independently. Same shape the daemon uses. */
export function messageKey(m) {
  return `${m.ts}${SEP}${m.from}${SEP}${m.text}`;
}

/** Bounded, so a long-lived tab cannot grow this without limit. Dropping the OLDEST is the safe
 *  direction: it can only make an old message look unread again, never hide a new one. */
const MAX_KEYS = 2000;

const storeKey = (space) => `paw.read.${space || "?"}`;

/**
 * Load the set of read message keys for a space.
 *
 * An unreadable or corrupt value reads as "nothing known read", never "all read": a storage glitch
 * should show you too much mail, not silently hide it.
 */
export function loadRead(space) {
  try {
    const raw = localStorage.getItem(storeKey(space));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist the set, trimmed to the newest {@link MAX_KEYS} entries (insertion order = arrival order). */
export function saveRead(space, set) {
  try {
    const keys = [...set];
    localStorage.setItem(storeKey(space), JSON.stringify(keys.length > MAX_KEYS ? keys.slice(-MAX_KEYS) : keys));
  } catch {
    /* storage full or blocked: the overlay degrades to the server cursor, which is still correct */
  }
}

/**
 * Is this message still unread — newer than the cursor AND not marked read here?
 *
 * `dir !== "out"` rather than `dir === "in"`, matching the daemon: the inbox-only shape omits `dir`
 * entirely, and everything in that shape is by definition addressed to you.
 */
export function isUnread(m, cursor, read) {
  if (m.dir === "out") return false;
  if (!(m.ts > (cursor ?? 0))) return false;
  return !read.has(messageKey(m));
}

/**
 * How far the SHARED cursor can safely be advanced: to just before the oldest message still unread.
 *
 * This is what keeps `paw inbox` and the CLI in step without ever hiding anything. Everything older
 * than the oldest thing you have not read is, by definition, read — so moving the cursor there is
 * always safe, no matter which conversation you happened to be looking at. Returns undefined when
 * there is nothing to advance to.
 */
export function safeCursor(messages, cursor, read) {
  let oldestUnread;
  let newestSeen;
  for (const m of messages) {
    if (m.dir === "out") continue;
    if (!(m.ts > (cursor ?? 0))) continue;
    if (newestSeen === undefined || m.ts > newestSeen) newestSeen = m.ts;
    if (!read.has(messageKey(m))) {
      if (oldestUnread === undefined || m.ts < oldestUnread) oldestUnread = m.ts;
    }
  }
  if (newestSeen === undefined) return undefined; // nothing past the cursor at all
  // Everything past the cursor has been read ⇒ the cursor can reach the newest of them.
  if (oldestUnread === undefined) return newestSeen;
  const target = oldestUnread - 1;
  return target > (cursor ?? 0) ? target : undefined;
}

/**
 * Which conversation is selected, how you move between them, and where its draft is kept.
 *
 * Pure on purpose: the client has no build step and no browser test harness, so anything with real edge
 * cases — clamping, a focus that has been filtered away, one draft per target — lives here where it can
 * be asserted directly instead of only being clicked at.
 */
import { isUnread } from "./read-state.js";

/**
 * Every conversation you can move between, in the order the sidebar shows them.
 *
 * Built from the SAME inputs the sidebar renders from, INCLUDING the filter. A keyboard order that
 * disagrees with the visible one is worse than no shortcut at all: the selection appears to jump at
 * random, and the operator can't tell where the next press will land. `null` leads because Activity is
 * the row that leads.
 */
export function orderTargets({ channels = [], rows = [], filter = "" } = {}) {
  const q = filter.trim().toLowerCase();
  return [
    null,
    ...channels.filter((ch) => !q || ch.toLowerCase().includes(q)).map((ch) => "#" + ch),
    ...rows.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.folder ?? "").toLowerCase().includes(q)).map((r) => r.name),
  ];
}

/**
 * The target `delta` steps away from `focus`.
 *
 * CLAMPED, not wrapped: falling off the last agent back to Activity reads as a glitch rather than a
 * move, and in a 40-agent list you'd have no idea you had wrapped. A focus that is no longer in the
 * list (its channel filtered out from under you) starts from the top rather than from nowhere — the
 * alternative is a keypress that silently does nothing.
 */
export function stepTarget(targets, focus, delta) {
  if (!targets.length) return focus;
  const i = targets.indexOf(focus ?? null);
  if (i === -1) return targets[0];
  return targets[Math.min(targets.length - 1, Math.max(0, i + delta))];
}

/**
 * The timestamp of the first message you haven't read in this conversation, or undefined if there is
 * none — the place a "new messages" divider belongs.
 *
 * Only INBOUND messages count: your own send is not something you need to be told to read, and a reply
 * you fired off last night would otherwise put the divider above your own words.
 *
 * The caller FREEZES this when the conversation is opened rather than recomputing it per render. The
 * cursor moves as messages are displayed, so a divider tracking it live would slide down or vanish
 * while you were still looking for your place — which is the one thing this must not do.
 */
export function firstUnreadTs(list, cursor, read = new Set()) {
  if (!Number.isFinite(cursor)) return undefined;
  let first;
  for (const m of list) {
    // The same rule the badge uses — cursor AND the per-message overlay. Testing the cursor alone
    // would re-open the divider over mail you had already read here, whenever the shared cursor was
    // held back by an older unread message in some OTHER conversation.
    if (!isUnread(m, cursor, read)) continue;
    if (first === undefined || m.ts < first) first = m.ts;
  }
  return first;
}

/**
 * Where to scroll so the divider reads as a BOUNDARY rather than a ceiling.
 *
 * Pinning the divider to the top of the viewport shows what's new but strips the thing that makes it
 * legible: a glimpse of what came before. You want the tail of the last message you'd already read,
 * then the line, then the new mail — so the line divides two things you can see, instead of floating
 * above the fold.
 *
 * The headroom is the previous message's own height, CLAMPED: a short one shows in full, while a long
 * one (a 40-line reply is normal here) would otherwise push the divider off the bottom of the screen —
 * scrolling so far up that the thing you scrolled to isn't visible. All offsets are relative to the
 * scroll container. No previous message means the divider is the first row, and the top is already the
 * right answer.
 */
export function markScrollTop({ markTop, prevTop, maxHeadroom = 96 }) {
  const headroom = prevTop === undefined || prevTop === null ? 0 : Math.min(Math.max(0, markTop - prevTop), maxHeadroom);
  return Math.max(0, markTop - headroom);
}

/**
 * Where a conversation's draft is stored.
 *
 * Keyed by SPACE as well as target: two spaces share a browser origin, so a bare target name would let
 * a draft written for one space's `queue` surface in another's.
 */
export function draftKey(space, target) {
  return `paw.draft.${space || "?"}.${target}`;
}

/**
 * The label for who an outgoing message WENT TO, for the Activity view.
 *
 * Activity is every conversation at once, and an outgoing row said only "you" — so the one thing you
 * cannot recover from a mixed feed is which agent you said it to. Inbound rows never had the problem
 * (they carry `from`).
 *
 * The recipient is an ID on the wire. paw's inbox resolves it to a name when that id has ever appeared
 * as a SENDER, and deliberately leaves it an id otherwise — so this must render both. An id is
 * SHORTENED, never dressed up as a name: a truncated id is still something you can match against
 * `paw status`, whereas a guessed name is a claim about who you talked to, and being confidently wrong
 * about that is worse than being unhelpfully honest.
 *
 * `known` (the roster) is what separates the two: a value in it is a name, anything else is an id.
 * Empty in, empty out — an absent recipient renders nothing rather than "unknown".
 */
export function recipientLabel(to, known = []) {
  if (!to) return "";
  const name = String(to);
  if (known.includes(name)) return name;
  // A name that simply isn't on the roster right now (a stopped agent) still LOOKS like a name; an id
  // is long and carries the owner.actor dot-form or a raw nkey. Keep short human-shaped tokens whole.
  if (name.length <= 24 && !name.includes(".")) return name;
  const tail = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  return `${tail.slice(0, 8)}…`;
}

/**
 * Where to scroll so a jumped-to message is READABLE.
 *
 * Centring was wrong, and wrong in the way that looks like a different bug: an agent message is often
 * TALLER than the viewport, so centring puts its first lines above the top of the list — which reads
 * as the text being cut off by the header (reported exactly that way, 2026-08-19). The header does not
 * overlap anything; the message simply started off-screen.
 *
 * When you jump to a message you want its BEGINNING, so this top-aligns and then gives back whatever
 * headroom is spare: a short message gets some of the previous conversation above it for context, a
 * tall one gets a small margin and starts at its first line. Both cases keep the one thing that
 * matters visible — where the message starts.
 */
export function jumpScrollTop({ rowTop, rowHeight = 0, viewport = 0, maxHeadroom = 96, minMargin = 12 }) {
  const spare = (viewport - rowHeight) / 3;
  const headroom = Math.min(maxHeadroom, Math.max(minMargin, Number.isFinite(spare) ? spare : minMargin));
  return Math.max(0, rowTop - headroom);
}

/**
 * Whether a pending (optimistic) send has been echoed back by the server, and can therefore be retired.
 *
 * Its own module because getting it wrong is INVISIBLE in the good direction and permanent in the bad
 * one: a row that is never retired sits under the real message as a second copy that no reload clears,
 * which is exactly what shipped for channel posts (reported 2026-08-06).
 *
 * The subtlety is that the two destinations echo in different SHAPES, in different arrays:
 *
 *   DM      → `state.messages`        `{ dir: "out", to: "agent", text, ts }`
 *   channel → `state.channelMessages` `{ from: "you", channel: "team2027", text, ts }`
 *
 * A channel entry carries no direction and no recipient at all — the sender is in `from` and the
 * destination is in `channel` — so the single `dir === "out" && to === …` test that works for a DM can
 * never match a channel post, and silently never retires it.
 *
 * Identity is (destination, exact text), because `Entry` carries no message id on the wire. Two
 * identical messages sent to the same place in quick succession therefore reconcile against each
 * other's echo; that costs one optimistic row retiring early, which is invisible, whereas the
 * alternative — matching on nothing and keeping both — is the duplicate this exists to prevent.
 */
export function isEchoed(pending, messages, channelMessages) {
  const to = String(pending.to ?? "");
  if (to.startsWith("#")) {
    const channel = to.slice(1);
    return (channelMessages ?? []).some((m) => m.channel === channel && m.from === "you" && m.text === pending.text);
  }
  return (messages ?? []).some((m) => m.dir === "out" && m.to === to && m.text === pending.text);
}

/** The pending rows that survive a reconcile: a FAILED send always stays (it is the operator's only
 *  handle to retry it), and an un-echoed send stays because it is still in flight. */
export function survivingPending(pending, messages, channelMessages) {
  return pending.filter((p) => p.state === "failed" || !isEchoed(p, messages, channelMessages));
}

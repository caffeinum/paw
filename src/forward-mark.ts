/**
 * How a stale-id forward (src/stale-forward.ts) is marked on the wire, and how a reader pairs it with
 * the DM it repeats.
 *
 * A forward is a SECOND copy of a DM: the original stays in the DM stream addressed to the dead id, and
 * the forwarder re-publishes it to the live id under the same sender, same `ts`, same parts, with a note
 * part first and a deterministic `id = forwardId(original.id, forward.to)`. A reader that sees both
 * (the human's own outbound DM — both copies are "from you") would show it twice. The pair is exact,
 * never a text match: the note names the dead id (= the original's `to`), and the forward's id is the
 * hash of the original's id and the forward's `to`.
 *
 * Leaf module (node:crypto only) so feed/chat/web can use it without pulling in the forwarder.
 */
import { createHash } from "node:crypto";

/** A deterministic message id for the forward of `origId` to `to` — a retried forward carries the SAME
 *  msgID, so JetStream's duplicate window drops it even if the forwarder's done-set write was lost. */
export function forwardId(origId: string, to: string): string {
  const h = createHash("sha256").update(`paw-stale-forward\0${origId}\0${to}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The note a forwarded DM leads with, so the agent knows why it arrived and where to reply. */
export function forwardNote(oldId: string): string {
  return `[paw: forwarded — this DM was sent to your previous instance (${oldId}); reply to the sender as usual]`;
}

const NOTE = /^\[paw: forwarded — this DM was sent to your previous instance \(([^)\s]+)\); reply to the sender as usual\]$/;

type Part = { kind?: string; text?: unknown };

/** The dead id a forward was originally addressed to — undefined when the message is not a forward. */
export function forwardedFrom(parts: readonly unknown[] | undefined): string | undefined {
  const first = parts?.[0] as Part | undefined;
  if (!first || first.kind !== "text" || typeof first.text !== "string") return undefined;
  return NOTE.exec(first.text)?.[1];
}

/** The parts the sender actually wrote: a forward minus its note, anything else unchanged. */
export function withoutForwardNote<T>(parts: readonly T[]): T[] {
  return forwardedFrom(parts) === undefined ? [...parts] : parts.slice(1);
}

/** Is `fwd` the forwarder's copy of `orig`? Exact: same sender, the note's dead id is the original's
 *  recipient, and the forward's id is {@link forwardId} of the original's id and the forward's recipient. */
export function isForwardOf(
  fwd: { id: string; to?: string; from: { id?: string }; forwardOf?: string },
  orig: { id: string; to?: string; from: { id?: string } },
): boolean {
  return (
    fwd.forwardOf !== undefined &&
    fwd.to !== undefined &&
    fwd.from.id !== undefined &&
    fwd.from.id === orig.from.id &&
    orig.to === fwd.forwardOf &&
    fwd.id === forwardId(orig.id, fwd.to)
  );
}

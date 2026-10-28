/**
 * Publish a chat message whose id the CALLER owns, so a retry is the same message.
 *
 * cotal's `unicast` / `multicast` mint the message id inside the call and only hand it back on success.
 * A publish whose JetStream ack timed out (nats.js `TimeoutError`, message `timeout` — the bare
 * `! timeout` paw chat printed after a send on a flaky link, team2027 2026-10-27) may or may not have
 * been stored, and the caller never learned its id: re-sending through `unicast` mints a new id, which
 * the broker cannot dedupe, so a retry could deliver the message twice.
 *
 * This builds the exact message `unicast` / `multicast` build and publishes it on the same subject with
 * `msgID = message id` — the stream's duplicate window (2 min on the DM and chat streams) collapses a
 * re-publish of a copy that did land. cotal keeps the JetStream client private; reading it is the one
 * coupling here, checked loud (upstream gap: `unicast`/`multicast` should accept `opts.id`).
 */
import { randomUUID } from "node:crypto";
import { chatSubject, isConcreteChannel, parsePrincipalKey, unicastSubject, type CotalMessage } from "@cotal-ai/core";

/** The stream duplicate window both the DM and chat streams are created with (cotal backup-config). */
export const DEDUP_WINDOW_MS = 2 * 60_000;

/** The slice of a cotal Endpoint this needs — public fields plus the private JetStream client. */
export interface PublishingEndpoint {
  readonly space: string;
  readonly card: { id: string; name: string; role?: string; owner?: string; actor?: string };
}

interface JsPublisher {
  publish(subject: string, data: string, opts: { msgID: string }): Promise<{ seq: number; duplicate?: boolean }>;
}

export interface PublishAck {
  seq: number;
  /** The broker already had this msgID — an earlier attempt did land. */
  duplicate: boolean;
}

function jsOf(ep: PublishingEndpoint): JsPublisher {
  if (!("js" in ep)) throw new Error("paw: cotal's Endpoint has no `js` field — paw's retry-safe publish (src/mesh-publish.ts) needs a new hook");
  const js = (ep as unknown as { js?: JsPublisher }).js;
  // cotal nulls it in its rebuild window; its own wording for that is "reconnecting - try again shortly".
  if (!js) throw new Error("reconnecting - try again shortly");
  return js;
}

function sender(ep: PublishingEndpoint): { owner: string; actor: string } {
  const p = parsePrincipalKey(ep.card.id);
  if (!p) throw new Error(`paw: this endpoint's id "${ep.card.id}" is not an <owner>.<actor> principal`);
  return p;
}

/** A DM to `to` (a principal id), shaped exactly like cotal's `unicast`. Not yet sent. */
export function draftDm(ep: PublishingEndpoint, to: string, text: string, now = Date.now()): CotalMessage {
  if (!parsePrincipalKey(to)) throw new Error(`unicast: "${to}" is not a valid recipient principal <owner>.<actor>`);
  return { id: randomUUID(), ts: now, space: ep.space, from: { id: ep.card.id, name: ep.card.name, role: ep.card.role }, to, parts: [{ kind: "text", text }] } as CotalMessage;
}

/** A channel post, shaped exactly like cotal's `multicast`. Not yet sent. */
export function draftPost(ep: PublishingEndpoint, channel: string, text: string, now = Date.now()): CotalMessage {
  if (!isConcreteChannel(channel)) throw new Error(`cannot publish to wildcard channel "${channel}" - pick a concrete sub-channel`);
  return { id: randomUUID(), ts: now, space: ep.space, from: { id: ep.card.id, name: ep.card.name, role: ep.card.role }, channel, parts: [{ kind: "text", text }] } as CotalMessage;
}

/** Publish a drafted message (again, possibly). Same id → the broker stores it at most once. */
export async function publishDraft(ep: PublishingEndpoint, msg: CotalMessage): Promise<PublishAck> {
  const m = msg as CotalMessage & { to?: string; channel?: string };
  const me = sender(ep);
  let subject: string;
  if (m.to) {
    const r = parsePrincipalKey(m.to);
    if (!r) throw new Error(`unicast: "${m.to}" is not a valid recipient principal <owner>.<actor>`);
    subject = unicastSubject(ep.space, r.owner, r.actor, me.owner, me.actor);
  } else if (m.channel) subject = chatSubject(ep.space, me.owner, me.actor, m.channel);
  else throw new Error("paw: a drafted message names neither a recipient nor a channel");
  const ack = await jsOf(ep).publish(subject, JSON.stringify(msg), { msgID: msg.id });
  return { seq: ack.seq, duplicate: ack.duplicate === true };
}

/**
 * How `paw sleep` and the sleep host reach the broker — bare on an open mesh (exactly as before), and
 * with paw's own NARROW creds on a REMOTE (JWT-authed) space (src/remote-creds.ts), TLS required.
 *
 * Three connections, each holding only what its job needs:
 *  - a WATCH per sleeping agent: live subscribe on the stand-in's and the despawned seat's DM subjects,
 *    and reads of those subjects through named, filter-pinned consumers ({@link readFiltered});
 *  - a FORWARD per wake: publish to the woken seat's DM subjects from the backlog's senders, one-shot;
 *  - the STAND-IN presence: cotal's own `agent` profile for the persisted stand-in nkey (what the
 *    mailbox's "you" beacon holds too) — the agent's name on the roster, nothing of the agent's own.
 *
 * Callers must have decided the agent is hosted here (src/hosted.ts) BEFORE asking for any of these:
 * this module mints whatever it is asked to.
 */
import { DEV_OWNER, dmStream, idFromCreds, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { pawCotalRoot } from "./cotal-root.ts";
import { FORWARD_TTL_SEC, WATCH_TTL_SEC, credsSecondsLeft, forwardGrants, signScopedCreds, watchConsumerName, watchGrants } from "./remote-creds.ts";
import { natsTls } from "./server.ts";
import { claimStandInIdentity, standInActor } from "./sleep-state.ts";
import { isRemoteSpace } from "./server.ts";

/** A held connection and when its cred runs out (unix seconds; Infinity on an open mesh). */
export interface Held {
  nc: NatsConnection;
  expSec: number;
}

async function dialWith(space: string, server: string, creds: string | undefined): Promise<NatsConnection> {
  return connect({
    servers: server,
    ...natsTls(space),
    ...(creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}` } : {}),
  });
}

/** The watch connection for one sleeping agent's `filters`. `purpose` names its consumers. */
export async function openWatch(space: string, server: string, name: string, filters: string[], purpose: "host" | "cli"): Promise<Held> {
  if (!isRemoteSpace(space)) return { nc: await dialWith(space, server, undefined), expSec: Infinity };
  const names = filters.map((_, i) => watchConsumerName(space, name, purpose, i));
  const creds = await signScopedCreds(space, `sleep-watch-${purpose}`, newIdentity(), watchGrants(space, filters, names), WATCH_TTL_SEC);
  return { nc: await dialWith(space, server, creds), expSec: Math.floor(Date.now() / 1000) + credsSecondsLeft(creds) };
}

/** A one-shot connection allowed to publish exactly `subjects` (open mesh: bare). */
export async function openForward(space: string, server: string, subjects: string[]): Promise<NatsConnection> {
  if (!isRemoteSpace(space)) return dialWith(space, server, undefined);
  return dialWith(space, server, await signScopedCreds(space, "sleep-forward", newIdentity(), forwardGrants(subjects), FORWARD_TTL_SEC));
}

/** The stand-in's principal: the persisted nkey on a remote space (minted on first use), the stable
 *  hash on an open mesh. */
export function standInPrincipal(space: string, name: string): { owner: string; actor: string } {
  if (!isRemoteSpace(space)) return { owner: DEV_OWNER, actor: standInActor(space, name) };
  return { owner: DEV_OWNER, actor: claimStandInIdentity(space, name, newIdentity()).id };
}

/** CotalEndpoint options for the stand-in presence. Remote: the stand-in nkey minted as cotal's `agent`
 *  (presence + its own DM subject; no channel rows), TLS required, a fresh lifecycle uid, and card kind
 *  `endpoint` — the kind "you" (the mailbox beacon) registers as. An authed `agent`-kind presence must
 *  first prove its incarnation by a provisioned `dm_` durable (SPEC 13.1 fail-before-presence); a
 *  stand-in consumes nothing, so it provisions nothing — the host reads the stream itself. Senders resolve
 *  it by name exactly as they resolve "you". Open mesh: unchanged (`agent`, the hash actor). */
export async function standInEndpointAuth(space: string, name: string): Promise<{ creds?: string; tls?: true; lifecycleUid?: string; cardId?: string; kind: "agent" | "endpoint" }> {
  if (!isRemoteSpace(space)) return { cardId: standInActor(space, name), kind: "agent" };
  const dir = authDir(pawCotalRoot(space));
  const auth = loadSpaceAuth(dir, space);
  if (!auth) throw new Error(`paw: space "${space}" is remote but no signer loads under ${dir} — see \`paw mesh add\``);
  const identity = claimStandInIdentity(space, name, newIdentity());
  const lifecycleUid = mintLifecycleUid();
  return { creds: await mintCreds(auth, identity, "agent", { lifecycleUid }), tls: true, lifecycleUid, kind: "endpoint" };
}

/** A one-shot connection that may read the DM stream's info and nothing else (open mesh: bare). */
export async function openStreamInfo(space: string, server: string): Promise<NatsConnection> {
  if (!isRemoteSpace(space)) return dialWith(space, server, undefined);
  const grants = { pub: ["$JS.API.INFO", `$JS.API.STREAM.INFO.${dmStream(space)}`], sub: [] };
  return dialWith(space, server, await signScopedCreds(space, "dm-cursor", newIdentity(), grants, FORWARD_TTL_SEC));
}

/** The DM stream's last sequence over `nc`. */
export async function dmLastSeqOn(nc: NatsConnection, space: string): Promise<number> {
  return (await (await jetstreamManager(nc)).streams.info(dmStream(space))).state.last_seq;
}

/**
 * Every message stored on ONE `filter` after `afterSeq`, oldest first, read through a NAMED consumer
 * (`cname`) so the remote grant can pin both name and filter. The consumer is recreated per read and
 * deleted after; `countOnly` returns just its pending count. Shared by both modes.
 */
export async function readFiltered(
  nc: NatsConnection,
  space: string,
  filter: string,
  afterSeq: number,
  cname: string,
  countOnly = false,
): Promise<{ pending: number; msgs: Array<{ subject: string; seq: number; data: Record<string, unknown> }> }> {
  const DM = dmStream(space);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.delete(DM, cname).catch(() => {}); // a leftover from a crashed read
  await jsm.consumers.add(DM, {
    name: cname,
    filter_subject: filter,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: afterSeq + 1,
    ack_policy: AckPolicy.None,
    inactive_threshold: 60_000_000_000, // 60s in ns: a crashed reader's consumer reaps itself
    mem_storage: true,
  });
  const msgs: Array<{ subject: string; seq: number; data: Record<string, unknown> }> = [];
  try {
    const c = await jetstream(nc).consumers.get(DM, cname);
    const pending = (await c.info()).num_pending;
    if (countOnly) return { pending, msgs };
    for (;;) {
      if ((await c.info()).num_pending === 0) break;
      const batch = await c.fetch({ max_messages: 200, expires: 2000 });
      let n = 0;
      for await (const m of batch) {
        n++;
        try {
          msgs.push({ subject: m.subject, seq: m.seq, data: m.json() });
        } catch {
          /* not a cotal envelope — nothing to forward */
        }
      }
      if (n === 0) break;
    }
    return { pending, msgs };
  } finally {
    await jsm.consumers.delete(DM, cname).catch(() => {});
  }
}

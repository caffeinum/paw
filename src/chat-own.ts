/**
 * What `paw chat` reads of "you"'s OWN mail beyond its inbox: the cross-session echo (what another
 * `paw chat` sent), the earlier block's read, and the messages view's other-peer rows.
 *
 * Open mesh: unchanged — a space-wide `ep.tap` and `readConversation` over the whole DM stream.
 *
 * Remote (JWT-authed) mesh: chat's `agent` cred may subscribe to its channels and bind its own inbox,
 * nothing else, so the space-wide tap died with `Permissions Violation for Subscription to
 * "cotal.<s>.>"` and `dmHistory` cannot create its consumer. Neither job needs the whole space:
 *  - channel echo: "you"'s own posts, `chat.<o>.<you>.>` — inside the agent cred's `chat.*.*.>` grant,
 *    so it rides the chat endpoint's own connection;
 *  - DM echo: "you"'s own outbound DMs, `inst.*.*.<o>.<you>` — a paw-signed `chat-echo` cred holding
 *    ONLY that subscription (src/remote-creds.ts), TLS required, re-signed before it expires;
 *  - history seed: DMs to and from "you", read through named filter-pinned consumers with a one-shot
 *    `chat-history` cred. Never another agent's mail.
 *
 * The messages view's other-peer rows (another agent's mail, by design): open mesh — the space-wide tap
 * ({@link tapPeerTraffic}) and the whole DM stream ({@link readPeerTraffic}). Remote — the operator-only
 * `chat-peers` cred, scoped to the SELECTED agent's own subjects ({@link agentTrafficReads}): a read
 * cred signed per read, and one live tap for the target ({@link tapAgentTraffic}) renewed before it
 * expires. Never the space wildcard, never `admin`.
 */
import { createHash, randomUUID } from "node:crypto";
import { chatStream, chatSubject, type CotalMessage, dmStream, idFromCreds, newIdentity, parsePrincipalKey, parseSubject, unicastRecvFilter, unicastSubject, type CotalEndpoint } from "@cotal-ai/core";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { classifyPeer, dropPairedPeerForwards, type PeerMsg, type RawMsg } from "./chat-peers.ts";
import { forwardedFrom, withoutForwardNote } from "./forward-mark.ts";
import { conversationEntries, dmRow, FETCH_CAP, messageText, readConversation, type Entry } from "./feed.ts";
import { cachedLedger, type Ledger } from "./peer-ledger.ts";
import {
  ECHO_TTL_SEC,
  FORWARD_TTL_SEC,
  PEERS_RENEW_BEFORE_SEC,
  PEERS_TTL_SEC,
  RENEW_BEFORE_SEC,
  credsSecondsLeft,
  echoGrants,
  filteredReadGrants,
  pinnedReadGrants,
  signScopedCreds,
  tapGrants,
} from "./remote-creds.ts";
import { isRemoteSpace, natsTls } from "./server.ts";
import { readFiltered } from "./sleep-dial.ts";

type TapHandler = (subject: string, m: unknown) => void;

const enc = new TextEncoder();

type Principal = { owner: string; actor: string };

/** "you"'s principal from the endpoint's id — under auth a card id is the dot-form `<owner>.<actor>`. */
export function principalOfId(id: string): Principal {
  const p = parsePrincipalKey(id);
  if (!p) throw new Error(`paw: chat's own id "${id}" is not an <owner>.<actor> principal — can't narrow its taps`);
  return p;
}

/** Pure: the subjects "you"'s own sends travel on. */
export function ownSendSubjects(space: string, me: Principal): { chat: string; dm: string } {
  return { chat: chatSubject(space, me.owner, me.actor, ">"), dm: unicastSubject(space, "*", "*", me.owner, me.actor) };
}

/** Pure: the two filters of "you"'s conversation — DMs addressed to "you", and DMs "you" sent. */
export function ownConversationFilters(space: string, me: Principal): string[] {
  return [unicastRecvFilter(space, me.owner, me.actor), ownSendSubjects(space, me).dm];
}

/** Pure: NATS-safe, per-read consumer names for {@link ownConversationFilters}. */
export function historyConsumerNames(space: string, me: Principal, nonce: string, n: number): string[] {
  const h = createHash("sha256").update(`${space}\0${me.owner}.${me.actor}\0${nonce}`).digest("hex").slice(0, 16);
  return Array.from({ length: n }, (_, i) => `pawch_${h}_${i}`);
}

/**
 * Feed `handler` every message "you" send (any session). Returns a stop function. `onError` hears a
 * failure of the remote echo connection — loud, never swallowed.
 */
export async function tapOwnSends(ep: CotalEndpoint, space: string, server: string, handler: TapHandler, onError: (e: Error) => void): Promise<() => Promise<void>> {
  tapOwnSubject(ep, space, handler);
  return startEcho(ep, space, server, handler, onError);
}

/**
 * The half of the echo that rides the chat endpoint's own connection: a plain `ep.tap`, bound on
 * connect — so `paw chat` attaches it BEFORE starting the endpoint and misses no frame. Sync.
 */
export function tapOwnSubject(ep: CotalEndpoint, space: string, handler: TapHandler): void {
  if (!isRemoteSpace(space)) ep.tap(handler);
  else ep.tap(handler, { subject: ownSendSubjects(space, principalOfId(ep.card.id)).chat });
}

/**
 * The remote half: "you"'s own outbound DMs over a second, narrowly-signed connection. Off chat's
 * critical path — started once the chat is ready, never awaited by it — so a DM another session sends
 * in chat's first moments is not echoed (it is still in `paw history`). A no-op on an open mesh, where
 * the space-wide tap already sees them.
 */
export async function startEcho(ep: CotalEndpoint, space: string, server: string, handler: TapHandler, onError: (e: Error) => void): Promise<() => Promise<void>> {
  if (!isRemoteSpace(space)) return async () => {};
  const { dm } = ownSendSubjects(space, principalOfId(ep.card.id));
  const identity = newIdentity();
  const sign = () => signScopedCreds(space, "chat-echo", identity, echoGrants(dm), ECHO_TTL_SEC);
  let creds = await sign();
  const nc: NatsConnection = await connect({
    servers: server,
    ...natsTls(space),
    authenticator: credsAuthenticator(() => enc.encode(creds)),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
  });
  const sub = nc.subscribe(dm);
  void (async () => {
    for await (const m of sub) {
      let decoded: unknown;
      try {
        decoded = m.json();
      } catch {
        decoded = undefined;
      }
      handler(m.subject, decoded);
    }
  })().catch((e: Error) => onError(new Error(`paw: chat's echo of your own DMs stopped: ${e.message}`)));
  // Re-sign the same nkey before the broker expires it, then reconnect onto it (the authenticator
  // reads `creds` at every connect).
  const renew = setInterval(() => {
    if (credsSecondsLeft(creds) > RENEW_BEFORE_SEC) return;
    sign()
      .then((fresh) => {
        creds = fresh;
        return nc.reconnect();
      })
      .catch((e: Error) => onError(new Error(`paw: couldn't renew chat's echo cred: ${e.message}`)));
  }, 10 * 60_000);
  renew.unref();
  return async () => {
    clearInterval(renew);
    await nc.close().catch(() => {});
  };
}

/** "you"'s conversation, both directions, with message ids — the whole DM stream on an open mesh,
 *  only "you"'s own mail on a remote space. Chat's earlier-history block
 *  (src/chat-backlog.ts) reads through here; the only other DM-stream read in chat is {@link readPeerTraffic} (the selected agent's own subjects on a remote space). */
export async function readOwnConversation(ep: CotalEndpoint, space: string, server: string): Promise<Entry[]> {
  if (!isRemoteSpace(space)) return readConversation(ep, { withSent: true, withIds: true });
  const me = ep.card.id;
  const principal = principalOfId(me);
  const filters = ownConversationFilters(space, principal);
  const names = historyConsumerNames(space, principal, randomUUID(), filters.length);
  const creds = await signScopedCreds(space, "chat-history", newIdentity(), filteredReadGrants(space, filters, names), FORWARD_TTL_SEC);
  const nc = await connect({
    servers: server,
    ...natsTls(space),
    authenticator: credsAuthenticator(enc.encode(creds)),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
    maxReconnectAttempts: 0,
    timeout: 5_000,
  });
  try {
    const rows = [];
    for (const [i, f] of filters.entries()) {
      for (const m of (await readFiltered(nc, space, f, 0, names[i]!)).msgs) {
        const d = m.data as unknown as Parameters<typeof dmRow>[0];
        if (d && typeof d === "object" && d.from && d.id) rows.push(dmRow(d, me));
      }
    }
    return conversationEntries(rows, me, space, { withSent: true, withIds: true });
  } finally {
    await nc.close().catch(() => {});
  }
}

/**
 * The messages view's live other-peer rows (src/chat-peers.ts) on an OPEN mesh: a space-wide tap, like
 * the echo's — `handler` sees every frame and classifies it. REMOTE: false, nothing tapped on chat's
 * endpoint — the remote live rows come off {@link tapAgentTraffic}'s own narrow connection. Sync,
 * attached before the endpoint starts (no frame is missed).
 */
export function tapPeerTraffic(ep: CotalEndpoint, space: string, handler: TapHandler): boolean {
  if (isRemoteSpace(space)) return false;
  ep.tap(handler);
  return true;
}

/** At most this many of an agent's ids are read/tapped (current ids first, then the ledger's most
 *  recently seen) — each id is three pinned consumers per read. */
export const MAX_PEER_IDS = 16;

/** Pure: the principals to read for `ids` — every id that parses, live ones (not in the ledger) first,
 *  then by the ledger's `last` seen, capped at {@link MAX_PEER_IDS}. An id that is not an
 *  `<owner>.<actor>` principal fails loud: under auth every card id is one. */
export function peerPrincipals(ids: Iterable<string>, ledger: Ledger): { principals: Principal[]; omitted: number } {
  const all = [...new Set(ids)];
  for (const id of all) if (!parsePrincipalKey(id)) throw new Error(`paw: "${id}" is not an <owner>.<actor> principal — can't scope a chat-peers cred to it`);
  const rank = (id: string): number => (ledger[id] ? ledger[id]!.last : Infinity);
  const sorted = all.sort((a, b) => rank(b) - rank(a));
  return { principals: sorted.slice(0, MAX_PEER_IDS).map((id) => parsePrincipalKey(id)!), omitted: Math.max(0, sorted.length - MAX_PEER_IDS) };
}

/** Pure: everything that is ONE agent's own traffic, per id — DMs addressed to it, DMs it sent, and its
 *  channel posts — as (stream, filter) pairs. Each filter names the agent's principal in a concrete
 *  slot; none is the space wildcard. */
export function agentTrafficReads(space: string, principals: Principal[]): Array<{ stream: string; filter: string }> {
  return principals.flatMap((p) => [
    { stream: dmStream(space), filter: unicastRecvFilter(space, p.owner, p.actor) },
    { stream: dmStream(space), filter: unicastSubject(space, "*", "*", p.owner, p.actor) },
    { stream: chatStream(space), filter: chatSubject(space, p.owner, p.actor, ">") },
  ]);
}

/** Pure: NATS-safe, per-read consumer names for one chat-peers read. */
export function peerConsumerNames(space: string, agent: string, nonce: string, n: number): string[] {
  const h = createHash("sha256").update(`${space}\0${agent.toLowerCase()}\0${nonce}`).digest("hex").slice(0, 16);
  return Array.from({ length: n }, (_, i) => `pawcp_${h}_${i}`);
}

/** Seams for the hermetic check (scripts/check-remote.ts); production uses the real signer and dial. */
export interface PeerDeps {
  sign: typeof signScopedCreds;
  connect: typeof connect;
}
const realDeps: PeerDeps = { sign: signScopedCreds, connect };

/** A stored/tapped frame as the message it carries; a chat-stream frame gets its channel from the subject. */
function frameMessage(subject: string, data: unknown): (CotalMessage & RawMsg) | undefined {
  if (!data || typeof data !== "object") return undefined;
  const m = data as CotalMessage & RawMsg;
  if (m.channel) return m;
  const p = parseSubject(subject);
  return p?.kind === "chat" ? ({ ...m, channel: p.rest } as CotalMessage & RawMsg) : m;
}

/**
 * Everything that classifies as `agent`'s other-peer traffic — the messages view's earlier rows.
 * OPEN mesh: the whole DM stream (every DM, agent↔agent included) plus every channel's backlog.
 * REMOTE: a fresh `chat-peers` cred per call (signed from the space signer the operator holds, 5 min),
 * holding only name+filter-pinned consumers on {@link agentTrafficReads} for every id the agent has had.
 * A recipient is named from the stream's senders, paw's ledger, then the caller's live roster (a peer
 * that only ever received has no name in the stream). `onOmitted` hears how many older ids were left out.
 */
export async function readPeerTraffic(
  ep: CotalEndpoint,
  space: string,
  server: string,
  agent: string,
  knownIds: ReadonlySet<string>,
  rosterName: (id: string) => string | undefined,
  o: { onOmitted?: (n: number) => void; deps?: PeerDeps } = {},
): Promise<PeerMsg[]> {
  const ledger = cachedLedger(space);
  const key = agent.toLowerCase();
  const agentIds = new Set(knownIds);
  for (const [id, e] of Object.entries(ledger)) if (e.name.toLowerCase() === key) agentIds.add(id);
  const msgs = isRemoteSpace(space) ? await readAgentTrafficRemote(space, server, agent, agentIds, ledger, o) : await readSpaceTraffic(ep);
  const nameById = new Map<string, string>();
  for (const [id, e] of Object.entries(ledger)) nameById.set(id, e.name);
  for (const m of msgs) if (m.from?.id && m.from.name) nameById.set(m.from.id, m.from.name);
  for (const [id, name] of nameById) if (name.toLowerCase() === key) agentIds.add(id);
  const me = ep.card.id;
  const out: PeerMsg[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const who = classifyPeer(m, { agent, agentIds, me, nameOf: (id) => nameById.get(id) ?? rosterName(id) });
    if (!who) continue;
    if (!m.id) throw new Error(`paw: a history row from ${m.from.name} at ${m.ts} has no id — can't dedup it against the live view`);
    if (seen.has(m.id)) continue; // one DM can match two of an agent's filters (to an old id of itself)
    seen.add(m.id);
    out.push(peerMsg(m, who));
  }
  return dropPairedPeerForwards(out).sort((a, b) => a.ts - b.ts);
}

async function readSpaceTraffic(ep: CotalEndpoint): Promise<Array<CotalMessage & RawMsg>> {
  const dms = await ep.dmHistory({ limit: FETCH_CAP });
  const channels = (await ep.listChannels()).filter((c) => c.messages > 0 && !/[*>]/.test(c.channel)).map((c) => c.channel);
  const posts = channels.length ? (await ep.multiChannelHistory(channels, { limit: FETCH_CAP })).map((r) => ({ ...r.msg, channel: r.channel })) : [];
  return [...dms, ...posts] as Array<CotalMessage & RawMsg>;
}

async function readAgentTrafficRemote(
  space: string,
  server: string,
  agent: string,
  agentIds: ReadonlySet<string>,
  ledger: Ledger,
  o: { onOmitted?: (n: number) => void; deps?: PeerDeps },
): Promise<Array<CotalMessage & RawMsg>> {
  const deps = o.deps ?? realDeps;
  const { principals, omitted } = peerPrincipals(agentIds, ledger);
  if (!principals.length) throw new Error(`no mesh id is known for ${agent} on ${space} — nothing to read its messages by`);
  if (omitted) o.onOmitted?.(omitted);
  const reads = agentTrafficReads(space, principals);
  const names = peerConsumerNames(space, agent, randomUUID(), reads.length);
  const creds = await deps.sign(space, "chat-peers", newIdentity(), pinnedReadGrants(reads.map((r, i) => ({ ...r, name: names[i]! }))), PEERS_TTL_SEC);
  const nc = await deps.connect({
    servers: server,
    ...natsTls(space),
    authenticator: credsAuthenticator(enc.encode(creds)),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
    maxReconnectAttempts: 0,
    timeout: 5_000,
  });
  try {
    const pages = await Promise.all(reads.map((r, i) => readFiltered(nc, space, r.filter, 0, names[i]!, false, r.stream)));
    return pages.flatMap((p) => p.msgs.map((m) => frameMessage(m.subject, m.data)).filter((m): m is CotalMessage & RawMsg => !!m?.from && !!m.id));
  } finally {
    await nc.close().catch(() => {});
  }
}

/**
 * The messages view's live other-peer rows on a REMOTE space: ONE agent's own subjects
 * ({@link agentTrafficReads}' filters, as plain subscriptions) over a second connection holding a
 * `chat-peers` tap cred — subscribe only, 5 minutes. Before it runs out, the tap re-reads `ids()` (a
 * restarted agent has a new one), signs a fresh cred and opens the new connection BEFORE closing the old
 * (no gap; duplicates dedup by id downstream). `onGap(false/true)` hears the connection drop and come
 * back, so the caller can read the gap back. Returns stop. A no-op on an open mesh.
 */
export async function tapAgentTraffic(
  space: string,
  server: string,
  agent: string,
  ids: () => Iterable<string>,
  handler: TapHandler,
  onError: (e: Error) => void,
  onGap: (connected: boolean) => void,
  o: { deps?: PeerDeps; tickMs?: number; onOmitted?: (n: number) => void } = {},
): Promise<() => Promise<void>> {
  if (!isRemoteSpace(space)) return async () => {};
  const deps = o.deps ?? realDeps;
  let stopped = false;
  const open = async (): Promise<{ nc: NatsConnection; creds: string }> => {
    const { principals, omitted } = peerPrincipals(ids(), cachedLedger(space));
    if (!principals.length) throw new Error(`no mesh id is known for ${agent} on ${space} — nothing to tap its messages by`);
    if (omitted) o.onOmitted?.(omitted);
    const subjects = agentTrafficReads(space, principals).map((r) => r.filter);
    const creds = await deps.sign(space, "chat-peers", newIdentity(), tapGrants(subjects), PEERS_TTL_SEC);
    const nc = await deps.connect({
      servers: server,
      ...natsTls(space),
      authenticator: credsAuthenticator(enc.encode(creds)),
      inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
    });
    for (const subject of subjects) {
      const sub = nc.subscribe(subject);
      void (async () => {
        for await (const m of sub) {
          let decoded: unknown;
          try {
            decoded = m.json();
          } catch {
            decoded = undefined;
          }
          handler(m.subject, frameMessage(m.subject, decoded));
        }
      })().catch((e: Error) => onError(new Error(`paw: the messages view's tap on ${agent} stopped: ${e.message}`)));
    }
    void (async () => {
      for await (const st of nc.status()) {
        if (st.type === "disconnect") onGap(false);
        else if (st.type === "reconnect") onGap(true);
      }
    })().catch(() => {});
    void nc.closed().then((err) => {
      if (err && !stopped && cur.nc === nc) onError(new Error(`paw: the messages view's tap on ${agent} closed: ${err.message}`));
    });
    return { nc, creds };
  };
  const cur = await open();
  let renewing = false;
  const renew = setInterval(() => {
    if (stopped || renewing || credsSecondsLeft(cur.creds) > PEERS_RENEW_BEFORE_SEC) return;
    renewing = true;
    open()
      .then((fresh) => {
        const old = cur.nc;
        Object.assign(cur, fresh);
        if (stopped) return fresh.nc.close();
        return old.close();
      })
      .catch((e: Error) => onError(new Error(`paw: couldn't renew the messages view's chat-peers cred for ${agent}: ${e.message}`)))
      .finally(() => (renewing = false));
  }, o.tickMs ?? 30_000);
  renew.unref();
  return async () => {
    stopped = true;
    clearInterval(renew);
    await cur.nc.close().catch(() => {});
  };
}

/** A classified wire message as a {@link PeerMsg}: the text the sender wrote (a stale-id forward's note
 *  dropped), and for a DM the wire ids a forward is paired by. */
export function peerMsg(m: CotalMessage & RawMsg, who: { from: string; to: string }): PeerMsg {
  const forwardOf = forwardedFrom(m.parts);
  const dm = !m.channel && !m.toService && !!m.to;
  return {
    id: m.id,
    ts: m.ts,
    from: who.from,
    to: who.to,
    text: messageText({ ...m, parts: withoutForwardNote(m.parts) }),
    ...(dm && m.from.id ? { fromId: m.from.id } : {}),
    ...(dm ? { toId: m.to } : {}),
    ...(forwardOf !== undefined ? { forwardOf } : {}),
  };
}

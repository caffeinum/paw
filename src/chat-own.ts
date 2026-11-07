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
 * The messages view's other-peer rows (another agent's mail, by design) are OPEN-mesh only
 * ({@link tapPeerTraffic}, {@link readPeerTraffic}); on a remote space they are refused, never read
 * with a widened cred.
 */
import { createHash, randomUUID } from "node:crypto";
import { chatSubject, type CotalMessage, idFromCreds, newIdentity, parsePrincipalKey, unicastRecvFilter, unicastSubject, type CotalEndpoint } from "@cotal-ai/core";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { classifyPeer, type PeerMsg, type RawMsg } from "./chat-peers.ts";
import { conversationEntries, dmRow, FETCH_CAP, messageText, readConversation, type Entry } from "./feed.ts";
import { cachedLedger } from "./peer-ledger.ts";
import { ECHO_TTL_SEC, FORWARD_TTL_SEC, RENEW_BEFORE_SEC, credsSecondsLeft, echoGrants, filteredReadGrants, signScopedCreds } from "./remote-creds.ts";
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
 *  (src/chat-backlog.ts) reads through here; the only other DM-stream read in chat is {@link readPeerTraffic} (open mesh only). */
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
 * The messages view's live other-peer rows (src/chat-peers.ts). OPEN mesh: a space-wide tap, like the
 * echo's — `handler` sees every frame and classifies it. REMOTE: false, and nothing is tapped — chat's
 * creds cover only "you"'s own subjects and paw mints no narrow cred for another agent's mail, so the
 * view says that loudly instead. Sync, attached before the endpoint starts (no frame is missed).
 */
export function tapPeerTraffic(ep: CotalEndpoint, space: string, handler: TapHandler): boolean {
  if (isRemoteSpace(space)) return false;
  ep.tap(handler);
  return true;
}

/**
 * Everything the DM and chat streams hold that classifies as `agent`'s other-peer traffic — the
 * messages view's earlier rows. OPEN mesh only: the whole DM stream (every DM, agent↔agent included)
 * plus every channel's backlog. A recipient is named from the stream's senders, paw's ledger, then the
 * caller's live roster (a peer that only ever received has no name in the stream). A remote space THROWS: those reads need the space-wide `admin` cred
 * (what `paw history`/`paw web` hold), and chat never widens its creds silently.
 */
export async function readPeerTraffic(
  ep: CotalEndpoint,
  space: string,
  agent: string,
  knownIds: ReadonlySet<string>,
  rosterName: (id: string) => string | undefined,
): Promise<PeerMsg[]> {
  if (isRemoteSpace(space)) throw new Error(`other-peer messages aren't readable with this chat's credentials on a remote space (${space})`);
  const me = ep.card.id;
  const dms = await ep.dmHistory({ limit: FETCH_CAP });
  const channels = (await ep.listChannels()).filter((c) => c.messages > 0 && !/[*>]/.test(c.channel)).map((c) => c.channel);
  const posts = channels.length ? (await ep.multiChannelHistory(channels, { limit: FETCH_CAP })).map((r) => ({ ...r.msg, channel: r.channel })) : [];
  const nameById = new Map<string, string>();
  for (const [id, e] of Object.entries(cachedLedger(space))) nameById.set(id, e.name);
  for (const m of dms) if (m.from.id && m.from.name) nameById.set(m.from.id, m.from.name);
  const key = agent.toLowerCase();
  const agentIds = new Set(knownIds);
  for (const [id, name] of nameById) if (name.toLowerCase() === key) agentIds.add(id);
  const out: PeerMsg[] = [];
  for (const m of [...dms, ...posts]) {
    const who = classifyPeer(m as RawMsg, { agent, agentIds, me, nameOf: (id) => nameById.get(id) ?? rosterName(id) });
    if (!who) continue;
    if (!m.id) throw new Error(`paw: a history row from ${m.from.name} at ${m.ts} has no id — can't dedup it against the live view`);
    out.push({ id: m.id, ts: m.ts, from: who.from, to: who.to, text: messageText(m as CotalMessage) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

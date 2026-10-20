/**
 * What `paw chat` reads of "you"'s OWN mail beyond its inbox: the cross-session echo (what another
 * `paw chat` sent) and the tasks view's last-exchange seed.
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
 */
import { createHash, randomUUID } from "node:crypto";
import { chatSubject, idFromCreds, newIdentity, parsePrincipalKey, unicastRecvFilter, unicastSubject, type CotalEndpoint } from "@cotal-ai/core";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { conversationEntries, dmRow, readConversation, type Entry } from "./feed.ts";
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
  if (!isRemoteSpace(space)) {
    ep.tap(handler);
    return async () => {};
  }
  const { chat, dm } = ownSendSubjects(space, principalOfId(ep.card.id));
  ep.tap(handler, { subject: chat });

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

/** "you"'s conversation, both directions — the whole DM stream on an open mesh, only "you"'s own
 *  mail on a remote space. */
export async function readOwnConversation(ep: CotalEndpoint, space: string, server: string): Promise<Entry[]> {
  if (!isRemoteSpace(space)) return readConversation(ep, { withSent: true });
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
    return conversationEntries(rows, me, space, { withSent: true });
  } finally {
    await nc.close().catch(() => {});
  }
}

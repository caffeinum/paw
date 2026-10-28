/**
 * Narrow, paw-shaped credentials for a REMOTE (JWT-authed) space, signed with the space's account
 * signer (`<root>/.cotal/auth/auth.json`, the file `paw mesh add` recorded).
 *
 * cotal mints only its own profiles, and none of them fits what paw's status and sleep host need on
 * an authed broker without handing out far more: the `admin` "god view" reads every DM in the space.
 * So paw signs its own user JWTs with an explicit allow-list per job, nothing else:
 *
 *  - `inbox-lag` (paw status): `$JS.API.CONSUMER.INFO.DM_<space>.*` + its own reply inbox. Read-only
 *    consumer metadata on the DM stream. CACHED at `spaces/<s>/creds/inbox-lag.creds` (0600) and
 *    re-signed once less than {@link RENEW_BEFORE_SEC} of its {@link LAG_TTL_SEC} life is left.
 *  - `sleep-watch` (sleep host, `paw sleep`): one per sleeping agent, in memory only. Subscribe to the
 *    stand-in's and the despawned seat's DM subjects, and read them back through consumers whose NAME
 *    and FILTER are pinned in the grant (a stream-wide MSG.NEXT would let it drain an agent's durable).
 *  - `sleep-forward` (sleep host, on wake): one-shot, 5 minutes. Publish ONLY to the woken seat's DM
 *    subjects from the exact senders found in the backlog — the re-delivery under the original sender
 *    an open mesh allows implicitly, and nothing wider.
 *  - `chat-echo` (`paw chat`): subscribe to "you"'s OWN outbound DM subject (`inst.*.*.<o>.<you>`), so
 *    one chat session mirrors what another sent. Nobody else's mail. 24h, re-signed in place.
 *  - `chat-history` (`paw chat` tasks view): one-shot, 5 minutes. Read "you"'s own conversation (DMs
 *    to and from "you") through named, filter-pinned consumers — the same shape as `sleep-watch`.
 *  - `presence-probe` (wake gate, `paw status`): one per probe, 60s, in memory only. Publish to exactly
 *    ONE throwaway presence key (`$KV.cotal_presence_<space>.paw-probe-<hex>`) — the put and the KV
 *    purge marker that clears it share that subject. No `$JS.API`, no other key, no subscribe. Signed
 *    for local PAW_AUTH spaces too (any space whose auth loads), so latch detection works under auth.
 *
 * Every cred is a bearer secret: written 0600, never printed or logged.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credsClaims, dmStream, newIdentity, presenceBucket, type Identity } from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { pawCotalRoot } from "./cotal-root.ts";

export const LAG_TTL_SEC = 24 * 3600;
export const WATCH_TTL_SEC = 24 * 3600;
export const FORWARD_TTL_SEC = 5 * 60;
export const ECHO_TTL_SEC = 24 * 3600;
export const PROBE_TTL_SEC = 60;
/** Re-sign a cached / held cred once less than this is left of it. */
export const RENEW_BEFORE_SEC = 3600;

export interface Grants {
  pub: string[];
  sub: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function stateRoot(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

/** The space's signer, or a loud error naming where it should be. */
function signer(space: string) {
  const dir = authDir(pawCotalRoot(space));
  const auth = loadSpaceAuth(dir, space);
  if (!auth?.account?.signingSeed) throw new Error(`paw: space "${space}" is remote but no account signer loads under ${dir} — see \`paw mesh add\``);
  return auth;
}

/** Sign a user cred for `identity` holding exactly `grants` (plus its own `_INBOX_<id>.>` reply inbox). */
export async function signScopedCreds(space: string, label: string, identity: Identity, grants: Grants, ttlSec: number): Promise<string> {
  const auth = signer(space);
  const inbox = `_INBOX_${identity.id}.>`;
  const jwt = await encodeUser(
    `paw-${label}`,
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    { pub: { allow: [...grants.pub] }, sub: { allow: [inbox, ...grants.sub] } },
    { signer: fromSeed(enc.encode(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + ttlSec },
  );
  return dec.decode(fmtCreds(jwt, fromSeed(enc.encode(identity.seed))));
}

/** Seconds of life left in a creds file (negative once expired). A cred with no `exp` is a bug here. */
export function credsSecondsLeft(creds: string, nowSec = Math.floor(Date.now() / 1000)): number {
  const exp = credsClaims(creds).exp;
  if (typeof exp !== "number") throw new Error("paw: a paw-scoped cred carries no expiry");
  return exp - nowSec;
}

/** Pure: the inbox-lag reader's grants — consumer INFO on the DM stream, nothing else. */
export function lagGrants(space: string): Grants {
  return { pub: [`$JS.API.CONSUMER.INFO.${dmStream(space)}.*`], sub: [] };
}

export function lagCredsPath(space: string): string {
  return join(stateRoot(), "spaces", space, "creds", "inbox-lag.creds");
}

/** The cached inbox-lag reader cred for a remote space, re-signed before it expires. */
export async function lagReaderCreds(space: string): Promise<string> {
  const file = lagCredsPath(space);
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf8");
    if (credsSecondsLeft(cur) > RENEW_BEFORE_SEC) return cur;
  }
  const creds = await signScopedCreds(space, "inbox-lag", newIdentity(), lagGrants(space), LAG_TTL_SEC);
  mkdirSync(join(stateRoot(), "spaces", space, "creds"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, creds, { mode: 0o600 });
  renameSync(tmp, file);
  return creds;
}

/** Deterministic, NATS-safe consumer names for one sleeping agent's backlog reads — one per filter,
 *  per purpose, so the grant can pin them exactly. `purpose` keeps the CLI's count (`paw sleep`) and
 *  the host's reads from ever colliding on one name. */
export function watchConsumerName(space: string, name: string, purpose: "host" | "cli", i: number): string {
  return `pawsl_${createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 16)}_${purpose}${i}`;
}

/** Pure: a sleep watcher's grants — live subscribe + pinned named-consumer reads on exactly `filters`. */
export function watchGrants(space: string, filters: string[], names: string[]): Grants {
  return { pub: filteredReadGrants(space, filters, names).pub, sub: [...filters] };
}

/** Pure: pinned named-consumer reads on exactly `filters` of the DM stream, no live subscribe. */
export function filteredReadGrants(space: string, filters: string[], names: string[]): Grants {
  if (filters.length !== names.length) throw new Error("paw: a filtered read needs one consumer name per filter");
  const DM = dmStream(space);
  const pub = [`$JS.API.INFO`, `$JS.API.STREAM.INFO.${DM}`];
  filters.forEach((f, i) => {
    const n = names[i]!;
    pub.push(`$JS.API.CONSUMER.CREATE.${DM}.${n}.${f}`, `$JS.API.CONSUMER.INFO.${DM}.${n}`, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${n}`, `$JS.API.CONSUMER.DELETE.${DM}.${n}`);
  });
  return { pub, sub: [] };
}

/** Pure: the chat echo's grants — subscribe to `subject` ("you"'s own outbound DMs), publish nothing. */
export function echoGrants(subject: string): Grants {
  return { pub: [], sub: [subject] };
}

/** Pure: the forwarder's grants — publish to exactly these DM subjects (the woken seat, each sender). */
export function forwardGrants(subjects: string[]): Grants {
  return { pub: [...new Set(subjects)], sub: [] };
}

/** Pure: the presence probe's grants — publish to exactly one presence key, nothing else. */
export function presenceProbeGrants(space: string, key: string): Grants {
  if (!/^paw-probe-[0-9a-f]+$/.test(key)) throw new Error(`paw: "${key}" is not a presence probe key`);
  return { pub: [`$KV.${presenceBucket(space)}.${key}`], sub: [] };
}

/** The cred a presence probe of `key` runs with: undefined on an open mesh (no auth loads for the
 *  space), else a fresh one-key cred signed with the space's signer (which fails loud when absent). */
export async function presenceProbeCreds(space: string, key: string): Promise<string | undefined> {
  if (!loadSpaceAuth(authDir(pawCotalRoot(space)), space)) return undefined;
  return signScopedCreds(space, "presence-probe", newIdentity(), presenceProbeGrants(space, key), PROBE_TTL_SEC);
}

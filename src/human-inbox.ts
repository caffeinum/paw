/**
 * The CONSUMING "you" (`paw chat`) and the durable DM inbox it binds.
 *
 * Open mesh: the endpoint self-mints a lifecycle uid and self-creates its `dm_<owner>-<actor>-<uid>`
 * durable (with an inactive threshold that retires it after chat leaves) — nothing to do here.
 *
 * Authed (remote) mesh: cotal 0.84 lets an agent cred only BIND its inbox durables; creating them is a
 * privileged `provisioner` act (the create-time filter is the attack surface), done by whoever launches
 * the endpoint — the manager for its agents, `cotal spawn` for a foreground one. Nobody launches "you":
 * the mailbox beacon is consume:false and binds nothing, so a chat that minted a fresh uid bound a
 * durable no one had created and cotal's `pump()` died with a bare "consumer not found". So chat does
 * what `cotal spawn` does for a foreground agent: provision this lifecycle's DM + DELIVER durables and
 * read-ACL row under the signer, mint the agent cred for the SAME uid, and retire the footprint on exit
 * (an authed durable has no inactive threshold — it would outlive every chat forever otherwise).
 *
 * The footprint is LEDGERED before it exists (`$PAW_HOME/spaces/<s>/chat-inboxes/<uid>.json`): chat's UI
 * is up before startup finishes, so a quit can land mid-provision. The ledger entry is written by
 * {@link prepareHumanInbox} (local work only), its release is registered before {@link PreparedInbox.provision}
 * dials, and an entry a dead chat left behind is retired by the next one ({@link sweepOrphanInboxes}).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  aclKey,
  CotalEndpoint,
  DEV_OWNER,
  dlvDurable,
  dlvStream,
  dmDurable,
  dmStream,
  isConsumerNotFound,
  memberKey,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  openAclRegistry,
  openMembersRegistry,
  principalKey,
  provisionAgentDurables,
  standaloneConnectOpts,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { humanEndpointAuth, remoteHumanIdentity, spaceDir } from "./addressing.ts";
import { pawCotalRoot } from "./cotal-root.ts";
import { pidAlive } from "./lock.ts";
import { readRemoteMesh } from "./remote-mesh.ts";

export interface HumanInbox {
  /** Spread into the consuming CotalEndpoint: creds (+ tls + the provisioned lifecycle uid). */
  auth: { creds?: string; tls?: true; lifecycleUid?: string };
}

/**
 * A chat inbox before anything touches the broker: its lifecycle uid is minted and written to the
 * cleanup ledger, so `release` exists — and is registered by the caller — BEFORE `provision` makes the
 * first remote durable. A chat killed mid-provision (a second Ctrl-C, a crash) leaves a ledger entry the
 * next `paw chat` retires, never a durable nobody knows about.
 */
export interface PreparedInbox {
  /** The lifecycle uid every name this run creates embeds; undefined on an open mesh (nothing to retire). */
  uid?: string;
  /** Create the remote footprint and mint the cred bound to it. */
  provision(): Promise<HumanInbox>;
  /** Retire whatever provision made (safe whether it ran, half-ran or never ran), then drop the ledger
   *  entry. Idempotent once it succeeds. Throws naming what it left behind — the entry then stays. */
  release(): Promise<void>;
}

/** Every channel a "you" chat may read or post — the same full grant a paw agent's persona carries. */
const HUMAN_CHANNEL_GRANT = [">"];

/** One remote chat inbox this machine may have left on a broker. */
export interface InboxLedgerEntry {
  pid: number;
  server: string;
  channels: string[];
  startedAt: number;
}

export function inboxLedgerDir(space: string): string {
  return join(spaceDir(space), "chat-inboxes");
}

export function writeLedger(space: string, uid: string, entry: InboxLedgerEntry): void {
  const dir = inboxLedgerDir(space);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${uid}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, join(dir, `${uid}.json`));
}

export function readLedger(space: string): { uid: string; entry: InboxLedgerEntry }[] {
  const dir = inboxLedgerDir(space);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const file = join(dir, f);
      const v = JSON.parse(readFileSync(file, "utf8")) as Partial<InboxLedgerEntry>;
      if (typeof v.pid !== "number" || typeof v.server !== "string" || !Array.isArray(v.channels) || typeof v.startedAt !== "number")
        throw new Error(`paw: ${file} is not a chat-inbox ledger entry {pid, server, channels, startedAt}`);
      return { uid: f.slice(0, -".json".length), entry: v as InboxLedgerEntry };
    });
}

/**
 * Local work only — the signer, the identity, a fresh lifecycle uid and its ledger entry. Nothing here
 * dials the broker, so a quit at any moment after it returns can be cleaned up exactly.
 */
export async function prepareHumanInbox(space: string, server: string, channels: string[]): Promise<PreparedInbox> {
  if (!readRemoteMesh(space)) return { provision: async () => ({ auth: await humanEndpointAuth(space, "agent") }), release: async () => {} };
  const auth = loadSpaceAuth(authDir(pawCotalRoot(space)), space);
  if (!auth) throw new Error(`paw: space "${space}" is remote but no signer loads under ${authDir(pawCotalRoot(space))} — see \`paw mesh add\``);
  const identity = remoteHumanIdentity(space);
  const lifecycleUid = mintLifecycleUid();
  const target = { owner: DEV_OWNER, actor: identity.id, lifecycleUid };
  writeLedger(space, lifecycleUid, { pid: process.pid, server, channels, startedAt: Date.now() });
  let released: Promise<void> | undefined;
  return {
    uid: lifecycleUid,
    provision: async () => {
      const delay = Number(process.env.PAW_TEST_PROVISION_DELAY_MS ?? 0); // e2e seam: widens the mid-provision window
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const prov = new CotalEndpoint({
        space,
        servers: server,
        creds: await mintCreds(auth, newIdentity(), "provisioner"),
        tls: true,
        channels: [],
        consume: false,
        registerPresence: false,
        watchPresence: false,
        watchChannels: false,
        card: { name: "paw-chat-provisioner", role: "provisioner", kind: "endpoint" },
      });
      prov.on("error", (e: Error) => console.error(`paw: chat inbox provisioner: ${e.message}`));
      await prov.start();
      try {
        await provisionAgentDurables(prov, target, { subscribe: channels, allowSubscribe: HUMAN_CHANNEL_GRANT });
      } catch (e) {
        throw new Error(`paw: couldn't provision "you"'s chat inbox on remote space "${space}" (${server}) — the space signer must be allowed to create DM/DELIVER durables: ${(e as Error).message}`);
      } finally {
        await prov.stop().catch(() => {});
      }
      const creds = await mintCreds(auth, identity, "agent", {
        lifecycleUid,
        allowSubscribe: HUMAN_CHANNEL_GRANT,
        allowPublish: HUMAN_CHANNEL_GRANT,
      });
      return { auth: { creds, tls: true, lifecycleUid } };
    },
    release: () =>
      (released ??= retireUid(space, server, lifecycleUid, channels).catch((e: Error) => {
        released = undefined; // a failed retire may be tried again; the ledger entry stays meanwhile
        throw e;
      })),
  };
}

/** Retire one lifecycle's footprint under a fresh deprovisioner cred, then drop its ledger entry. */
async function retireUid(space: string, server: string, lifecycleUid: string, channels: string[]): Promise<void> {
  const auth = loadSpaceAuth(authDir(pawCotalRoot(space)), space);
  if (!auth) throw new Error(`paw: space "${space}" is remote but no signer loads under ${authDir(pawCotalRoot(space))} — chat inbox ${lifecycleUid} is left on the broker`);
  const identity = remoteHumanIdentity(space);
  const teardown = await mintCreds(auth, newIdentity(), "deprovisioner", {
    deprovisionTarget: { principal: identity.id, lifecycleUid, memberChannels: channels },
  });
  await retireHumanInbox(space, server, teardown, { owner: DEV_OWNER, actor: identity.id, lifecycleUid }, channels);
  rmSync(join(inboxLedgerDir(space), `${lifecycleUid}.json`), { force: true });
}

/**
 * Retire the chat inboxes a dead `paw chat` left in the ledger (a second Ctrl-C mid-startup, a crash, a
 * closed terminal). Entries whose pid is alive belong to another running chat and are skipped. A
 * failure on any entry is thrown after the others were tried — never swallowed.
 */
export async function sweepOrphanInboxes(
  space: string,
  alive: (pid: number) => boolean = pidAlive,
  retire: (space: string, server: string, uid: string, channels: string[]) => Promise<void> = retireUid,
): Promise<{ retired: string[]; skipped: string[] }> {
  if (!readRemoteMesh(space)) return { retired: [], skipped: [] };
  const retired: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const { uid, entry } of readLedger(space)) {
    if (entry.pid === process.pid || alive(entry.pid)) {
      skipped.push(uid);
      continue;
    }
    try {
      await retire(space, entry.server, uid, entry.channels);
      retired.push(uid);
    } catch (e) {
      failed.push(`${uid}: ${(e as Error).message}`);
    }
  }
  if (failed.length) throw new Error(`paw: couldn't retire ${failed.length} orphaned chat inbox${failed.length === 1 ? "" : "es"} on "${space}": ${failed.join("; ")}`);
  return { retired, skipped };
}

/**
 * cotal's `deprovisionAgent`, with TLS REQUIRED: cotal's dials with `tls: false` (not yet wired to a
 * transport), which hands the cred to a plaintext listener at that address. Every name below embeds
 * this chat's lifecycle uid, so it can touch nothing but this run's own footprint. Tolerant of a
 * footprint that was never (fully) made — a quit mid-provision: an absent consumer is not an error, and
 * a KV purge of an absent key only writes a purge marker.
 */
async function retireHumanInbox(space: string, server: string, creds: string, t: { owner: string; actor: string; lifecycleUid: string }, channels: string[]): Promise<void> {
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: true }), maxReconnectAttempts: 0, timeout: 5_000 });
  const left: string[] = [];
  try {
    const jsm = await jetstreamManager(nc);
    const principal = principalKey(t.owner, t.actor).key;
    await (await openAclRegistry(nc, space)).purge(aclKey(principal, t.lifecycleUid)).catch((e: Error) => left.push(`read-ACL row (${e.message})`));
    if (channels.length) {
      const members = await openMembersRegistry(nc, space);
      for (const ch of channels)
        await members.purge(memberKey(ch, principal, t.lifecycleUid)).catch((e: Error) => left.push(`#${ch} membership (${e.message})`));
    }
    for (const [stream, name] of [
      [dmStream(space), dmDurable(t.owner, t.actor, t.lifecycleUid)],
      [dlvStream(space), dlvDurable(t.owner, t.actor, t.lifecycleUid)],
    ] as const) {
      await jsm.consumers.delete(stream, name).catch((e: Error) => {
        if (!isConsumerNotFound(e)) left.push(`${stream}/${name} (${e.message})`);
      });
    }
  } finally {
    await nc.drain().catch(() => {});
  }
  if (left.length) throw new Error(`paw: chat left its inbox footprint on "${space}": ${left.join("; ")}`);
}

/**
 * The bind failure, said plainly. cotal's own text is the bare JetStream "consumer not found": it names
 * neither the durable nor why it is missing.
 */
export function describeInboxBindFailure(space: string, uid: string | undefined, e: Error): Error {
  if (!/consumer not found/i.test(e.message)) return e;
  const remote = !!readRemoteMesh(space);
  return new Error(
    remote
      ? `paw: chat couldn't bind "you"'s DM inbox on remote space "${space}" — the durable for lifecycle ${uid ?? "?"} is not at the broker ` +
          `(provisioned, then deleted under it?). Nothing is lost: \`paw inbox --space ${space}\` reads every DM. (${e.message})`
      : `paw: chat couldn't bind "you"'s DM inbox on space "${space}" — its durable is missing at the broker (${e.message})`,
  );
}

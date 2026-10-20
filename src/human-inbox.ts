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
 */
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
import { humanEndpointAuth, remoteHumanIdentity } from "./addressing.ts";
import { pawCotalRoot } from "./cotal-root.ts";
import { readRemoteMesh } from "./remote-mesh.ts";

export interface HumanInbox {
  /** Spread into the consuming CotalEndpoint: creds (+ tls + the provisioned lifecycle uid). */
  auth: { creds?: string; tls?: true; lifecycleUid?: string };
  /** Retire what open() provisioned. No-op on an open mesh. Throws naming what it left behind. */
  release(): Promise<void>;
}

/** Every channel a "you" chat may read or post — the same full grant a paw agent's persona carries. */
const HUMAN_CHANNEL_GRANT = [">"];

export async function openHumanInbox(space: string, server: string, channels: string[]): Promise<HumanInbox> {
  if (!readRemoteMesh(space)) return { auth: await humanEndpointAuth(space, "agent"), release: async () => {} };
  const auth = loadSpaceAuth(authDir(pawCotalRoot(space)), space);
  if (!auth) throw new Error(`paw: space "${space}" is remote but no signer loads under ${authDir(pawCotalRoot(space))} — see \`paw mesh add\``);
  const identity = remoteHumanIdentity(space);
  const lifecycleUid = mintLifecycleUid();
  const target = { owner: DEV_OWNER, actor: identity.id, lifecycleUid };

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
  return {
    auth: { creds, tls: true, lifecycleUid },
    release: async () => {
      const teardown = await mintCreds(auth, newIdentity(), "deprovisioner", {
        deprovisionTarget: { principal: identity.id, lifecycleUid, memberChannels: channels },
      });
      await retireHumanInbox(space, server, teardown, target, channels);
    },
  };
}

/**
 * cotal's `deprovisionAgent`, with TLS REQUIRED: cotal's dials with `tls: false` (not yet wired to a
 * transport), which hands the cred to a plaintext listener at that address. Every name below embeds
 * this chat's lifecycle uid, so it can touch nothing but this run's own footprint.
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

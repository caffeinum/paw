/**
 * The sleep host: keeps a sleeping agent ADDRESSABLE and wakes it on its first DM.
 *
 * Runs inside the mailbox daemon (already one long-lived beacon process per space that `ensure()` keeps
 * up). For every `sleep/<name>.json` it raises a STAND-IN presence under the agent's name, with a stable
 * per-agent actor (`standInActor`), so a sender's `cotal_dm("<name>")` resolves to it instead of failing
 * with "no peer". It also listens on the despawned incarnation's own DM subject (`lastId`): a sender
 * that still holds the old, offline roster entry publishes there.
 *
 * A DM on either subject → lower the stand-in → `ensureAgentSpawned` (the normal interactive --resume
 * spawn) → once the new seat is live on the mesh, re-publish every DM that arrived since the sleep
 * (stream seq > cursorSeq on either subject) to the new principal, UNDER ITS ORIGINAL SENDER, so the
 * agent sees an ordinary DM it can answer. The new incarnation's durable starts at its activation
 * frontier (SPEC §8), which is AFTER the re-publish only because the re-publish waits for the seat.
 *
 * An external wake (`paw dm`, `paw chat`, `paw start`) goes through the same `ensureAgentSpawned`, whose
 * `prepareWake` flips the record to `.waking`; the host sees that, lowers the stand-in, and forwards the
 * backlog the same way.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_SERVER, DEV_OWNER, CotalEndpoint, dmStream, parsePrincipalKey, principalKey, unicastRecvFilter, unicastSubject } from "@cotal-ai/core";
import { connect, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import { DeliverPolicy, jetstream } from "@nats-io/jetstream";
import { ensureAgentSpawned, wirePrincipal, waitForMeshLive, type PsRow } from "./addressing.js";
import { withManagerControl } from "./control.js";
import { clearWaking, listSleeping, listWaking, markStandIn, readSleepRecord, sleepLog, standInActor, type SleepRecord } from "./sleep-state.js";

const TICK_MS = 1000;
const WAKE_READY_MS = 120_000;

interface StandIn {
  ep: CotalEndpoint;
  subs: Subscription[];
}

/** The subjects a sleeping agent's mail can arrive on: the stand-in's and the despawned seat's. */
export function backlogFilters(space: string, rec: SleepRecord): string[] {
  const out = [unicastRecvFilter(space, DEV_OWNER, standInActor(space, rec.name))];
  const old = rec.lastId ? parsePrincipalKey(rec.lastId) : undefined;
  if (old) out.push(unicastRecvFilter(space, old.owner, old.actor));
  return out;
}

/** The sender tokens of a DM subject `cotal.<space>.inst.<rO>.<rA>.<sO>.<sA>`, or undefined. */
export function dmSender(subject: string): { owner: string; actor: string } | undefined {
  const p = subject.split(".");
  return p.length === 7 && p[2] === "inst" ? { owner: p[5], actor: p[6] } : undefined;
}

/** Every DM stored on `filters` after `cursorSeq`, oldest first. */
async function readBacklog(nc: NatsConnection, space: string, filters: string[], cursorSeq: number): Promise<Array<{ subject: string; seq: number; data: Record<string, unknown> }>> {
  const js = jetstream(nc);
  const c = await js.consumers.get(dmStream(space), { filter_subjects: filters, deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: cursorSeq + 1 });
  const out: Array<{ subject: string; seq: number; data: Record<string, unknown> }> = [];
  try {
    for (;;) {
      if ((await c.info(true)).num_pending === 0) break;
      const batch = await c.fetch({ max_messages: 200, expires: 2000 });
      let n = 0;
      for await (const m of batch) {
        n++;
        try {
          out.push({ subject: m.subject, seq: m.seq, data: m.json() });
        } catch {
          /* not a cotal envelope — nothing to forward */
        }
      }
      if (n === 0) break;
    }
  } finally {
    await c.delete().catch(() => {});
  }
  return out;
}

export async function startSleepHost(space: string, server = DEFAULT_SERVER): Promise<() => Promise<void>> {
  const nc = await connect({ servers: server });
  const standIns = new Map<string, StandIn>();
  const inflight = new Set<string>();
  const failedAt = new Map<string, number>();

  const lower = async (name: string) => {
    const s = standIns.get(name);
    if (!s) return;
    standIns.delete(name);
    for (const sub of s.subs) sub.unsubscribe();
    await s.ep.stop().catch(() => {});
    markStandIn(space, name, false);
  };

  const raise = async (rec: SleepRecord) => {
    const ep = new CotalEndpoint({
      space,
      servers: server,
      channels: [],
      registerPresence: true,
      consume: false, // the backlog stays in the stream; the host reads it on wake
      watchPresence: false,
      card: { name: rec.name, kind: "agent", id: standInActor(space, rec.name), description: "asleep (paw sleep) — a DM wakes it" },
    });
    ep.on("error", (e: Error) => console.error(`[sleep] stand-in ${rec.name}: ${e.message}`));
    await ep.start();
    const subs = backlogFilters(space, rec).map((f) => {
      const sub = nc.subscribe(f);
      void (async () => {
        for await (const m of sub) {
          let from = "?";
          try {
            from = (m.json() as { from?: { name?: string } }).from?.name ?? "?";
          } catch {
            /* still a wake */
          }
          void wake(rec.name, `DM from ${from}`);
        }
      })();
      return sub;
    });
    standIns.set(rec.name, { ep, subs });
    markStandIn(space, rec.name, true);
    // Mail that landed between the despawn and this stand-in (on the old seat's subject) is a wake too.
    const pending = await readBacklog(nc, space, backlogFilters(space, rec), rec.cursorSeq);
    if (pending.length) void wake(rec.name, `${pending.length} DM(s) queued before the stand-in came up`);
  };

  /** Re-publish the backlog to the woken agent, each DM under its original sender. */
  const forward = async (rec: SleepRecord, newId: string): Promise<number> => {
    const target = parsePrincipalKey(newId);
    if (!target) throw new Error(`paw sleep: woken "${rec.name}" has no valid principal (${newId})`);
    const js = jetstream(nc);
    let n = 0;
    for (const { subject, data } of await readBacklog(nc, space, backlogFilters(space, rec), rec.cursorSeq)) {
      const snd = dmSender(subject);
      if (!snd) continue;
      const ts = typeof data.ts === "number" ? data.ts : Date.now();
      const parts = Array.isArray(data.parts) ? data.parts : [];
      const note = { kind: "text", text: `[sent ${Math.max(1, Math.round((Date.now() - ts) / 60_000))}m ago, while you were asleep]` };
      const msg = { ...data, id: randomUUID(), to: newId, parts: [note, ...parts] };
      await js.publish(unicastSubject(space, target.owner, target.actor, snd.owner, snd.actor), JSON.stringify(msg), { msgID: msg.id });
      n++;
    }
    return n;
  };

  /** Bring the agent up (if not already) and hand it its backlog. */
  const finish = async (name: string, why: string) => {
    if (inflight.has(name)) return;
    const last = failedAt.get(name);
    if (last && Date.now() - last < 60_000) return; // a failed wake is retried once a minute, not every tick
    inflight.add(name);
    try {
      const rec = readSleepRecord(space, name) ?? listWaking(space).find((r) => r.name === name);
      if (!rec) return;
      await lower(name);
      await withManagerControl(space, server, async (ctl) => {
        await ensureAgentSpawned(ctl, { space, name, cwd: rec.folder }); // prepareWake flips .json → .waking
        if (!(await waitForMeshLive(ctl, name, WAKE_READY_MS))) throw new Error(`"${name}" did not reach the mesh within ${WAKE_READY_MS / 1000}s`);
        const ps = await ctl.ps();
        const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
        if (!row?.id) throw new Error(`"${name}" is live but its ps row has no id`);
        const n = await forward(rec, wirePrincipal(row.id));
        clearWaking(space, name);
        failedAt.delete(name);
        sleepLog(space, `woke ${name} — ${why}; re-delivered ${n} DM(s)`);
      });
    } catch (e) {
      failedAt.set(name, Date.now());
      sleepLog(space, `wake of ${name} FAILED — ${(e as Error).message}`);
    } finally {
      inflight.delete(name);
    }
  };
  const wake = (name: string, why: string) => finish(name, why);

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const sleeping = listSleeping(space);
      const names = new Set(sleeping.map((r) => r.name));
      for (const name of [...standIns.keys()]) if (!names.has(name) && !inflight.has(name)) await lower(name);
      for (const rec of sleeping) if (!standIns.has(rec.name) && !inflight.has(rec.name)) await raise(rec).catch((e) => console.error(`[sleep] raise ${rec.name}: ${(e as Error).message}`));
      for (const rec of listWaking(space)) void finish(rec.name, "woken by a paw command");
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  await tick();
  console.error(`[sleep] host up for space "${space}"`);
  return async () => {
    clearInterval(timer);
    for (const name of [...standIns.keys()]) await lower(name);
    await nc.close().catch(() => {});
  };
}

/** The stand-in's wire principal (for tests and `paw sleep` output). */
export function standInPrincipal(space: string, name: string): string {
  return principalKey(DEV_OWNER, standInActor(space, name)).key;
}

/**
 * The sleep host: keeps a sleeping agent ADDRESSABLE and wakes it on its first DM.
 *
 * Runs inside the mailbox daemon (already one long-lived beacon process per space that `ensure()` keeps
 * up). For every `sleep/<name>.json` it raises a STAND-IN presence under the agent's name, with a stable
 * per-agent actor (`standInActor`), so a sender's `cotal_dm("<name>")` resolves to it instead of failing
 * with "no peer". It also listens on the despawned incarnation's own DM subject (`lastId`): a sender
 * that still holds the old, offline roster entry publishes there.
 *
 * A DM on either subject → `ensureAgentSpawned` (the normal interactive --resume spawn, which flips the
 * record to `.waking`) WITH THE STAND-IN STILL UP, so the name never goes dead during the boot → once the
 * seat is on the mesh, lower the stand-in → re-publish every DM that arrived since the sleep (stream seq >
 * cursorSeq on either subject) to the new principal, UNDER ITS ORIGINAL SENDER, so the agent sees an
 * ordinary DM it can answer. Each forwarded seq is recorded, so a retried forward never sends one twice;
 * a second pass a few seconds later catches DMs sent during the hand-over.
 *
 * Failure handling, because this runs inside the process that keeps "you" reachable: every tick is
 * caught and logged (a corrupt record is reported and skipped, never thrown), a wake that keeps failing
 * goes back to sleep after MAX_WAKE_FAILURES with its error on the record (`paw status` shows it), and an
 * agent whose registry entry vanished or moved is NOT woken — its record is dropped, loudly.
 *
 * REMOTE (JWT-authed) space: the same host, dialling with paw's narrow per-job creds (src/sleep-dial.ts)
 * — a watch connection per sleeping agent, a one-shot forward connection per wake, the stand-in under its
 * own persisted nkey. It stands in ONLY for an agent this machine hosts: a record whose manager instance
 * is not this machine's, or whose persona is not here, is dropped loudly and never stood in for.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { CotalEndpoint, DEV_OWNER, parsePrincipalKey, unicastRecvFilter, unicastSubject } from "@cotal-ai/core";
import { jetstream } from "@nats-io/jetstream";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { agentRecord, ensureAgentSpawned, personaFilePath, psRowAlive, stuckWarning, wirePrincipal, type PsRow } from "./addressing.ts";
import { sharedManagerControl, withManagerControl } from "./control.ts";
import { localManagerInstanceId } from "./hosted.ts";
import { RENEW_BEFORE_SEC, watchConsumerName } from "./remote-creds.ts";
import { dmLastSeqOn, openForward, openWatch, readFiltered, standInEndpointAuth, standInPrincipal, type Held } from "./sleep-dial.ts";
import {
  MAX_WAKE_FAILURES,
  clearSleep,
  clearWaking,
  failWake,
  markStandIn,
  prepareWake,
  readSleepRecord,
  readWakingRecord,
  scanRecords,
  sleepLog,
  standInActor,
  writeWakingRecord,
  type SleepRecord,
} from "./sleep-state.ts";
import { isRemoteSpace, pawServer } from "./server.ts";

const TICK_MS = 1000;
/** How often the tick also reconciles against ps and re-checks undelivered backlog. */
const SWEEP_MS = 15_000;

/** Pure: back-off before retrying a failed wake — 1m, 2m, 4m … capped at 30m. */
export function retryDelayMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1));
}

/** Pure: sleeping names that nonetheless have a live seat in the manager's ps (and no wake in flight). */
export function reconcileTargets(sleeping: string[], rows: PsRow[], inflight: Set<string>): string[] {
  return sleeping.filter((name) => {
    const row = rows.find((r) => r.name === name);
    return !!row && psRowAlive(row) && row.mesh !== "absent" && !inflight.has(name);
  });
}
/** Gap before the second forward pass that catches DMs sent while the stand-in was handing over. */
const STRAGGLER_MS = 3000;

/** The subjects a sleeping agent's mail can arrive on: the stand-in's and the despawned seat's.
 *  `standIn` defaults to the open mesh's stable hash actor; a remote space passes its persisted nkey. */
export function backlogFilters(space: string, rec: SleepRecord, standIn: { owner: string; actor: string } = { owner: DEV_OWNER, actor: standInActor(space, rec.name) }): string[] {
  const out = [unicastRecvFilter(space, standIn.owner, standIn.actor)];
  const old = rec.lastId ? parsePrincipalKey(rec.lastId) : undefined;
  if (old) out.push(unicastRecvFilter(space, old.owner, old.actor));
  return out;
}

/** The sender tokens of a DM subject `cotal.<space>.inst.<rO>.<rA>.<sO>.<sA>`, or undefined. */
export function dmSender(subject: string): { owner: string; actor: string } | undefined {
  const p = subject.split(".");
  return p.length === 7 && p[2] === "inst" ? { owner: p[5], actor: p[6] } : undefined;
}

/** Pure: where to start reading the backlog. A cursor beyond the stream's end means the stream was reset
 *  under us — the cursor no longer means anything, so everything retained is forwarded (a duplicate is
 *  better than a lost DM). */
export function effectiveCursor(cursorSeq: number, lastSeq: number): number {
  return cursorSeq > lastSeq ? 0 : cursorSeq;
}

/** Pure: which backlog entries still need forwarding (idempotent re-runs skip the recorded seqs). */
export function toForward<T extends { seq: number }>(backlog: T[], forwarded: number[] | undefined): T[] {
  const done = new Set(forwarded ?? []);
  return backlog.filter((m) => !done.has(m.seq));
}

/** Pure: the DM subjects a forward publishes on — the woken seat, from each backlog sender. */
export function forwardSubjects(space: string, target: { owner: string; actor: string }, subjects: string[]): string[] {
  const out = new Set<string>();
  for (const s of subjects) {
    const snd = dmSender(s);
    if (snd) out.add(unicastSubject(space, target.owner, target.actor, snd.owner, snd.actor));
  }
  return [...out];
}

/** Pure: may this machine stand in for `rec`? On a remote space only for an agent it hosts: the record
 *  names THIS machine's manager instance and the persona lives here. Local spaces: always. */
export function standInRefusal(o: { remote: boolean; rec: SleepRecord; localInstanceId?: string; personaHere: boolean }): string | undefined {
  if (!o.remote) return undefined;
  if (!o.localInstanceId) return "no manager of this machine has registered in the space";
  if (!o.rec.instanceId) return "its sleep record names no manager instance (not slept by this machine)";
  if (o.rec.instanceId !== o.localInstanceId) return `it was slept from manager ${o.rec.instanceId}, not this machine's ${o.localInstanceId} — hosted on another machine`;
  if (!o.personaHere) return "its persona is not in this machine's paw state — hosted on another machine";
  return undefined;
}

/** How many DMs are stored on `filters` after `cursorSeq` (the CLI's pre-despawn check). */
export async function dmsSince(space: string, name: string, filters: string[], cursorSeq: number, server = pawServer(space)): Promise<number> {
  const held = await openWatch(space, server, name, filters, "cli");
  try {
    let n = 0;
    for (const [i, f] of filters.entries()) n += (await readFiltered(held.nc, space, f, cursorSeq, watchConsumerName(space, name, "cli", i), true)).pending;
    return n;
  } finally {
    await held.nc.close().catch(() => {});
  }
}

/** Every DM stored on `filters` after `cursorSeq`, oldest first (one filter-pinned read per subject). */
async function readBacklog(nc: NatsConnection, space: string, name: string, filters: string[], cursorSeq: number): Promise<Array<{ subject: string; seq: number; data: Record<string, unknown> }>> {
  const last = await dmLastSeqOn(nc, space);
  const from = effectiveCursor(cursorSeq, last);
  if (from !== cursorSeq) console.error(`[sleep] cursor ${cursorSeq} is past the DM stream's end (${last}) — the stream was reset; forwarding everything retained`);
  const out: Array<{ subject: string; seq: number; data: Record<string, unknown> }> = [];
  for (const [i, f] of filters.entries()) out.push(...(await readFiltered(nc, space, f, from, watchConsumerName(space, name, "host", i))).msgs);
  return out.sort((a, b) => a.seq - b.seq);
}

export async function startSleepHost(space: string, server = pawServer(space)): Promise<() => Promise<void>> {
  const remote = isRemoteSpace(space);
  /** One watch connection per sleeping agent (remote: its own narrow cred; open mesh: bare). */
  const watches = new Map<string, Held & { subs: Subscription[] }>();
  const standIns = new Map<string, { ep: CotalEndpoint }>();
  const inflight = new Set<string>();
  const failedAt = new Map<string, number>();
  const reportedBad = new Set<string>();
  /** Per-agent serialization of backlog reads (their consumer names are fixed per agent). */
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(name) ?? Promise.resolve()).then(fn, fn);
    chains.set(name, next.catch(() => {}));
    return next;
  };

  const filtersOf = (rec: SleepRecord) => backlogFilters(space, rec, standInPrincipal(space, rec.name));

  /** Open (or re-open, when its cred nears expiry) the agent's watch: live DM subscriptions → wake. */
  const watch = async (rec: SleepRecord): Promise<NatsConnection> => {
    const cur = watches.get(rec.name);
    if (cur && cur.expSec - Date.now() / 1000 > RENEW_BEFORE_SEC) return cur.nc;
    const filters = filtersOf(rec);
    const held = await openWatch(space, server, rec.name, filters, "host");
    const subs = filters.map((f) => {
      const sub = held.nc.subscribe(f);
      void (async () => {
        for await (const m of sub) {
          let from = "?";
          try {
            from = (m.json() as { from?: { name?: string } }).from?.name ?? "?";
          } catch {
            /* still a wake */
          }
          void finish(rec.name, `DM from ${from}`);
        }
      })();
      return sub;
    });
    watches.set(rec.name, { ...held, subs });
    if (cur) await cur.nc.close().catch(() => {}); // the renewed watch is up first; then drop the old
    return held.nc;
  };

  const unwatch = async (name: string) => {
    const w = watches.get(name);
    if (!w) return;
    watches.delete(name);
    for (const sub of w.subs) sub.unsubscribe();
    await w.nc.close().catch(() => {});
  };

  const lower = async (name: string) => {
    const s = standIns.get(name);
    if (!s) return;
    standIns.delete(name);
    yielded.delete(name);
    await unwatch(name);
    await s.ep.stop().catch(() => {});
    markStandIn(space, name, false);
  };

  const raise = async (rec: SleepRecord) => {
    const refusal = standInRefusal({ remote, rec, localInstanceId: remote ? localManagerInstanceId(space) : undefined, personaHere: existsSync(personaFilePath(space, rec.name)) });
    if (refusal) {
      clearSleep(space, rec.name);
      sleepLog(space, `NOT standing in for ${rec.name} — ${refusal}; dropped its sleep record`);
      return;
    }
    const auth = await standInEndpointAuth(space, rec.name);
    const ep = new CotalEndpoint({
      space,
      servers: server,
      ...(auth.creds ? { creds: auth.creds, tls: auth.tls, lifecycleUid: auth.lifecycleUid } : {}),
      channels: [],
      registerPresence: true,
      consume: false, // the backlog stays in the stream; the host reads it on wake
      watchPresence: false,
      card: { name: rec.name, kind: "agent", ...(auth.cardId ? { id: auth.cardId } : {}), description: "asleep (paw sleep) — a DM wakes it" },
    });
    ep.on("error", (e: Error) => console.error(`[sleep] stand-in ${rec.name}: ${e.message}`));
    // The watch first: a stand-in nobody listens behind would swallow the wake DM (the next tick
    // skips a name whose stand-in is up). If the presence then fails, the watch goes with it.
    const nc = await watch(rec);
    try {
      await ep.start();
    } catch (e) {
      await unwatch(rec.name);
      throw e;
    }
    standIns.set(rec.name, { ep });
    markStandIn(space, rec.name, true);
    // Mail that landed between the despawn and this stand-in (on the old seat's subject) is a wake too.
    const pending = await serial(rec.name, () => readBacklog(nc, space, rec.name, filtersOf(rec), rec.cursorSeq));
    if (toForward(pending, rec.forwarded).length) void finish(rec.name, `${pending.length} DM(s) queued before the stand-in came up`);
  };

  /**
   * Let the manager have the name WITHOUT taking it off the roster. The manager refuses a hard-pinned
   * spawn while any roster-LIVE peer holds the name (measured: "already held by a live incarnation"),
   * but offline rows don't occupy — and a sender's name lookup still falls back to an offline match when
   * nothing live holds it. So the stand-in goes `offline` (still present, still on its DM subject) for the
   * boot, the manager can spawn, senders keep resolving to the stand-in, and the moment the real seat is
   * live it wins the lookup outright.
   */
  const yielded = new Set<string>();
  /** Names whose woken seat is running but not yet on the mesh (logged once, not every tick). */
  const booting = new Set<string>();
  const yieldName = async (name: string) => {
    const s = standIns.get(name);
    if (!s || yielded.has(name)) return;
    yielded.add(name);
    await s.ep.setStatus("offline");
    await new Promise((r) => setTimeout(r, 1500)); // let the manager's roster see it
  };

  /** Re-publish the not-yet-forwarded backlog to the woken agent, each DM under its original sender. */
  const forward = async (name: string, newId: string): Promise<number> => {
    const target = parsePrincipalKey(newId);
    if (!target) throw new Error(`woken "${name}" has no valid principal (${newId})`);
    let rec = readWakingRecord(space, name)!;
    // The watch may be gone (lowered); a forward then reads through a fresh one of its own.
    const own = watches.get(name) ? undefined : await openWatch(space, server, name, filtersOf(rec), "host");
    try {
      const nc = own?.nc ?? watches.get(name)!.nc;
      const backlog = toForward(await serial(name, () => readBacklog(nc, space, name, filtersOf(rec), rec.cursorSeq)), rec.forwarded);
      if (!backlog.length) return 0;
      const pub = await openForward(space, server, forwardSubjects(space, target, backlog.map((m) => m.subject)));
      try {
        const js = jetstream(pub);
        let n = 0;
        for (const { subject, seq, data } of backlog) {
          const snd = dmSender(subject);
          if (snd) {
            const ts = typeof data.ts === "number" ? data.ts : Date.now();
            const parts = Array.isArray(data.parts) ? data.parts : [];
            const note = { kind: "text", text: `[sent ${Math.max(1, Math.round((Date.now() - ts) / 60_000))}m ago, while you were asleep]` };
            const msg = { ...data, id: randomUUID(), to: newId, parts: [note, ...parts] };
            await js.publish(unicastSubject(space, target.owner, target.actor, snd.owner, snd.actor), JSON.stringify(msg), { msgID: msg.id });
            n++;
          }
          rec = { ...rec, forwarded: [...(rec.forwarded ?? []), seq] };
          writeWakingRecord(space, rec); // after EACH publish: a crash mid-forward never re-sends what went out
        }
        return n;
      } finally {
        await pub.close().catch(() => {});
      }
    } finally {
      await own?.nc.close().catch(() => {});
    }
  };

  /** Bring the agent up (stand-in kept until it is live) and hand it its backlog. */
  const finish = async (name: string, why: string) => {
    if (inflight.has(name)) return;
    const last = failedAt.get(name);
    const failures = (readWakingRecord(space, name) ?? readSleepRecord(space, name))?.wakeFailures ?? 0;
    if (last && Date.now() - last < retryDelayMs(failures)) return; // backed off, not every tick
    inflight.add(name);
    try {
      prepareWake(space, name); // asleep -> waking, so failures are counted on the waking record
      const rec = readWakingRecord(space, name);
      if (!rec) return;
      const refusal = standInRefusal({ remote, rec, localInstanceId: remote ? localManagerInstanceId(space) : undefined, personaHere: existsSync(personaFilePath(space, name)) });
      if (refusal) {
        clearSleep(space, name);
        await lower(name);
        sleepLog(space, `NOT waking ${name} — ${refusal}; dropped its sleep record (${why})`);
        return;
      }
      const reg = agentRecord(space, name);
      if (!reg || reg.folder !== rec.folder) {
        clearSleep(space, name);
        await lower(name);
        sleepLog(space, `NOT waking ${name} — ${reg ? `it is now registered at ${reg.folder}, not ${rec.folder}` : "it is no longer registered"}; dropped its sleep record (${why})`);
        return;
      }
      await yieldName(name);
      await withManagerControl(space, server, async (ctl) => {
        // Returns once the seat is ON the mesh (ensureAgentSpawned waits for that) — only then does the
        // stand-in come down, so a sender never finds the name missing mid-boot.
        const r = await ensureAgentSpawned(ctl, { space, name, cwd: rec.folder });
        if (r.starting) {
          // Its seat runs but isn't on the mesh yet. Not a failed wake: keep the stand-in and the backlog,
          // and wait for THIS seat — the next tick asks the gate again, which won't restart a booting seat.
          if (!booting.has(name)) sleepLog(space, r.stuck ? `${stuckWarning(name, r.stuck, false)} — stand-in + backlog kept (${why})` : `${name} is still starting — waiting for its seat (stand-in kept, ${why})`);
          booting.add(name);
          return;
        }
        booting.delete(name);
        await lower(name);
        const ps = await ctl.ps();
        const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
        if (!row?.id) throw new Error(`"${name}" is live but its ps row has no id`);
        const id = wirePrincipal(row.id);
        let n = await forward(name, id);
        await new Promise((r) => setTimeout(r, STRAGGLER_MS));
        n += await forward(name, id);
        clearWaking(space, name);
        failedAt.delete(name);
        sleepLog(space, `woke ${name} — ${why}; re-delivered ${n} DM(s)`);
      });
    } catch (e) {
      booting.delete(name);
      failedAt.set(name, Date.now());
      const msg = (e as Error).message;
      const { failures, backToSleep } = failWake(space, name, msg);
      if (backToSleep && yielded.delete(name)) await standIns.get(name)?.ep.setStatus("idle").catch(() => {});
      sleepLog(
        space,
        backToSleep
          ? `wake of ${name} FAILED ${failures}× — back to sleep, stand-in kept; retrying in ${Math.round(retryDelayMs(failures) / 60_000)}m or on the next DM (last error: ${msg})`
          : `wake of ${name} FAILED (${failures}/${MAX_WAKE_FAILURES}) — ${msg}`,
      );
    } finally {
      inflight.delete(name);
    }
  };

  let ticking = false;
  let lastSweep = 0;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const sleeping = scanRecords(space, ".json");
      const waking = scanRecords(space, ".waking");
      for (const b of [...sleeping.bad, ...waking.bad]) {
        if (reportedBad.has(b)) continue;
        reportedBad.add(b);
        sleepLog(space, `skipping unreadable sleep record ${b}`);
      }
      // A waking agent KEEPS its stand-in until it is live; only a record that is gone entirely lowers it.
      const held = new Set([...sleeping.records, ...waking.records].map((r) => r.name));
      for (const name of [...standIns.keys()]) if (!held.has(name) && !inflight.has(name)) await lower(name);
      for (const rec of sleeping.records) {
        if (standIns.has(rec.name) || inflight.has(rec.name)) continue;
        await raise(rec).catch((e) => console.error(`[sleep] raise ${rec.name}: ${(e as Error).message}`));
      }
      // A held watch whose cred nears expiry is renewed in place (remote spaces; open-mesh ones never expire).
      for (const rec of [...sleeping.records, ...waking.records]) {
        if (watches.has(rec.name)) await watch(rec).catch((e) => console.error(`[sleep] renew watch ${rec.name}: ${(e as Error).message}`));
      }
      // An external wake (`paw dm`, `paw chat`, `paw start`) is already spawning in another process and
      // retries a held name for 30s: yield the name now, then take over the hand-off.
      for (const rec of waking.records) {
        await yieldName(rec.name).catch(() => {});
        void finish(rec.name, "woken by a paw command");
      }
      if (sleeping.records.length && Date.now() - lastSweep >= SWEEP_MS) {
        lastSweep = Date.now();
        // A seat that came up for a sleeping name OUTSIDE the wake path (a late boot, `paw claude`,
        // `paw cotal spawn`): the stand-in beside it would make the name ambiguous forever. Treat it as woken.
        const ctl = await sharedManagerControl(space, server);
        const ps = await ctl.ps();
        if (ps.ok) {
          for (const name of reconcileTargets(sleeping.records.map((r) => r.name), (ps.data as PsRow[]) ?? [], inflight)) {
            sleepLog(space, `${name} has a live seat while recorded asleep — treating it as woken`);
            void finish(name, "a seat came up outside the wake path");
          }
        }
        // A wake that failed leaves its triggering DM unforwarded; retry it without waiting for a new DM.
        for (const rec of sleeping.records) {
          const w = watches.get(rec.name);
          if (inflight.has(rec.name) || !w) continue;
          const pending = toForward(await serial(rec.name, () => readBacklog(w.nc, space, rec.name, filtersOf(rec), rec.cursorSeq)), rec.forwarded);
          if (pending.length) void finish(rec.name, `${pending.length} DM(s) still waiting`);
        }
      }
    } catch (e) {
      console.error(`[sleep] tick failed: ${(e as Error).message}`);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  await tick();
  console.error(`[sleep] host up for space "${space}"${remote ? " (remote: narrow per-agent creds, hosted-here agents only)" : ""}`);
  return async () => {
    clearInterval(timer);
    for (const name of [...standIns.keys()]) await lower(name);
    for (const name of [...watches.keys()]) await unwatch(name);
  };
}

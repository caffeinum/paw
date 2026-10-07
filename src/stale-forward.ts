/**
 * The stale-id forwarder: a DM addressed to a DEAD incarnation of an agent reaches its live one.
 *
 * Every agent restart mints a new mesh id, and cotal resolves a `to` that is an exact id to that id at
 * any status — so a peer that copied an old id out of an earlier message gets "stored … recipient was
 * idle at send; delivery not confirmed" and the DM sits on a subject nobody will ever read again
 * (2026-10-06, queue-ea → evals). cotal should resolve or refuse that send itself (the upstream ask is
 * in docs/notes/messaging.md); until it does, this runs inside the mailbox daemon and repairs it:
 *
 *   tail the DM stream → a DM whose recipient has no live presence → name it via the peer ledger →
 *   exactly one live instance of THAT name → re-publish under the ORIGINAL sender, marked forwarded.
 *
 * Rules (all in {@link decideForward}, pure): never forward to a different name; never guess a name (an
 * id the ledger doesn't know is left alone); a sleeping/waking name belongs to the sleep host; a
 * recipient that is itself a sleep stand-in is the sleep host's; two live instances of a name is
 * ambiguous → left alone; no live instance yet → held (pending) and retried until PENDING_MS. Each
 * stream seq is decided once (a persisted cursor), each original message is forwarded at most once (a
 * persisted done-set + a deterministic msgID the broker dedups on), and a forward is addressed to a LIVE
 * id, so it is never itself a candidate — no loops.
 *
 * Publishing under the original sender's subject is the same move the sleep host makes, and needs the
 * same thing: an OPEN mesh. Under PAW_AUTH the broker forbids it, so the forwarder does not start there
 * (said loudly) — the ledger-based NAMING still works for every reader.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, createSpaceStreams, dmStream, parsePrincipalKey, spacePrefix, unicastSubject, type Presence } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { dmSender } from "./sleep-host.ts";
import { isAsleep, readWakingRecord } from "./sleep-state.ts";
import { isStandIn, presenceLive } from "./roster.ts";
import { ledgerName, observe, pruneLedger, readLedger, writeLedger, type Ledger } from "./peer-ledger.ts";

/** How long a DM to a dead id waits for its agent's next incarnation before it is given up on. */
export const PENDING_MS = 30 * 60_000;
/** How often pending DMs are re-decided and the ledger flushed. */
const TICK_MS = 2000;
/** Original message ids remembered as forwarded (beyond this the broker's msgID dedup still holds). */
const DONE_CAP = 2000;

export type LivePeer = { id: string; name: string };

export type ForwardDecision =
  | { action: "skip"; reason: string }
  | { action: "hold"; reason: string }
  | { action: "forward"; name: string; to: string };

/** Pure: what to do with one DM, given who is live right now and what the ledger knows. */
export function decideForward(a: {
  recipient: string;
  sender: string;
  ledger: Ledger;
  live: LivePeer[];
  rosterFresh: boolean;
  asleep: (name: string) => boolean;
  alreadyForwarded: boolean;
  /** The DM's own `ts`. A recipient seen alive at or after it had its chance to read it (this matters
   *  on a catch-up after the mailbox was down: the old instance may have read it before it died). */
  sentAt: number;
}): ForwardDecision {
  if (a.alreadyForwarded) return { action: "skip", reason: "already forwarded" };
  if (a.live.some((p) => p.id === a.recipient)) return { action: "skip", reason: "recipient is live" };
  const seen = a.ledger[a.recipient];
  if (seen && seen.last >= a.sentAt) return { action: "skip", reason: "recipient was alive when it was sent" };
  if (/\.pawsleep_[0-9a-f]+$/.test(a.recipient)) return { action: "skip", reason: "recipient is a sleep stand-in (sleep host's)" };
  const name = ledgerName(a.ledger, a.recipient);
  if (!name) return { action: "skip", reason: "recipient id unknown to the ledger — not guessing a name" };
  if (a.asleep(name)) return { action: "skip", reason: `${name} is asleep/waking — the sleep host owns its mail` };
  if (!a.rosterFresh) return { action: "hold", reason: "roster not current — can't tell who is live" };
  const targets = a.live.filter((p) => p.name === name && p.id !== a.recipient);
  if (targets.length === 0) return { action: "hold", reason: `no live instance of ${name} yet` };
  if (targets.length > 1) return { action: "skip", reason: `${targets.length} live instances of ${name} — ambiguous, not picking` };
  if (targets[0].id === a.sender) return { action: "skip", reason: `sender is ${name}'s live instance itself` };
  return { action: "forward", name, to: targets[0].id };
}

/** Pure: the live, non-stand-in peers on a roster snapshot. */
export function livePeers(space: string, roster: Presence[], now: number): LivePeer[] {
  return roster.filter((p) => presenceLive(p, now) && !isStandIn(space, p.card.name, p.card.id)).map((p) => ({ id: p.card.id, name: p.card.name }));
}

/** Pure: a deterministic message id for the forward of `origId` to `to` — a retried forward carries the
 *  SAME msgID, so JetStream's duplicate window drops it even if the done-set write was lost. */
export function forwardId(origId: string, to: string): string {
  const h = createHash("sha256").update(`paw-stale-forward\0${origId}\0${to}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The note a forwarded DM leads with, so the agent knows why it arrived and where to reply. */
export function forwardNote(oldId: string): string {
  return `[paw: forwarded — this DM was sent to your previous instance (${oldId}); reply to the sender as usual]`;
}

/** Pure: the forwarded envelope — original sender/body/replyTo kept, new id, new recipient, note first. */
export function forwardEnvelope(data: Record<string, unknown>, origId: string, oldId: string, to: string): Record<string, unknown> {
  const parts = Array.isArray(data.parts) ? data.parts : [];
  return { ...data, id: forwardId(origId, to), to, parts: [{ kind: "text", text: forwardNote(oldId) }, ...parts] };
}

type State = { cursor: number; pending: Array<{ seq: number; since: number }>; done: string[] };

function statePath(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  return join(root, "spaces", space, "stale-forward.json");
}

function readState(space: string): State | undefined {
  const file = statePath(space);
  if (!existsSync(file)) return undefined;
  const s = JSON.parse(readFileSync(file, "utf8")) as State;
  if (typeof s.cursor !== "number" || !Array.isArray(s.pending) || !Array.isArray(s.done)) throw new Error(`corrupt forwarder state ${file} — fix or delete it`);
  return s;
}

function writeState(space: string, s: State): void {
  const file = statePath(space);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(s));
  renameSync(`${file}.tmp`, file);
}

const fwdLog = (msg: string) => console.error(`[forward] ${msg}`);

export async function startStaleForwarder(space: string, server: string): Promise<() => Promise<void>> {
  const ledger = readLedger(space);
  let ledgerDirty = false;
  // Decisions read `last` from memory (every heartbeat); the FILE only needs a new id, a renamed one,
  // or `last` moved by a minute — otherwise a 2s heartbeat per agent would rewrite it constantly.
  const note = (id: string, name: string, ts: number) => {
    const before = ledger[id] ? { ...ledger[id] } : undefined;
    if (!observe(ledger, id, name, ts)) return;
    if (!before || before.name !== name || ledger[id].last - before.last >= 60_000 || ledger[id].first !== before.first) ledgerDirty = true;
  };

  const ep = new CotalEndpoint({
    space,
    servers: server,
    channels: [],
    registerPresence: false,
    consume: false,
    watchPresence: true,
    card: { name: "paw-forwarder", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => fwdLog(`observer: ${e.message}`));
  const learnRoster = (roster: Presence[]) => {
    for (const p of roster) if (!isStandIn(space, p.card.name, p.card.id)) note(p.card.id, p.card.name, p.ts);
  };
  ep.on("roster", learnRoster);
  await ep.start();
  await ep.waitForPresenceSnapshot(5000);
  learnRoster(ep.getRoster());
  // Seed from the DM backlog: every sender's (id, name) is authenticated by its subject.
  for (const m of await ep.dmHistory({ limit: 2000 })) note(m.from.id, m.from.name, m.ts);

  const nc = await connect({ servers: server });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const stream = dmStream(space);
  // Open mode creates the space's streams lazily on the first consuming endpoint; the mailbox may be
  // first on a fresh broker. Idempotent — the same call every agent makes.
  await createSpaceStreams(jsm, space);
  const last =(await jsm.streams.info(stream)).state.last_seq;
  const state: State = readState(space) ?? { cursor: last, pending: [], done: [] };
  if (state.cursor > last) {
    fwdLog(`cursor ${state.cursor} is past the DM stream's end (${last}) — the stream was reset; starting from its end`);
    state.cursor = last;
    state.pending = [];
  }
  writeState(space, state);

  const asleep = (name: string) => isAsleep(space, name) || readWakingRecord(space, name) !== undefined;

  /** Decide one stored DM. Returns true when it is settled (forwarded or skipped), false to keep holding. */
  const handle = async (seq: number, subject: string, data: Record<string, unknown>): Promise<boolean> => {
    const snd = dmSender(subject);
    const rcp = subject.split(".");
    if (!snd || rcp.length !== 7) return true;
    const sender = `${snd.owner}.${snd.actor}`;
    const recipient = `${rcp[3]}.${rcp[4]}`;
    const from = data.from as { id?: unknown; name?: unknown } | undefined;
    if (!from || from.id !== sender || typeof data.id !== "string") return true; // forged/malformed — never relay
    if (typeof from.name === "string") note(sender, from.name, typeof data.ts === "number" ? data.ts : Date.now());
    const origId = data.id;
    const d = decideForward({
      recipient,
      sender,
      ledger,
      live: livePeers(space, ep.getRoster(), Date.now()),
      rosterFresh: ep.presenceView().fresh,
      asleep,
      alreadyForwarded: state.done.includes(origId),
      sentAt: typeof data.ts === "number" ? data.ts : Date.now(),
    });
    if (d.action === "hold") return false;
    if (d.action === "skip") {
      if (d.reason !== "recipient is live" && d.reason !== "already forwarded") fwdLog(`seq ${seq} to ${recipient}: not forwarded — ${d.reason}`);
      return true;
    }
    const target = parsePrincipalKey(d.to);
    if (!target) throw new Error(`live instance of ${d.name} has no valid principal (${d.to})`);
    const msg = forwardEnvelope(data, origId, recipient, d.to);
    await js.publish(unicastSubject(space, target.owner, target.actor, snd.owner, snd.actor), JSON.stringify(msg), { msgID: msg.id as string });
    state.done = [...state.done, origId].slice(-DONE_CAP);
    writeState(space, state); // after the publish: a crash re-sends at worst, and the msgID dedups that
    fwdLog(`seq ${seq}: DM from ${String(from.name)} to ${d.name}'s old instance ${recipient} → re-sent to ${d.to}`);
    return true;
  };

  let stopped = false;
  const tail = async () => {
    while (!stopped) {
      try {
        const c = await js.consumers.get(stream, {
          filter_subjects: [`${spacePrefix(space)}.inst.>`],
          deliver_policy: DeliverPolicy.StartSequence,
          opt_start_seq: state.cursor + 1,
        });
        const msgs = await c.consume();
        stopTail = () => msgs.stop();
        for await (const m of msgs) {
          let data: Record<string, unknown> | undefined;
          try {
            data = m.json();
          } catch {
            /* not a cotal envelope */
          }
          if (data && !(await handle(m.seq, m.subject, data))) {
            fwdLog(`seq ${m.seq} to a dead id: holding until its agent is live again (up to ${PENDING_MS / 60_000}m)`);
            state.pending.push({ seq: m.seq, since: Date.now() });
          }
          state.cursor = m.seq;
          writeState(space, state);
        }
      } catch (e) {
        if (!stopped) fwdLog(`tail failed, restarting from seq ${state.cursor + 1}: ${(e as Error).message}`);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  let stopTail = () => {};
  void tail();

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      // The tail appends to `pending` while this awaits, so settle by seq rather than replacing the list.
      const settled = new Set<number>();
      for (const p of [...state.pending]) {
        if (Date.now() - p.since > PENDING_MS) {
          fwdLog(`seq ${p.seq}: gave up — no live instance of its recipient's agent within ${PENDING_MS / 60_000}m`);
          settled.add(p.seq);
          continue;
        }
        try {
          const sm = await jsm.streams.getMessage(stream, { seq: p.seq });
          if (!sm || (await handle(p.seq, sm.subject, sm.json()))) settled.add(p.seq);
        } catch (e) {
          fwdLog(`seq ${p.seq}: retry failed — ${(e as Error).message}`);
        }
      }
      if (settled.size) {
        state.pending = state.pending.filter((p) => !settled.has(p.seq));
        writeState(space, state);
      }
      if (ledgerDirty) {
        ledgerDirty = false;
        writeLedger(space, pruneLedger(ledger, Date.now()));
      }
    } catch (e) {
      fwdLog(`tick failed: ${(e as Error).message}`);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  await tick();
  fwdLog(`up for space "${space}" — DMs to a restarted agent's old id reach its live instance`);
  return async () => {
    stopped = true;
    clearInterval(timer);
    stopTail();
    await tick();
    await ep.stop().catch(() => {});
    await nc.close().catch(() => {});
  };
}

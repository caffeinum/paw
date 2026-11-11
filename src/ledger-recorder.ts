/**
 * The peer ledger's writer on a REMOTE (authed) space (src/peer-ledger.ts).
 *
 * On an open mesh the stale-id forwarder keeps the ledger. Under auth the forwarder is off (it would
 * re-publish under another sender), and until 2026-11-06 nothing else wrote the ledger — so on team2027
 * paw knew only an agent's CURRENT id. The messages view's `chat-peers` read is scoped by id, so after a
 * restart it read the new, empty id and showed "(no messages between vercel and other peers)" while
 * `paw history` held its conversation with evals-intern on the previous id.
 *
 * This records (id, name) with no forwarding, inside the mailbox (still the ledger's only writer):
 *  - the roster the mailbox endpoint watches (every incarnation seen live from now on);
 *  - once at start, `seed` — the DM backlog's senders, names and ids only (the broker forge-locks the
 *    sender into the subject, so the pair is authenticated), what the open-mesh forwarder seeds from.
 * Sleep stand-ins are never recorded — they are not the agent.
 */
import type { Presence } from "@cotal-ai/core";
import { observe, pruneLedger, readLedger, writeLedger } from "./peer-ledger.ts";
import { isStandIn } from "./roster.ts";

export interface Sighting {
  id: string;
  name: string;
  ts: number;
  host?: string; // the card's meta.host — which machine runs this id (absent from a DM-backlog seed)
}

/** Record every sighting into the on-disk ledger, flushing every `flushMs` when something changed.
 *  Returns stop (flushes once more). `log` hears a failure — loud, never fatal to the mailbox. */
export async function startLedgerRecorder(
  space: string,
  roster: () => Presence[],
  seed: (() => Promise<Sighting[]>) | undefined,
  log: (msg: string) => void,
  flushMs = 5000,
): Promise<() => void> {
  const ledger = readLedger(space);
  let dirty = false;
  const note = (s: Sighting): void => {
    if (isStandIn(space, s.name, s.id)) return;
    const before = ledger[s.id] ? { ...ledger[s.id]! } : undefined;
    if (!observe(ledger, s.id, s.name, s.ts, s.host)) return;
    if (!before || before.name !== s.name || before.host !== ledger[s.id]!.host || ledger[s.id]!.last - before.last >= 60_000) dirty = true;
  };
  const flush = (): void => {
    if (!dirty) return;
    dirty = false;
    writeLedger(space, pruneLedger(ledger, Date.now()));
  };
  const scan = (): void => {
    try {
      for (const p of roster()) {
        const host = typeof p.card.meta?.host === "string" && p.card.meta.host ? p.card.meta.host : undefined;
        if (p.card.id && p.card.name) note({ id: p.card.id, name: p.card.name, ts: p.ts, ...(host ? { host } : {}) });
      }
      flush();
    } catch (e) {
      log(`peer ledger: ${(e as Error).message}`);
    }
  };
  if (seed) {
    try {
      for (const s of await seed()) note(s);
    } catch (e) {
      log(`peer ledger: couldn't seed from the DM backlog — only ids seen live from now on are named: ${(e as Error).message}`);
    }
  }
  scan();
  const timer = setInterval(scan, flushMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    scan();
  };
}

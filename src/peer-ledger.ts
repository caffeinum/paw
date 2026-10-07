/**
 * The peer ledger: every mesh id paw has seen, and the agent NAME it belonged to.
 *
 * WHY: every agent restart mints a NEW mesh id (`local.<actor>`). A peer that copies an id out of an old
 * message and DMs it reaches a dead instance (2026-10-06: queue-ea → evals' previous id; stored, never
 * read), and every surface that renders the recipient showed the raw id. The roster cannot answer "whose
 * id WAS this" — it only knows who is around now — so paw keeps its own record.
 *
 * Sources (all authenticated, never guessed): presence cards the mailbox sees on the roster, and DM
 * senders (the broker forge-locks the sender into the subject, and the receive path rejects a `from.id`
 * that disagrees). The mailbox daemon is the ONLY writer; every other process reads. Sleep stand-ins
 * hold a sleeping agent's name under their own actor and are never recorded — they are not the agent.
 *
 * Leaf module (node imports only), so the transcript renderer can use it without a cycle.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LedgerEntry = { name: string; first: number; last: number };
export type Ledger = Record<string, LedgerEntry>;

/** Entries unseen this long are dropped; a month of ids is plenty to name an old message. */
export const LEDGER_MAX_AGE_MS = 30 * 24 * 3600_000;
/** Hard cap so a churny mesh can't grow the file without bound. */
export const LEDGER_CAP = 5000;

export function ledgerPath(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  return join(root, "spaces", space, "peers.json");
}

/** Missing file = empty ledger. A file that exists but doesn't parse is a bug — fail loud. */
export function readLedger(space: string): Ledger {
  const file = ledgerPath(space);
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`paw: peer ledger ${file} is not valid JSON (${(e as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`paw: peer ledger ${file} is not an object`);
  return parsed as Ledger;
}

/** Atomic replace (tmp + rename): a reader never sees a half-written ledger. */
export function writeLedger(space: string, ledger: Ledger): void {
  const file = ledgerPath(space);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger));
  renameSync(tmp, file);
}

/** Record that `id` is (or was) `name`, seen at `ts`. Returns whether the ledger changed. Pure. An id
 *  never changes name — a later card claiming a different name for a known id replaces it (the card is
 *  authoritative for its own id), but that is not expected to happen. */
export function observe(ledger: Ledger, id: string, name: string, ts: number): boolean {
  if (!id || !name) return false;
  const cur = ledger[id];
  if (!cur) {
    ledger[id] = { name, first: ts, last: ts };
    return true;
  }
  let changed = false;
  if (cur.name !== name) {
    cur.name = name;
    changed = true;
  }
  if (ts > cur.last) {
    cur.last = ts;
    changed = true;
  }
  if (ts < cur.first) {
    cur.first = ts;
    changed = true;
  }
  return changed;
}

/** Drop stale entries, then the oldest beyond the cap. Pure (mutates and returns `ledger`). */
export function pruneLedger(ledger: Ledger, now: number, maxAgeMs = LEDGER_MAX_AGE_MS, cap = LEDGER_CAP): Ledger {
  for (const [id, e] of Object.entries(ledger)) if (now - e.last > maxAgeMs) delete ledger[id];
  const ids = Object.keys(ledger);
  if (ids.length > cap) {
    ids.sort((a, b) => ledger[a].last - ledger[b].last);
    for (const id of ids.slice(0, ids.length - cap)) delete ledger[id];
  }
  return ledger;
}

/** The newest incarnation recorded for `name` (latest `first`), or undefined. Pure. */
export function newestIdFor(ledger: Ledger, name: string): string | undefined {
  let best: string | undefined;
  for (const [id, e] of Object.entries(ledger)) {
    if (e.name !== name) continue;
    if (!best || e.first > ledger[best].first) best = id;
  }
  return best;
}

/** Is `id` a superseded incarnation — its name has a NEWER id on record? Pure. */
export function isOldInstance(ledger: Ledger, id: string): boolean {
  const e = ledger[id];
  return !!e && newestIdFor(ledger, e.name) !== id;
}

/**
 * How to show `idOrName` to a human: a name passes through; a recorded id renders as its agent name,
 * suffixed " (old instance)" when the name has since restarted under a newer id; an id paw never saw
 * stays the raw id — an id you can still match on is honest, a guessed name is not. Pure.
 */
export function peerLabel(ledger: Ledger, idOrName: string): string {
  const e = ledger[idOrName];
  if (!e) return idOrName;
  return isOldInstance(ledger, idOrName) ? `${e.name} (old instance)` : e.name;
}

/** The ledger's name for an id (no "(old instance)" suffix), or undefined. Pure. */
export function ledgerName(ledger: Ledger, id: string): string | undefined {
  return ledger[id]?.name;
}

const cache = new Map<string, { mtimeMs: number; ledger: Ledger }>();

/** Read the ledger, re-parsing only when the file changed — renderers call this per block. */
export function cachedLedger(space: string): Ledger {
  const file = ledgerPath(space);
  if (!existsSync(file)) return {};
  const mtimeMs = statSync(file).mtimeMs;
  const hit = cache.get(space);
  if (hit && hit.mtimeMs === mtimeMs) return hit.ledger;
  const ledger = readLedger(space);
  cache.set(space, { mtimeMs, ledger });
  return ledger;
}

/** {@link peerLabel} against the on-disk ledger. */
export function labelPeer(space: string, idOrName: string): string {
  return peerLabel(cachedLedger(space), idOrName);
}

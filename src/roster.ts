/**
 * The mesh's own answer to "is <name> running?" — its presence roster, read once.
 *
 * The manager's ps only knows the agents THIS manager spawned. Since cotal 0.49 a stopped manager
 * spares its agents, so after a manager restart a fully working agent can be on the mesh, heartbeating
 * and answering DMs, while ps is empty. Deciding liveness from ps alone made `paw chat @evals` try to
 * start a second copy of a running agent (the two-writer guard refused it, 2026-10-05). The roster is
 * the second witness.
 */
import { CotalEndpoint, type Presence } from "@cotal-ai/core";
import { standInActor } from "./sleep-state.ts";

/** How recent a presence heartbeat must be to count as a running agent. cotal heartbeats every 2s; a
 *  record older than this is a process that stopped without publishing `offline`. */
export const ROSTER_FRESH_MS = 15_000;

const LIVE = new Set(["idle", "working", "waiting"]);

export type RosterEntry = { id: string; status: string; ts: number };

/** Is this presence record a running agent right now? Live status AND a fresh heartbeat. Pure. */
export function presenceLive(p: { status: string; ts: number }, now: number, freshMs = ROSTER_FRESH_MS): boolean {
  const age = now - p.ts;
  return LIVE.has(p.status) && age < freshMs && age > -freshMs;
}

/** A `paw sleep` stand-in holds the sleeping agent's NAME on the roster (so a DM can wake it) under its
 *  own actor. It is not the agent: reading it as live would mean never waking anything. Pure. */
export function isStandIn(space: string, name: string, cardId: string): boolean {
  const actor = standInActor(space, name);
  return cardId === actor || cardId.endsWith(`.${actor}`);
}

/** Pick, per wanted name, the best roster record: a live one over an offline one, newest first. Stand-ins
 *  are dropped. Pure — the I/O is in {@link readMeshRoster}. */
export function pickRoster(space: string, roster: Presence[], want: Set<string>, now: number): Map<string, RosterEntry> {
  const out = new Map<string, RosterEntry>();
  for (const p of roster) {
    const name = p.card.name;
    if (!want.has(name) || isStandIn(space, name, p.card.id)) continue;
    const cur = out.get(name);
    const rank = (e: { status: string; ts: number }) => (presenceLive(e, now) ? 2 : e.status !== "offline" ? 1 : 0);
    const next = { id: p.card.id, status: p.status, ts: p.ts };
    if (!cur || rank(next) > rank(cur) || (rank(next) === rank(cur) && next.ts > cur.ts)) out.set(name, next);
  }
  return out;
}

/**
 * Read the presence roster for `want` names. Waits for the presence watch's initial snapshot (fast — a
 * KV read, not a heartbeat wait) rather than sleeping a fixed time. A snapshot that times out means the
 * roster may be partial, so the result is only ever used to say "running", never "not running".
 */
export async function readMeshRoster(
  space: string,
  server: string,
  creds: string | undefined,
  want: Set<string>,
  timeoutMs = 2500,
): Promise<Map<string, RosterEntry>> {
  if (want.size === 0) return new Map();
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name: "paw-roster", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  try {
    await ep.waitForPresenceSnapshot(timeoutMs);
    return pickRoster(space, ep.getRoster(), want, Date.now());
  } finally {
    await ep.stop().catch(() => {});
  }
}

/**
 * `paw dm` to a KNOWN agent that is briefly off the mesh: wait for it instead of refusing it.
 *
 * WHY: the team2027 broker (one node on Fly) redeploys on every push to paw main — a 10–60s gap in
 * which the connection is down and then presence (memory-backed, republished by each endpoint's 2s
 * heartbeat) is briefly empty. `paw dm evals …` from a cron, an agent or the office bridge then failed
 * at once with `no agent "evals" present or known` against an agent that was fine and reconnecting.
 *
 * Known = registered in this paw home (that path wakes it, unchanged — src/addressing.ts
 * ensureAgentSpawned), on the roster in any status, or in the peer ledger (spaces/<s>/peers.json, the
 * mailbox's record of every id it has seen) within {@link KNOWN_PEER_MAX_AGE_MS}. Such a name gets a
 * bounded wait (connect + presence share one budget); a name never seen anywhere still fails at once.
 *
 * Leaf module (pure + node env parsing) so check:dm tests the decision without a mesh.
 */
import type { Ledger } from "./peer-ledger.ts";

/** Default budget for the connect + presence wait. Covers a broker redeploy's usual gap. */
export const DM_WAIT_MS = 20_000;
/** A ledger sighting older than this no longer makes a name "known" — that agent is gone, not reconnecting. */
export const KNOWN_PEER_MAX_AGE_MS = 7 * 24 * 3600_000;

/** The budget: `--wait-for <s>` > `PAW_DM_WAIT` (seconds) > {@link DM_WAIT_MS}. 0 = no wait. Garbage fails loud. */
export function dmWaitMs(flag: string | undefined, env: string | undefined = process.env.PAW_DM_WAIT): number {
  const [raw, from] = flag !== undefined ? [flag, "--wait-for"] : env !== undefined && env.trim() !== "" ? [env, "PAW_DM_WAIT"] : [undefined, ""];
  if (raw === undefined) return DM_WAIT_MS;
  const s = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(s) || s < 0) throw new Error(`paw: ${from} must be a number of seconds ≥ 0 (got "${raw}")`);
  return Math.round(s * 1000);
}

/** When `paw dm`'s wait started: bin/paw.ts starts it before the mesh gate, so the gate's wait and
 *  sendAsYou's share ONE budget. Unset (in-process callers: web, cron, office) = the send's own start. */
let clockStart: number | undefined;
export function startDmClock(now = Date.now()): void {
  clockStart ??= now;
}
export function dmDeadline(budgetMs: number, now = Date.now()): number {
  return (clockStart ?? now) + budgetMs;
}

/**
 * Run `fn`; while it throws a `retryable` error and the deadline hasn't passed, say `onWait` once and
 * retry every `stepMs`. Past the deadline → `expired(lastError)`. A non-retryable error throws as is.
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  o: { deadline: number; retryable: (e: Error) => boolean; onWait: () => void; expired: (e: Error) => Error; stepMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let said = false;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!o.retryable(err)) throw err;
      const rest = o.deadline - now();
      if (rest <= 0) throw o.expired(err);
      if (!said) o.onWait();
      said = true;
      await sleep(Math.min(o.stepMs ?? 1000, rest));
    }
  }
}

/** Did the ledger see an id under this name (case-insensitive) within the window? Pure. */
export function seenInLedger(ledger: Ledger, name: string, now: number, maxAgeMs = KNOWN_PEER_MAX_AGE_MS): boolean {
  const want = name.toLowerCase();
  return Object.values(ledger).some((e) => e.name.toLowerCase() === want && now - e.last <= maxAgeMs);
}

export type AbsentVerdict = "send" | "wake" | "wait" | "unknown";

/**
 * What `paw dm <name>` does with a bare agent name, once the roster is readable. Pure.
 *  - present on the roster → send;
 *  - registered here → wake (ensureAgentSpawned — today's semantics, untouched);
 *  - on the roster offline / seen by the ledger → wait for it to come back;
 *  - none of these → unknown, fail now.
 */
export function absentVerdict(o: { present: boolean; registered: boolean; onRoster: boolean; inLedger: boolean }): AbsentVerdict {
  if (o.present) return "send";
  if (o.registered) return "wake";
  if (o.onRoster || o.inLedger) return "wait";
  return "unknown";
}

export const unknownAgentMessage = (name: string): string => `paw: no agent "${name}" present or known (\`paw ps\` for live names)`;

export const waitingLine = (name: string): string => `waiting for ${name} to come back on the mesh…`;
export const waitingForMeshLine = (server: string): string => `waiting for the mesh (${server}) to come back…`;

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** The budget ran out. Names WHICH half failed: the mesh itself, or the agent on a reachable mesh. Pure. */
export function waitExpiredMessage(o: { name?: string; server: string; budgetMs: number; meshUp: boolean; lastError?: string }): string {
  if (!o.meshUp)
    return (
      `paw: mesh unreachable — ${o.server} did not come back within ${secs(o.budgetMs)}${o.lastError ? ` (${o.lastError})` : ""}; ` +
      `${o.name ? `nothing was sent to "${o.name}"` : "nothing was sent"} (PAW_DM_WAIT / --wait-for <s> to wait longer)`
    );
  return (
    `paw: "${o.name}" stayed offline — the mesh is up but it did not come back within ${secs(o.budgetMs)}; nothing was sent ` +
    `(it is known from an earlier sighting, not registered here, so paw can't wake it — \`paw ps\` for live names, PAW_DM_WAIT / --wait-for <s> to wait longer)`
  );
}

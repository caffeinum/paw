/**
 * Spawn pacing — the anti-thundering-herd gate for fleet revival.
 *
 * The 2026-08-21 incident: a machine deep in swap (14.4GB/15.3GB used, load 141 on 10 throttled
 * cores) missed one lease renew, the manager restarted, and revival respawned SEVEN agents in a
 * burst. Seven cold claude boots on an already-drowning machine deepen the exact starvation that
 * caused the lease loss — a doom loop smaller than the 0.15 one, but the same shape. The revival
 * loops were already sequential, but on cotal 0.25 spawn is an ACCEPTANCE and mesh-live lands as
 * soon as the connector registers presence — the heavy part of a claude boot (transcript resume,
 * MCP servers, hooks) continues long after, so boots still overlap almost completely.
 *
 * This is OTP's restart-intensity idea without the VM: before each spawn, wait for the 1-minute
 * load average to drop below a headroom threshold. BOUNDED — after `capMs` the spawn proceeds
 * anyway, because an agent that stays down forever is the other failure (its name can't be
 * resolved on the roster, so agent→agent DMs to it fail at resolution — the wake gap). Nothing
 * here can lose a message that was already sent: DMs to a down agent queue in its durable
 * JetStream consumer and deliver on reconnect (the INBOX column in `paw status`); the gate only
 * trades a wider not-yet-resolvable window for not capsizing the machine.
 *
 * Pure/injectable so tests never depend on the host's actual load.
 */
import os from "node:os";

/** load1 at or above ncpu × factor means "the machine has no headroom for another claude boot".
 *  factor 2 is deliberately permissive: load briefly exceeds ncpu on any healthy busy box, and
 *  gating normal operation would slow every restart for a problem it doesn't have. */
export function loadThreshold(ncpu: number, factor = 2): number {
  return ncpu * factor;
}

export function hasHeadroom(load1: number, ncpu: number, factor = 2): boolean {
  return load1 < loadThreshold(ncpu, factor);
}

export interface HeadroomOpts {
  factor?: number;
  capMs?: number;
  pollMs?: number;
  /** 1-minute load average sampler; injectable for tests. */
  sample?: () => number;
  cpus?: number;
  /** Called once when gating begins, so the caller can say WHY revival is pausing. */
  onWait?: (load1: number, threshold: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until the machine has spawn headroom, or until `capMs` has elapsed — never forever.
 * Returns "clear" (headroom seen) or "gave-up" (cap hit; the caller spawns anyway, informed).
 */
export async function awaitSpawnHeadroom(opts: HeadroomOpts = {}): Promise<"clear" | "gave-up"> {
  const factor = opts.factor ?? 2;
  const capMs = opts.capMs ?? 90_000;
  const pollMs = opts.pollMs ?? 5_000;
  const sample = opts.sample ?? (() => os.loadavg()[0]);
  const cpus = opts.cpus ?? os.cpus().length;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let load = sample();
  if (hasHeadroom(load, cpus, factor)) return "clear";
  opts.onWait?.(load, loadThreshold(cpus, factor));
  let waited = 0;
  while (waited < capMs) {
    await sleep(pollMs);
    waited += pollMs;
    load = sample();
    if (hasHeadroom(load, cpus, factor)) return "clear";
  }
  return "gave-up";
}

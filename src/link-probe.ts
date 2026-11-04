/**
 * Notice a dead socket the moment a send needs it, instead of minutes later.
 *
 * On a flaky Wi-Fi a TCP flow can die SILENTLY (the router/NAT forgets it, nothing sends a RST): every
 * byte written to it vanishes, and nats.js only notices through its own PINGs — every 2 min, stale after
 * 2 unanswered, so 4–6 min. Meanwhile paw chat's outbox (src/outbox.ts) re-sent the message over that
 * same dead socket every few seconds, each try a JetStream request that timed out, and gave up after 90s
 * with `✕ not sent … no ack in 95s, 8 tries` while the transport still read "up" (footer `◐ degraded`).
 * Measured through a black-holing proxy (team2027, 2026-11-04): baseline = 8 tries, failed at 95s, the
 * transport never went down; with this probe = delivered in ~10s on a fresh socket, once.
 *
 * So: a send's ack timed out → PING the connection ({@link LinkProbe.check}). A live socket answers
 * the PONG straight from the broker's read loop (a slow JetStream ack does not delay it) and nothing
 * changes; no PONG within {@link PROBE_MS} → `nc.reconnect()`, a fresh socket, and the outbox resends
 * on the transport-up event (same msgID — a copy that did land is deduped). The connection comes from
 * cotal's public `onConnection` hook (every epoch, rebuilds included) and nats.js's public
 * `flush()` / `reconnect()`; nothing private.
 */

/** How long a PING may go unanswered before the socket is declared dead and replaced — as long as the
 *  JetStream ack was already given (nats.js's 5s), so a merely slow link (measured: 4s RTT) is not torn
 *  down by it; a 3s bound did that twice in six sends there. */
export const PROBE_MS = 5000;

/** The slice of a nats.js NatsConnection this needs (all public API). */
export interface ProbedConnection {
  flush(): Promise<void>;
  reconnect(): Promise<void>;
  isClosed(): boolean;
}

export type ProbeResult = "alive" | "reconnected" | "closed";

export interface LinkProbeOpts {
  probeMs?: number;
  /** Resolve after `ms` (a fake clock in tests). */
  wait?: (ms: number) => Promise<void>;
}

const realWait = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export class LinkProbe {
  private nc: ProbedConnection | undefined;
  private running: Promise<ProbeResult> | undefined;
  private readonly probeMs: number;
  private readonly wait: (ms: number) => Promise<void>;
  /** Sockets this probe found dead and replaced, for `/conn`. */
  forced = 0;

  constructor(o: LinkProbeOpts = {}) {
    this.probeMs = o.probeMs ?? PROBE_MS;
    this.wait = o.wait ?? realWait;
  }

  /** Spread into the CotalEndpoint options: hands every connection the endpoint opens to the probe. */
  endpointOptions(): { onConnection: (nc: ProbedConnection) => void } {
    return {
      onConnection: (nc) => {
        this.nc = nc;
      },
    };
  }

  /** PING the current connection; no PONG in time → force a reconnect. Concurrent calls share one probe. */
  check(): Promise<ProbeResult> {
    return (this.running ??= this.run().finally(() => (this.running = undefined)));
  }

  private async run(): Promise<ProbeResult> {
    const nc = this.nc;
    if (!nc) throw new Error("paw: the link probe was never handed a connection — spread linkProbe.endpointOptions() into the endpoint's options (src/link-probe.ts)");
    if (nc.isClosed()) return "closed";
    const pong = await Promise.race([nc.flush().then(() => true, () => false), this.wait(this.probeMs).then(() => false)]);
    if (pong) return "alive";
    // A rebuild may have swapped the connection while we waited; the new one has not failed anything.
    if (nc !== this.nc || nc.isClosed()) return "closed";
    this.forced++;
    await nc.reconnect();
    return "reconnected";
  }
}

/** A JetStream publish whose ack never came (nats.js `TimeoutError`) — the one failure worth a probe. */
export function isAckTimeout(e: unknown): boolean {
  const err = e as { name?: unknown; message?: unknown };
  return err?.name === "TimeoutError" || (typeof err?.message === "string" && /^timeout$/i.test(err.message));
}

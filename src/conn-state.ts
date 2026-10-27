/**
 * Mesh connection state for long-lived observers (paw chat, paw inbox --watch, paw web).
 *
 * cotal's endpoint reports trouble one event at a time: a `warning` per failed presence heartbeat, and
 * an `error` per failed presence-watch rebind — a raw nats `TimeoutError` whose whole message is
 * "timeout", once per presence TTL (6s) for as long as a slow link holds the watch silent. Printing each
 * one buried a remote chat in red `! timeout` lines (team2027, 2026-10-26). This folds those signals into
 * ONE state the UI shows in place, and prints a transcript line only when the trouble is sustained,
 * when it recovers, or when it is not transient at all (auth, permissions, anything unrecognised).
 *
 * Every state comes from a real signal — the endpoint's `transport` / `connection` events and the
 * warning stream — never from a guess. Nothing is swallowed: every signal is counted, the last one is
 * kept, and {@link ConnState.report} hands both to `/conn`. Pure: time is passed in.
 */

export type ConnPhase = "connecting" | "connected" | "degraded" | "reconnecting" | "disconnected";

export type ConnSignal =
  /** nats transport up/down for the endpoint's current connection (cotal `transport` event). */
  | { kind: "transport"; connected: boolean }
  /** the full cotal bind ready / lost (cotal `connection` event). */
  | { kind: "connection"; connected: boolean }
  | { kind: "warning" | "error"; error: Error };

export interface ConnLine {
  level: "error" | "recovered";
  text: string;
}

/** transient: folded into the state. loud: printed now (auth, permissions, unknown). */
export type Severity = "transient" | "loud";

const AUTH_RE = /authoriz|authenticat|permission|not permitted|denied|expired|revoked|bad (creds|jwt)|invalid (creds|jwt|token)/i;
const TRANSIENT_RE =
  /^timeout$|\btime[sd]? ?out\b|mesh connection closed|connection (closed|draining|lost|refused|reset)|reconnect|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|membership watch closed|presence watch silent|no responders|error connecting/i;

/** A dial that failed (nats.js ConnectionError, a refused/reset socket) — one reconnect attempt. */
const CONNECT_FAILURE_RE = /ConnectionError|error connecting|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused/i;

/**
 * Auth and permission refusals are loud even inside a reconnect message: a broker that drops us for an
 * expired JWT must say so, not show "reconnecting" forever. A creds/bearer refresh failure retries on its
 * own but ends the connection at the token's expiry, so it is loud too. cotal marks an escalated
 * condition (presence-write-stuck) `transient: false`. Anything unrecognised is loud — fail loud.
 */
export function classifyEndpointError(e: Error): Severity {
  const text = `${e.name ?? ""}: ${e.message ?? String(e)}`;
  if (AUTH_RE.test(text)) return "loud";
  if ((e as { transient?: unknown }).transient === false) return "loud";
  if (/refresh failed/i.test(text)) return "loud";
  if (e.name === "TimeoutError" || e.name === "ClosedConnectionError") return "transient";
  return TRANSIENT_RE.test(e.message ?? "") ? "transient" : "loud";
}

const secs = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/** A loud text repeated within this window is counted, not reprinted (digits ignored). */
const LOUD_REPEAT_MS = 10 * 60_000;
const loudKey = (text: string): string => text.replace(/\d+/g, "#");

export class ConnState {
  private readonly sustainMs: number;
  private readonly degradedWindowMs: number;
  private everBound = false;
  private transportUp = false;
  private bound = false;
  /** cotal's terminal-close supervisor fired: nats gave up, cotal is rebuilding the connection. */
  private closedAt: number | undefined;
  /** When the current non-connected streak began, and whether its one sustained line was printed. */
  private problemSince: number | undefined;
  private sustainedPrinted = false;
  /** Failed re-establish attempts (warnings while down) in the current outage. */
  private attempts = 0;
  private lastTransientAt: number | undefined;
  private streakTransients = 0;
  private totalTransients = 0;
  private totalLoud = 0;
  private lastTransient: { text: string; at: number } | undefined;
  private lastLoud: { text: string; at: number } | undefined;
  private readonly loudSeen = new Map<string, number>();
  private readonly startedAt: number;

  constructor(now: number, o: { sustainMs?: number; degradedWindowMs?: number } = {}) {
    this.startedAt = now;
    this.sustainMs = o.sustainMs ?? 30_000;
    this.degradedWindowMs = o.degradedWindowMs ?? 20_000;
  }

  feed(sig: ConnSignal, now: number): ConnLine[] {
    const out: ConnLine[] = [];
    if (sig.kind === "transport") {
      this.transportUp = sig.connected;
      if (sig.connected) this.closedAt = undefined;
    } else if (sig.kind === "connection") {
      this.bound = sig.connected;
      if (sig.connected) {
        this.everBound = true;
        this.closedAt = undefined;
        // A bound connection is up by definition; cotal emits `transport` first, but don't depend on it.
        this.transportUp = true;
      }
    } else {
      const text = sig.error.message || String(sig.error);
      if (classifyEndpointError(sig.error) === "loud" && !this.outageConsequence(sig.error)) {
        this.totalLoud++;
        this.lastLoud = { text, at: now };
        const key = loudKey(text);
        const seen = this.loudSeen.get(key);
        if (seen === undefined || now - seen >= LOUD_REPEAT_MS) {
          this.loudSeen.set(key, now);
          out.push({ level: "error", text: `! ${text}` });
        }
      } else {
        this.totalTransients++;
        this.streakTransients++;
        this.lastTransient = { text, at: now };
        this.lastTransientAt = now;
        if (/mesh connection closed/i.test(text)) {
          this.closedAt ??= now;
          this.bound = false;
        }
        // Only a failed dial is an attempt — the heartbeat timeouts that keep arriving while nats.js
        // reconnects are not, and counting them showed "reconnecting (13)" after one real try.
        if (this.everBound && CONNECT_FAILURE_RE.test(`${sig.error.name}: ${text}`)) this.attempts++;
      }
    }
    return out.concat(this.settle(now));
  }

  /** cotal's presence-write-stuck escalation is the #1356 latched-bucket fault when the connection is
   *  up — and merely the outage restated when it isn't (measured: it fires 3s into a held link). */
  private outageConsequence(e: Error): boolean {
    const down = this.closedAt !== undefined || !this.bound || !this.transportUp;
    return down && (e as { code?: unknown }).code === "presence-write-stuck";
  }

  tick(now: number): ConnLine[] {
    return this.settle(now);
  }

  phase(now: number): ConnPhase {
    if (!this.everBound) return "connecting";
    if (this.closedAt !== undefined) return "disconnected";
    if (!this.transportUp || !this.bound) return "reconnecting";
    if (this.lastTransientAt !== undefined && now - this.lastTransientAt < this.degradedWindowMs) return "degraded";
    return "connected";
  }

  /** The status-line text, uncoloured. Changes only when what it says changes. */
  label(now: number): string {
    const p = this.phase(now);
    if (p === "connected") return "● connected";
    if (p === "connecting") return "◌ connecting…";
    if (p === "degraded") return `◐ degraded (${this.streakTransients} failed)`;
    if (p === "reconnecting") return this.attempts ? `◌ reconnecting (${this.attempts})` : "◌ reconnecting…";
    return `✕ disconnected ${secs(now - (this.closedAt ?? now))}`;
  }

  /** What `/conn` prints: the state, the counts, the last of each kind of signal. */
  report(now: number): string[] {
    const ago = (at: number) => `${secs(now - at)} ago`;
    const lines = [`connection: ${this.label(now)}${this.problemSince !== undefined ? ` — for ${secs(now - this.problemSince)}` : ""}`];
    lines.push(`transient warnings this session: ${this.totalTransients}${this.lastTransient ? ` — last ${ago(this.lastTransient.at)}: ${this.lastTransient.text}` : ""}`);
    lines.push(`errors printed or repeated this session: ${this.totalLoud}${this.lastLoud ? ` — last ${ago(this.lastLoud.at)}: ${this.lastLoud.text}` : ""}`);
    lines.push(`session up ${secs(now - this.startedAt)} · PAW_CONN_DEBUG=1 prints every raw signal`);
    return lines;
  }

  /** The one-line-per-streak rule: a problem prints once when sustained, and once when it recovers. */
  private settle(now: number): ConnLine[] {
    const p = this.phase(now);
    if (p === "connected") {
      const lines: ConnLine[] = [];
      if (this.problemSince !== undefined && this.sustainedPrinted) {
        lines.push({ level: "recovered", text: `● mesh connected again after ${secs(now - this.problemSince)} (${this.streakTransients} transient warning${this.streakTransients === 1 ? "" : "s"} meanwhile)` });
      }
      this.problemSince = undefined;
      this.sustainedPrinted = false;
      this.attempts = 0;
      this.streakTransients = 0;
      return lines;
    }
    this.problemSince ??= p === "connecting" ? this.startedAt : now;
    if (this.sustainedPrinted || now - this.problemSince < this.sustainMs) return [];
    this.sustainedPrinted = true;
    const why = this.lastTransient ? ` — last: ${this.lastTransient.text}` : "";
    const what =
      p === "degraded"
        ? `mesh degraded for ${secs(now - this.problemSince)}: ${this.streakTransients} transient failures with the connection up`
        : p === "connecting"
          ? `still connecting to the mesh after ${secs(now - this.problemSince)}`
          : `mesh ${p} for ${secs(now - this.problemSince)}${this.attempts ? ` (${this.attempts} attempt${this.attempts === 1 ? "" : "s"})` : ""}`;
    return [{ level: "error", text: `! ${what}${why}` }];
  }
}

interface SignalSource {
  on(event: "transport" | "connection", fn: (s: { connected: boolean }) => void): unknown;
  on(event: "warning" | "error", fn: (e: Error) => void): unknown;
}

/**
 * Route an endpoint's connection signals into a {@link ConnState}. `sink` gets the lines to print (the
 * caller decides where: chat's transcript, stderr). The `error` listener this installs is also what
 * keeps node from throwing on an unhandled endpoint error. `PAW_CONN_DEBUG=1` hands every raw signal to
 * `debug` too.
 */
export function attachConn(ep: SignalSource, now: () => number, sink: (lines: ConnLine[]) => void, debug?: (raw: string) => void): ConnState {
  const conn = new ConnState(now());
  const raw = process.env.PAW_CONN_DEBUG === "1" ? debug : undefined;
  const feed = (sig: ConnSignal) => {
    raw?.(sig.kind === "transport" || sig.kind === "connection" ? `[conn] ${sig.kind} ${sig.connected ? "up" : "down"}` : `[conn] ${sig.kind}: ${sig.error.name}: ${sig.error.message}`);
    const lines = conn.feed(sig, now());
    if (lines.length) sink(lines);
  };
  ep.on("transport", (s: { connected: boolean }) => feed({ kind: "transport", connected: s.connected }));
  ep.on("connection", (s: { connected: boolean }) => feed({ kind: "connection", connected: s.connected }));
  ep.on("warning", (e: Error) => feed({ kind: "warning", error: e }));
  ep.on("error", (e: Error) => feed({ kind: "error", error: e }));
  return conn;
}

/** {@link attachConn} for a process with no status line (inbox --watch, paw web): lines go to `write`,
 *  ticked once a second so a sustained streak and its recovery still print. The tick never holds the
 *  process open. */
export function logConn(ep: SignalSource, write: (line: ConnLine) => void): ConnState {
  const sink = (lines: ConnLine[]) => lines.forEach(write);
  const conn = attachConn(ep, Date.now, sink, (raw) => write({ level: "error", text: raw }));
  setInterval(() => sink(conn.tick(Date.now())), 1000).unref();
  return conn;
}

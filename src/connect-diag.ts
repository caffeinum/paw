/**
 * Which step of a NATS connect stalled. cotal's probeConnect says only `timeout`/`unreachable`, which
 * read as "the link is slow or the broker is overloaded" — the 2026-10 team2027 outage (fly box out of
 * memory: TCP connected in 26ms, then nothing) was undiagnosable from that. On the FAILURE path only,
 * paw re-walks the connect one step at a time on sockets it owns — DNS lookup, TCP connect, the
 * server's plaintext NATS INFO greeting, the TLS upgrade — times each, and names the first step that
 * failed. Past TLS (the credentialed CONNECT/PONG) needs the creds' signing handshake, so a stall
 * there is inferred only when every earlier step answered, and said as such.
 *
 * {@link diagnoseConnect} does the network work; {@link explainConnectFailure} is pure (check:connect-diag).
 * The re-check runs after the failed connect, so the broker may have changed in between — the text says so.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type DiagStep = "dns" | "tcp" | "info" | "tls";

export interface StepResult {
  step: DiagStep;
  ms: number;
  /** ok, or how it failed: `error` (with `code`/`detail`), `timeout`, `closed` (peer hung up), `unexpected` (not NATS), `not-offered` (TLS). */
  outcome: "ok" | "error" | "timeout" | "closed" | "unexpected" | "not-offered";
  code?: string;
  detail?: string;
}

export interface ConnectTrace {
  host: string;
  port: number;
  address?: string;
  steps: StepResult[];
  /** From the broker's INFO greeting, when it arrived. */
  info?: { version?: string; tlsRequired: boolean; authRequired: boolean };
  /** True when no INFO came but a TLS-first handshake (`handshake_first` brokers) succeeded. */
  tlsFirst?: boolean;
  /** Per-step time limit used. */
  stepMs: number;
}

export interface DiagOpts {
  stepMs?: number;
  lookup?: (host: string) => Promise<{ address: string }>;
}

/** host + port from a server URL as paw records it (`tls://host:4222`, `nats://…`, bare `host:port`). */
export function serverHostPort(server: string): { host: string; port: number } {
  const first = server.split(",")[0].trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `nats://${first}`);
  if (url.protocol === "ws:" || url.protocol === "wss:") throw new Error(`paw: no step-by-step connect check for websocket server ${server}`);
  if (!url.hostname) throw new Error(`paw: server ${server} names no host`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port: url.port ? Number(url.port) : 4222 };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

function errCode(e: unknown): { code?: string; detail: string } {
  const err = e as NodeJS.ErrnoException;
  return { code: typeof err?.code === "string" ? err.code : undefined, detail: err?.message ?? String(e) };
}

function tcpConnect(address: string, port: number, ms: number): Promise<{ sock?: Socket; r: Omit<StepResult, "step" | "ms"> }> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: address, port });
    const t = setTimeout(() => (sock.destroy(), resolve({ r: { outcome: "timeout" } })), ms);
    sock.once("connect", () => (clearTimeout(t), resolve({ sock, r: { outcome: "ok" } })));
    sock.once("error", (e) => (clearTimeout(t), sock.destroy(), resolve({ r: { outcome: "error", ...errCode(e) } })));
  });
}

/** Read the first line off a connected socket: the NATS `INFO {…}` greeting. */
function readInfo(sock: Socket, ms: number): Promise<{ r: Omit<StepResult, "step" | "ms">; info?: ConnectTrace["info"] }> {
  return new Promise((resolve) => {
    let buf = "";
    const done = (v: { r: Omit<StepResult, "step" | "ms">; info?: ConnectTrace["info"] }) => {
      clearTimeout(t);
      sock.removeListener("data", onData);
      sock.removeListener("close", onClose);
      sock.removeListener("error", onError);
      resolve(v);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const nl = buf.indexOf("\r\n");
      if (nl < 0 && buf.length < 64 * 1024) return;
      const line = nl < 0 ? buf : buf.slice(0, nl);
      const m = /^INFO\s+(\{.*\})\s*$/.exec(line);
      if (!m) return done({ r: { outcome: "unexpected", detail: JSON.stringify(line.slice(0, 60)) } });
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(m[1]) as Record<string, unknown>;
      } catch {
        return done({ r: { outcome: "unexpected", detail: "an INFO line whose JSON does not parse" } });
      }
      done({
        r: { outcome: "ok" },
        info: {
          version: typeof parsed.version === "string" ? parsed.version : undefined,
          tlsRequired: parsed.tls_required === true || parsed.tls_available === true,
          authRequired: parsed.auth_required === true,
        },
      });
    };
    const onClose = () => done({ r: { outcome: "closed" } });
    const onError = (e: Error) => done({ r: { outcome: "error", ...errCode(e) } });
    const t = setTimeout(() => done({ r: { outcome: "timeout" } }), ms);
    sock.on("data", onData);
    sock.once("close", onClose);
    sock.once("error", onError);
  });
}

function tlsHandshake(sock: Socket, host: string, ms: number): Promise<Omit<StepResult, "step" | "ms">> {
  return new Promise((resolve) => {
    const tls = tlsConnect({ socket: sock, ...(isIP(host) ? {} : { servername: host }) });
    const t = setTimeout(() => (tls.destroy(), resolve({ outcome: "timeout" })), ms);
    tls.once("secureConnect", () => (clearTimeout(t), tls.destroy(), resolve({ outcome: "ok" })));
    tls.once("error", (e) => (clearTimeout(t), tls.destroy(), resolve({ outcome: "error", ...errCode(e) })));
    tls.once("close", () => (clearTimeout(t), resolve({ outcome: "closed" })));
  });
}

/** Re-walk a connect to `server` step by step on sockets of our own, each step bounded by `stepMs`. Never throws on a network failure. */
export async function diagnoseConnect(server: string, opts: DiagOpts = {}): Promise<ConnectTrace> {
  const stepMs = opts.stepMs ?? 3000;
  const lookup = opts.lookup ?? ((h: string) => dnsLookup(h));
  const { host, port } = serverHostPort(server);
  const trace: ConnectTrace = { host, port, steps: [], stepMs };
  const timed = async <T>(step: DiagStep, f: () => Promise<T>, r: (v: T) => Omit<StepResult, "step" | "ms">): Promise<T> => {
    const t0 = performance.now();
    const v = await f();
    trace.steps.push({ step, ms: Math.round(performance.now() - t0), ...r(v) });
    return v;
  };

  let address = host;
  if (!isIP(host)) {
    const res = await timed(
      "dns",
      () => withTimeout(lookup(host), stepMs).catch((e: unknown) => ({ err: errCode(e) })),
      (v): Omit<StepResult, "step" | "ms"> => (v === "timeout" ? { outcome: "timeout" } : "err" in v ? { outcome: "error", ...v.err } : { outcome: "ok" }),
    );
    if (res === "timeout" || "err" in res) return trace;
    address = res.address;
  }
  trace.address = address;

  // Dial the NAME, as the real client does (node tries every resolved address); the step above timed DNS alone.
  const tcp = await timed("tcp", () => tcpConnect(host, port, stepMs), (v) => v.r);
  if (!tcp.sock) return trace;
  const sock = tcp.sock;
  if (sock.remoteAddress) trace.address = sock.remoteAddress;
  try {
    const info = await timed("info", () => readInfo(sock, stepMs), (v) => v.r);
    if (info.info) {
      trace.info = info.info;
      if (!info.info.tlsRequired) {
        trace.steps.push({ step: "tls", ms: 0, outcome: "not-offered" });
        return trace;
      }
      await timed("tls", () => tlsHandshake(sock, host, stepMs), (v) => v);
      return trace;
    }
    if (info.r.outcome !== "timeout") return trace;
  } finally {
    sock.destroy();
  }
  // No greeting at all: a `handshake_first` broker opens with TLS instead. One bounded TLS-first try
  // on a fresh socket tells that apart from a broker that accepts and never answers.
  const again = await tcpConnect(host, port, stepMs);
  if (!again.sock) return trace;
  const t0 = performance.now();
  const first = await tlsHandshake(again.sock, host, stepMs);
  again.sock.destroy();
  if (first.outcome === "ok") {
    trace.tlsFirst = true;
    trace.steps = trace.steps.filter((s) => s.step !== "info");
    trace.steps.push({ step: "tls", ms: Math.round(performance.now() - t0), outcome: "ok", detail: "TLS-first" });
  }
  return trace;
}

const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

const secs = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

/** "DNS 4ms → 1.2.3.4, TCP 26ms, INFO 31ms (nats 2.14.7), TLS 140ms" — the steps that answered. */
function timings(t: ConnectTrace): string {
  const parts: string[] = [];
  for (const s of t.steps) {
    if (s.outcome !== "ok") continue;
    if (s.step === "dns") parts.push(`DNS ${s.ms}ms → ${t.address}`);
    if (s.step === "tcp") parts.push(`TCP ${s.ms}ms`);
    if (s.step === "info") parts.push(`INFO ${s.ms}ms${t.info?.version ? ` (nats-server ${t.info.version})` : ""}`);
    if (s.step === "tls") parts.push(`TLS${t.tlsFirst ? "-first" : ""} ${s.ms}ms`);
  }
  return parts.join(", ");
}

/** "check `fly status -a <app>` and its memory" for a fly-hosted broker; nothing otherwise. */
function hostHint(host: string): string {
  const fly = /^([a-z0-9-]+)\.fly\.dev$/i.exec(host);
  return fly ? ` — check \`fly status -a ${fly[1]}\` and the app's memory/CPU metrics` : " — check the broker host's memory/CPU";
}

/**
 * Why a probeConnect `timeout`/`unreachable` happened, from a {@link diagnoseConnect} re-check:
 * the first failed step and what that step failing means. Says only what the trace shows.
 */
export function explainConnectFailure(reason: "timeout" | "unreachable", trace: ConnectTrace, timeoutMs: number): string {
  const head = reason === "timeout" ? `the connect timed out after ${secs(timeoutMs)}` : `the connect failed`;
  const ok = timings(trace);
  const before = ok ? `${ok}; then ` : "";
  const failed = trace.steps.find((s) => s.outcome !== "ok");
  const step = secs(trace.stepMs);
  const at = `${trace.address ?? trace.host}:${trace.port}`;
  const err = (s: StepResult) => (s.code && s.detail && !s.detail.includes(s.code) ? `${s.code}: ${s.detail}` : (s.detail ?? s.code ?? "no detail"));
  let verdict: string;
  if (!failed) {
    const last = trace.steps[trace.steps.length - 1];
    if (!last || last.step !== "tls") throw new Error(`paw: connect trace for ${at} ended at step ${last?.step ?? "none"} without a failure`);
    verdict =
      reason === "timeout"
        ? `${ok} all answered on a re-check, so either the ${secs(timeoutMs)} stall was past TLS, on the authenticated CONNECT — the broker itself is stalled (overloaded or out of memory)${hostHint(trace.host)} — or it recovered between the two tries, so retry`
        : `${ok} all answered on a re-check, but the NATS connect itself failed past TLS — the broker dropped the session (restarting?), or it recovered between the two tries, so retry`;
  } else if (failed.step === "dns") {
    verdict =
      failed.outcome === "timeout"
        ? `the DNS lookup of ${trace.host} got no answer within ${step}: this machine's network or resolver is down`
        : `the DNS lookup of ${trace.host} failed on this machine (${err(failed)}): this machine's network/resolver, or a wrong address`;
  } else if (failed.step === "tcp") {
    if (failed.outcome === "timeout") verdict = `${before}the TCP connect to ${at} did not complete within ${step}: the link or the broker's host is down, or a firewall drops the traffic`;
    else if (failed.code === "ECONNREFUSED") verdict = `${before}the TCP connect to ${at} was refused: nothing listens there — the broker (or the proxy in front of it) is down, or the port is wrong`;
    else verdict = `${before}the TCP connect to ${at} failed (${err(failed)}): no route from this machine to the broker — check this machine's network`;
  } else if (failed.step === "info") {
    if (failed.outcome === "timeout")
      verdict = `${before}no NATS INFO greeting within ${step}: something accepts connections at ${at} but the broker is not serving them — stalled (overloaded or out of memory)${hostHint(trace.host)}`;
    else if (failed.outcome === "closed")
      verdict = `${before}the peer closed the connection before any NATS INFO greeting: the broker (or the proxy in front of it) dropped it — it may be down or restarting${hostHint(trace.host)}`;
    else if (failed.outcome === "unexpected") verdict = `${before}the peer answered with something that is not NATS (${failed.detail}): the address or port points at another service`;
    else verdict = `${before}the connection failed while waiting for the NATS INFO greeting (${err(failed)})`;
  } else {
    if (failed.outcome === "not-offered")
      verdict = `${before}the broker's INFO says it does not offer TLS, and paw requires TLS for a remote mesh: the broker has no tls block, or the address points at a plaintext listener`;
    else if (failed.outcome === "timeout")
      verdict = `${before}the TLS handshake stalled for ${step}: the broker is stalled (overloaded or out of memory)${hostHint(trace.host)}`;
    else if (failed.code && CERT_CODES.has(failed.code))
      verdict = `${before}this machine rejected the broker's TLS certificate (${err(failed)}): a private CA needs NODE_EXTRA_CA_CERTS=<ca.pem> in the environment of every paw command`;
    else verdict = `${before}the TLS handshake failed (${failed.outcome === "closed" ? "the peer closed it" : err(failed)})`;
  }
  return `${head}. A step-by-step re-check: ${verdict}`;
}

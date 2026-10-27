/**
 * The remote-connect failure explanation (src/connect-diag.ts): the pure classification of a step
 * trace, then diagnoseConnect against throwaway localhost listeners that each fail one step.
 * Hermetic: loopback sockets and an injected DNS lookup only. Run: pnpm check:connect-diag
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { diagnoseConnect, explainConnectFailure, serverHostPort, type ConnectTrace, type StepResult } from "../src/connect-diag.ts";

let failures = 0;
function assert(cond: boolean, msg: string, got?: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}${got === undefined ? "" : `\n        got: ${got}`}`);
  }
}

const ok = (step: StepResult["step"], ms: number): StepResult => ({ step, ms, outcome: "ok" });
const fly = (steps: StepResult[], extra: Partial<ConnectTrace> = {}): ConnectTrace => ({
  host: "2027-cotal.fly.dev",
  port: 4222,
  address: "66.241.124.9",
  steps,
  stepMs: 3000,
  info: { version: "2.14.7", tlsRequired: true, authRequired: true },
  ...extra,
});

console.log("explainConnectFailure");
{
  const m = explainConnectFailure("timeout", fly([ok("dns", 4), ok("tcp", 26), ok("info", 31), ok("tls", 140)]), 10_000);
  assert(m.startsWith("the connect timed out after 10s."), "timeout: says the budget", m);
  assert(m.includes("DNS 4ms → 66.241.124.9, TCP 26ms, INFO 31ms (nats-server 2.14.7), TLS 140ms"), "timeout past TLS: lists every step's time", m);
  assert(m.includes("the 10s stall was past TLS, on the authenticated CONNECT") && m.includes("stalled (overloaded or out of memory)"), "timeout past TLS: blames the broker's CONNECT", m);
  assert(m.includes("fly status -a 2027-cotal"), "fly host: names the app to check", m);
  assert(m.includes("recovered between the two tries"), "past-TLS verdict admits the re-check is a second try", m);

  const silent = explainConnectFailure("timeout", fly([ok("dns", 4), ok("tcp", 26), { step: "info", ms: 3000, outcome: "timeout" }], { info: undefined }), 10_000);
  assert(silent.includes("TCP 26ms; then no NATS INFO greeting within 3s") && silent.includes("broker is not serving them"), "TCP ok + no INFO: the broker is stalled", silent);
  assert(!silent.includes("link is slow"), "no unfounded link blame", silent);

  const dns = explainConnectFailure("unreachable", fly([{ step: "dns", ms: 12, outcome: "error", code: "ENOTFOUND", detail: "getaddrinfo ENOTFOUND 2027-cotal.fly.dev" }], { address: undefined, info: undefined }), 10_000);
  assert(dns.startsWith("the connect failed.") && dns.includes("DNS lookup of 2027-cotal.fly.dev failed on this machine (getaddrinfo ENOTFOUND 2027-cotal.fly.dev)"), "ENOTFOUND: DNS on this machine", dns);
  assert(!dns.includes("fly status"), "DNS failure: no broker hint", dns);

  const dnsT = explainConnectFailure("timeout", fly([{ step: "dns", ms: 3000, outcome: "timeout" }], { address: undefined, info: undefined }), 10_000);
  assert(dnsT.includes("DNS lookup of 2027-cotal.fly.dev got no answer within 3s"), "DNS timeout", dnsT);

  const refused = explainConnectFailure("unreachable", fly([ok("dns", 3), { step: "tcp", ms: 1, outcome: "error", code: "ECONNREFUSED", detail: "connect ECONNREFUSED 66.241.124.9:4222" }], { info: undefined }), 10_000);
  assert(refused.includes("DNS 3ms → 66.241.124.9; then the TCP connect to 66.241.124.9:4222 was refused: nothing listens there"), "ECONNREFUSED", refused);

  const tcpT = explainConnectFailure("timeout", fly([ok("dns", 3), { step: "tcp", ms: 3000, outcome: "timeout" }], { info: undefined }), 10_000);
  assert(tcpT.includes("TCP connect to 66.241.124.9:4222 did not complete within 3s: the link or the broker's host is down"), "TCP timeout: link or host", tcpT);

  const unroute = explainConnectFailure("unreachable", fly([ok("dns", 3), { step: "tcp", ms: 2, outcome: "error", code: "ENETUNREACH", detail: "connect ENETUNREACH" }], { info: undefined }), 10_000);
  assert(unroute.includes("no route from this machine"), "ENETUNREACH: this machine's network", unroute);

  const closed = explainConnectFailure("unreachable", fly([ok("dns", 3), ok("tcp", 20), { step: "info", ms: 5, outcome: "closed" }], { info: undefined }), 10_000);
  assert(closed.includes("closed the connection before any NATS INFO greeting"), "peer hangs up before INFO", closed);

  const http = explainConnectFailure("unreachable", fly([ok("dns", 3), ok("tcp", 20), { step: "info", ms: 5, outcome: "unexpected", detail: '"HTTP/1.1 400 Bad Request"' }], { info: undefined }), 10_000);
  assert(http.includes("not NATS") && http.includes("HTTP/1.1 400"), "a non-NATS service", http);

  const cert = explainConnectFailure("unreachable", fly([ok("dns", 3), ok("tcp", 20), ok("info", 22), { step: "tls", ms: 30, outcome: "error", code: "SELF_SIGNED_CERT_IN_CHAIN", detail: "self-signed certificate in certificate chain" }]), 10_000);
  assert(cert.includes("rejected the broker's TLS certificate (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)") && cert.includes("NODE_EXTRA_CA_CERTS"), "cert trust: names the code + the CA fix", cert);

  const tlsT = explainConnectFailure("timeout", fly([ok("dns", 3), ok("tcp", 20), ok("info", 22), { step: "tls", ms: 3000, outcome: "timeout" }]), 10_000);
  assert(tlsT.includes("INFO 22ms (nats-server 2.14.7); then the TLS handshake stalled for 3s") && tlsT.includes("fly status"), "TLS stall: broker stalled", tlsT);

  const plain = explainConnectFailure("unreachable", fly([ok("dns", 3), ok("tcp", 20), ok("info", 22), { step: "tls", ms: 0, outcome: "not-offered" }], { info: { tlsRequired: false, authRequired: false } }), 10_000);
  assert(plain.includes("does not offer TLS, and paw requires TLS"), "plaintext broker vs required TLS", plain);

  const past = explainConnectFailure("unreachable", fly([ok("dns", 3), ok("tcp", 20), ok("info", 22), ok("tls", 50)]), 10_000);
  assert(past.includes("the NATS connect itself failed past TLS"), "unreachable but every step answers", past);

  const other = explainConnectFailure("timeout", { host: "mesh.example.com", port: 4222, address: "10.0.0.2", steps: [ok("dns", 1), ok("tcp", 2), { step: "info", ms: 3000, outcome: "timeout" }], stepMs: 3000 }, 10_000);
  assert(other.includes("check the broker host's memory/CPU") && !other.includes("fly"), "non-fly host: generic host hint", other);

  let threw = false;
  try {
    explainConnectFailure("timeout", fly([ok("dns", 1), ok("tcp", 2)]), 10_000);
  } catch {
    threw = true;
  }
  assert(threw, "a trace that stops without a failure throws (never a guessed verdict)");
}

console.log("serverHostPort");
{
  const a = serverHostPort("tls://2027-cotal.fly.dev:4222");
  assert(a.host === "2027-cotal.fly.dev" && a.port === 4222, "tls:// URL");
  const b = serverHostPort("127.0.0.1:5222");
  assert(b.host === "127.0.0.1" && b.port === 5222, "bare host:port");
  const c = serverHostPort("nats://[::1]:4223");
  assert(c.host === "::1" && c.port === 4223, "IPv6 literal");
  let threw = false;
  try {
    serverHostPort("wss://x.example:443");
  } catch {
    threw = true;
  }
  assert(threw, "websocket servers fail loud");
}

async function listen(onConn: (s: Socket) => void): Promise<{ srv: Server; port: number }> {
  const srv = createServer(onConn);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { srv, port: addr.port };
}
const sockets: Socket[] = [];
const close = (srv: Server) => {
  for (const s of sockets.splice(0)) s.destroy();
  return new Promise<void>((r) => srv.close(() => r()));
};
const keep = (s: Socket) => (sockets.push(s), s.on("error", () => {}));
const INFO = (o: Record<string, unknown>) => `INFO ${JSON.stringify({ server_id: "x", version: "2.14.7", ...o })}\r\n`;
const outcomes = (t: ConnectTrace) => t.steps.map((s) => `${s.step}:${s.outcome}`).join(" ");

console.log("diagnoseConnect (loopback)");
{
  const { srv, port } = await listen(() => {});
  await close(srv);
  const t = await diagnoseConnect(`tls://127.0.0.1:${port}`, { stepMs: 500 });
  assert(outcomes(t) === "tcp:error" && t.steps[0].code === "ECONNREFUSED", "closed port → tcp ECONNREFUSED (IP literal skips DNS)", outcomes(t));
}
{
  const t = await diagnoseConnect("tls://nowhere.invalid:4222", {
    stepMs: 500,
    lookup: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.invalid"), { code: "ENOTFOUND" });
    },
  });
  assert(outcomes(t) === "dns:error" && t.steps[0].code === "ENOTFOUND", "lookup failure → dns error", outcomes(t));
}
{
  const t = await diagnoseConnect("tls://slow.invalid:4222", { stepMs: 200, lookup: () => new Promise(() => {}) });
  assert(outcomes(t) === "dns:timeout", "hung lookup → dns timeout", outcomes(t));
}
{
  const { srv, port } = await listen(keep);
  const t0 = Date.now();
  const t = await diagnoseConnect(`tls://localhost:${port}`, { stepMs: 300, lookup: async () => ({ address: "127.0.0.1" }) });
  assert(outcomes(t) === "dns:ok tcp:ok info:timeout", "accepts but never greets → info timeout (TLS-first try fails too)", outcomes(t));
  assert(Date.now() - t0 < 2000, "bounded by the step limit");
  const m = explainConnectFailure("timeout", t, 10_000);
  assert(m.includes("no NATS INFO greeting within 0.3s"), "end to end: the stall named", m);
  await close(srv);
}
{
  const { srv, port } = await listen((s) => s.destroy());

  const t = await diagnoseConnect(`tls://127.0.0.1:${port}`, { stepMs: 500 });
  assert(outcomes(t) === "tcp:ok info:closed", "hangs up at once → info closed", outcomes(t));
  await close(srv);
}
{
  const { srv, port } = await listen((s) => (keep(s), s.write("HTTP/1.1 400 Bad Request\r\n\r\n")));
  const t = await diagnoseConnect(`tls://127.0.0.1:${port}`, { stepMs: 500 });
  assert(outcomes(t) === "tcp:ok info:unexpected" && (t.steps[1].detail ?? "").includes("HTTP/1.1 400"), "non-NATS greeting → unexpected", outcomes(t));
  await close(srv);
}
{
  const { srv, port } = await listen((s) => (keep(s), s.write(INFO({ tls_required: false }))));
  const t = await diagnoseConnect(`tls://127.0.0.1:${port}`, { stepMs: 500 });
  assert(outcomes(t) === "tcp:ok info:ok tls:not-offered" && t.info?.version === "2.14.7", "plaintext INFO → TLS not offered", outcomes(t));
  await close(srv);
}
{
  const { srv, port } = await listen((s) => (keep(s), s.write(INFO({ tls_required: true }))));
  const t = await diagnoseConnect(`tls://127.0.0.1:${port}`, { stepMs: 300 });
  assert(outcomes(t) === "tcp:ok info:ok tls:timeout", "INFO then silence on the TLS upgrade → tls timeout", outcomes(t));
  await close(srv);
}
{
  // A self-signed cert this machine doesn't trust: the upgrade must fail with the cert's own code.
  const dir = mkdtempSync(join(tmpdir(), "paw-diag-"));
  let haveCert = true;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  } catch {
    haveCert = false;
  }
  if (!haveCert) console.log("  skip  self-signed TLS rejection (no openssl)");
  else {
    const key = readFileSync(join(dir, "k.pem"));
    const cert = readFileSync(join(dir, "c.pem"));
    const { srv, port } = await listen((s) => {
      keep(s);
      s.write(INFO({ tls_required: true }));
      const t = new TLSSocket(s, { isServer: true, key, cert });
      t.on("error", () => {});
    });
    const t = await diagnoseConnect(`tls://localhost:${port}`, { stepMs: 1000, lookup: async () => ({ address: "127.0.0.1" }) });
    assert(outcomes(t) === "dns:ok tcp:ok info:ok tls:error" && t.steps[3].code === "DEPTH_ZERO_SELF_SIGNED_CERT", "untrusted cert → tls error with its code", `${outcomes(t)} ${t.steps[3]?.code}`);
    const m = explainConnectFailure("unreachable", t, 10_000);
    assert(m.includes("rejected the broker's TLS certificate") && m.includes("NODE_EXTRA_CA_CERTS"), "end to end: cert verdict", m);
    await close(srv);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log("ensure() on a remote space whose broker accepts and never answers (the 2026-10 outage)");
{
  process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-diag-home-"));
  process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "paw-diag-cotal-"));
  delete process.env.PAW_SERVER;
  delete process.env.PAW_COTAL_ROOT;
  const space = `test-diag-${process.pid}`;
  const { createSpaceAuth, stripSpaceAuth } = await import("@cotal-ai/core");
  const { writeRemoteMesh } = await import("../src/remote-mesh.ts");
  const { ensure } = await import("../src/lifecycle.ts");
  const root = mkdtempSync(join(tmpdir(), "paw-diag-root-"));
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
  writeFileSync(join(root, ".cotal", "auth", "auth.json"), JSON.stringify(stripSpaceAuth(await createSpaceAuth(space))), { mode: 0o600 });
  const { srv, port } = await listen(keep);
  writeRemoteMesh({ space, server: `tls://127.0.0.1:${port}`, root, ts: new Date().toISOString() });
  let msg = "";
  try {
    await ensure({ space, needMesh: true });
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes(`remote mesh "${space}"`) && msg.includes("the connect timed out after 10s"), "the probe still times out at 10s", msg);
  assert(/TCP \d+ms; then no NATS INFO greeting within 3s/.test(msg) && msg.includes("broker is not serving them"), "and the message names the stalled step", msg);
  await close(srv);
  for (const d of [process.env.PAW_HOME, process.env.COTAL_HOME, root]) rmSync(d, { recursive: true, force: true });
}

for (const s of sockets) s.destroy();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall connect-diag checks passed");

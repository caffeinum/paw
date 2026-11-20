/**
 * e2e:echo-renewal — chat's `chat-echo` connection (src/chat-own.ts startEcho) outlives its cred on a
 * REMOTE JWT + TLS broker, with no paw timer: cotal's endpoint creds SOURCE re-signs it at 75% of its
 * life and moves the connection onto it. Fully isolated (temp PAW_HOME / COTAL_HOME / roots, a private
 * broker on a free port), torn down at the end.
 *
 *   1. control: a raw connect() on the same kind of paw-signed cred, static, is closed by the broker
 *      at `exp` ("User Authentication Expired") — what any connection paw dials itself gets;
 *   2. startEcho on a TTL-second cred still delivers "you"'s own outbound DM published after 2×TTL.
 *
 *   COTAL_BIN=<cotal-ai@X>/dist/cotal.js node scripts/e2e-echo-renewal.ts   (E2E_TTL=20 by default)
 *
 * The broker's cotal version is free (team2027's broker runs 0.100.2): renewal is client-side, and
 * the broker's only part is nats-server closing a connection at its JWT's `exp`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TTL = Number(process.env.E2E_TTL ?? 20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === "--probe") {
  const [, , , space, server] = process.argv as [string, string, string, string, string];
  const { idFromCreds, newIdentity, unicastSubject } = await import("@cotal-ai/core");
  const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
  const { signScopedCreds, echoGrants } = await import("../src/remote-creds.ts");
  const { startEcho, ownSendSubjects } = await import("../src/chat-own.ts");
  const enc = new TextEncoder();
  const me = { owner: "local", actor: "UME" };
  const dm = ownSendSubjects(space, me).dm;
  const sent = unicastSubject(space, "local", "agent", me.owner, me.actor);
  const dial = (creds: string) => connect({ servers: server, tls: {}, authenticator: credsAuthenticator(enc.encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}`, maxReconnectAttempts: 2 });

  const control = await dial(await signScopedCreds(space, "probe-static", newIdentity(), echoGrants(dm), TTL));
  let controlClosed = "";
  void control.closed().then((e) => (controlClosed = e ? e.message : "clean"));
  let controlExpired = false;
  void (async () => {
    for await (const s of control.status()) if (s.type === "error" && /expired/i.test(String((s as { error?: Error }).error?.message))) controlExpired = true;
  })();

  const seen: string[] = [];
  const errors: string[] = [];
  const fakeEp = { card: { id: `${me.owner}.${me.actor}` } } as unknown as Parameters<typeof startEcho>[0];
  const stop = await startEcho(fakeEp, space, server, (_s, m) => seen.push(String((m as { id?: string } | undefined)?.id)), (e) => errors.push(e.message), { ttlSec: TTL });

  const pub = await dial(await signScopedCreds(space, "probe-pub", newIdentity(), { pub: [sent], sub: [] }, 3600));
  const publish = async (id: string) => {
    pub.publish(sent, JSON.stringify({ id }));
    await pub.flush();
    await sleep(1500);
    return seen.includes(id);
  };
  const before = await publish("m-before");
  await sleep((2 * TTL + 5) * 1000);
  const after = await publish("m-after");
  await Promise.allSettled([stop(), pub.close(), control.close()]);
  console.log(JSON.stringify({ controlExpired, controlClosed, before, after, errors }));
  process.exit(0);
}

const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:echo-renewal needs COTAL_BIN=<cotal-ai package>/dist/cotal.js (see e2e-remote.ts)");
const tag = `${process.pid}`;
const R = `echorenew-${tag}`;
const work = realpathSync(mkdtempSync("/tmp/er-"));
const remoteRoot = join(work, "remote");
const localRoot = join(work, "local");
for (const d of [join(work, "pawhome"), remoteRoot, join(localRoot, ".cotal", "auth"), join(work, "cotalhome"), join(work, "xdg")]) mkdirSync(d, { recursive: true });
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const server = `tls://127.0.0.1:${port}`;
const cert = join(work, "cert.pem");
const key = join(work, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAW_HOME: join(work, "pawhome"),
  PAW_SPACE: `echodecoy-${tag}`,
  PAW_SERVER: "nats://127.0.0.1:9",
  PAW_RELEASE: "dev",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NODE_EXTRA_CA_CERTS: cert,
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "PAW_COTAL_HUB"]) delete env[k];
const must = (what: string, cmd: string[], cwd: string) => {
  const r = spawnSync(process.execPath, cmd, { env, cwd, encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`e2e:echo-renewal setup failed — ${what}: ${r.stdout}${r.stderr}`);
  return r.stdout;
};

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
try {
  must("cotal up", [COTAL, "up", "--detach", "--no-manager", "--space", R, "--server", server, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")], remoteRoot);
  console.log(`broker: cotal-ai@${(JSON.parse(readFileSync(join(COTAL, "../../package.json"), "utf8")) as { version: string }).version}, cred TTL ${TTL}s`);
  must("cotal auth signer", [COTAL, "auth", "signer", "--out", join(work, "signer.json")], remoteRoot);
  copyFileSync(join(work, "signer.json"), join(localRoot, ".cotal", "auth", "auth.json"));
  must("paw mesh add", [join(REPO, "bin/paw.ts"), "mesh", "add", R, "--server", server, "--root", localRoot], REPO);
  const out = must("probe", [fileURLToPath(import.meta.url), "--probe", R, server], REPO).trim().split("\n").pop()!;
  const r = JSON.parse(out) as { controlExpired: boolean; controlClosed: string; before: boolean; after: boolean; errors: string[] };
  ok("control: a static paw-signed connection is cut by the broker at its cred's exp", r.controlExpired && r.controlClosed !== "", r.controlClosed);
  ok("startEcho delivers before the first exp", r.before);
  ok(`startEcho still delivers after 2×TTL (cotal renewed the source-backed cred)`, r.after);
  ok("startEcho reported no error", r.errors.length === 0, r.errors.join(" | "));
} finally {
  spawnSync(process.execPath, [COTAL, "down", "--yes"], { env, cwd: remoteRoot, encoding: "utf8" });
  await sleep(1000);
  const left = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => (l.includes(work) || l.includes(R)) && !l.includes("e2e-echo-renewal"));
  for (const l of left) {
    try {
      process.kill(Number(l.trim().split(/\s+/)[0]), "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  ok("teardown leaves no process of this run", left.length === 0, left.join(" | "));
  rmSync(work, { recursive: true, force: true });
}
console.log(`\ne2e:echo-renewal — ${fails} failure(s)`);
if (fails) process.exit(1);

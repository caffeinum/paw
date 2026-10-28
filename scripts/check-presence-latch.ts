/**
 * The wake gate must not restart agents while the presence store is latched (2026-10-14: a disk-full
 * broker froze `cotal_presence_paw`, every agent read offline, and `paw chat @evals` restarted evals into
 * a seat that could never register — evals died). Boots a PRIVATE nats-server on a random port
 * (PAW_SERVER points every paw read at it; the live broker is never touched) and an isolated PAW_HOME.
 *
 * A latch is a presence put that gets NO answer. The hermetic stand-in: a plain subscriber on the
 * bucket's `$KV.` subjects swallows the put, exactly the no-reply a latched JetStream gives. (A real
 * latch was reproduced once by hand on a 4 MB ramdisk filled to 100% — nats-server 2.14.7 logged
 * "Critical write error: no space left on device" and the probe read latched even after the disk was
 * freed — but a ramdisk is not hermetic, so it isn't run here.)
 *
 * Under auth: a third private broker in operator/JWT mode (cotal's own `serverConfig`, a fresh space
 * account) proves the probe's paw-signed one-key cred can write AND clear its key, still reads a latch,
 * and can reach nothing else — and that paw's control creds alone are refused. Run: pnpm check:presence-latch
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-latch-home-"));
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), "paw-latch-js-"));
// The authed space's signer lives here; every other space finds no auth under it (an open mesh).
process.env.PAW_COTAL_ROOT = mkdtempSync(join(tmpdir(), "paw-latch-root-"));

const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { jetstream, jetstreamManager } = await import("@nats-io/jetstream");
const { createSpaceAuth, idFromCreds, newIdentity, serverConfig, stripSpaceAuth } = await import("@cotal-ai/core");
const { probePresenceWrites, presenceLatchRefusal, isPermissionViolation, probeRefusedLine } = await import("../src/presence-health.ts");
const { presenceProbeCreds, presenceProbeGrants, signScopedCreds } = await import("../src/remote-creds.ts");
const { controlCreds, ensureAgentSpawned, ensurePersonaFile, restartAgent } = await import("../src/addressing.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const srv = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", storeDir], { stdio: "ignore" });
srv.on("error", (e) => {
  throw new Error(`check:presence-latch needs nats-server on PATH: ${e.message}`);
});
const server = process.env.PAW_SERVER;
let nc;
for (let i = 0; !nc; i++) {
  try {
    nc = await connect({ servers: server });
  } catch (e) {
    if (i > 40) throw new Error(`private nats-server never came up on ${server}: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const jsm = await jetstreamManager(nc);
let denySrv: ChildProcess | undefined;
let authSrv: ChildProcess | undefined;

async function connectWhenUp(servers: string, creds?: string) {
  const auth = creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}` } : {};
  for (let i = 0; ; i++) {
    try {
      return await connect({ servers, ...auth });
    } catch (e) {
      if (i > 40) throw new Error(`private nats-server never came up on ${servers}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

try {
  // --- the probe itself -------------------------------------------------------
  let t = Date.now();
  assert((await probePresenceWrites("nobucket", server, undefined)).kind === "no-bucket", "probe: a space with no presence bucket is no-bucket (not latched)");
  assert(Date.now() - t < 1000, "probe: no-bucket answers at once");

  await jsm.streams.add({ name: "KV_cotal_presence_healthy", subjects: ["$KV.cotal_presence_healthy.>"], max_msgs_per_subject: 1 });
  t = Date.now();
  assert((await probePresenceWrites("healthy", server, undefined)).kind === "ok", "probe: a writable bucket is ok");
  const healthyMs = Date.now() - t;
  assert(healthyMs < 500, `probe: healthy cost is small (${healthyMs}ms)`);
  assert((await jsm.streams.info("KV_cotal_presence_healthy")).state.messages === 0, "probe: leaves no probe key behind");

  nc.subscribe("$KV.cotal_presence_latched.>", { callback: () => {} }); // swallow: the put never gets an answer
  t = Date.now();
  const latched = await probePresenceWrites("latched", server, undefined, 800);
  assert(latched.kind === "latched" && latched.bucket === "cotal_presence_latched", "probe: an unanswered put reads latched");
  assert(Date.now() - t < 2500, "probe: bounded by its timeout");

  const msg = presenceLatchRefusal("evals", { bucket: "cotal_presence_paw", waitedMs: 3000 }, "nats://127.0.0.1:4222");
  assert(msg.includes("isn't accepting writes") && msg.includes("#1356") && msg.includes("nothing was stopped or started") && msg.includes("restart the mesh broker"), "refusal: names the latch, says nothing was restarted, gives the remedy");

  // --- the wake gate -------------------------------------------------------------
  const calls: string[] = [];
  const fakeCtl = (rows: object[]) =>
    ({
      ps: async () => ({ ok: true, data: rows }),
      despawn: async (n: string) => {
        calls.push(`despawn ${n}`);
        return { ok: true };
      },
      spawn: async (a: { name: string }) => {
        calls.push(`spawn ${a.name}`);
        return { ok: false, error: "stub" };
      },
    }) as unknown as Parameters<typeof ensureAgentSpawned>[0];
  const offlineRow = [{ name: "evals", status: "running", mesh: "offline", id: "x" }];

  // The incident, end to end against the private broker: no stub probe, the real put goes unanswered.
  let err = "";
  await ensureAgentSpawned(fakeCtl(offlineRow), { space: "latched", name: "evals", cwd: process.env.PAW_HOME! }).catch((e: Error) => (err = e.message));
  assert(err.includes("isn't accepting writes") && err.includes("nothing was stopped or started"), "gate (restart, real probe): refuses loudly on a latched store");
  assert(calls.length === 0, `gate (restart, real probe): never despawned nor spawned (${calls.join(", ") || "no calls"})`);

  err = "";
  const latchedStub = async () => ({ kind: "latched" as const, bucket: "cotal_presence_x", waitedMs: 3000 });
  await ensureAgentSpawned(fakeCtl([{ name: "evals", status: "exited", mesh: "offline" }]), { space: "x", name: "evals", cwd: "/x", probePresence: latchedStub }).catch((e: Error) => (err = e.message));
  assert(err.includes("nothing was stopped or started") && calls.length === 0, "gate (restart of an exited row): refuses too — a new seat couldn't register either");

  err = "";
  await restartAgent(fakeCtl(offlineRow), { space: "latched", name: "evals", cwd: process.env.PAW_HOME! }).catch((e: Error) => (err = e.message));
  assert(err.includes("isn't accepting writes") && calls.length === 0, "restartAgent: refuses BEFORE stopping the live agent");

  // A cold start reads the roster first, and that read CREATES the bucket on an open mesh — which ends
  // the swallow simulation (the put would then be answered). So this one uses the probe seam.
  err = "";
  await ensureAgentSpawned(fakeCtl([]), { space: "x", name: "fresh", cwd: "/x", probePresence: latchedStub }).catch((e: Error) => (err = e.message));
  assert(err.includes("isn't accepting writes") && calls.length === 0, `gate (cold start): refuses before spawning (${err.split("\n")[0]})`);

  // A healthy store leaves the gate exactly as it was: the zombie is still cleared. The stub despawn
  // never resolves the flow onward (the rest of a spawn writes trust state), so race it.
  ensurePersonaFile("healthy", "evals"); // the restart branch reads its resume pin
  const reached = new Promise<void>((resolve) => {
    const ctl = fakeCtl(offlineRow) as unknown as { despawn: (n: string) => Promise<unknown> };
    ctl.despawn = async (n: string) => {
      calls.push(`despawn ${n}`);
      resolve();
      return new Promise(() => {});
    };
    void ensureAgentSpawned(ctl as unknown as Parameters<typeof ensureAgentSpawned>[0], { space: "healthy", name: "evals", cwd: "/x", restartLive: "allow" }).catch((e: Error) => console.error("healthy gate threw:", e.message));
  });
  await Promise.race([reached, new Promise((r) => setTimeout(r, 5000))]);
  assert(calls.join() === "despawn evals", `gate (healthy store, real probe): still restarts a genuine zombie (${calls.join() || "no calls"})`);

  // --- auth refusal (PAW_AUTH) -------------------------------------------------------
  // paw's control creds hold no `$KV` grant, so under PAW_AUTH the probe's put is REFUSED by the broker.
  // A second private broker denies the presence publish to its default user — the same server -ERR a JWT
  // mesh sends (measured there too: RequestError ← PermissionViolationError, at once). It must read
  // not-permitted, fast, and the gate must proceed rather than call it a latch.
  const denyPort = port + 1;
  const denyServer = `nats://127.0.0.1:${denyPort}`;
  const denyConf = join(storeDir, "deny.conf");
  writeFileSync(
    denyConf,
    `listen: 127.0.0.1:${denyPort}\njetstream { store_dir: "${join(storeDir, "deny-js")}" }\n` +
      `authorization { users = [ { user: "probe", password: "probe", permissions: { publish: { deny: ["$KV.cotal_presence_denied.>"] } } } ] }\nno_auth_user: probe\n`,
  );
  denySrv = spawn("nats-server", ["-c", denyConf], { stdio: "ignore" });
  let dnc;
  for (let i = 0; !dnc; i++) {
    try {
      dnc = await connect({ servers: denyServer });
    } catch (e) {
      if (i > 40) throw new Error(`deny nats-server never came up on ${denyServer}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await (await jetstreamManager(dnc)).streams.add({ name: "KV_cotal_presence_denied", subjects: ["$KV.cotal_presence_denied.>"], max_msgs_per_subject: 1 });
  await dnc.close();
  t = Date.now();
  const denied = await probePresenceWrites("denied", denyServer, undefined);
  assert(denied.kind === "not-permitted" && /permissions violation/i.test((denied as { message: string }).message), `probe: a refused put reads not-permitted (${JSON.stringify(denied)})`);
  assert(Date.now() - t < 1000, `probe: a refusal answers at once, never waits out the latch timeout (${Date.now() - t}ms)`);
  assert(isPermissionViolation(Object.assign(new Error("request failed"), { cause: Object.assign(new Error("x"), { name: "PermissionViolationError" }) })), "probe: a RequestError wrapping a PermissionViolationError is a refusal");
  const line = probeRefusedLine("Permissions Violation for Publish", "ctx");
  assert(!line.includes("\n") && line.includes("Permissions Violation for Publish") && line.includes("ctx"), "refusal: said in ONE line, with the broker's reason");
  assert(!isPermissionViolation(Object.assign(new Error("TIMEOUT"), { name: "TimeoutError" })), "probe: a timeout is not a refusal");

  calls.length = 0;
  err = "";
  const deniedGate = new Promise<void>((resolve) => {
    const ctl = fakeCtl([]) as unknown as { spawn: (a: { name: string }) => Promise<unknown> };
    ctl.spawn = async (a: { name: string }) => {
      calls.push(`spawn ${a.name}`);
      resolve();
      return new Promise(() => {});
    };
    void ensureAgentSpawned(ctl as unknown as Parameters<typeof ensureAgentSpawned>[0], {
      space: "denied",
      name: "fresh",
      cwd: process.env.PAW_HOME!,
      probePresence: () => probePresenceWrites("denied", denyServer, undefined),
    }).catch((e: Error) => {
      err = e.message;
      resolve();
    });
  });
  await Promise.race([deniedGate, new Promise((r) => setTimeout(r, 5000))]);
  assert(calls.join() === "spawn fresh" && !err.includes("isn't accepting writes"), `gate (auth refusal, real probe): proceeds — a refusal is not a latch (${calls.join() || err.split("\n")[0] || "no calls"})`);

  // --- under auth (PAW_AUTH / a remote space): a real operator-mode JWT broker ------------------------
  const space = "authed";
  const auth = await createSpaceAuth(space);
  mkdirSync(join(process.env.PAW_COTAL_ROOT!, ".cotal", "auth"), { recursive: true });
  writeFileSync(join(process.env.PAW_COTAL_ROOT!, ".cotal", "auth", "auth.json"), JSON.stringify(stripSpaceAuth(auth)), { mode: 0o600 });
  const authPort = port + 2;
  const authServer = `nats://127.0.0.1:${authPort}`;
  const authConf = join(storeDir, "auth.conf");
  writeFileSync(authConf, serverConfig(auth, [auth], { port: authPort, host: "127.0.0.1", storeDir: join(storeDir, "auth-js"), transport: { kind: "plaintext" } }));
  authSrv = spawn("nats-server", ["-c", authConf], { stdio: "ignore" });
  // The test's own all-subjects user (signed with the same account signer) sets the bucket up.
  const rootCreds = await signScopedCreds(space, "test-root", newIdentity(), { pub: [">"], sub: [">"] }, 600);
  const anc = await connectWhenUp(authServer, rootCreds);
  const ajsm = await jetstreamManager(anc);
  // A KV bucket's stream as cotal creates the presence one (rollups allowed, 6s max_age).
  await ajsm.streams.add({ name: `KV_cotal_presence_${space}`, subjects: [`$KV.cotal_presence_${space}.>`], max_msgs_per_subject: 1, allow_rollup_hdrs: true, deny_delete: true, max_age: 6_000_000_000 });

  const control = await controlCreds(space);
  assert(control !== undefined, "auth: the space's signer loads (paw would mint control creds)");
  const refused = await probePresenceWrites(space, authServer, async () => control);
  assert(refused.kind === "not-permitted", `auth: paw's control creds alone are refused — why the probe has its own cred (${refused.kind})`);
  assert((await presenceProbeCreds("healthy", "paw-probe-ab")) === undefined, "auth: a space with no auth gets no probe cred (open mesh, unchanged)");

  t = Date.now();
  const authed = await probePresenceWrites(space, authServer, (key) => presenceProbeCreds(space, key));
  assert(authed.kind === "ok", `auth: the probe's own cred writes and clears its key (${JSON.stringify(authed)})`);
  assert(Date.now() - t < 1000, `auth: healthy cost is small (${Date.now() - t}ms)`);
  const st = (await ajsm.streams.info(`KV_cotal_presence_${space}`)).state;
  const last = await ajsm.streams.getMessage(`KV_cotal_presence_${space}`, { seq: st.last_seq });
  assert(st.messages === 1 && last?.header.get("KV-Operation") === "PURGE", `auth: leaves only a purge marker, no live probe key (${st.messages} msg, ${last?.header.get("KV-Operation") || "a value"})`);

  // Narrow: the cred reaches its one key and nothing else.
  const g = presenceProbeGrants(space, "paw-probe-0a1b");
  assert(g.pub.join() === "$KV.cotal_presence_authed.paw-probe-0a1b" && g.sub.length === 0, `auth: grants are exactly one presence key (${g.pub.join()})`);
  let refusedKey = false;
  try {
    presenceProbeGrants(space, "evals");
  } catch {
    refusedKey = true;
  }
  assert(refusedKey, "auth: a grant for a non-probe key (a real agent's) is refused");
  const pc = await presenceProbeCreds(space, "paw-probe-0a1b");
  const pnc = await connectWhenUp(authServer, pc);
  const pjs = jetstream(pnc, { timeout: 2000 });
  for (const [what, subject] of [
    ["another key", `$KV.cotal_presence_${space}.evals`],
    ["another probe key", `$KV.cotal_presence_${space}.paw-probe-ffff`],
  ] as const) {
    let e: unknown;
    await pjs.publish(subject, "x").catch((err: unknown) => (e = err));
    assert(isPermissionViolation(e), `auth: the probe cred can't write ${what}`);
  }
  let pe: unknown;
  await (await jetstreamManager(pnc, { timeout: 2000, checkAPI: false })).streams.purge(`KV_cotal_presence_${space}`).catch((err: unknown) => (pe = err));
  assert(isPermissionViolation(pe), "auth: the probe cred can't purge the presence stream");
  await pnc.close();

  // A latch is still a latch under auth: the stream gone, a swallowing subscriber in its place.
  await ajsm.streams.delete(`KV_cotal_presence_${space}`);
  anc.subscribe(`$KV.cotal_presence_${space}.>`, { callback: () => {} });
  await anc.flush();
  t = Date.now();
  const authLatched = await probePresenceWrites(space, authServer, (key) => presenceProbeCreds(space, key), 800);
  assert(authLatched.kind === "latched", `auth: an unanswered put under a probe cred still reads latched (${JSON.stringify(authLatched)})`);
  assert(Date.now() - t < 2500, "auth: bounded by its timeout");
  await anc.close();
} finally {
  authSrv?.kill();
  denySrv?.kill();
  await nc.close().catch(() => {});
  srv.kill();
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(process.env.PAW_HOME!, { recursive: true, force: true });
  rmSync(process.env.PAW_COTAL_ROOT!, { recursive: true, force: true });
}

if (failures) {
  console.error(`\ncheck:presence-latch — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:presence-latch — all ok");
process.exit(0);

/**
 * The cotal roles that watch the presence / channel-registry / membership KV must be able to delete
 * their OWN ordered watch consumers, and nothing wider (patches/@cotal-ai__core@0.100.0.patch).
 *
 * The team2027 broker logged `Publish Violation` for `$JS.API.CONSUMER.DELETE.KV_cotal_presence_<s>.oc_…`
 * and `…KV_cotal_channels_<s>.oc_…` (2026-10-28): a KV watch is a nats.js ordered push consumer named
 * `oc_<nuid>_<serial>`, and every rebuild (two missed 30s heartbeats, a sequence gap) deletes the
 * predecessor before creating `_<serial+1>`. cotal 0.100 minted no CONSUMER.DELETE on those streams
 * (#691), so each delete was refused and the old consumer stayed until its 5-minute inactive threshold.
 *
 * Boots a PRIVATE JWT + TLS nats-server (cotal's own `serverConfig`, a fresh space account, a
 * self-signed cert, its own log file), mints each affected role with the PATCHED `mintCreds`, opens a
 * watch exactly as `kv.watch()` does, and drives nats.js's own `reset()` (the rebuild path). Per role:
 * the same grant MINUS the new rows still reproduces the violation (so the check can see it), the
 * patched cred rebuilds with no violation and the predecessor is gone, and the cred still cannot delete
 * a consumer on CHAT / DM / another KV bucket, nor purge or delete a KV stream. The broker's own log is
 * read last. The live broker is never touched. Run: pnpm check:kv-consumer-perms
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-kvperm-home-"));
process.env.PAW_COTAL_ROOT = mkdtempSync(join(tmpdir(), "paw-kvperm-root-"));
const work = mkdtempSync(join(tmpdir(), "paw-kvperm-"));

const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { jetstream, jetstreamManager, DeliverPolicy, AckPolicy } = await import("@nats-io/jetstream");
const { encodeUser, fmtCreds } = await import("@nats-io/jwt");
const { fromPublic, fromSeed } = await import("@nats-io/nkeys");
const core = await import("@cotal-ai/core");
const { createSpaceAuth, stripSpaceAuth, serverConfig, mintCreds, permissionsFor, newIdentity, idFromCreds, mintLifecycleUid } = core;
const { presenceBucket, channelBucket, membershipBucket, managerBucket, chatStream, dmStream } = core;
const { signScopedCreds } = await import("../src/remote-creds.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const space = "kvperm";
const PKV = `KV_${presenceBucket(space)}`;
const CHKV = `KV_${channelBucket(space)}`;
const MEMKV = `KV_${membershipBucket(space)}`;
const MGRKV = `KV_${managerBucket(space)}`;
const CHAT = chatStream(space);
const DM = dmStream(space);

const cert = join(work, "cert.pem");
const key = join(work, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });

const auth = await createSpaceAuth(space);
mkdirSync(join(process.env.PAW_COTAL_ROOT, ".cotal", "auth"), { recursive: true });
writeFileSync(join(process.env.PAW_COTAL_ROOT, ".cotal", "auth", "auth.json"), JSON.stringify(stripSpaceAuth(auth)), { mode: 0o600 });
const port = 20000 + Math.floor(Math.random() * 20000);
const logFile = join(work, "nats.log");
const conf = join(work, "nats.conf");
writeFileSync(conf, serverConfig(auth, [auth], { port, host: "127.0.0.1", storeDir: join(work, "js"), transport: { kind: "tls-required", certFile: cert, keyFile: key } }) + `\nlog_file: ${JSON.stringify(logFile)}\n`);
const srv: ChildProcess = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
srv.on("error", (e) => {
  throw new Error(`check:kv-consumer-perms needs nats-server on PATH: ${e.message}`);
});
const servers = `127.0.0.1:${port}`;

async function dial(creds: string) {
  const id = idFromCreds(creds);
  for (let i = 0; ; i++) {
    try {
      return await connect({ servers, tls: { caFile: cert }, authenticator: credsAuthenticator(enc.encode(creds)), inboxPrefix: `_INBOX_${id}`, name: `kvperm-${id.slice(0, 8)}` });
    } catch (e) {
      if (i > 50) throw new Error(`private TLS nats-server never came up on ${servers}: ${(e as Error).message}`);
      await sleep(100);
    }
  }
}

type Perms = { pub: { allow?: string[]; deny?: string[] }; sub: { allow?: string[] } };
/** The same profile's grant with this patch's rows taken out = cotal 0.100 as shipped. */
async function unpatchedCreds(profile: string, opts: Record<string, unknown>): Promise<string> {
  const identity = newIdentity();
  const pr = { owner: "dev", actor: identity.id, connId: identity.id, ...(opts.lifecycleUid ? { lifecycleUid: opts.lifecycleUid } : {}) };
  const perms = permissionsFor(profile as never, space, pr as never, opts as never) as Perms;
  const allow = (perms.pub.allow ?? []).filter((s) => !/^\$JS\.API\.CONSUMER\.DELETE\.KV_cotal_(presence|channels|membership)_/.test(s));
  const jwt = await encodeUser(profile, fromPublic(identity.id), fromPublic(auth.account.pub), { ...perms, pub: { ...perms.pub, allow } } as never, { signer: fromSeed(enc.encode(auth.account.signingSeed)) });
  return new TextDecoder().decode(fmtCreds(jwt, fromSeed(enc.encode(identity.seed))));
}

const violations = (errs: Error[], needle: string) => errs.filter((e) => /permissions violation/i.test(e.message) && e.message.includes(needle));

try {
  // --- the space as cotal lays it out: three KV buckets the roles watch, plus decoys ---------------
  const rootCreds = await signScopedCreds(space, "test-root", newIdentity(), { pub: [">"], sub: [">"] }, 900);
  const root = await dial(rootCreds);
  const rjsm = await jetstreamManager(root);
  for (const s of [PKV, CHKV, MEMKV, MGRKV]) {
    const bucket = s.slice(3);
    await rjsm.streams.add({ name: s, subjects: [`$KV.${bucket}.>`], max_msgs_per_subject: 1, allow_rollup_hdrs: true, deny_delete: true, allow_direct: true });
    await jetstream(root).publish(`$KV.${bucket}.k1`, "v");
  }
  await rjsm.streams.add({ name: CHAT, subjects: [`cotal.${space}.chat.>`] });
  await rjsm.streams.add({ name: DM, subjects: [`cotal.${space}.inst.>`] });
  for (const s of [CHAT, DM, MGRKV]) await rjsm.consumers.add(s, { durable_name: "victim", ack_policy: AckPolicy.Explicit });
  const consumerNames = async (stream: string) => {
    const out: string[] = [];
    for await (const c of rjsm.consumers.list(stream)) out.push(c.name);
    return out;
  };

  const roles: { profile: string; opts: Record<string, unknown>; watches: string[]; denied: string[] }[] = [
    { profile: "agent", opts: { lifecycleUid: mintLifecycleUid() }, watches: [PKV, CHKV], denied: [MEMKV] },
    { profile: "observer", opts: {}, watches: [PKV, CHKV, MEMKV], denied: [] },
    { profile: "admin", opts: {}, watches: [PKV, CHKV, MEMKV], denied: [] },
    { profile: "supervisor", opts: {}, watches: [PKV], denied: [CHKV, MEMKV] },
  ];

  for (const role of roles) {
    console.log(`\n${role.profile}`);
    const g = permissionsFor(role.profile as never, space, { owner: "dev", actor: "probeactor", connId: "UPROBECONN", ...role.opts } as never, role.opts as never) as Perms;
    const dels = (g.pub.allow ?? []).filter((s) => s.startsWith("$JS.API.CONSUMER.DELETE.KV_"));
    assert(dels.sort().join() === role.watches.map((s) => `$JS.API.CONSUMER.DELETE.${s}.>`).sort().join(), `grant: CONSUMER.DELETE on exactly ${role.watches.join(", ")} (${dels.join(", ")})`);
    assert(!(g.pub.allow ?? []).some((s) => /STREAM\.(PURGE|DELETE)\.|CONSUMER\.DELETE\.(CHAT|DM|DLV|TASK)_[^.]+\.(>|\*)$|CONSUMER\.DELETE\.(>|\*)|\$JS\.API\.>/.test(s)), "grant: no stream purge/delete, no stream-wide CHAT/DM consumer delete, no $JS wildcard");

    for (const [label, creds] of [["0.100 as shipped", await unpatchedCreds(role.profile, role.opts)], ["patched", await mintCreds(auth, newIdentity(), role.profile as never, role.opts as never)]] as const) {
      const nc = await dial(creds);
      const errs: Error[] = [];
      void (async () => {
        for await (const s of nc.status()) if (s.type === "error") errs.push((s as { error: Error }).error);
      })();
      const js = jetstream(nc, { watcherPrefix: `_INBOX_${idFromCreds(creds)}` });
      for (const stream of role.watches) {
        // kv.watch()'s consumer: ordered push, last value per key over the whole bucket.
        const oc = await js.consumers.getPushConsumer(stream, { filter_subjects: `$KV.${stream.slice(3)}.>`, deliver_policy: DeliverPolicy.LastPerSubject });
        const first = (await oc.info(true)).name;
        const msgs = await oc.consume({ callback: () => {} });
        // nats.js's own rebuild: what two missed heartbeats or a sequence gap run.
        (msgs as unknown as { reset(): void }).reset();
        let names: string[] = [];
        for (let i = 0; i < 30; i++) {
          names = await consumerNames(stream);
          if (names.includes(first.replace(/_\d+$/, "_2")) && (label === "0.100 as shipped" ? violations(errs, first).length > 0 : !names.includes(first))) break;
          await sleep(100);
        }
        const rebuilt = names.includes(first.replace(/_\d+$/, "_2"));
        if (label === "0.100 as shipped") {
          assert(rebuilt && names.includes(first) && violations(errs, `CONSUMER.DELETE.${stream}.${first}`).length === 1, `${label}: ${stream} rebuild → Publish Violation on its predecessor delete, ${first} left behind (repro)`);
        } else {
          assert(rebuilt && !names.includes(first), `${label}: ${stream} rebuilt to _2 and the predecessor ${first} is gone (${names.join(", ")})`);
          assert(violations(errs, stream).length === 0, `${label}: ${stream} rebuild raised no violation`);
          msgs.stop();
          await (await jetstreamManager(nc, { checkAPI: false })).consumers.delete(stream, first.replace(/_\d+$/, "_2"));
          assert(!(await consumerNames(stream)).some((n) => n.startsWith(first.replace(/_\d+$/, ""))), `${label}: ${stream} stop + own delete leaves nothing on the broker`);
        }
        msgs.stop();
      }
      if (label === "patched") {
        const jsm = await jetstreamManager(nc, { checkAPI: false, timeout: 2000 });
        const refused = async (what: string, run: () => Promise<unknown>) => {
          let e: unknown;
          await run().catch((err: unknown) => (e = err));
          const msg = `${(e as Error)?.message ?? ""} ${((e as Error)?.cause as Error)?.message ?? ""}`;
          assert(e !== undefined && /permissions violation/i.test(msg), `${label}: can't ${what}`);
        };
        for (const s of [CHAT, DM, MGRKV]) await refused(`delete a consumer on ${s}`, () => jsm.consumers.delete(s, "victim"));
        for (const s of role.denied) await refused(`delete a consumer on ${s} (a bucket it doesn't watch)`, () => jsm.consumers.delete(s, "oc_x_1"));
        for (const s of role.watches) {
          await refused(`purge ${s}`, () => jsm.streams.purge(s));
          await refused(`delete the ${s} stream`, () => jsm.streams.delete(s));
        }
        for (const s of [CHAT, DM, MGRKV]) assert((await consumerNames(s)).includes("victim"), `${label}: the ${s} durable is untouched`);
      }
      await nc.close();
    }
  }

  // --- the broker's own log: the symptom team2027 showed -------------------------------------------
  await root.close();
  await sleep(200);
  const log = readFileSync(logFile, "utf8").split("\n").filter((l) => /Publish Violation/.test(l) && /CONSUMER\.DELETE\.KV_cotal_(presence|channels|membership)_/.test(l));
  const expected = roles.reduce((n, r) => n + r.watches.length, 0) + roles.reduce((n, r) => n + r.denied.length, 0);
  assert(log.length === expected, `broker log: KV consumer-delete violations only from the 0.100 repro and the denied-bucket probes (${log.length}, expected ${expected})`);
} finally {
  srv.kill();
  rmSync(work, { recursive: true, force: true });
  rmSync(process.env.PAW_HOME!, { recursive: true, force: true });
  rmSync(process.env.PAW_COTAL_ROOT!, { recursive: true, force: true });
}

if (failures) {
  console.error(`\ncheck:kv-consumer-perms — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:kv-consumer-perms — all ok");
process.exit(0);

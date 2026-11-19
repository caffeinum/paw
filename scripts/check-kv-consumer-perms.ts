/**
 * The presence / channel-registry / membership KV watch consumers on cotal 0.170, now that paw's core
 * patch for them is gone.
 *
 * The team2027 broker logged `Publish Violation` for `$JS.API.CONSUMER.DELETE.KV_cotal_presence_<s>.oc_…`
 * and `…KV_cotal_channels_<s>.oc_…` (2026-10-28): a KV watch is a nats.js ordered push consumer named
 * `oc_<nuid>_<serial>`, and every rebuild (two missed 30s heartbeats, a sequence gap) deletes the
 * predecessor before creating `_<serial+1>`. cotal 0.100 minted no CONSUMER.DELETE on those streams
 * (#691), so each delete was refused at the broker. paw's patch (cotal 0.100) granted the delete; cotal
 * 0.170 keeps #691 and instead never PUBLISHES a delete its credential's claims exclude (#4123: the
 * endpoint wraps its connection's `request` and refuses an ungranted delete of its own recorded watch
 * consumer locally), so the broker logs nothing and reaps the consumer at its 5-minute inactive threshold.
 *
 * Boots a PRIVATE JWT nats-server (cotal's own `serverConfig`, a fresh space account, its own log file):
 *   1. the grants: no watching role holds a stream-wide CONSUMER.DELETE on those KV streams (#691 kept —
 *      if a cotal bump or a re-added patch changes that, this says so), and none holds a stream purge/
 *      delete or a CHAT/DM consumer wildcard;
 *   2. the hazard, kept visible: a RAW nats.js watch on a minted agent cred still hits the Publish
 *      Violation on its rebuild (so paw must not run raw KV watches on minted creds — it runs none);
 *   3. the fix paw relies on: a real CotalEndpoint (agent cred, presence watch) refuses the same delete
 *      of its own watch consumer locally, and the broker logs nothing for it.
 * The live broker is never touched. Run: pnpm check:kv-consumer-perms
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-kvperm-home-"));
process.env.PAW_COTAL_ROOT = mkdtempSync(join(tmpdir(), "paw-kvperm-root-"));
const work = mkdtempSync(join(tmpdir(), "paw-kvperm-"));

const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { jetstream, jetstreamManager, DeliverPolicy } = await import("@nats-io/jetstream");
const core = await import("@cotal-ai/core");
const { createSpaceAuth, stripSpaceAuth, serverConfig, mintCreds, permissionsFor, newIdentity, idFromCreds, mintLifecycleUid, CotalEndpoint } = core;
const { presenceBucket, channelBucket, membershipBucket } = core;
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
const WATCHED = /^\$JS\.API\.CONSUMER\.DELETE\.KV_cotal_(presence|channels|membership)_[^.]+\.(>|\*)$/;

const auth = await createSpaceAuth(space);
mkdirSync(join(process.env.PAW_COTAL_ROOT, ".cotal", "auth"), { recursive: true });
writeFileSync(join(process.env.PAW_COTAL_ROOT, ".cotal", "auth", "auth.json"), JSON.stringify(stripSpaceAuth(auth)), { mode: 0o600 });
const port = 20000 + Math.floor(Math.random() * 20000);
const logFile = join(work, "nats.log");
const conf = join(work, "nats.conf");
writeFileSync(conf, serverConfig(auth, [auth], { port, host: "127.0.0.1", storeDir: join(work, "js"), transport: { kind: "plaintext" } }) + `\nlog_file: ${JSON.stringify(logFile)}\n`);
const srv: ChildProcess = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
srv.on("error", (e) => {
  throw new Error(`check:kv-consumer-perms needs nats-server on PATH: ${e.message}`);
});
const servers = `127.0.0.1:${port}`;

async function dial(creds: string) {
  const id = idFromCreds(creds);
  for (let i = 0; ; i++) {
    try {
      return await connect({ servers, authenticator: credsAuthenticator(enc.encode(creds)), inboxPrefix: `_INBOX_${id}`, name: `kvperm-${id.slice(0, 8)}` });
    } catch (e) {
      if (i > 50) throw new Error(`private nats-server never came up on ${servers}: ${(e as Error).message}`);
      await sleep(100);
    }
  }
}

type Perms = { pub: { allow?: string[] } };
const brokerViolations = () => readFileSync(logFile, "utf8").split("\n").filter((l) => /Publish Violation/.test(l) && /CONSUMER\.DELETE\.KV_cotal_(presence|channels|membership)_/.test(l));

try {
  // --- the space as cotal lays it out: the KV buckets the roles watch -------------------------------
  const rootCreds = await signScopedCreds(space, "test-root", newIdentity(), { pub: [">"], sub: [">"] }, 900);
  const root = await dial(rootCreds);
  const rjsm = await jetstreamManager(root);
  for (const s of [PKV, CHKV, MEMKV]) {
    const bucket = s.slice(3);
    await rjsm.streams.add({ name: s, subjects: [`$KV.${bucket}.>`], max_msgs_per_subject: 1, allow_rollup_hdrs: true, deny_delete: true, allow_direct: true });
    await jetstream(root).publish(`$KV.${bucket}.k1`, "v");
  }
  const consumerNames = async (stream: string) => {
    const out: string[] = [];
    for await (const c of rjsm.consumers.list(stream)) out.push(c.name);
    return out;
  };

  // 1. grants ---------------------------------------------------------------------------------------
  console.log("grants (cotal 0.170, unpatched)");
  for (const [profile, opts] of [["agent", { lifecycleUid: mintLifecycleUid() }], ["observer", {}], ["admin", {}], ["supervisor", {}]] as const) {
    const g = permissionsFor(profile as never, space, { owner: "dev", actor: "probeactor", connId: "UPROBECONN", ...opts } as never, opts as never) as Perms;
    const allow = g.pub.allow ?? [];
    assert(!allow.some((s) => WATCHED.test(s)), `${profile}: no stream-wide CONSUMER.DELETE on the presence/channels/membership KV (#691 kept upstream)`);
    assert(!allow.some((s) => /STREAM\.(PURGE|DELETE)\.KV_cotal_(presence|channels|membership)_|CONSUMER\.DELETE\.(CHAT|DM|DLV|TASK)_[^.]+\.(>|\*)$|CONSUMER\.DELETE\.(>|\*)|\$JS\.API\.>/.test(s)), `${profile}: no KV stream purge/delete, no stream-wide CHAT/DM consumer delete, no $JS wildcard`);
  }

  // 2. the raw nats.js hazard -----------------------------------------------------------------------
  console.log("\na raw nats.js watch on a minted agent cred");
  const agentCreds = await mintCreds(auth, newIdentity(), "agent" as never, { lifecycleUid: mintLifecycleUid() } as never);
  const raw = await dial(agentCreds);
  const rawErrs: Error[] = [];
  void (async () => {
    for await (const s of raw.status()) if (s.type === "error") rawErrs.push((s as { error: Error }).error);
  })();
  const oc = await jetstream(raw, { watcherPrefix: `_INBOX_${idFromCreds(agentCreds)}` }).consumers.getPushConsumer(PKV, { filter_subjects: `$KV.${PKV.slice(3)}.>`, deliver_policy: DeliverPolicy.LastPerSubject });
  const first = (await oc.info(true)).name;
  const msgs = await oc.consume({ callback: () => {} });
  (msgs as unknown as { reset(): void }).reset(); // nats.js's own rebuild: two missed heartbeats or a sequence gap
  let names: string[] = [];
  for (let i = 0; i < 30 && !(names.includes(first.replace(/_\d+$/, "_2")) && rawErrs.length > 0); i++) {
    names = await consumerNames(PKV);
    await sleep(100);
  }
  assert(names.includes(first.replace(/_\d+$/, "_2")) && names.includes(first), `rebuilt to _2 with ${first} left behind for the inactive threshold`);
  assert(rawErrs.some((e) => /permissions violation/i.test(e.message) && e.message.includes(`CONSUMER.DELETE.${PKV}.${first}`)), "its predecessor delete reached the broker and was refused (the team2027 symptom)");
  msgs.stop();
  await raw.close();
  await sleep(300);
  const afterRaw = brokerViolations().length;
  assert(afterRaw === 1, `broker log: one violation from the raw repro (${afterRaw})`);

  // 3. cotal's own avoidance ------------------------------------------------------------------------
  console.log("\na CotalEndpoint on a minted agent cred");
  const epUid = mintLifecycleUid();
  const ep = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "agent" as never, { lifecycleUid: epUid } as never), lifecycleUid: epUid, card: { name: "kvprobe", kind: "agent" }, registerPresence: false, watchPresence: true, consume: false });
  ep.on("error", () => {});
  ep.on("warning", () => {});
  await ep.start();
  for (let i = 0; i < 50 && !(await consumerNames(PKV)).some((n) => n.startsWith("oc_")); i++) await sleep(100);
  const internals = ep as unknown as { nc?: { request(subject: string, payload?: Uint8Array, opts?: { timeout: number }): Promise<unknown> }; ownWatchDeletePrefixes?: Set<string> };
  const prefixes = internals.ownWatchDeletePrefixes;
  if (!(prefixes instanceof Set) || !internals.nc)
    throw new Error("cotal's CotalEndpoint no longer has `nc` + `ownWatchDeletePrefixes` (the #4123 request avoidance) — re-read endpoint.js before trusting the unpatched grants");
  const own = [...prefixes].filter((p) => p.startsWith(`$JS.API.CONSUMER.DELETE.${PKV}.`));
  assert(own.length >= 1, `the endpoint recorded its presence watch consumer (${own.join(", ") || "none"})`);
  for (const prefix of own) {
    // Exactly what nats.js's rebuild sends for the predecessor: a request to delete `<prefix><serial>`.
    let refused: unknown;
    await internals.nc.request(`${prefix}1`, undefined, { timeout: 2000 }).catch((e: unknown) => (refused = e));
    const msg = `${(refused as Error)?.message ?? ""} ${((refused as Error)?.cause as Error)?.message ?? ""}`;
    assert(refused !== undefined && /permissions violation/i.test(msg), `the endpoint refuses the ungranted delete of its own ${prefix}… locally`);
  }
  await ep.stop();
  await root.close();
  await sleep(300);
  assert(brokerViolations().length === afterRaw, `broker log: nothing from the endpoint's refused deletes (${brokerViolations().length - afterRaw} new)`);
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

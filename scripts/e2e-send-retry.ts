/**
 * e2e: paw chat's outbox (src/outbox.ts + src/mesh-publish.ts) on the real wire, through a STALLED link.
 *
 * Starts a private nats-server (random port, temp store — never the live broker), a receiving agent
 * endpoint connected directly, and a "you" endpoint connected through a TCP proxy that can stall: bytes
 * are held, not dropped, the way a Wi-Fi drop holds them until the link is back. Then:
 *   1. send while stalled → the JetStream ack times out → `pending`; unstall → the held publish lands
 *      late AND the retry re-publishes → the receiver gets exactly ONE copy (msgID dedup);
 *   2. send while stalled past a short give-up bound → ONE `failed`; unstall; `retry()` → still one copy;
 *   3. the flow dies SILENTLY (bytes dropped, no RST — a Wi-Fi/NAT drop): nats.js would not notice for
 *      minutes; the link probe (src/link-probe.ts) PINGs it after the ack timeout, forces a fresh socket,
 *      and the transport-up kick re-sends — delivered once, well inside the give-up bound.
 * Needs nats-server (PAW_NATS_SERVER, else ~/.local/share/nats/nats-server-2.14.7, else PATH).
 * Run: PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/e2e-send-retry.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Socket, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { Outbox, type OutEvent } from "../src/outbox.ts";
import { draftDm, publishDraft } from "../src/mesh-publish.ts";
import { LinkProbe, isAckTimeout } from "../src/link-probe.ts";

const space = `sendretry${process.pid}`;
const pinned = join(homedir(), ".local/share/nats/nats-server-2.14.7");
const natsBin = process.env.PAW_NATS_SERVER ?? (existsSync(pinned) ? pinned : "nats-server");
const store = mkdtempSync(join(tmpdir(), "paw-sendretry-"));

const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const natsPort = await freePort();
const nats = spawn(natsBin, ["-js", "-a", "127.0.0.1", "-p", String(natsPort), "-sd", store], { stdio: "ignore" });
nats.on("error", (e) => {
  throw new Error(`nats-server failed to start (${natsBin}): ${e.message}`);
});
for (let i = 0; i < 50; i++) {
  const ok = await new Promise<boolean>((res) => connect(natsPort, "127.0.0.1").on("connect", function (this: Socket) { this.destroy(); res(true); }).on("error", () => res(false)));
  if (ok) break;
  await sleep(100);
}

/** A TCP proxy whose links can be stalled (bytes queued in order, then flushed) or black-holed (every
 *  byte dropped from then on, the socket left open — what a dropped Wi-Fi/NAT flow looks like). */
let stalled = false;
const links: { flush(): void; blackhole(): void }[] = [];
const proxy = createServer((client) => {
  const upstream = connect(natsPort, "127.0.0.1");
  const held: { to: Socket; data: Buffer }[] = [];
  let dead = false;
  const pass = (to: Socket) => (data: Buffer) => (dead ? undefined : stalled ? held.push({ to, data }) : to.write(data));
  client.on("data", pass(upstream));
  upstream.on("data", pass(client));
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  links.push({ flush: () => held.splice(0).forEach(({ to, data }) => to.write(data)), blackhole: () => void (dead = true) });
}).listen(0, "127.0.0.1");
await new Promise((r) => proxy.once("listening", r));
const proxyPort = (proxy.address() as AddressInfo).port;
const unstall = () => {
  stalled = false;
  links.forEach((l) => l.flush());
};

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
};

const got = new Map<string, number>();
const kit = new CotalEndpoint({ space, servers: `nats://127.0.0.1:${natsPort}`, card: { name: "kit", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
kit.on("error", () => {});
kit.on("warning", () => {});
kit.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
  if (meta.kind === "dm") got.set(m.id, (got.get(m.id) ?? 0) + 1);
  d.ack();
});
await kit.start();
// Wired exactly as paw chat wires it: the probe sees every connection, a timed-out send runs it, and a
// fresh socket kicks the outbox.
const probe = new LinkProbe();
const you = new CotalEndpoint({ space, servers: `nats://127.0.0.1:${proxyPort}`, card: { name: "you", kind: "endpoint" }, registerPresence: true, consume: false, watchPresence: true, ...probe.endpointOptions() });
const boxes: Outbox<CotalMessage>[] = [];
you.on("transport", (st: { connected: boolean }) => st.connected && boxes.forEach((b) => b.kick()));
const youSignals: string[] = [];
you.on("error", (e: Error) => youSignals.push(`error: ${e.message}`));
you.on("warning", (e: Error) => youSignals.push(`warning: ${e.message}`));
await you.start();

const events: string[] = [];
const publishProbed = async (m: CotalMessage) => {
  try {
    return await publishDraft(you, m);
  } catch (err) {
    if (isAckTimeout(err)) void probe.check();
    throw err;
  }
};
const box = (giveUpMs?: number) => {
  const b = new Outbox<CotalMessage>({
    publish: publishProbed,
    onEvent: (e: OutEvent<CotalMessage>) => events.push(`${e.kind}${e.kind === "failed" ? `:${e.transient ? "transient" : "loud"}:${e.error}` : e.kind === "pending" ? `:${e.error}` : ""}`),
    ...(giveUpMs ? { giveUpMs } : {}),
  });
  boxes.push(b);
  return b;
};

try {
  // 0. healthy: one attempt, no events but `sent`.
  const ok = draftDm(you, kit.card.id, "hello");
  const it0 = await box().submit("kit", ok);
  await sleep(1000);
  assert(it0.state === "sent" && it0.attempts === 1 && eq(events, ["sent"]) && got.get(ok.id) === 1, `healthy link: sent on the first try, delivered once (events ${JSON.stringify(events)})`);
  events.length = 0;

  // 1. stalled ~12s: the ack times out, the outbox retries, the link comes back, ONE copy.
  stalled = true;
  const m1 = draftDm(you, kit.card.id, "status");
  const t1 = Date.now();
  const p1 = box().submit("kit", m1);
  setTimeout(unstall, 12_000);
  const it1 = await p1;
  await sleep(2000);
  console.log(`  ·  stalled send: ${it1.state} after ${Math.round((Date.now() - t1) / 1000)}s, ${it1.attempts} attempts, duplicate=${it1.duplicate}`);
  assert(events[0]?.startsWith("pending:") && /timeout/i.test(events[0]), `stalled: the ack timeout shows as pending, not a bare error (got ${JSON.stringify(events)})`);
  assert(it1.state === "sent" && it1.retried, "stalled: sent once the link is back");
  assert(got.get(m1.id) === 1, `stalled: the receiver got exactly ONE copy (got ${got.get(m1.id) ?? 0})`);
  events.length = 0;

  // 2. stalled past the give-up bound: ONE failure; link back; retry() → still one copy.
  stalled = true;
  const short = box(15_000);
  const m2 = draftDm(you, kit.card.id, "create pdf one-pager");
  const it2 = await short.submit("kit", m2);
  assert(it2.state === "failed" && events.filter((e) => e.startsWith("failed:transient")).length === 1, `give-up: ONE transient failure after the bound (got ${JSON.stringify(events)})`);
  unstall();
  await sleep(3000);
  const again = short.retry();
  assert(again.length === 1 && again[0].msg.id === m2.id, "give-up: retry() re-queues it with the same id");
  for (let i = 0; i < 50 && again[0].state !== "sent"; i++) await sleep(200);
  await sleep(1500);
  console.log(`  ·  retried send: ${again[0].state}, duplicate=${again[0].duplicate}`);
  assert(again[0].state === "sent" && got.get(m2.id) === 1, `give-up → /retry: delivered exactly ONCE (got ${got.get(m2.id) ?? 0}; the held copy ${again[0].duplicate ? "had landed and was deduped" : "had not landed"})`);

  // 3. the flow dies silently: no RST, nats.js still thinks it's up. Before the probe this failed at 95s
  //    after 8 tries over the dead socket (the transport never went down).
  const forcedBefore = probe.forced;
  links.forEach((l) => l.blackhole());
  const m3 = draftDm(you, kit.card.id, "after a silent drop");
  const t3 = Date.now();
  const it3 = await box().submit("kit", m3);
  const took = Date.now() - t3;
  await sleep(1500);
  console.log(`  ·  silent drop: ${it3.state} after ${Math.round(took / 1000)}s, ${it3.attempts} attempts, ${probe.forced - forcedBefore} forced reconnect(s)`);
  assert(it3.state === "sent" && took < 25_000, `silent drop: delivered on a fresh socket in ${Math.round(took / 1000)}s (< 25s; was a 95s ✕ not sent)`);
  assert(probe.forced - forcedBefore >= 1, "silent drop: the probe found the dead socket and replaced it");
  assert(got.get(m3.id) === 1, `silent drop: the receiver got exactly ONE copy (got ${got.get(m3.id) ?? 0})`);
} finally {
  await you.stop().catch(() => {});
  await kit.stop().catch(() => {});
  proxy.close();
  nats.kill("SIGTERM");
  await sleep(300);
  rmSync(store, { recursive: true, force: true });
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

if (youSignals.length) console.log(`  ·  "you" endpoint signals during the run: ${youSignals.length} (first: ${youSignals[0]})`);
if (failures) {
  console.error(`\n${failures} send-retry e2e check(s) failed`);
  process.exit(1);
}
console.log("\nsend-retry e2e passed 🐾");
process.exit(0);

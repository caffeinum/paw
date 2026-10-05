/**
 * Wire sniffer: runs two REAL @cotal-ai/core endpoints on a throwaway nats-server and logs every
 * NATS frame (subject, headers, payload). This is the reference the Go client github.com/caffeinum/cotal-go
 * (~/Github/caffeinum/cotal-go) was written against — re-run it to re-verify the wire after a cotal bump. Isolated: own nats-server on a random port, own store dir, own space. Never touches a
 * live mesh.
 *
 *   node scripts/lean/kit/sniff-cotal.ts > sniff.log
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { CotalEndpoint } from "@cotal-ai/core";

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "sniffjs-"))], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
const server = `nats://127.0.0.1:${port}`;
const space = "sniff";
const td = new TextDecoder();
const nc = await connect({ servers: server });
const t0 = Date.now();
let phase = "boot";
const seen = new Map<string, number>();
nc.subscribe(">", {
  callback: (_e, m) => {
    const hdr = m.headers ? [...m.headers.keys()].map((k) => `${k}=${m.headers!.get(k)}`).join(" ") : "";
    let body = td.decode(m.data);
    if (m.subject.startsWith("$KV.")) {
      const n = (seen.get(m.subject) ?? 0) + 1;
      seen.set(m.subject, n);
      if (n > 4 && phase === "idle") return;
    }
    if (body.length > 2500) body = body.slice(0, 2500) + "…";
    console.log(`[${((Date.now() - t0) / 1000).toFixed(2)} ${phase}] ${m.subject}${m.reply ? ` reply=${m.reply}` : ""}${hdr ? ` hdr{${hdr}}` : ""}\n    ${body}`);
  },
});
const mk = (name: string) => {
  const ep = new CotalEndpoint({ space, servers: server, channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name, kind: "agent", meta: { connector: "kit" } } as any });
  ep.on("error", (e: Error) => console.log(`!! ${name} error ${e.message}`));
  ep.on("message", (m: unknown, d: { ack(): void }) => {
    console.log(`>> ${name} got message ${JSON.stringify(m)}`);
    d.ack();
  });
  return ep;
};
phase = "alice-start";
const alice = mk("alice");
await alice.start();
phase = "bob-start";
const bob = mk("bob");
await bob.start();
await sleep(1500);
phase = "status-working";
await alice.setStatus("working" as any);
await sleep(300);
phase = "unicast";
await alice.unicast(bob.card.id, "hello bob");
await sleep(800);
phase = "multicast";
await alice.multicast("hello general", { channel: "general" } as any);
await sleep(800);
phase = "status-idle";
await alice.setStatus("idle" as any);
await sleep(500);
phase = "idle";
await sleep(4500);
phase = "roster";
console.log(JSON.stringify(alice.getRoster(), null, 1));
phase = "stop";
await bob.stop();
await alice.stop();
await sleep(500);
await nc.close();
nats.kill("SIGTERM");
process.exit(0);

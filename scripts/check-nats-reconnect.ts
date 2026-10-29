/**
 * Hermetic check for the nats.js reconnect patch (patches/@nats-io__transport-node@3.4.0.patch and the
 * bundled copy in patches/@cotal-ai__connector-claude-code@0.100.0.patch). A fake NATS server on loopback
 * accepts the client, then black-holes it (stops reading, never closes) while 32MB of publishes back up the
 * socket's write buffer. The client's PING timeout must still close that connection and redial — unpatched,
 * the close awaited a goodbye write that never drains and the client sat on the dead link (the sandboxed
 * agents' 15-minute mesh outages). → docs/notes/sandbox.md#mesh-reconnect
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { connect } from "@nats-io/transport-node";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};

async function blackholedClientRedials(): Promise<boolean> {
  const conns: net.Socket[] = [];
  const server = net.createServer((s) => {
    conns.push(s);
    s.on("error", () => {});
    s.write('INFO {"server_id":"check","version":"2.12.0","proto":1,"max_payload":8388608,"headers":true}\r\n');
    if (conns.length === 1) return;
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith("PING")) s.write("PONG\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  // The first connection must answer the handshake PING before it goes dark.
  const first = new Promise<net.Socket>((r) => server.once("connection", r));
  const pending = connect({ servers: `127.0.0.1:${port}`, pingInterval: 500, maxPingOut: 2, reconnectTimeWait: 100, maxReconnectAttempts: -1 });
  (await first).once("data", () => conns[0].write("PONG\r\n"));
  const nc = await pending;
  conns[0].pause();
  const big = new Uint8Array(512 * 1024);
  for (let i = 0; i < 64; i++) nc.publish("check.fill", big);
  const deadline = Date.now() + 8000;
  while (conns.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const redialed = conns.length >= 2;
  for (const s of conns) s.destroy();
  server.close();
  await nc.close().catch(() => {});
  return redialed;
}

ok("a stale connection with a backed-up write buffer is closed and redialed", await blackholedClientRedials());

const mcp = readFileSync(createRequire(import.meta.url).resolve("@cotal-ai/connector-claude-code/mcp"), "utf8");
ok("the cotal MCP server's bundled transport bounds its goodbye flush", mcp.includes("paw patch: bound the goodbye flush"));
ok(
  "the cotal MCP server's bundled transport no longer awaits an unbounded goodbye write",
  !/await this\._send\(new TextEncoder\(\)\.encode\(""\)\)/.test(mcp),
);

if (fails) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall nats reconnect checks passed");
process.exit(0);

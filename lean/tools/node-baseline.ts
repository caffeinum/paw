/**
 * The language decision's baseline: what ONE node process holding ONE idle @cotal-ai/core endpoint
 * costs (the floor of a one-process-per-agent TS harness, before any conversation or HTTP client).
 * Own nats-server on a random port; never touches a live mesh.
 *
 *   node lean/tools/node-baseline.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "basejs-"))], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
const footprint = () => /Footprint:\s+([\d.]+ \w+)/.exec(spawnSync("footprint", [String(process.pid)], { encoding: "utf8" }).stdout ?? "")?.[1];
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const t0 = performance.now();
const { CotalEndpoint } = await import("@cotal-ai/core");
const ep = new CotalEndpoint({ space: "baseline", servers: `nats://127.0.0.1:${port}`, channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "base", kind: "agent" } });
ep.on("error", () => {});
await ep.start();
console.log(`import+start ${(performance.now() - t0).toFixed(0)} ms`);
await sleep(8000);
console.log(`idle endpoint: rss ${mb(process.memoryUsage().rss)} heap ${mb(process.memoryUsage().heapUsed)} footprint ${footprint()}`);
await ep.stop();
nats.kill("SIGTERM");
process.exit(0);

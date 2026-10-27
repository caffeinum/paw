/**
 * END-TO-END: a seat's cotal MCP server rides out a broker outage, on an ISOLATED broker of its own.
 *
 * The 2026-10-24 team2027 reports ("the cotal tools disconnected") were first blamed on the MCP server
 * dying on a NATS drop. This drives cotal's real `mcp.cjs` over stdio exactly as claude does
 * (initialize → tools/list → tools/call) and SIGKILLs the broker under it for longer than the endpoint's
 * 60s reconnect backoff cap, then restarts it:
 *
 *   1. before: tools/list answers, cotal_roster shows the seat;
 *   2. during the outage: the process stays up, tools/list still answers with the SAME tool set, a
 *      send fails as a tool error (never a dead server);
 *   3. after the broker returns: the seat reconnects on its own and cotal_roster shows it again.
 *
 * Open mesh (no creds) — this proves the transport self-heal, not JWT renewal.
 *
 *   NATS_SERVER=/path/to/nats-server OUTAGE_S=90 node scripts/e2e-mcp-reconnect.ts
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const NATS = process.env.NATS_SERVER ?? "nats-server";
const OUTAGE_MS = Number(process.env.OUTAGE_S ?? 90) * 1000;
if (!Number.isFinite(OUTAGE_MS) || OUTAGE_MS <= 0) throw new Error(`OUTAGE_S must be a positive number of seconds, got "${process.env.OUTAGE_S}"`);
// The package exports no subpath to it; claude's launch names the same file by path.
const MCP = realpathSync(join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", "@cotal-ai", "connector-claude-code", "dist", "mcp.cjs"));

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const store = mkdtempSync(join(tmpdir(), "pawmcpjs-"));
const home = mkdtempSync(join(tmpdir(), "pawmcphome-"));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`mcp-reconnect: ${m}`);
  n++;
  log(`ok  ${m}`);
};

let nats = spawn(NATS, ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", store], { stdio: "ignore" });
const natsUp = () => (nats = spawn(NATS, ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", store], { stdio: "ignore" }));
await sleep(1000);

const space = `mcprc-${process.pid}`;
const mcp = spawn(process.execPath, [MCP], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH,
    HOME: home,
    COTAL_HOME: join(home, ".cotal"),
    COTAL_TELEMETRY_DISABLED: "1",
    COTAL_NAME: "probe",
    COTAL_SPACE: space,
    COTAL_SERVERS: `nats://127.0.0.1:${port}`,
    COTAL_CONTROL_SOCKET: join(home, "ctl.sock"),
    COTAL_CONTROL_TOKEN: "t".repeat(32),
    COTAL_CHANNEL: "1",
  },
});
let exited: string | undefined;
mcp.on("exit", (c, s) => (exited = `${c ?? s}`));
const stderr: string[] = [];
createInterface({ input: mcp.stderr }).on("line", (l) => stderr.push(l));

const pending = new Map<number, (m: Record<string, unknown>) => void>();
let id = 0;
createInterface({ input: mcp.stdout }).on("line", (l) => {
  const m = JSON.parse(l) as { id?: number };
  if (m.id !== undefined) pending.get(m.id)?.(m);
  pending.delete(m.id as number);
});
const rpc = (method: string, params: object) =>
  new Promise<Record<string, any>>((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => (pending.delete(i), rej(new Error(`${method}: no answer in 20s (server hung?)`))), 20_000);
    pending.set(i, (m) => (clearTimeout(timer), res(m)));
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
const tools = async () => ((await rpc("tools/list", {})).result.tools as Array<{ name: string }>).map((t) => t.name).sort().join();
const call = async (name: string, args: object) => {
  const r = (await rpc("tools/call", { name, arguments: args })).result as { isError?: boolean; content: Array<{ text: string }> };
  return { error: r.isError === true, text: r.content[0]?.text ?? "" };
};

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-mcp-reconnect", version: "0" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(3000);
  const before = await tools();
  ok(before.includes("cotal_dm") && before.includes("cotal_roster"), "before: the seat serves its cotal tools");
  ok(/probe/.test((await call("cotal_roster", {})).text), "before: cotal_roster shows the seat on the mesh");

  nats.kill("SIGKILL");
  log(`broker SIGKILLed for ${OUTAGE_MS / 1000}s`);
  await sleep(5000);
  ok((await tools()) === before, "during: tools/list still answers with the same tool set");
  ok((await call("cotal_dm", { to: "nobody", text: "x" })).error, "during: a send is a tool ERROR, not a dead server");
  await sleep(OUTAGE_MS);
  ok(exited === undefined, `during: the MCP process never exited (${OUTAGE_MS / 1000}s, past the 60s backoff cap)`);

  natsUp();
  let back = false;
  for (let i = 0; i < 24 && !back; i++) {
    await sleep(5000);
    back = /Present in .*\n.*probe/s.test((await call("cotal_roster", {})).text);
  }
  ok(back, "after: the seat reconnected by itself and is on the roster again");
  ok((await tools()) === before && exited === undefined, "after: same tools, same process");
  console.log(`✓ e2e-mcp-reconnect — ${n} assertions`);
} catch (e) {
  console.error(stderr.slice(-20).join("\n"));
  throw e;
} finally {
  mcp.stdin.end();
  nats.kill("SIGKILL");
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}

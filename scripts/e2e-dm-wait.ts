/**
 * END-TO-END `paw dm` to a known agent that is briefly off the mesh (src/dm-wait.ts), on an ISOLATED
 * broker of its own (refuses anything else):
 *
 *   1. own nats-server (PAW_SERVER) + ensure() → the mailbox, which writes the peer ledger;
 *   2. a stub seat "evals" (not registered here — another machine's agent) comes up, the ledger learns it;
 *   3. evals goes away; `paw dm evals` while it's down → "waiting for evals…", evals comes back within the
 *      budget → delivered EXACTLY once;
 *   4. evals stays down → `paw dm evals --wait-for 4` fails loud after the budget ("stayed offline");
 *   5. an unknown name fails at once with today's message;
 *   6. the BROKER goes away (the Fly redeploy): `paw dm evals` waits for the mesh, the broker comes back on
 *      the same port + store, evals reconnects and republishes presence → delivered exactly once;
 *   7. the broker stays down → fails loud after the budget naming the MESH, not the agent.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=dmwait-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-dm-wait.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("dmwait-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=dmwait-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), "pawdmwaitjs-"));
const startNats = () => spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", storeDir], { stdio: "ignore" });
let nats: ChildProcess = startNats();

const { ensure, stop } = await import("../src/lifecycle.ts");
const { readLedger } = await import("../src/peer-ledger.ts");
const { pawServer } = await import("../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (cond()) return true;
  return cond();
};
const text = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ");

/** `paw dm …` as a child: resolves with its exit code, output and wall time. */
function pawDm(...args: string[]): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const t0 = Date.now();
  const p = spawn("node", [join(REPO, "bin/paw.ts"), "dm", ...args, "--space", space], { env: process.env });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  return new Promise((r) => p.on("exit", (code) => r({ code, out, err, ms: Date.now() - t0 })));
}

/** A mesh seat as paw sees a remote agent: present under a name, consuming its DM inbox. */
const got: CotalMessage[] = [];
async function seat(name: string): Promise<CotalEndpoint> {
  const ep = new CotalEndpoint({ space, servers: pawServer(), channels: [], registerPresence: true, consume: true, watchPresence: true, card: { name, kind: "agent" } });
  ep.on("message", (m: CotalMessage) => {
    if (m.to) got.push(m);
  });
  ep.on("error", () => {});
  ep.on("warning", () => {});
  await ep.start();
  return ep;
}
const copies = (tag: string) => got.filter((m) => text(m).includes(tag)).length;

const seats: CotalEndpoint[] = [];
try {
  await sleep(500);
  await ensure({ needMesh: true, space });

  let evals = await seat("evals");
  seats.push(evals);
  ok("ledger learned evals (seen on the mesh, not registered here)", await until(() => Object.values(readLedger(space)).some((e) => e.name === "evals"), 20_000));

  // Warm the manager (dm is NEEDS_MANAGER) so the timings below measure the wait, not a cold start.
  const warm = await pawDm("evals", "WARM");
  ok("warm-up dm to the live evals is delivered", warm.code === 0 && (await until(() => copies("WARM") === 1, 10_000)), warm.err.trim());

  // ── 3. down, back within the budget → delivered once ──────────────────────────────────────────
  await evals.stop();
  await sleep(7000); // past the 6s presence TTL: the roster no longer has it
  const pending = pawDm("evals", "DM-1 while you were away");
  await sleep(4000);
  evals = await seat("evals");
  seats.push(evals);
  const r1 = await pending;
  ok("dm to a known-but-absent agent waits, then succeeds", r1.code === 0, `exit ${r1.code} in ${r1.ms}ms: ${r1.err.trim()}`);
  ok("…printing one 'waiting for evals' line", (r1.err.match(/waiting for evals to come back on the mesh/g) ?? []).length === 1, r1.err.trim());
  await sleep(3000);
  ok("…delivered exactly once", copies("DM-1") === 1, `${copies("DM-1")} copies`);

  // ── 4. stays down → fails loud after the budget ────────────────────────────────────────────────
  await evals.stop();
  await sleep(7000);
  const r2 = await pawDm("evals", "DM-2 nobody home", "--wait-for", "4");
  ok("dm to an agent that stays offline fails", r2.code !== 0, `exit ${r2.code}`);
  ok("…after the budget, not at once", r2.ms >= 4000, `${r2.ms}ms`);
  ok("…saying the agent stayed offline on a live mesh", /"evals" stayed offline — the mesh is up/.test(r2.err), r2.err.trim());
  ok("…and nothing was sent", copies("DM-2") === 0);

  // ── 5. unknown → fails immediately ─────────────────────────────────────────────────────────────
  const r3 = await pawDm("nobody-ever-xyz", "hello?");
  ok("dm to an unknown name fails", r3.code !== 0 && /no agent "nobody-ever-xyz" present or known/.test(r3.err), r3.err.trim());
  ok("…without waiting", !/waiting for/.test(r3.err) && r3.ms < 8000, `${r3.ms}ms`);

  // ── 6. the broker restarts (the Fly redeploy) mid-send ─────────────────────────────────────────
  evals = await seat("evals");
  seats.push(evals);
  await sleep(3000);
  nats.kill("SIGTERM");
  await new Promise((r) => nats.once("exit", r));
  const during = pawDm("evals", "DM-3 across a broker restart", "--wait-for", "40");
  await sleep(6000);
  nats = startNats();
  const r4 = await during;
  ok("dm across a broker restart succeeds", r4.code === 0, `exit ${r4.code} in ${r4.ms}ms: ${r4.err.trim()}`);
  await sleep(3000);
  ok("…delivered exactly once", copies("DM-3") === 1, `${copies("DM-3")} copies`);

  // ── 7. the broker stays down → fails loud naming the MESH ──────────────────────────────────────
  nats.kill("SIGTERM");
  await new Promise((r) => nats.once("exit", r));
  const r5 = await pawDm("evals", "DM-4 into the void", "--wait-for", "3");
  ok("dm with the broker down for good fails", r5.code !== 0 && r5.ms >= 3000, `exit ${r5.code} in ${r5.ms}ms`);
  ok("…saying the mesh was unreachable, not the agent", /mesh unreachable — nats:\/\/127\.0\.0\.1:\d+ did not come back within 3s/.test(r5.err) && !/stayed offline/.test(r5.err), r5.err.trim());
  nats = startNats();
  await sleep(4000);
  ok("…and nothing was sent", copies("DM-4") === 0);
} finally {
  for (const ep of seats) await ep.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

/**
 * END-TO-END: `paw office serve` the way cotal-host runs it (#85) — on the broker's box, its creds minted
 * from the box's OWN signer. Isolated: a JWT + TLS broker (`cotal up --no-manager`, self-signed cert, the
 * cotal version cotal-host pins) in a temp root, a local agent-office, temp paw homes, space test-osr-<pid>.
 *
 *   1  `paw mesh add <s> --root <the broker's own root>` accepts the auth `cotal up` wrote (no signer export)
 *   2  serve from that home mints observer creds, reads the roster in roster mode, mirrors an authed agent
 *   3  the owner's office chat is delivered as a DM from the `office` peer (its `operator` mint) without a
 *      permission error; serve registers no presence
 *   4  SIGTERM → exit 0
 *
 *   COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js PAW_OFFICE_TEST_URL=… PAW_OFFICE_TEST_ADMIN_KEY=… node scripts/e2e-office-serve-remote.ts
 */
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const url = process.env.PAW_OFFICE_TEST_URL;
const admin = process.env.PAW_OFFICE_TEST_ADMIN_KEY;
const COTAL = process.env.COTAL_BIN ?? "";
if (!url || !admin || !COTAL || !existsSync(COTAL)) {
  console.log("skip: set COTAL_BIN (cotal-ai@0.84.0 dist/cotal.js, as cotal-host pins) + PAW_OFFICE_TEST_URL + PAW_OFFICE_TEST_ADMIN_KEY");
  process.exit(0);
}

// Stage 2 (re-exec'd with NODE_EXTRA_CA_CERTS, read at node startup): a stub AGENT on the authed space,
// creds minted from its own paw home's record, presence registered, DMs read off the stream.
if (process.argv[2] === "--stub") {
  const [, , , space, server] = process.argv;
  const { CotalEndpoint } = await import("@cotal-ai/core");
  const { prepareHumanInbox } = await import("../src/human-inbox.ts");
  // an authed seat needs its DM/DELIVER durables provisioned before it may hold presence: the same
  // provision-then-bind paw chat does for "you" on a remote space
  const prepared = await prepareHumanInbox(space!, server!, []);
  const { auth } = await prepared.provision();
  const ep = new CotalEndpoint({ space: space!, servers: server!, ...auth, card: { name: "stubby", kind: "agent", meta: { host: "box" } }, registerPresence: true, consume: true, watchPresence: false });
  ep.on("error", (e: Error) => console.error(`stub: ${e.message}`));
  ep.on("message", (m: { from: { name: string }; parts: Array<{ text?: string }> }, d: { ack(): void }, meta: { kind: string }) => {
    d.ack();
    if (meta.kind === "dm") console.log(`DM ${JSON.stringify(`${m.from.name}: ${m.parts.map((p) => p.text ?? "").join("")}`)}`);
  });
  await ep.start();
  await ep.setStatus("working");
  console.log(`stub up ${ep.card.id}`);
  process.on("SIGTERM", () => void ep.stop().then(() => prepared.release()).finally(() => process.exit(0)));
  await new Promise(() => {});
}

const work = mkdtempSync(join(tmpdir(), "paw-osr-"));
const space = `test-osr-${process.pid}`;
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
const brokerRoot = join(work, "broker-root"); // the box's /data/cotal
mkdirSync(brokerRoot, { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAW_SPACE: `${space}-decoy`,
  PAW_SERVER: "nats://127.0.0.1:9",
  PAW_RELEASE: "dev",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NODE_EXTRA_CA_CERTS: cert,
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "OFFICE_URL", "OFFICE_JOIN_KEY", "OFFICE_OWNER_KEY", "OFFICE_VIEW_KEY", "OFFICE_ROSTER"]) delete env[k];
const homeServe = { ...env, PAW_HOME: join(work, "home-serve") };
const homeStub = { ...env, PAW_HOME: join(work, "home-stub") };
const run = (cmd: string, args: string[], e: NodeJS.ProcessEnv, cwd = REPO): SpawnSyncReturns<string> => spawnSync(cmd, args, { env: e, cwd, encoding: "utf8", timeout: 120_000 });
const paw = (args: string[], e: NodeJS.ProcessEnv) => run(process.execPath, [join(REPO, "bin/paw.mjs"), ...args], e);
const cotal = (args: string[]) => run(process.execPath, [COTAL, ...args], env, brokerRoot);
const out = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "").trim();

let fails = 0;
const ok = (label: string, cond: unknown, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return undefined;
}
const { officeClient } = await import("../src/office-api.ts");
const children: ChildProcess[] = [];
let serveOut = "";
try {
  const up = cotal(["up", "--detach", "--no-manager", "--space", space, "--server", server, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")]);
  ok("broker up (JWT + TLS, --no-manager)", up.status === 0, out(up).split("\n").pop());
  ok("cotal up wrote its auth under the root (what office-bridge.sh points at)", existsSync(join(brokerRoot, ".cotal", "auth")));

  // 1 — the record, straight on the broker's root (what office-bridge.sh does with /data/cotal)
  const add = paw(["mesh", "add", space, "--server", server, "--root", brokerRoot, "--force"], homeServe);
  ok("paw mesh add --root <the broker's own root> (serve's home)", add.status === 0, out(add).split("\n")[0]);
  ok("…the stub agent's home too", paw(["mesh", "add", space, "--server", server, "--root", brokerRoot], homeStub).status === 0);

  const stub = spawn(process.execPath, [fileURLToPath(import.meta.url), "--stub", space, server], { env: homeStub, stdio: ["ignore", "pipe", "pipe"] });
  children.push(stub);
  let stubOut = "";
  stub.stdout!.on("data", (b: Buffer) => (stubOut += b.toString()));
  stub.stderr!.on("data", (b: Buffer) => (stubOut += b.toString()));
  ok("an authed stub agent is on the roster", await until(() => /stub up/.test(stubOut), 30_000), stubOut.trim());

  // 2 — serve
  const created = (await (await fetch(`${url}/api/offices`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "paw serve remote e2e" }) })).json()) as { id: string; joinKey: string; ownerKey: string };
  const link = { url: url!, office: created.id, joinKey: created.joinKey };
  const look = async () => (await officeClient(link)("look", {})) as { agents: Array<{ id: string; name: string; status: string }> };
  const serve = spawn(process.execPath, [join(REPO, "bin/paw.mjs"), "office", "serve", "--space", space], {
    env: { ...homeServe, OFFICE_URL: url, OFFICE_JOIN_KEY: created.joinKey, OFFICE_OWNER_KEY: created.ownerKey, NODE_OPTIONS: "--max-old-space-size=192" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(serve);
  serve.stdout!.on("data", (b: Buffer) => (serveOut += b.toString()));
  serve.stderr!.on("data", (b: Buffer) => (serveOut += b.toString()));
  const stubby = await until(async () => (await look()).agents.find((a) => a.name === "stubby"), 60_000);
  ok("serve mints its creds from the box's signer and mirrors the authed agent (roster mode)", stubby?.status === "working" && /EVERY agent/.test(serveOut), serveOut.trim().split("\n").slice(-3).join(" | "));

  // 3 — inbound delivery from the `office` peer
  const ws = new WebSocket(`${url!.replace(/^http/, "ws")}/o/${created.id}/ws`, ["agent-office", `ao-key.${created.ownerKey}`]);
  await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("viewer socket failed")))));
  ws.send(JSON.stringify({ type: "chat", to: stubby!.id, text: "hello from the office", as: "mira" }));
  const dm = await until(() => stubOut.split("\n").find((l) => l.includes("hello from the office")), 45_000);
  ws.close();
  ok("the owner's chat reaches the authed agent as a DM from the `office` peer (its own operator mint)", dm?.startsWith('DM "office: [agent office · owner] mira: hello from the office') && existsSync(join(homeServe.PAW_HOME!, "spaces", space, "office.nkey.json")), dm);
  ok("…no delivery or permission error in serve's log", !/couldn't deliver|GAVE UP|ermission/i.test(serveOut), serveOut.split("\n").filter((l) => /deliver|ermission/i.test(l)).join(" | "));
  const officeId = JSON.parse(readFileSync(join(homeServe.PAW_HOME!, "spaces", space, "office-agents.json"), "utf8")).officePeer as string | undefined;
  ok("…the office peer's id was learned from the send", typeof officeId === "string" && officeId.length > 0, officeId);

  // 4 — SIGTERM
  const code = await new Promise<number | null>((r) => {
    serve.on("exit", (c) => r(c));
    serve.kill("SIGTERM");
  });
  ok("SIGTERM → exit 0", code === 0);
  ok("no office key in serve's output", ![created.joinKey, created.ownerKey].some((k) => serveOut.includes(k.split(".")[1]!)));
} finally {
  for (const c of children) c.kill("SIGTERM");
  await sleep(500);
  cotal(["down"]);
  if (!process.env.PAW_E2E_KEEP) rmSync(work, { recursive: true, force: true });
  const ps = spawnSync("pgrep", ["-f", work], { encoding: "utf8" }).stdout.trim();
  for (const pid of ps.split("\n").filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {}
  }
}
if (fails) console.log(`\nserve log:\n${serveOut}`);
console.log(fails ? `\n${fails} failed` : "\ne2e-office-serve-remote ok");
process.exit(fails ? 1 : 0);

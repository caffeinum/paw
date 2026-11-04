/**
 * END-TO-END: `paw office serve` in ROSTER mode — a headless bridge from an EMPTY paw home mirrors agents
 * that live in ANOTHER paw home (and on "another machine") into a real local agent-office (#85).
 *
 * Fully isolated: private nats on a free port, temp homes/roots, space test-office-serve-<pid>,
 * PAW_RELEASE=dev. Home A runs mesh + manager + mailbox (ensure()) with registered agents stood in by stub
 * endpoints; NO office link in A. Home B is empty: no personas, no mailbox — only `paw office serve`, its
 * link from OFFICE_URL / OFFICE_JOIN_KEY / OFFICE_OWNER_KEY. Then:
 *   1  serve mirrors every roster agent (and no endpoint: A's "you", the office sender), presence-only status
 *   2  a name on two machines (`queue`, card meta.host differs) shows twice, suffixed from the mesh id
 *   3  agent→agent DM shows as office chat; the owner's chat to ONE `queue~…` reaches that machine's agent
 *      only, as a DM from "office" labelled owner; serve registers no presence of its own
 *   4  an agent going offline walks out
 *   5  SIGTERM: clean exit 0, tokens kept; a restart from the stored link resumes without duplicates
 *   6  `paw office disconnect` from home B walks everyone out
 *
 *   PAW_OFFICE_TEST_URL=http://127.0.0.1:8823 PAW_OFFICE_TEST_ADMIN_KEY=… node scripts/e2e-office-serve.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.PAW_OFFICE_TEST_URL;
const admin = process.env.PAW_OFFICE_TEST_ADMIN_KEY;
if (!url || !admin) {
  console.log("skip: set PAW_OFFICE_TEST_URL + PAW_OFFICE_TEST_ADMIN_KEY (a local agent-office: `npm run dev` in agent-office)");
  process.exit(0);
}
const REPO = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "paw-office-serve-e2e-"));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const space = `test-office-serve-${process.pid}`;
const natsPort = await freePort();
const shared = { COTAL_HOME: join(base, "cotal-home"), PAW_BEADS_DIR: join(base, "beads"), PAW_RELEASE: "dev", PAW_SPACE: space, PAW_SERVER: `nats://127.0.0.1:${natsPort}`, PAW_OPERATOR: "operator" };
const homeA = { PAW_HOME: join(base, "home-a"), PAW_COTAL_ROOT: join(base, "root-a") };
const homeB = { PAW_HOME: join(base, "home-b"), PAW_COTAL_ROOT: join(base, "root-b") };
Object.assign(process.env, shared, homeA);
delete process.env.PAW_AUTH;
for (const d of ["home-a", "home-b", "root-a", "root-b", "cotal-home", "beads"]) mkdirSync(join(base, d), { recursive: true });
const envB = (extra: Record<string, string> = {}) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...shared, ...homeB, ...extra };
  for (const k of ["OFFICE_URL", "OFFICE_JOIN_KEY", "OFFICE_OWNER_KEY", "OFFICE_VIEW_KEY", "OFFICE_ROSTER"]) if (!(k in extra)) delete e[k];
  return e;
};

const bundled = join(REPO, "node_modules/.pnpm/node_modules", `@eplightning/nats-server-${process.platform}-${process.arch}`, "bin/nats-server");
const natsChild = spawn(existsSync(bundled) ? bundled : "nats-server", ["-js", "-a", "127.0.0.1", "-p", String(natsPort), "-sd", join(base, "jetstream")], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const { CotalEndpoint } = await import("@cotal-ai/core");
const { ensure, stop } = await import("../src/lifecycle.ts");
const { setFolderName, personaFilePath, waitForPeerId } = await import("../src/addressing.ts");
const { pawServer } = await import("../src/server.ts");
const { officeClient } = await import("../src/office-api.ts");
const { rosterSuffix } = await import("../src/office-roster.ts");

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

const children: ChildProcess[] = [];
const eps: InstanceType<typeof CotalEndpoint>[] = [];
let serveOut = "";
const startServe = (env: NodeJS.ProcessEnv): ChildProcess => {
  const c = spawn(process.execPath, [join(REPO, "bin/paw.mjs"), "office", "serve", "--space", space], { env, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout!.on("data", (b: Buffer) => (serveOut += b.toString()));
  c.stderr!.on("data", (b: Buffer) => (serveOut += b.toString()));
  children.push(c);
  return c;
};
try {
  for (const name of ["ada", "bob", "queue"]) {
    const folder = join(base, "work", name);
    mkdirSync(folder, { recursive: true });
    setFolderName(space, folder, name);
    writeFileSync(personaFilePath(space, name), `---\nname: ${name}\ncwd: ${folder}\n---\nstub\n`);
  }
  await ensure({ needMesh: true, needManager: true, space });
  const server = pawServer(space);
  ok("home A: isolated mesh + manager + mailbox up, no office link", server === shared.PAW_SERVER && !existsSync(join(homeA.PAW_HOME, "spaces", space, "office.json")));

  const inbox = new Map<string, string[]>();
  const fromIds = new Map<string, string>();
  const stub = async (key: string, name: string, host: string, meta: Record<string, unknown> = {}) => {
    const ep = new CotalEndpoint({ space, servers: server, card: { name, kind: "agent", meta: { host, ...meta } }, registerPresence: true, consume: true, watchPresence: true });
    ep.on("error", (e: Error) => console.error(`${key}:`, e.message));
    inbox.set(key, []);
    ep.on("message", (m: { from: { id: string; name: string }; parts: Array<{ kind: string; text?: string }> }, d: { ack(): void }, meta2: { kind: string }) => {
      d.ack();
      if (meta2.kind === "dm") {
        inbox.get(key)!.push(`${m.from.name}: ${m.parts.map((p) => p.text ?? "").join("")}`);
        fromIds.set(m.from.name, m.from.id);
      }
    });
    await ep.start();
    eps.push(ep);
    return ep;
  };
  const ada = await stub("ada", "ada", "machine-a", { emoji: "🦊", hue: 24 });
  const bob = await stub("bob", "bob", "machine-a");
  const qa = await stub("queue@a", "queue", "machine-a");
  const qb = await stub("queue@b", "queue", "machine-b"); // the same name, another machine
  await ada.setStatus("working");
  await bob.setStatus("waiting");

  const created = (await (await fetch(`${url}/api/offices`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "paw serve e2e" }) })).json()) as { id: string; joinKey: string; ownerKey: string };
  const keys = { OFFICE_URL: url, OFFICE_JOIN_KEY: created.joinKey, OFFICE_OWNER_KEY: created.ownerKey };
  const link = { url, office: created.id, joinKey: created.joinKey };
  const look = async () => (await officeClient(link)("look", {})) as { agents: Array<{ id: string; name: string; status: string; activity?: string; client?: string; emoji?: string }> };
  const byName = async (n: string) => (await look()).agents.find((a) => a.name === n);

  // 1 — serve from the EMPTY home B
  let serve = startServe(envB(keys));
  const qaName = `queue~${rosterSuffix(qa.card.id)}`;
  const qbName = `queue~${rosterSuffix(qb.card.id)}`;
  const all = await until(async () => ((await look()).agents.length === 4 ? (await look()).agents : undefined), 60_000);
  ok("serve (home B, no agents registered) mirrors all four roster agents", all?.length === 4, JSON.stringify((all ?? (await look()).agents).map((a) => `${a.name}:${a.status}:${a.activity ?? ""}`)));
  ok("…home B has no personas, no mailbox", !existsSync(join(homeB.PAW_HOME, "spaces", space, "personas")) || readdirSync(join(homeB.PAW_HOME, "spaces", space, "personas")).length === 0);
  ok("…its log says roster mode", /EVERY agent on space/.test(serveOut), serveOut.split("\n").filter(Boolean).slice(0, 4).join(" | "));
  ok("ada: working", (await byName("ada"))?.status === "working" && (await byName("ada"))?.client === "paw");
  ok("bob: waiting (presence only)", (await byName("bob"))?.status === "waiting");
  // 2 — collision
  ok(`a name on two machines → ${qaName} and ${qbName}, no bare "queue"`, !!(await byName(qaName)) && !!(await byName(qbName)) && !(await byName("queue")));
  ok("no endpoint mirrored (A's \"you\", the office sender)", !(await look()).agents.some((a) => a.name === "you" || a.name === "office"));

  await ada.setStatus("idle");
  ok("a status change on the mesh shows in the office", await until(async () => (await byName("ada"))?.status === "idle", 20_000));

  // 3 — speech + inbound by id
  const bobId = await waitForPeerId(ada, "bob", 5000);
  await ada.unicast(bobId!, "PR #12 is up, can you review?");
  const bobO = await byName("bob");
  const said = await until(async () => {
    const tok = JSON.parse(readFileSync(join(homeB.PAW_HOME, "spaces", space, "office-agents.json"), "utf8")).agents.bob.token as string;
    const r = (await officeClient(link)("chat_read", { since: 0 }, { token: tok })) as { messages: Array<{ to: string | null; text: string }> };
    return r.messages.find((m) => m.text === "PR #12 is up, can you review?");
  }, 30_000);
  ok("agent→agent DM shows as office chat to the other agent", said?.to === bobO?.id, JSON.stringify(said));

  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/o/${created.id}/ws`, ["agent-office", `ao-key.${created.ownerKey}`]);
  await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("viewer socket failed")))));
  const qbO = await byName(qbName);
  ws.send(JSON.stringify({ type: "chat", to: qbO!.id, text: "queue on b, drain please", as: "mira" }));
  const got = await until(() => inbox.get("queue@b")!.find((l) => l.includes("drain please")), 45_000);
  ok("the owner's chat to queue~(b) → a DM from \"office\" to THAT machine's agent, labelled owner", got === `office: [agent office · owner] mira: queue on b, drain please\n(from the office's owner; a reply to "office" is posted in the office's chat, which is public)`, JSON.stringify(got));
  ok("…and not to the other machine's queue", !inbox.get("queue@a")!.some((l) => l.includes("drain please")));
  await qb.unicast(fromIds.get("office")!, "draining now");
  const reply = await until(async () => {
    const tok = JSON.parse(readFileSync(join(homeB.PAW_HOME, "spaces", space, "office-agents.json"), "utf8")).agents[qbName].token as string;
    return ((await officeClient(link)("chat_read", { since: 0 }, { token: tok })) as { messages: Array<{ to: string | null; text: string }> }).messages.find((m) => m.text === "draining now");
  }, 30_000);
  ok("its reply to \"office\" goes back to mira", reply?.to === "human:mira", JSON.stringify(reply));
  ws.close();
  const presences = ada.getRoster();
  ok("serve registers no presence (no human beacon, no office peer on the roster)", presences.filter((p) => p.card.name === "you").length === 1 && !presences.some((p) => p.card.name === "office"), presences.map((p) => `${p.card.name}:${p.card.kind}`).join(","));

  // 4 — offline walks out
  await bob.stop();
  eps.splice(eps.indexOf(bob), 1);
  ok("an agent going offline walks out", await until(async () => !(await byName("bob")), 60_000));

  // 5 — SIGTERM, restart from the stored link
  const exited = new Promise<number | null>((r) => serve.on("exit", (code) => r(code)));
  serve.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(15_000).then(() => "timeout" as const)]);
  ok("SIGTERM → clean exit 0", code === 0 && /SIGTERM: stopping/.test(serveOut), String(code));
  const before = (await look()).agents.map((a) => a.name).sort();
  serve = startServe(envB());
  await sleep(12_000);
  const after = (await look()).agents.map((a) => a.name).sort();
  ok("restart from the stored link (no OFFICE_* env) resumes the same characters, no duplicates", JSON.stringify(before) === JSON.stringify(after) && after.length === 3, `${before} → ${after}`);
  ok("serve's output names no key", ![created.joinKey, created.ownerKey].some((k) => serveOut.includes(k.split(".")[1]!)));

  // 6 — disconnect from home B
  const dis = spawnSync(process.execPath, [join(REPO, "bin/paw.mjs"), "office", "disconnect", "--space", space], { encoding: "utf8", env: envB() });
  ok("paw office disconnect (home B) walks everyone out", dis.status === 0 && (await until(async () => (await look()).agents.length === 0, 15_000)), dis.stdout.trim());
} finally {
  for (const c of children) c.kill("SIGTERM");
  for (const ep of eps) await ep.stop().catch(() => {});
  await stop({ space }).catch((e: Error) => console.error("stop:", e.message));
  natsChild.kill("SIGTERM");
  if (!process.env.PAW_E2E_KEEP) rmSync(base, { recursive: true, force: true });
  const ps = spawnSync("pgrep", ["-f", base], { encoding: "utf8" }).stdout.trim();
  for (const pid of ps.split("\n").filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {}
  }
}
if (fails) console.log(`\nserve log:\n${serveOut}`);
console.log(fails ? `\n${fails} failed` : "\ne2e-office-serve ok");
process.exit(fails ? 1 : 0);

/**
 * END-TO-END: a paw space mirrored into a REAL local agent-office through the mailbox daemon's bridge.
 *
 * Fully isolated stack (own nats on a private port, temp PAW_HOME + COTAL_HOME + cotal root, space
 * test-office-<pid>, PAW_RELEASE=dev): ensure() boots mesh + manager + mailbox from this checkout, three
 * registered agents are stood in by stub mesh endpoints (presence + DMs — no claude), then:
 *   1  `paw office connect` (CLI) validates with office_look and writes the 0600 link
 *   2  the mailbox's bridge joins all three with persona emoji/hue and the right status
 *   3  a status change on the mesh shows in the office
 *   4  agent→agent and agent→you DMs show as office chat
 *   5  a human's chat from the owner viewer lands as a paw DM (from "you") on the agent's endpoint
 *   6  an agent going offline walks out
 *   7  `paw office disconnect` walks the rest out and removes the link
 * PAW_E2E_HOLD=<port> also serves `paw web` on that port before 6 and waits until /tmp/paw-office-e2e.hold
 * is deleted, so the embedded viewer can be looked at (and chatted from) in a real browser.
 *
 *   PAW_OFFICE_TEST_URL=http://127.0.0.1:8811 PAW_OFFICE_TEST_ADMIN_KEY=… node scripts/e2e-office.ts
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const base = mkdtempSync(join(tmpdir(), "paw-office-e2e-"));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const space = `test-office-${process.pid}`;
const natsPort = await freePort();
Object.assign(process.env, {
  PAW_HOME: join(base, "home"),
  COTAL_HOME: join(base, "cotal-home"),
  PAW_COTAL_ROOT: join(base, "root"),
  PAW_BEADS_DIR: join(base, "beads"),
  PAW_RELEASE: "dev",
  PAW_SPACE: space,
  PAW_SERVER: `nats://127.0.0.1:${natsPort}`,
  PAW_OPERATOR: "operator",
});
delete process.env.PAW_AUTH;
for (const d of ["home", "cotal-home", "root", "beads"]) mkdirSync(join(base, d), { recursive: true });

// paw only boots the default mesh: a private broker is ours to start (the nats-server cotal bundles, else PATH)
const bundled = join(REPO, "node_modules/.pnpm/node_modules", `@eplightning/nats-server-${process.platform}-${process.arch}`, "bin/nats-server");
const natsChild = spawn(existsSync(bundled) ? bundled : "nats-server", ["-js", "-a", "127.0.0.1", "-p", String(natsPort), "-sd", join(base, "jetstream")], { stdio: "ignore" });
natsChild.on("error", (e) => {
  throw new Error(`e2e-office needs a nats-server (bundled with @cotal-ai/cli, or on PATH): ${e.message}`);
});
await new Promise((r) => setTimeout(r, 800));

const { CotalEndpoint } = await import("@cotal-ai/core");
const { ensure, stop } = await import("../src/lifecycle.ts");
const { setFolderName, personaFilePath, waitForPeerId } = await import("../src/addressing.ts");
const { pawServer } = await import("../src/server.ts");
const { officeClient } = await import("../src/office-api.ts");
const { readOfficeLink, readBridgeState, officeLinkPath } = await import("../src/office-link.ts");

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
const paw = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "bin/paw.mjs"), ...args], { encoding: "utf8", env: process.env });

const children: ChildProcess[] = [];
const eps: InstanceType<typeof CotalEndpoint>[] = [];
try {
  // the fleet on paw's side: three registered folders with personas
  const agents = [
    { name: "ada", emoji: "🦊", hue: 24, repo: "acme/widgets" },
    { name: "bob", emoji: "🐙", hue: 200 },
    { name: "cy", emoji: "🌵", hue: 120 },
  ];
  for (const a of agents) {
    const folder = join(base, "work", a.name);
    mkdirSync(folder, { recursive: true });
    if (a.repo) {
      execFileSync("git", ["init", "-q"], { cwd: folder });
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${a.repo}.git`], { cwd: folder });
    }
    setFolderName(space, folder, a.name);
    writeFileSync(personaFilePath(space, a.name), `---\nname: ${a.name}\ncwd: ${folder}\nemoji: ${a.emoji}\nhue: ${a.hue}\n---\nstub\n`);
  }

  await ensure({ needMesh: true, needManager: true, space });
  const server = pawServer(space);
  ok("isolated mesh + manager + mailbox up", server === process.env.PAW_SERVER, server);

  const inbox = new Map<string, string[]>();
  for (const a of agents) {
    const ep = new CotalEndpoint({ space, servers: server, card: { name: a.name, kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
    ep.on("error", (e: Error) => console.error(`${a.name}:`, e.message));
    inbox.set(a.name, []);
    ep.on("message", (m: { from: { name: string }; parts: Array<{ kind: string; text?: string }> }, d: { ack(): void }, meta: { kind: string }) => {
      d.ack();
      if (meta.kind === "dm") inbox.get(a.name)!.push(`${m.from.name}: ${m.parts.map((p) => p.text ?? "").join("")}`);
    });
    await ep.start();
    eps.push(ep);
  }
  const [ada, bob, cy] = eps as [InstanceType<typeof CotalEndpoint>, InstanceType<typeof CotalEndpoint>, InstanceType<typeof CotalEndpoint>];
  await ada.setStatus("working");
  await bob.setStatus("waiting");

  // 1 — connect through the CLI
  const created = (await (await fetch(`${url}/api/offices`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "paw e2e" }) })).json()) as { id: string; joinKey: string; ownerKey: string };
  const bad = paw("office", "connect", "--space", space, "--url", url, "--join-key", `${created.id}.${"q".repeat(43)}`);
  ok("connect with a wrong key fails loudly, writes nothing, never echoes the key", bad.status === 1 && /refused the join key/.test(bad.stderr) && !bad.stderr.includes("qqqq") && !existsSync(officeLinkPath(space)), bad.stderr.trim());
  const con = paw("office", "connect", "--space", space, "--url", url, "--join-key", created.joinKey, "--owner-key", created.ownerKey);
  ok("paw office connect", con.status === 0 && /office "paw e2e"/.test(con.stdout), (con.stdout + con.stderr).trim().split("\n")[0]);
  ok("…link is 0600 and its output names no key", (statSync(officeLinkPath(space)).mode & 0o777) === 0o600 && !con.stdout.includes(created.joinKey.split(".")[1]!) && !con.stdout.includes(created.ownerKey.split(".")[1]!));
  const link = readOfficeLink(space)!;
  const look = async () => (await officeClient(link)("look", {})) as { agents: Array<{ id: string; name: string; status: string; activity?: string; client?: string }> };
  const byName = async (n: string) => (await look()).agents.find((a) => a.name === n);

  // 2 — the mailbox's bridge joins them
  const all = await until(async () => ((await look()).agents.length === 3 ? (await look()).agents : undefined), 60_000);
  ok("bridge joined all three into the office", all?.length === 3, JSON.stringify(all?.map((a) => `${a.name}:${a.status}:${a.activity ?? ""}`)));
  const adaO = await byName("ada");
  ok("ada: working, activity names its repo (no path)", adaO?.status === "working" && adaO.activity === "working · widgets" && adaO.client === "paw", JSON.stringify(adaO));
  ok("bob: waiting", (await byName("bob"))?.status === "waiting");
  ok("cy: idle", (await byName("cy"))?.status === "idle");
  const state = readBridgeState(space, link.office);
  ok("agent tokens kept in office-agents.json (0600)", Object.keys(state.agents).sort().join() === "ada,bob,cy" && (statSync(join(process.env.PAW_HOME!, "spaces", space, "office-agents.json")).mode & 0o777) === 0o600);
  const st = paw("office", "status", "--space", space);
  ok("paw office status lists them, prints no key", st.status === 0 && /ada\s+working/.test(st.stdout) && !st.stdout.includes(created.joinKey.split(".")[1]!), st.stdout.trim().split("\n").slice(0, 2).join(" | "));

  // 3 — status change
  await ada.setStatus("idle");
  ok("a mesh status change shows in the office", await until(async () => (await byName("ada"))?.status === "idle", 30_000));

  // 4 — speech
  const bobId = await waitForPeerId(ada, "bob", 5000);
  const youId = await until(() => ada.getRoster().find((p) => p.card.name === "you")?.card.id, 10_000);
  await ada.unicast(bobId!, "PR #12 is up, can you review?");
  await bob.unicast(youId!, "reviewing ada's PR now");
  const bobTok = readBridgeState(space, link.office).agents.bob!.token;
  const chatOf = async (token: string) => ((await officeClient(link)("chat_read", { since: 0 }, { token })) as { messages: Array<{ from: string; to: string | null; text: string }> }).messages;
  const agentLine = await until(async () => (await chatOf(bobTok)).find((m) => m.text === "PR #12 is up, can you review?"), 30_000);
  ok("agent→agent DM shows as office chat to the other agent", agentLine && agentLine.to === (await byName("bob"))?.id, JSON.stringify(agentLine));
  const humanLine = await until(async () => (await chatOf(bobTok)).find((m) => m.text === "reviewing ada's PR now"), 30_000);
  ok("agent→you DM shows as office chat to the office's human", humanLine?.to === "human:operator", JSON.stringify(humanLine));

  // 5 — a human chats from the owner viewer → paw DM
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/o/${link.office}/ws`, ["agent-office", `ao-key.${created.ownerKey}`]);
  await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("viewer socket failed")))));
  ws.send(JSON.stringify({ type: "chat", to: adaO!.id, text: "ada, can you rerun CI?", as: "mira" }));
  const dm = await until(() => inbox.get("ada")!.find((l) => l.includes("ada, can you rerun CI?")), 45_000);
  ok("office chat → a paw DM from you on ada's endpoint", dm === "you: [agent office] mira: ada, can you rerun CI?", dm);
  await ada.unicast(youId!, "rerunning CI now");
  const reply = await until(async () => (await chatOf(readBridgeState(space, link.office).agents.ada!.token)).find((m) => m.text === "rerunning CI now"), 30_000);
  ok("ada's reply goes back to mira in the office", reply?.to === "human:mira", JSON.stringify(reply));
  ws.close();

  const hold = process.env.PAW_E2E_HOLD;
  if (hold) {
    const web = spawn(process.execPath, [join(REPO, "bin/paw.mjs"), "web", "--port", hold, "--no-open", "--space", space], { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
    children.push(web);
    const flag = "/tmp/paw-office-e2e.hold";
    writeFileSync(flag, `${space}\n`);
    console.log(`HOLD: paw web on http://127.0.0.1:${hold}/?at=office — delete ${flag} to continue; DMs the stub agents receive are logged below`);
    const seen = new Map<string, number>();
    while (existsSync(flag)) {
      for (const [n, lines] of inbox) for (const l of lines.slice(seen.get(n) ?? 0)) console.log(`  DM → ${n}: ${l}`);
      for (const [n, lines] of inbox) seen.set(n, lines.length);
      await sleep(1000);
    }
  }

  // 6 — offline walks out
  await cy.stop();
  eps.splice(eps.indexOf(cy), 1);
  ok("an agent going offline walks out of the office", await until(async () => !(await byName("cy")), 90_000));

  // 7 — disconnect
  const dis = paw("office", "disconnect", "--space", space);
  ok("paw office disconnect walks the rest out and removes the link", dis.status === 0 && !existsSync(officeLinkPath(space)) && (await look()).agents.length === 0, dis.stdout.trim());
  await sleep(15_000); // the mailbox's bridge must not rejoin anyone (the ghost race) nor rewrite the tokens file
  const later = await look();
  ok("…and the office is still empty 15s later, tokens file still gone", later.agents.length === 0 && !existsSync(join(process.env.PAW_HOME!, "spaces", space, "office-agents.json")), JSON.stringify(later.agents.map((a) => `${a.name}:${a.status}`)));
  const mailboxLog = ["mailbox.log", "mailbox.err"].map((f) => join(process.env.PAW_HOME!, "spaces", space, f)).filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
  ok("no office key in the mailbox log", !mailboxLog.includes(created.joinKey.split(".")[1]!) && !mailboxLog.includes(created.ownerKey.split(".")[1]!), mailboxLog.split("\n").filter((l) => l.includes("[office]")).slice(0, 4).join(" | "));
} finally {
  for (const c of children) c.kill("SIGTERM");
  for (const ep of eps) await ep.stop().catch(() => {});
  await stop({ space }).catch((e: Error) => console.error("stop:", e.message));
  natsChild.kill("SIGTERM");
  if (!process.env.PAW_E2E_KEEP) rmSync(base, { recursive: true, force: true }); // PAW_E2E_KEEP=1 keeps the logs
  // anything still running with our temp dir in its argv (the private nats-server) goes too
  const ps = spawnSync("pgrep", ["-f", base], { encoding: "utf8" }).stdout.trim();
  for (const pid of ps.split("\n").filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {}
  }
}
console.log(fails ? `\n${fails} failed` : "\ne2e-office ok");
process.exit(fails ? 1 : 0);

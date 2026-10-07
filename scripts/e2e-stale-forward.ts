/**
 * END-TO-END stale-id forwarding on an ISOLATED broker of its own (refuses anything else):
 *
 *   1. own nats-server (PAW_SERVER) + ensure() → the mailbox daemon, which hosts the forwarder + ledger;
 *   2. "evals" comes up (incarnation #1), a peer "queue-ea" DMs it normally — delivered, not forwarded;
 *   3. evals RESTARTS: #1 goes away, #2 joins under the same name with a NEW id (what every agent
 *      restart does);
 *   4. queue-ea DMs #1's OLD id (the 2026-10-06 incident) → #2 receives it EXACTLY ONCE, under
 *      queue-ea's identity, marked forwarded;
 *   5. the mailbox restarts → nothing is re-forwarded (persisted cursor + done-set + msgID dedup);
 *   6. reads name the dead id: the ledger labels it "evals (old instance)", `paw history` shows it,
 *      `paw inbox --sent --json` keys a "you" DM to the old id as "evals".
 *
 * The agents are cotal endpoints (registerPresence + consume — exactly what the mesh sees of a seat),
 * not claude processes: the forwarder only ever sees presence + the DM stream, and this keeps the run
 * deterministic and free.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=stale-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-stale-forward.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("stale-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=stale-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawstalejs-"))], { stdio: "ignore" });

const { ensure, stop, mailboxProcs } = await import("../src/lifecycle.ts");
const { stableHumanId } = await import("../src/addressing.ts");
const { labelPeer, readLedger } = await import("../src/peer-ledger.ts");
const { HUMAN_PEER } = await import("../src/names.ts");
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
const mailboxLog = () => readFileSync(join(process.env.PAW_HOME!, "spaces", space, "mailbox.log"), "utf8");
const text = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ");
const paw = (...args: string[]) => execFileSync("node", [join(REPO, "bin/paw.ts"), ...args, "--space", space], { encoding: "utf8", env: process.env });

/** A mesh seat as the forwarder sees one: present under a name, consuming its DM inbox. */
async function seat(name: string): Promise<{ ep: CotalEndpoint; got: CotalMessage[] }> {
  const ep = new CotalEndpoint({ space, servers: pawServer(), channels: [], registerPresence: true, consume: true, watchPresence: true, card: { name, kind: "agent" } });
  const got: CotalMessage[] = [];
  ep.on("message", (m: CotalMessage) => {
    if (m.to) got.push(m);
  });
  ep.on("error", () => {});
  await ep.start();
  return { ep, got };
}

const seats: CotalEndpoint[] = [];
try {
  await sleep(500);
  await ensure({ needMesh: true, space });
  ok("mailbox started the forwarder", await until(() => /\[forward\] up for space/.test(mailboxLog()), 30_000), mailboxLog().split("\n").slice(-5).join(" | "));

  const evals1 = await seat("evals");
  const qea = await seat("queue-ea");
  seats.push(evals1.ep, qea.ep);
  const oldId = evals1.ep.card.id;
  await until(() => qea.ep.getRoster().some((p) => p.card.id === oldId), 10_000);
  await qea.ep.unicast(oldId, "LIVE-1 hello while you're up");
  ok("a DM to a live seat is delivered normally", await until(() => evals1.got.some((m) => text(m).includes("LIVE-1")), 10_000));
  ok("ledger learned evals #1", await until(() => readLedger(space)[oldId]?.name === "evals", 15_000));

  // ── restart: #1 dies without a goodbye (SIGKILL-like: no offline publish), #2 has a new id ──────
  await evals1.ep.stop();
  const evals2 = await seat("evals");
  seats.push(evals2.ep);
  const newId = evals2.ep.card.id;
  ok("the restart minted a new id", newId !== oldId, `${oldId} → ${newId}`);
  ok("ledger learned evals #2", await until(() => readLedger(space)[newId]?.name === "evals", 15_000));
  ok("ledger names the dead id 'evals (old instance)'", labelPeer(space, oldId) === "evals (old instance)", labelPeer(space, oldId));
  await sleep(16_000); // past ROSTER_FRESH_MS: #1's last heartbeat is now stale, as in the incident

  // ── the incident: queue-ea DMs the OLD id ───────────────────────────────────────────────────────
  await qea.ep.unicast(oldId, "STALE-1 copied your id from an old message");
  const fwd = () => evals2.got.filter((m) => text(m).includes("STALE-1"));
  ok("evals #2 receives the DM sent to #1's id", await until(() => fwd().length > 0, 20_000), mailboxLog().split("\n").filter((l) => l.includes("[forward]")).slice(-3).join(" | "));
  const m = fwd()[0];
  ok("…under the original sender", m?.from.id === qea.ep.card.id && m?.from.name === "queue-ea", JSON.stringify(m?.from));
  ok("…marked forwarded, naming the old instance", !!m && text(m).includes("[paw: forwarded") && text(m).includes(oldId));
  await sleep(5000);
  ok("…exactly once", fwd().length === 1, `${fwd().length} copies`);

  // ── the mailbox restarts: nothing is re-forwarded ───────────────────────────────────────────────
  for (const pid of mailboxProcs(space)) process.kill(pid, "SIGTERM");
  await until(() => mailboxProcs(space).length === 0, 10_000);
  await ensure({ needMesh: true, space });
  await until(() => (mailboxLog().match(/\[forward\] up for space/g) ?? []).length >= 2, 30_000);
  await sleep(6000);
  ok("a mailbox restart re-forwards nothing", fwd().length === 1, `${fwd().length} copies`);

  // ── what the human sees ─────────────────────────────────────────────────────────────────────────
  const you = new CotalEndpoint({ space, servers: pawServer(), channels: [], registerPresence: false, consume: false, watchPresence: false, card: { name: HUMAN_PEER, kind: "endpoint", id: stableHumanId(space) } });
  you.on("error", () => {});
  await you.start();
  await you.unicast(oldId, "STALE-2 from you to the old id");
  await you.stop();
  ok("a 'you' DM to the old id is forwarded too", await until(() => evals2.got.some((x) => text(x).includes("STALE-2")), 20_000));
  const hist = paw("history");
  ok("paw history names the dead recipient", /queue-ea .*→ evals \(old instance\):.*STALE-1/.test(hist), hist.split("\n").filter((l) => l.includes("STALE-1"))[0]);
  const sent = (JSON.parse(paw("inbox", "--sent", "--json", "--history")) as { messages: Array<{ dir?: string; to?: string; text: string }> }).messages;
  const out = sent.find((e) => e.dir === "out" && e.text.includes("STALE-2"));
  ok("paw inbox --sent keys the old-id DM to 'evals' (the conversation key, no suffix)", out?.to === "evals", JSON.stringify(out));
  ok("no forward loop: one forward line per original", (mailboxLog().match(/re-sent to/g) ?? []).length === 2, mailboxLog().split("\n").filter((l) => l.includes("re-sent")).join(" | "));
} finally {
  for (const ep of seats) await ep.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

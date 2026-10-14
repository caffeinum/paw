/**
 * check:prune — `paw spaces prune` deletes ONLY dead spaces' streams (beads-eic).
 *
 * Boots a PRIVATE nats-server (random port, temp store; PAW_SERVER points every paw read at it — the
 * live broker is never touched), an isolated PAW_HOME and COTAL_HOME, and seeds real space streams
 * with cotal's own `setupSpaceStreams`. Then proves the plan keeps every protected space — paw's
 * default, the current space, a --keep, a mesh-registry entry, a space a running process names, a
 * recently active space, a space whose deletion would take a kept space's stream with it — leaves
 * a foreign stream alone, and that executing it removes exactly the dead spaces' streams. Also
 * covers `purgeTestSpace` (test teardown) and the `paw spaces` CLI dry run (deletes nothing).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-prune-home-"));
process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "paw-prune-cotal-"));
process.env.PAW_SPACE = "prunetest-current";
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
const server = process.env.PAW_SERVER;
const storeDir = mkdtempSync(join(tmpdir(), "paw-prune-js-"));

const { connect } = await import("@nats-io/transport-node");
const { jetstreamManager } = await import("@nats-io/jetstream");
const { setupSpaceStreams, chatStream } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const prune = await import("../src/prune.ts");
const { parseSpacesArgs } = await import("../src/commands/spaces.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
async function throws(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
  }
}

// --- pure helpers -------------------------------------------------------------
assert(prune.parseDuration("0") === 0 && prune.parseDuration("30m") === 1_800_000 && prune.parseDuration("7d") === 604_800_000, "parseDuration: 0 / 30m / 7d");
await throws(async () => prune.parseDuration("soon"), /not a duration/, "parseDuration fails loud on junk");
assert([...prune.spacesInArgv("node x.ts supervise --space alpha --server n\npaw.ts mailbox --space=beta\nfoo")].join(",") === "alpha,beta", "spacesInArgv: both flag forms");
{
  const a = parseSpacesArgs(["prune", "--yes", "--keep", "k", "--min-idle", "2h", "--space", "cur"]);
  assert(a.prune && a.yes && a.keep.join() === "k" && a.minIdleMs === 7_200_000 && a.space === "cur", "parseSpacesArgs: prune --yes --keep --min-idle (+ injected --space)");
  assert(!parseSpacesArgs(["--space", "cur"]).prune, "parseSpacesArgs: bare `spaces` is the read-only listing");
  await throws(async () => parseSpacesArgs(["--yes", "--space", "cur"]), /belong to `paw spaces prune`/, "parseSpacesArgs: --yes without prune fails loud");
}
{
  const row = (name: string) => ({ name, bytes: 1, msgs: 0, consumers: 0, created: 1, lastTs: 0 });
  const { spaces, unowned } = prune.attributeStreams([row("EPT_REQ_x"), row("EPT_x"), row("CHAT_x"), row("OBJ_cotal_xfer_x_abc123"), row("WEIRD")]);
  assert([...spaces.keys()].join() === "x" && spaces.get("x")!.streams.length === 4, "attributeStreams: EPT_REQ_x is space x (longest prefix), transfer stream attributed");
  assert(unowned.map((r) => r.name).join() === "WEIRD", "attributeStreams: an unknown stream is unowned");
}

// --- private broker -----------------------------------------------------------
const srv = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", storeDir], { stdio: "ignore" });
srv.on("error", (e) => {
  throw new Error(`check:prune needs nats-server on PATH: ${e.message}`);
});
let busy: ReturnType<typeof spawn> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
for (let i = 0; !nc; i++) {
  try {
    nc = await connect({ servers: server });
  } catch (e) {
    if (i > 40) throw new Error(`private nats-server never came up on ${server}: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const jsm = await jetstreamManager(nc);
const names = async (): Promise<Set<string>> => {
  const out = new Set<string>();
  for await (const n of jsm.streams.names()) out.add(n);
  return out;
};

try {
  const spaces = ["paw", "prunetest-current", "kept-by-flag", "registered", "busy-sp", "dead-a", "dead-b"];
  for (const space of spaces) await setupSpaceStreams({ servers: server, space });
  // A dead space whose own teardown list names a KEPT space's stream: deleteSpace("REQ_kept-by-flag")
  // would delete EPT_REQ_kept-by-flag. Its only stream is a CHAT, so it attributes to REQ_kept-by-flag.
  await jsm.streams.add({ name: chatStream("REQ_kept-by-flag"), subjects: ["prunetest.req.>"] });
  await jsm.streams.add({ name: "FOREIGN", subjects: ["foreign.>"] });
  recordMesh({ space: "registered", server, root: process.env.PAW_HOME!, mode: "open", ts: new Date().toISOString() } as Parameters<typeof recordMesh>[0]);
  mkdirSync(join(process.env.PAW_HOME!, "spaces"), { recursive: true });
  busy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "--", "--space", "busy-sp"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));

  const before = await names();
  const owned = (s: string) => [...before].filter((n) => prune.attributeStreams([{ name: n, bytes: 0, msgs: 0, consumers: 0, created: 0, lastTs: 0 }]).spaces.has(s));
  assert(owned("dead-a").length >= 20, `seeded: dead-a has ${owned("dead-a").length} streams`);

  const { spaces: bySpace, unowned } = prune.attributeStreams(await prune.readBroker(server));
  assert(spaces.every((s) => bySpace.has(s)) && bySpace.has("REQ_kept-by-flag"), "readBroker+attribute: every seeded space found");
  assert(unowned.map((r) => r.name).join() === "FOREIGN", "readBroker+attribute: FOREIGN is unattributed");

  const protect = prune.gatherProtected(["kept-by-flag"]);
  const fresh = prune.planPrune(bySpace, unowned, protect, Date.now(), 3_600_000);
  assert(fresh.remove.length === 0, "default --min-idle 1h: freshly created spaces are all kept");

  const plan = prune.planPrune(bySpace, unowned, protect, Date.now(), 0);
  const removed = plan.remove.map((r) => r.space).sort().join();
  assert(removed === "dead-a,dead-b", `--min-idle 0: removes exactly dead-a,dead-b (got ${removed})`);
  const why = new Map(plan.keep.map((k) => [k.row.space, k.reason]));
  assert(/default/.test(why.get("paw") ?? ""), `keeps paw: ${why.get("paw")}`);
  assert(/current space/.test(why.get("prunetest-current") ?? ""), `keeps the current space: ${why.get("prunetest-current")}`);
  assert(/--keep/.test(why.get("kept-by-flag") ?? ""), `keeps --keep: ${why.get("kept-by-flag")}`);
  assert(/registry/.test(why.get("registered") ?? ""), `keeps a registered mesh: ${why.get("registered")}`);
  assert(/running process/.test(why.get("busy-sp") ?? ""), `keeps a space a running process names: ${why.get("busy-sp")}`);
  assert(/EPT_REQ_kept-by-flag/.test(why.get("REQ_kept-by-flag") ?? ""), `keeps a space whose teardown would hit a kept stream: ${why.get("REQ_kept-by-flag")}`);

  // The CLI dry run: prints the plan, deletes nothing.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = spawnSync(process.execPath, [join(root, "bin/paw.ts"), "spaces", "prune", "--min-idle", "0", "--keep", "kept-by-flag"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  assert(cli.status === 0 && /dry run — nothing deleted/.test(cli.stdout) && /2 spaces/.test(cli.stdout), `CLI dry run exits 0 and plans 2 spaces${cli.status === 0 ? "" : `: ${cli.stderr}`}`);
  assert((await names()).size === before.size, "CLI dry run deleted nothing");

  await prune.executePrune(server, plan);
  const after = await names();
  const expected = new Set([...before].filter((n) => !owned("dead-a").includes(n) && !owned("dead-b").includes(n)));
  assert(after.size === expected.size && [...expected].every((n) => after.has(n)), `execute: exactly dead-a/dead-b's ${before.size - expected.size} streams deleted, the other ${expected.size} intact`);
  assert(after.has("FOREIGN") && after.has("EPT_REQ_kept-by-flag") && after.has(chatStream("REQ_kept-by-flag")), "execute: FOREIGN, the kept space and the collision space untouched");

  // purgeTestSpace — the test-teardown path.
  await throws(() => prune.purgeTestSpace("paw", server), /live space/, "purgeTestSpace refuses paw");
  await throws(() => prune.purgeTestSpace("busy-sp", server), /running process/, "purgeTestSpace refuses a space a running process names");
  await setupSpaceStreams({ servers: server, space: "teardown-me" });
  recordMesh({ space: "teardown-me", server, root: process.env.PAW_HOME!, mode: "open", ts: new Date().toISOString() } as Parameters<typeof recordMesh>[0]);
  await prune.purgeTestSpace("teardown-me", server);
  const left = prune.attributeStreams(await prune.readBroker(server)).spaces;
  assert(!left.has("teardown-me"), "purgeTestSpace deletes the test space's streams");
  assert(!prune.gatherProtected().has("teardown-me"), "purgeTestSpace drops the registry entry");
} finally {
  busy?.kill();
  await nc.close();
  srv.kill();
  for (const d of [storeDir, process.env.PAW_HOME!, process.env.COTAL_HOME!]) rmSync(d, { recursive: true, force: true });
}

if (failures) {
  console.error(`\ncheck:prune: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ncheck:prune: only dead spaces go 🐾");

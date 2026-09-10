/**
 * Integration check for the headline: the human↔agent reply loop closes. Boots a paw-managed mesh in
 * an isolated space, stands up the persistent `you` peer exactly as chat does, and a stub agent that
 * replies to whoever DMs it (what the mesh brief now tells real agents to do). Asserts `you` is
 * addressable by the agent and the agent's reply lands back on `you` — the gap `paw dm` (fire-and-
 * forget) couldn't close. Needs the cotal mesh binary + a free NATS port; self-isolates and tears
 * down. Run: pnpm check:loop
 */
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, DEFAULT_SERVER, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { controlCreds, stableHumanId, waitForPeerId } from "../src/addressing.js";
import { removeMesh } from "@cotal-ai/workspace";
import { ensure, stop } from "../src/lifecycle.js";
import { HUMAN_PEER } from "../src/names.js";

const space = "pawloopprobe";
process.env.PAW_SPACE = space;
// Run the daemons from the CHECKOUT (src/release.ts): this check exercises the mesh loop, and
// snapshotting a release here would write into the operator's REAL ~/.paw/releases and could move
// the `current` pointer their live daemons resolve through — a test must never cut over production.
process.env.PAW_RELEASE = "dev";
const spaceDir = join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "spaces", space);
const text = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

await ensure({ needMesh: true, space });
const server = DEFAULT_SERVER;

const creds = await controlCreds(space);
const you = new CotalEndpoint({
  space,
  servers: server,
  creds,
  card: creds ? { name: HUMAN_PEER, kind: "endpoint" } : { name: HUMAN_PEER, kind: "endpoint", id: stableHumanId(space) },
  registerPresence: true,
  consume: true,
  watchPresence: true,
});
let reply = "";
you.on("error", (e: Error) => console.error("you:", e.message));
you.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
  if (meta.kind === "dm") reply = text(m);
  d.ack();
});
await you.start();

const web = new CotalEndpoint({ space, servers: server, card: { name: "web", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
web.on("error", (e: Error) => console.error("web:", e.message));
web.on("message", async (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
  d.ack();
  if (meta.kind !== "dm") return;
  const peer = web.getRoster().find((p) => p.card.name.toLowerCase() === m.from.name.toLowerCase());
  if (peer) await web.unicast(peer.card.id, `echo: ${text(m)}`); // reply to the sender, as the brief instructs
});
await web.start();

const webId = await waitForPeerId(you, "web", 5000);
if (!webId) throw new Error("web never appeared in you's roster");
await you.unicast(webId, "hello from human");

const deadline = Date.now() + 5000;
while (!reply && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

const youAddressable = web.getRoster().some((p) => p.card.name === HUMAN_PEER && p.status !== "offline");
console.log("you present & addressable from the agent:", youAddressable);
console.log("human received the agent's reply:", JSON.stringify(reply));

await you.stop();
await web.stop();
await stop({ space });
rmSync(spaceDir, { recursive: true, force: true });
// Also drop the MESH REGISTRY entry. Without this every run left a `pawloopprobe` claiming
// nats://127.0.0.1:4222 in ~/.cotal/meshes, and cotal's `up` preflight matches the FIRST entry holding
// a port — so months of accumulated test spaces eventually made the real mesh refuse to start with
// "already in use by mesh <some test space>". A test that litters shared machine state is a landmine.
removeMesh(space);

if (!youAddressable) {
  console.error("FAIL: human peer is not addressable (fire-and-forget regression)");
  process.exit(1);
}
if (reply !== "echo: hello from human") {
  console.error("FAIL: loop did not close");
  process.exit(1);
}
console.log("\nloop closed end-to-end 🐾");

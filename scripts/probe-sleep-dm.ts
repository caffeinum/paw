/**
 * PROBE (not a check): what happens to a DM sent to an agent the manager has DESPAWNED?
 * Spawns a real claude in an isolated space, records its principal + DM durable, despawns it,
 * publishes a DM to the old principal, inspects JetStream + the roster, respawns, and reports
 * whether the new incarnation's durable can see that DM.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=sleeptest-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) tsx scripts/probe-sleep-dm.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, dmStream } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { ManagerControl } from "../src/control.ts";
import { ensureAgentSpawned, setFolderName } from "../src/addressing.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { pawServer } from "../src/server.ts";

const space = process.env.PAW_SPACE!;
if (!process.env.PAW_HOME || !space || space === "paw" || !space.startsWith("sleeptest")) throw new Error("isolated PAW_HOME + PAW_SPACE=sleeptest-* required");
process.env.PAW_RUNTIME ??= "pty";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function consumers(): Promise<Array<{ name: string; pending: number; ackPending: number; delivered: number; optStart?: number; filter?: string }>> {
  const nc = await connect({ servers: pawServer() });
  try {
    const jsm = await jetstreamManager(nc);
    const out = [];
    for await (const ci of jsm.consumers.list(dmStream(space))) {
      out.push({ name: ci.name, pending: ci.num_pending, ackPending: ci.num_ack_pending, delivered: ci.delivered.stream_seq, optStart: ci.config.opt_start_seq, filter: ci.config.filter_subject });
    }
    const si = await jsm.streams.info(dmStream(space));
    console.log(`  DM stream last_seq=${si.state.last_seq} msgs=${si.state.messages}`);
    return out;
  } finally {
    await nc.close();
  }
}

const folder = mkdtempSync(join(tmpdir(), "pawsleep-"));
let ep: CotalEndpoint | undefined;
const ctl = new ManagerControl(space, pawServer());
try {
  await ensure({ needMesh: true, needManager: true, space });
  await sleep(3000);
  const name = setFolderName(space, folder, "sleeper").name;
  const r1 = await ensureAgentSpawned(ctl, { space, name, cwd: folder });
  console.log(`spawned #1 id=${r1.id}`);
  ep = new CotalEndpoint({ space, servers: pawServer(), channels: [], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint" } });
  ep.on("error", () => {});
  await ep.start();
  await sleep(2500);
  const roster = () => ep!.getRoster().filter((p) => p.card.name === name).map((p) => `${p.card.id}:${p.status}`);
  console.log(`roster before despawn: ${roster().join(", ")}`);
  console.log("consumers before despawn:", await consumers());

  const d = await ctl.despawn(name);
  console.log(`despawn ok=${d.ok} ${d.error ?? ""}`);
  await sleep(8000);
  console.log(`roster 8s after despawn: ${roster().join(", ") || "(none)"}`);
  console.log("consumers after despawn:", await consumers());

  const oldId = r1.id!;
  await ep.unicast(oldId, `SLEEPTOKEN-${Date.now()}: please reply "pong" to prober with cotal_dm`);
  console.log(`unicast to old principal ${oldId} published`);
  console.log("consumers after DM:", await consumers());

  const r2 = await ensureAgentSpawned(ctl, { space, name, cwd: folder });
  console.log(`spawned #2 id=${r2.id} (same principal: ${r2.id === oldId})`);
  console.log("consumers after respawn:", await consumers());
  const got: string[] = [];
  ep.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }) => got.push(`${m.from?.name}: ${m.parts?.[0]?.text ?? ""}`));
  await sleep(45_000);
  console.log("consumers after 45s:", await consumers());
  console.log(`prober received: ${JSON.stringify(got)}`);
  await ctl.despawn(name);
} finally {
  await ep?.stop().catch(() => {});
  await ctl.close();
  await stop({ space }).catch((e) => console.error("stop:", e.message));
  removeMesh(space);
}

/**
 * END-TO-END `paw cron` in an ISOLATED space (refuses anything else): a real mesh + manager, a listening
 * peer registered as agent "target", and the real CLI (`node bin/paw.ts cron …`):
 *  1. `cron add target --in 2s` → `cron tick` delivers the DM over the mesh, one-shot removed;
 *  2. inside an agent (COTAL_NAME/COTAL_SPACE, no PAW_SPACE) `cron add --in 2s` defaults to the caller + its space;
 *  3. a recurring job created hours ago (missed fires) delivers exactly ONE DM over two ticks;
 *  4. a job for an unregistered name is refused at add, and a hand-written one is NOT delivered (nothing spawned);
 *  5. `cron rm` removes a job.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-cron.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint } from "@cotal-ai/core";
import { setFolderName } from "../src/addressing.ts";
import { readStore, updateStore } from "../src/cron.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { pawServer } from "../src/server.ts";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT) {
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
}
process.env.PAW_RUNTIME ??= "pty";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paw.ts");
const paw = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(process.execPath, [bin, "cron", ...args], { env, encoding: "utf8", timeout: 120_000 });
  console.log(`  $ paw cron ${args.join(" ")} → ${r.status}\n${(r.stdout + r.stderr).trim().replace(/^/gm, "    ")}`);
  return r;
};

let target: CotalEndpoint | undefined;
const inbox: string[] = [];
const senders: string[] = [];
const waitFor = async (pred: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !pred(); ) await sleep(250);
  return pred();
};
try {
  await ensure({ needMesh: true, needManager: true, space });
  const folder = mkdtempSync(join(tmpdir(), "pawcron-target-"));
  const name = setFolderName(space, folder, "target").name;
  ok("registered agent \"target\"", name === "target");
  target = new CotalEndpoint({ space, servers: pawServer(space), channels: [], consume: true, registerPresence: true, watchPresence: true, card: { name: "target", kind: "endpoint" } });
  target.on("error", () => {});
  target.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }) => {
    inbox.push((m.parts ?? []).map((p) => p.text ?? "").join(" "));
    senders.push(m.from?.name ?? "?");
  });
  await target.start();
  await sleep(1500);

  // 1. one-shot via the CLI, fired by tick
  ok("add --in 2s", paw(["add", "target", "--in", "2s", "e2e one-shot token-A"]).status === 0);
  ok("ls shows it", paw(["ls"]).stdout.includes("token-A"));
  await sleep(2500);
  ok("tick exits 0", paw(["tick"]).status === 0);
  ok("the one-shot DM arrived over the mesh", await waitFor(() => inbox.some((t) => t.includes("token-A") && t.startsWith("⏰ paw cron")), 15_000), inbox.at(-1));
  ok('…sent by the peer "cron", not "you"', senders[inbox.findIndex((t) => t.includes("token-A"))] === "cron", senders.join(","));
  ok("…and the one-shot was removed", !readStore(space).jobs.some((j) => j.prompt.includes("token-A")));

  // 2. inside an agent: the caller + its space by default (no PAW_SPACE in the child)
  const agentEnv: NodeJS.ProcessEnv = { ...process.env, COTAL_NAME: "target", COTAL_SPACE: space };
  delete agentEnv.PAW_SPACE;
  ok("add --in 2s from inside agent \"target\" (no agent, no --space)", paw(["add", "--in", "2s", "self token-B"], agentEnv).status === 0);
  const self = readStore(space).jobs.find((j) => j.prompt.includes("token-B"));
  ok("…stored for the caller in the caller's space", self?.agent === "target" && self?.createdBy === "target");
  await sleep(2500);
  paw(["tick"]);
  ok("…and delivered", await waitFor(() => inbox.some((t) => t.includes("token-B")), 15_000));

  // 3. catch-up once: a recurring job whose last fire was hours ago
  ok("add a recurring job", paw(["add", "target", "* * * * *", "recurring token-C"]).status === 0);
  updateStore(space, (s) => {
    for (const j of s.jobs) if (j.prompt.includes("token-C")) j.createdAt = Date.now() - 3 * 3_600_000;
  });
  paw(["tick"]);
  paw(["tick"]);
  await sleep(3000);
  const c = inbox.filter((t) => t.includes("token-C")).length;
  ok("~180 missed minutes → exactly ONE DM across two ticks", c === 1, `${c} delivered`);
  ok("…and the recurring job is still scheduled", readStore(space).jobs.some((j) => j.prompt.includes("token-C") && j.lastFiredAt));

  // 4. never spawn what isn't registered
  const refused = paw(["add", "ghost", "--in", "5m", "x"]);
  ok("add for an unregistered name fails loud", refused.status === 1 && /not a registered agent/.test(refused.stderr));
  updateStore(space, (s) => void s.jobs.push({ id: "ghost001", agent: "ghost", prompt: "token-D", at: Date.now() - 1000, createdAt: Date.now() - 60_000, createdBy: "operator" }));
  const t = paw(["tick"]);
  ok("a hand-written job for an unregistered name is NOT delivered, tick exits 1", t.status === 1 && /ghost001 → ghost.*NOT delivered/.test(t.stdout));
  ok("…and kept for a bounded retry", readStore(space).jobs.find((j) => j.id === "ghost001")?.attempts === 1);

  // 5. rm
  const rec = readStore(space).jobs.find((j) => j.prompt.includes("token-C"))!;
  ok("rm removes a job", paw(["rm", rec.id]).status === 0 && !readStore(space).jobs.some((j) => j.id === rec.id));
  ok("rm of an unknown id fails loud", paw(["rm", "nope"]).status === 1);
} finally {
  await target?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await purgeTestSpace(space, pawServer()).catch((e) => {
    console.error("purge:", (e as Error).message);
    fails++;
  });
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

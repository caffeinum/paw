/**
 * END-TO-END `paw cron` against a REAL claude agent, fired by the REAL keeper entry (`paw global --space
 * <s>`, the argv the launchd plist runs), in an ISOLATED space (refuses anything else):
 *  1. spawn "worker" (haiku), wait for it idle; `paw cron add worker --in 1m "write PONG to <file>"`;
 *     after the minute, run `paw global --space <s>` (brings up a test-space `global` too) — its stderr
 *     shows the sweep firing, and the worker writes the file;
 *  2. `paw sleep worker --now`; schedule a second `--in 1m`; the next keeper run fires it, the DM reaches
 *     the stand-in, the agent wakes and writes the second file.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-cron-agent.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAgentSpawned, setFolderName } from "../src/addressing.ts";
import { ManagerControl } from "../src/control.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { pawServer } from "../src/server.ts";
import { isAsleep } from "../src/sleep-state.ts";
import { collectStatus } from "../src/status.ts";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT) {
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT");
}
process.env.PAW_RUNTIME ??= "pty";
process.env.PAW_MODEL ??= "haiku";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paw.ts");
const paw = (args: string[], timeout = 300_000) => {
  const r = spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: "utf8", timeout, cwd: tmpdir() });
  const out = `${r.stdout}${r.stderr}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "").trim();
  console.log(`  $ paw ${args.join(" ")} → ${r.status}\n${out.replace(/^/gm, "    ")}`);
  return { status: r.status, out };
};
const waitFor = async (pred: () => boolean | Promise<boolean>, ms: number, step = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await pred()) return true;
  return pred();
};
const fileSays = (f: string, word: string) => existsSync(f) && readFileSync(f, "utf8").includes(word);

const ctl = new ManagerControl(space, pawServer());
const rowOf = async (name: string) => (await collectStatus(space, ctl)).rows.find((r) => r.name === name);
try {
  await ensure({ needMesh: true, needManager: true, space });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pawcron-worker-")));
  const name = setFolderName(space, dir, "worker").name;
  await ensureAgentSpawned(ctl, { space, name, cwd: dir });
  ok("worker is idle on the mesh", await waitFor(async () => (await rowOf(name))?.mesh === "idle", 180_000, 3000), (await rowOf(name))?.mesh);

  // ── 1. a live idle agent, fired from the keeper entry ──────────────────────────────────────────
  const f1 = join(dir, "pong1.txt");
  ok("cron add worker --in 1m", paw(["cron", "add", "worker", "--in", "1m", `use your Bash tool to run: echo PONG > ${f1}`, "--space", space]).status === 0);
  await sleep(62_000);
  const k1 = paw(["global", "--space", space]);
  ok("the keeper entry (`paw global --space <s>`) fired it", /paw cron: fired \S+ → worker#/.test(k1.out));
  ok("the worker acted: PONG written", await waitFor(() => fileSays(f1, "PONG"), 180_000), f1);

  // ── 2. a sleeping agent: the fire wakes it ─────────────────────────────────────────────────────
  ok("worker idle again", await waitFor(async () => (await rowOf(name))?.mesh === "idle", 120_000, 3000));
  await sleep(5000);
  ok("paw sleep worker --now", paw(["sleep", "worker", "--now", "--space", space]).status === 0);
  ok("…it is asleep (record + no seat)", await waitFor(async () => isAsleep(space, name) && !(await rowOf(name))?.live, 60_000));
  const f2 = join(dir, "pong2.txt");
  ok("cron add worker --in 1m (while asleep)", paw(["cron", "add", "worker", "--in", "1m", `use your Bash tool to run: echo PONG2 > ${f2}`, "--space", space]).status === 0);
  await sleep(62_000);
  const k2 = paw(["global", "--space", space]);
  ok("the keeper fired it", /paw cron: fired \S+ → worker#/.test(k2.out));
  ok("the sleeping worker woke and acted: PONG2 written", await waitFor(() => fileSays(f2, "PONG2"), 300_000, 3000), f2);
  ok("…and is no longer asleep", !isAsleep(space, name));
  const log = join(process.env.PAW_HOME!, "spaces", space, "sleep.log");
  if (existsSync(log)) console.log(readFileSync(log, "utf8").trim().replace(/^/gm, "    sleep.log: "));
} finally {
  for (const n of ["worker", "global"]) await ctl.despawn(n).catch(() => {});
  await ctl.close();
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await purgeTestSpace(space, pawServer()).catch((e) => {
    console.error("purge:", (e as Error).message);
    fails++;
  });
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

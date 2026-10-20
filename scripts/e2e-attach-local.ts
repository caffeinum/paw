/**
 * e2e:attach-local — `paw attach <folder>` on a LOCAL OPEN mesh (the default paw space shape), isolated.
 *
 * A private `cotal up --open --no-manager` broker on a free port (registered in an isolated COTAL_HOME
 * registry, as paw's own `cotald up` registers the live space), PAW_SERVER pointed at it, then under a
 * real pty (node-pty): `paw attach <folder>` spawns a real claude (haiku) and attaches through cotal's
 * grant-based attach (open mesh ⇒ bare redemption, cotal #1205). Asserts cotal says "attached", the
 * claude TUI streams, Ctrl-] exits 0 with "detached", and the agent is still on the mesh afterwards.
 *
 *   COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-attach-local.ts
 *
 * cotal-ai must be installed OUTSIDE the repo (see scripts/e2e-remote.ts).
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:attach-local needs COTAL_BIN=<cotal-ai package>/dist/cotal.js");
const want = JSON.parse(readFileSync(join(REPO, "node_modules/@cotal-ai/cli/package.json"), "utf8")).version as string;
const have = JSON.parse(readFileSync(join(dirname(dirname(COTAL)), "package.json"), "utf8")) as { name: string; version: string };
if (have.name !== "cotal-ai" || have.version !== want) throw new Error(`COTAL_BIN is ${have.name}@${have.version}; the repo pins cotal ${want}`);

const S = `attachlocal-${process.pid}`;
const home = mkdtempSync("/tmp/pal-");
const work = realpathSync(mkdtempSync("/tmp/pal-work-"));
const root = join(work, "root");
const agentDir = join(work, "agent");
for (const d of [root, agentDir, join(work, "cotalhome"), join(work, "xdg")]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: agentDir });
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const server = `nats://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAW_HOME: home,
  PAW_SPACE: S,
  PAW_SERVER: server,
  PAW_RELEASE: "dev",
  PAW_MODEL: process.env.PAW_MODEL ?? "haiku",
  PAW_RUNTIME: "pty",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "PAW_COTAL_HUB"]) delete env[k];

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const paw = (args: string[]) => spawnSync(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env, cwd: REPO, encoding: "utf8", timeout: 180_000 });
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)/g, "");

try {
  const up = spawnSync(process.execPath, [COTAL, "up", "--detach", "--no-manager", "--open", "--space", S, "--server", server, "--store-dir", join(work, "store")], { env, cwd: root, encoding: "utf8" });
  ok("private OPEN broker up and registered", up.status === 0, `${up.stdout}${up.stderr}`.trim().split("\n").pop());

  const p = ptySpawn(process.execPath, [join(REPO, "bin/paw.ts"), "attach", agentDir], { name: "xterm-256color", cols: 120, rows: 40, cwd: REPO, env: env as Record<string, string> });
  let output = "";
  let code: number | undefined;
  p.onData((d) => (output += d));
  p.onExit((e) => (code = e.exitCode));
  for (let i = 0; i < 360 && code === undefined && !/attached to /.test(strip(output)); i++) await sleep(500);
  const attached = /attached to /.test(strip(output));
  ok("paw attach <folder> spawns the agent and cotal attaches (open mesh: bare redeem)", attached, attached ? "" : strip(output).trim().split("\n").slice(-4).join(" | "));
  const at = output.length;
  await sleep(6000);
  if (code === undefined) p.write(" ");
  await sleep(2000);
  const after = strip(output).slice(strip(output).search(/attached to /));
  ok("claude's TUI streams through", output.length > at || /bypass permissions|❯|for shortcuts/.test(after), `${output.length - at} bytes after attach`);
  ok("…and it is claude's own chrome", /bypass permissions|❯|for shortcuts/.test(after));
  if (code === undefined) p.write("\x1d");
  for (let i = 0; i < 30 && code === undefined; i++) await sleep(500);
  ok("Ctrl-] detaches cleanly", code === 0 && /detached from /.test(strip(output)), `exit ${code}`);
  if (code === undefined) p.kill();
  const who = paw(["who"]);
  ok("the agent is still on the mesh after the detach", who.status === 0 && /\bagent\b/.test(who.stdout), who.stdout.trim().replace(/\n/g, " | "));
} finally {
  console.log(`${paw(["down"]).stdout}`.trim());
  console.log(spawnSync(process.execPath, [COTAL, "down"], { env, cwd: root, encoding: "utf8" }).stdout.trim());
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
if (fails) {
  console.error(`\ne2e:attach-local — ${fails} failure(s)`);
  process.exit(1);
}
console.log("\ne2e:attach-local — all ok");

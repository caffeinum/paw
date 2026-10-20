/**
 * e2e:remote — a paw space on a REMOTE JWT + TLS broker, end to end, fully isolated.
 *
 * Stands up the "remote" exactly as the Fly box runs it: cotal 0.84 `cotal up --no-manager` with a
 * self-signed TLS cert, then `cotal mint --signer` into a separate root. Everything paw does goes
 * through the CLI, with `--space <remote>` while PAW_SPACE names a DIFFERENT (decoy) space and
 * PAW_SERVER points at a dead port — so any path that ignored --space, or dialled the local broker,
 * fails here instead of touching the operator's live mesh.
 *
 *   1. paw mesh add (refused for a world-readable signer, accepted at 0600);
 *   2. without the CA, ensure() fails loud naming TLS trust — and starts no broker;
 *   3. paw dm --space R <folder> spawns a real claude (haiku) there; it replies; paw inbox reads it;
 *   4. paw chat @agent --space R (piped stdin) binds "you"'s durable inbox, sends, and shows the reply;
 *   5. who / status see it; paw restart --space R revives it and a second DM is answered;
 *   6. paw down --space R + cotal down: nothing left naming either space.
 *
 *   COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-remote.ts
 *
 * COTAL_BIN must be the `cotal-ai` package at the version of the repo's @cotal-ai/cli (it runs the
 * broker's delivery daemon, which @cotal-ai/cli alone cannot start). Install it OUTSIDE the repo,
 * e.g. `npm i --prefix /tmp/cotal084 --ignore-scripts cotal-ai@0.84.0`.
 */
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:remote needs COTAL_BIN=<cotal-ai package>/dist/cotal.js (see the header)");
const want = JSON.parse(readFileSync(join(REPO, "node_modules/@cotal-ai/cli/package.json"), "utf8")).version as string;
const have = JSON.parse(readFileSync(join(dirname(dirname(COTAL)), "package.json"), "utf8")) as { name: string; version: string };
if (have.name !== "cotal-ai" || have.version !== want) throw new Error(`COTAL_BIN is ${have.name}@${have.version}; the repo pins cotal ${want}`);

const tag = `${process.pid}`;
const R = `remotetest-${tag}`; // the remote space
const DECOY = `remotedecoy-${tag}`; // PAW_SPACE: a local space nothing should touch
const home = mkdtempSync("/tmp/pr-"); // short: the hub socket path must fit sun_path
const work = realpathSync(mkdtempSync(join("/tmp", "pr-work-")));
const remoteRoot = join(work, "remote");
const localRoot = join(work, "local");
const agentDir = join(work, "agent");
for (const d of [remoteRoot, join(localRoot, ".cotal", "auth"), agentDir, join(work, "cotalhome"), join(work, "xdg")]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: agentDir });
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

// Isolation for every child: own PAW_HOME / COTAL_HOME / XDG config, a decoy current space, a dead local
// broker, the checkout's code, no connector-seed writes into the operator's ~/.config/cotal.
const base: NodeJS.ProcessEnv = {
  ...process.env,
  PAW_HOME: home,
  PAW_SPACE: DECOY,
  PAW_SERVER: "nats://127.0.0.1:9",
  PAW_RELEASE: "dev",
  PAW_MODEL: process.env.PAW_MODEL ?? "haiku",
  PAW_RUNTIME: "pty",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "PAW_COTAL_HUB", "NODE_EXTRA_CA_CERTS"]) delete base[k];
const withCa: NodeJS.ProcessEnv = { ...base, NODE_EXTRA_CA_CERTS: cert };

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO, timeout = 180_000): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { env, cwd, encoding: "utf8", timeout });
const paw = (args: string[], env = withCa) => run(process.execPath, [join(REPO, "bin/paw.ts"), ...args], env);
const cotal = (args: string[]) => run(process.execPath, [COTAL, ...args], withCa, remoteRoot);
const out = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "");
const procs = (needle: string) =>
  execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(needle) && !l.includes("e2e-remote"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function inboxHas(word: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (out(paw(["inbox", "--space", R, "--json"])).toLowerCase().includes(word)) return true;
    await sleep(3000);
  }
  return false;
}

/** The DM/DELIVER durables named for "you" (the persisted human nkey), read from the broker's own
 *  store dir (no cotal cred may LIST consumers) — proves chat retired what it provisioned. */
function humanDurables(): string[] {
  const id = (JSON.parse(readFileSync(join(home, "spaces", R, "human.nkey.json"), "utf8")) as { id: string }).id;
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (basename(dir) === "obs" && /^(DM|DLV)_/.test(basename(dirname(dir)))) {
        if (e.name.includes(id)) found.push(e.name);
      } else walk(join(dir, e.name));
    }
  };
  walk(join(work, "store"));
  return found;
}

/** Drive `paw chat @<agent> --space R` over piped stdin: send one line, wait for `want` in its output. */
async function chatRoundTrip(agent: string, line: string, want: string, ms: number): Promise<{ ok: boolean; clean: boolean; live: string[]; output: string }> {
  const child = spawn(process.execPath, [join(REPO, "bin/paw.ts"), "chat", `@${agent}`, "--space", R], { env: withCa, cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let exited = false;
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  child.on("exit", () => (exited = true));
  await sleep(8000); // connect + bind before typing
  if (!exited) child.stdin.write(`${line}\n`);
  const deadline = Date.now() + ms;
  while (!exited && Date.now() < deadline && !output.toLowerCase().includes(want)) await sleep(1000);
  const found = output.toLowerCase().includes(want);
  const live = exited ? [] : humanDurables();
  child.stdin.end(); // EOF = quit: chat retires the inbox footprint it provisioned
  for (let i = 0; i < 20 && !exited; i++) await sleep(500);
  const clean = exited;
  if (!exited) child.kill("SIGKILL");
  return { ok: found, clean, live, output };
}

try {
  // ── the "remote": cotal 0.84, JWT auth + TLS, broker only ────────────────────────────────────────
  const up = cotal(["up", "--detach", "--no-manager", "--space", R, "--server", server, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")]);
  ok("remote broker up (JWT + TLS, --no-manager, delivery daemon)", up.status === 0 && /delivery daemon/.test(out(up)), out(up).trim().split("\n").pop());
  const signer = join(localRoot, ".cotal", "auth", "auth.json");
  const mint = cotal(["mint", "--signer", "--out", signer]);
  ok("cotal mint --signer", mint.status === 0 && existsSync(signer));

  // ── 1. the record ────────────────────────────────────────────────────────────────────────────────
  chmodSync(signer, 0o644);
  const loose = paw(["mesh", "add", R, "--server", server, "--root", localRoot]);
  ok("mesh add refuses a world-readable signer", loose.status !== 0 && /chmod 600/.test(out(loose)));
  chmodSync(signer, 0o600);
  const add = paw(["mesh", "add", R, "--server", server, "--root", localRoot]);
  ok("mesh add records the remote space", add.status === 0, out(add).split("\n")[0]);
  ok("the signer never reaches the output", !out(add).includes("signingSeed") && !out(paw(["mesh", "--json"])).includes("signingSeed"));

  // ── 2. TLS trust is required, and paw never starts a broker for it ───────────────────────────────
  const natsBefore = procs("nats-server").length;
  const noCa = paw(["status", "--space", R], base);
  ok("without the CA, ensure() fails loud naming TLS trust", noCa.status !== 0 && /NODE_EXTRA_CA_CERTS/.test(out(noCa)), out(noCa).trim().split("\n")[0]);
  ok("…and no paw daemon started for it", procs(`--space ${R}`).filter((l) => !l.includes(COTAL)).length === 0);

  // ── 3. spawn through paw + DM ────────────────────────────────────────────────────────────────────
  const dm = paw(["dm", "--space", R, agentDir, "reply with just the word: pong"]);
  ok("paw dm --space R spawns the folder's agent and sends", dm.status === 0, out(dm).trim().split("\n").pop());
  ok("the agent's reply lands in paw inbox --space R", await inboxHas("pong", 150_000));
  ok("paw started no broker", procs("nats-server").length === natsBefore);
  const mgr = procs(`supervise --space ${R} --server ${server}`);
  ok("the manager dials the remote broker", mgr.length > 0);
  // The seat's cotal MCP takes its transport from COTAL_TLS alone; without it the seat dialled tls://
  // with `tls: false` (upgrading only because this broker asks). `ps -E` shows a process's env (macOS).
  const seatMcp = execFileSync("ps", ["-A", "-E", "-ww", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes("mcp.cjs") && l.includes(`COTAL_SPACE=${R}`));
  ok("the seat's cotal MCP requires TLS (COTAL_TLS=1)", seatMcp.length > 0 && seatMcp.every((l) => /\sCOTAL_TLS=1(\s|$)/.test(l)), `${seatMcp.length} seat MCP process(es)`);
  ok("nothing ran for the decoy space", procs(DECOY).length === 0 && !existsSync(join(home, "spaces", DECOY, "manager.log")));

  const name = "agent";
  // ── 4. paw chat: a CONSUMING "you" (binds its own durable inbox) on the authed mesh ──────────────
  const durablesBefore = humanDurables();
  const chat = await chatRoundTrip(name, "reply with only the word pong spelled backwards, nothing else", "gnop", 150_000);
  ok("paw chat --space R binds its inbox and shows the agent's reply", chat.ok, chat.ok ? "" : chat.output.trim().split("\n").slice(-6).join(" | "));
  const durablesAfter = humanDurables();
  ok(
    "…and quits on EOF, retiring the inbox durables it provisioned",
    chat.clean && !/left its inbox footprint/.test(chat.output) && chat.live.length >= 2 && durablesAfter.length === durablesBefore.length,
    `"you" durables before ${durablesBefore.length}, during ${chat.live.length}, after ${durablesAfter.length}${chat.output.match(/.*footprint.*/)?.[0] ?? ""}`,
  );

  // ── 5. who / status / restart ───────────────────────────────────────────────────────────────────
  const who = paw(["who", "--space", R]);
  ok("who --space R lists the agent and you", who.status === 0 && out(who).includes(name) && out(who).includes("you"), out(who).trim().split("\n")[0]);
  const st = paw(["status", "--space", R, "--json"]);
  let row: { name?: string; live?: boolean; mesh?: string } | undefined;
  let errors: string[] | undefined;
  try {
    const parsed = JSON.parse(st.stdout) as { rows: Array<{ name?: string; live?: boolean; mesh?: string }>; errors: string[] };
    row = parsed.rows.find((r) => r.name === name);
    errors = parsed.errors;
  } catch {
    /* reported below */
  }
  ok("status --space R shows it live", st.status === 0 && row?.live === true, `${row ? `mesh=${row.mesh}` : out(st).slice(0, 200)}`);
  // The presence probe dials with TLS required: it must still reach the broker (a refusal answer),
  // never "couldn't probe" (a dial that failed).
  const unreached = (errors ?? []).filter((e) => /couldn't probe the presence store/.test(e));
  ok("status's TLS-required presence probe reaches the broker", errors !== undefined && unreached.length === 0, unreached.join(" | "));
  const rs = paw(["restart", "--space", R]);
  ok("restart --space R bounces the manager", rs.status === 0, out(rs).trim().split("\n").pop());
  const dm2 = paw(["dm", "--space", R, name, "reply with just the word: again"]);
  ok("after the restart a DM is answered", dm2.status === 0 && (await inboxHas("again", 150_000)));
  const stop = paw(["stop", "--space", R, name]);
  ok("stop --space R stops it", stop.status === 0, out(stop).trim().split("\n").pop());
  const start = paw(["start", "--space", R]);
  ok("start --space R cold-starts the registered agent", start.status === 0 && out(start).includes(name), out(start).trim().split("\n").pop());
  const who2 = paw(["who", "--space", R]);
  ok("…and it is back on the remote mesh", out(who2).includes(name));
} finally {
  // ── 6. teardown ─────────────────────────────────────────────────────────────────────────────────
  const down = paw(["down", "--space", R]);
  console.log(out(down).trim());
  const cdown = cotal(["down"]);
  console.log(out(cdown).trim());
  ok("nothing left naming the remote space", procs(R).length === 0, procs(R).join(" | "));
  ok("nothing left naming the decoy space", procs(DECOY).length === 0);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
if (fails) {
  console.error(`\ne2e:remote — ${fails} failure(s)`);
  process.exit(1);
}
console.log("\ne2e:remote — all ok");

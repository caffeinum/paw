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
 *   4b. paw attach agent --space R under a real pty: cotal's grant is issued + redeemed with a
 *       session-caller cred minted from the signer, the TUI streams, a typed key reaches it, Ctrl-]
 *       detaches and the agent stays live — also `paw cotal attach --space R --creds <junk>` (the
 *       operator's exact failing shape), and from a SECOND root with its own manager instance on the
 *       space that does not host the agent (cotal pins the session to the hosting instance);
 *   5. who / status see it; paw restart --space R revives it and a second DM is answered;
 *   6. paw down --space R + cotal down: nothing left naming either space.
 *
 *   COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-remote.ts
 *
 * E2E_HUMAN=<name> adds `--as <name>` to `paw mesh add`: the mailbox presence must then appear under
 * that name (never "you") and the agent's reply — briefed to cotal_dm that name — must reach the inbox.
 *
 * COTAL_BIN must be the `cotal-ai` package at the version of the repo's @cotal-ai/cli (it runs the
 * broker's delivery daemon, which @cotal-ai/cli alone cannot start). Install it OUTSIDE the repo,
 * e.g. `npm i --prefix /tmp/cotal084 --ignore-scripts cotal-ai@0.84.0`.
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:remote needs COTAL_BIN=<cotal-ai package>/dist/cotal.js (see the header)");
const want = JSON.parse(readFileSync(join(REPO, "node_modules/@cotal-ai/cli/package.json"), "utf8")).version as string;
const have = JSON.parse(readFileSync(join(dirname(dirname(COTAL)), "package.json"), "utf8")) as { name: string; version: string };
if (have.name !== "cotal-ai" || have.version !== want) throw new Error(`COTAL_BIN is ${have.name}@${have.version}; the repo pins cotal ${want}`);

const HUMAN = process.env.E2E_HUMAN?.trim() || "you";
const tag = `${process.pid}`;
const R = `remotetest-${tag}`; // the remote space
const DECOY = `remotedecoy-${tag}`; // PAW_SPACE: a local space nothing should touch
const home = mkdtempSync("/tmp/pr-"); // short: the hub socket path must fit sun_path
const homeB = mkdtempSync("/tmp/prb-"); // a SECOND operator machine on the same remote space
const work = realpathSync(mkdtempSync(join("/tmp", "pr-work-")));
const remoteRoot = join(work, "remote");
const localRoot = join(work, "local");
const localRootB = join(work, "localb");
const agentDir = join(work, "agent");
for (const d of [remoteRoot, join(localRoot, ".cotal", "auth"), join(localRootB, ".cotal", "auth"), agentDir, join(work, "cotalhome"), join(work, "xdg")]) mkdirSync(d, { recursive: true });
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
const withCaB: NodeJS.ProcessEnv = { ...withCa, PAW_HOME: homeB };

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

/**
 * Drive an attach command under a REAL pty (node-pty): wait for the agent's TUI to stream through,
 * type one key, then press Ctrl-] (cotal's detach key) and wait for a clean exit.
 */
async function ptyAttach(args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<{ attached: boolean; streamed: number; tui: boolean; detached: boolean; code: number | undefined; output: string }> {
  const p = ptySpawn(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { name: "xterm-256color", cols: 120, rows: 40, cwd: REPO, env: env as Record<string, string> });
  let output = "";
  let code: number | undefined;
  p.onData((d) => (output += d));
  p.onExit((e) => (code = e.exitCode));
  const plain = () => output.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  const deadline = Date.now() + ms;
  while (code === undefined && Date.now() < deadline && !/attached to /.test(plain())) await sleep(500);
  const attached = /attached to /.test(plain());
  const at = output.length;
  // The seat repaints on attach; give the stream a few seconds, then poke it with one keystroke.
  for (let i = 0; i < 20 && code === undefined && output.length - at < 200; i++) await sleep(500);
  if (code === undefined) p.write(" ");
  await sleep(2000);
  const streamed = output.length - at;
  // The claude TUI's own chrome, seen AFTER cotal said "attached" — bytes from the seat, not from paw/cotal.
  const after = plain().slice(plain().search(/attached to /));
  const tui = /bypass permissions|❯|for shortcuts/.test(after);
  if (code === undefined) p.write("\x1d");
  for (let i = 0; i < 30 && code === undefined; i++) await sleep(500);
  const detached = code === 0 && /detached from /.test(plain());
  if (code === undefined) p.kill();
  return { attached, streamed, tui, detached, code, output: plain() };
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
  const add = paw(["mesh", "add", R, "--server", server, "--root", localRoot, ...(HUMAN !== "you" ? ["--as", HUMAN] : [])]);
  ok("mesh add records the remote space", add.status === 0, out(add).split("\n")[0]);
  ok(`mesh ls shows you as "${HUMAN}"`, out(paw(["mesh", "ls"])).includes(`as ${HUMAN}`));
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
  // ── 4a. paw attach: cotal's grant-based pty attach on the authed remote mesh ────────────────────
  const att = await ptyAttach(["attach", name, "--space", R], withCa, 60_000);
  const tail = (o: string) => o.trim().split("\n").slice(-4).join(" | ").slice(0, 400);
  ok("paw attach --space R: grant issued + redeemed (cotal says attached)", att.attached, att.attached ? "" : tail(att.output));
  ok("…the agent's terminal (claude's TUI) streams through", att.tui && att.streamed > 0, `${att.streamed} bytes after attach`);
  ok("…Ctrl-] detaches cleanly (exit 0)", att.detached, `exit ${att.code}${att.detached ? "" : ` — ${tail(att.output)}`}`);
  ok("…and the agent is still live after the detach", out(paw(["who", "--space", R])).includes(name));
  const passthru = await ptyAttach(["cotal", "attach", "--name", name, "--space", R, "--server", server, "--creds", join(work, "junk.creds")], withCa, 60_000);
  ok("paw cotal attach --space R --creds <junk> (the operator's shape) attaches", passthru.attached && passthru.tui && passthru.detached, passthru.attached ? `exit ${passthru.code}` : tail(passthru.output));
  ok("…and says it dropped --creds", /--creds dropped/.test(passthru.output));
  // A second operator machine: its own signer copy + its OWN manager instance on the same space (cotal
  // 0.84: per-instance leases, a manager in a second root coexists). Started raw, not through a second
  // paw home's ensure() — on one host that would pgrep-adopt A's manager and prove nothing. The agent
  // runs under A's manager; an attach from B's root must make cotal locate it there (a scatter `ps`
  // over both instances) and pin the session to A's instance.
  copyFileSync(join(localRoot, ".cotal", "auth", "auth.json"), join(localRootB, ".cotal", "auth", "auth.json"));
  chmodSync(join(localRootB, ".cotal", "auth", "auth.json"), 0o600);
  const addB = paw(["mesh", "add", R, "--server", server, "--root", localRootB, "--as", "operator-b"], withCaB);
  ok("second paw home records the same remote space", addB.status === 0, out(addB).split("\n")[0]);
  const mgrB = spawn(process.execPath, [join(REPO, "bin/cotald.ts"), "supervise", "--space", R, "--server", server], { env: withCaB, cwd: localRootB, stdio: ["ignore", "pipe", "pipe"] });
  let mgrBOut = "";
  mgrB.stdout.on("data", (d: Buffer) => (mgrBOut += d.toString()));
  mgrB.stderr.on("data", (d: Buffer) => (mgrBOut += d.toString()));
  for (let i = 0; i < 60 && !/manager up/.test(mgrBOut) && mgrB.exitCode === null; i++) await sleep(500);
  ok("a second manager instance (machine B's root) serves the same space", /manager up/.test(mgrBOut), mgrBOut.trim().split("\n").slice(-2).join(" | "));
  await sleep(3000); // let it register its service before the scatter
  const psB = paw(["cotal", "ps", "--space", R], { ...withCaB, PAW_SPACE: R });
  const headers = out(psB).replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => /^manager \S+ /.test(l));
  ok(
    "paw cotal ps --space R (from B's root) sees two manager instances, the agent on one",
    headers.length === 2 && headers.some((l) => /1 agent/.test(l)) && headers.some((l) => /no agents/.test(l)),
    headers.join(" | ") || out(psB).trim().split("\n").slice(-3).join(" | "),
  );
  // B's attach goes through `paw cotal attach` so no paw gate adopts/ensures anything for home B.
  const attB = await ptyAttach(["cotal", "attach", "--name", name, "--space", R], { ...withCaB, PAW_SPACE: R }, 90_000);
  ok("attach from machine B's root reaches the seat A's manager hosts", attB.attached && attB.tui && attB.detached, attB.attached ? `${attB.streamed} bytes, exit ${attB.code}` : tail(attB.output));
  mgrB.kill("SIGTERM");
  for (let i = 0; i < 20 && mgrB.exitCode === null; i++) await sleep(500);
  if (mgrB.exitCode === null) mgrB.kill("SIGKILL");
  ok("…and the agent is still live", out(paw(["who", "--space", R])).includes(name));

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
  const whoNames = out(who).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim().split(/[\s/]+/)[0]);
  ok(`who --space R lists the agent and the mailbox as "${HUMAN}"`, who.status === 0 && out(who).includes(name) && whoNames.includes(HUMAN), out(who).trim().split("\n")[0]);
  if (HUMAN !== "you") ok('…and nobody is "you" on the space', !whoNames.includes("you"), out(who).trim().replace(/\n/g, " | "));
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
  rmSync(homeB, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
if (fails) {
  console.error(`\ne2e:remote — ${fails} failure(s)`);
  process.exit(1);
}
console.log("\ne2e:remote — all ok");

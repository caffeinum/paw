/**
 * e2e:remote — a paw space on a REMOTE JWT + TLS broker, end to end, fully isolated.
 *
 * Stands up the "remote" exactly as the Fly box runs it: cotal 0.84 `cotal up --no-manager` with a
 * self-signed TLS cert, then `cotal auth signer` into a separate root. Everything paw does goes
 * through the CLI, with `--space <remote>` while PAW_SPACE names a DIFFERENT (decoy) space and
 * PAW_SERVER points at a dead port — so any path that ignored --space, or dialled the local broker,
 * fails here instead of touching the operator's live mesh.
 *
 *   1. paw mesh add (refused for a world-readable signer, accepted at 0600);
 *   2. without the CA, ensure() fails loud naming TLS trust — and starts no broker;
 *   3. paw dm --space R <folder> spawns a real claude (haiku) there; it replies; paw inbox reads it;
 *   4. paw chat @agent --space R (piped stdin) binds "you"'s durable inbox, sends, and shows the reply;
 *      a second `paw chat --all` mirrors its DM and #general post; /who, /ps, #channel, @name work; no
 *      permission error is printed; the tasks + logs views work under a pty; paw web serves cleanly;
 *   4b. paw attach agent --space R under a real pty: cotal's grant is issued + redeemed with a
 *       session-caller cred minted from the signer, the TUI streams, a typed key reaches it, Ctrl-]
 *       detaches and the agent stays live — also `paw cotal attach --space R --creds <junk>` (the
 *       operator's exact failing shape), and from a SECOND root with its own manager instance on the
 *       space that does not host the agent (cotal pins the session to the hosting instance);
 *   5. who / status see it; paw restart --space R revives it and a second DM is answered;
 *   6. status: INBOX lag is a real number for the local agent (paw's cached consumer-INFO-only cred);
 *   7. a SECOND machine (own PAW_HOME, root, signer copy → its own manager) spawns its agent: machine 1
 *      never lists it or claims its lag, and `paw sleep` across machines fails "hosted on another machine";
 *      machine 1's `paw chat @<it>` round-trips a DM with no permission line, and `!pwd` there says
 *      the agent is hosted on another machine;
 *   8. paw sleep agent --now: stand-in under its own nkey; a raw DM by name reaches the stand-in, wakes
 *      the agent, and is re-delivered (its reply lands in paw inbox);
 *   9. paw down --space R + cotal down: nothing left naming either space.
 *
 *   COTAL_BIN=<cotal-ai@0.100.0>/dist/cotal.js node scripts/e2e-remote.ts
 *
 * E2E_HUMAN=<name> adds `--as <name>` to `paw mesh add`: the mailbox presence must then appear under
 * that name (never "you") and the agent's reply — briefed to cotal_dm that name — must reach the inbox.
 *
 * COTAL_BIN must be the `cotal-ai` package at the version of the repo's @cotal-ai/cli (it runs the
 * broker's delivery daemon, which @cotal-ai/cli alone cannot start). Install it OUTSIDE the repo,
 * e.g. `npm i --prefix /tmp/cotal100 --ignore-scripts cotal-ai@0.100.0`.
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:remote needs COTAL_BIN=<cotal-ai package>/dist/cotal.js (see the header)");
const want = JSON.parse(readFileSync(join(REPO, "node_modules/@cotal-ai/cli/package.json"), "utf8")).version as string;
const have = JSON.parse(readFileSync(join(dirname(dirname(COTAL)), "package.json"), "utf8")) as { name: string; version: string };
if (have.name !== "cotal-ai" || have.version !== want) throw new Error(`COTAL_BIN is ${have.name}@${have.version}; the repo pins cotal ${want}`);

// Helper mode (re-exec'd under the CA env, since NODE_EXTRA_CA_CERTS is read at node startup): DM <name>
// as "you" through the roster WITHOUT paw's wake path — the way an agent's `cotal_dm` reaches a sleeping
// agent's stand-in. Prints {"to": <the id it resolved>}.
if (process.argv[2] === "--send-raw") {
  const [, , , space, name, text] = process.argv;
  const { CotalEndpoint } = await import("@cotal-ai/core");
  const { humanEndpointAuth } = await import("../src/addressing.ts");
  const { pawServer } = await import("../src/server.ts");
  const { humanPeer } = await import("../src/names.ts");
  const ep = new CotalEndpoint({ space: space!, servers: pawServer(space), ...(await humanEndpointAuth(space!, "operator")), card: { name: humanPeer(space!), kind: "endpoint" }, registerPresence: false, consume: false, watchPresence: true });
  ep.on("error", () => {});
  await ep.start();
  let to: string | undefined;
  for (let i = 0; i < 40 && !to; i++) {
    to = ep.getRoster().find((p) => p.card.name === name && p.status !== "offline")?.card.id;
    if (!to) await new Promise((r) => setTimeout(r, 500));
  }
  if (!to) throw new Error(`no live roster entry named ${name}`);
  await ep.unicast(to, text!);
  await ep.stop();
  console.log(JSON.stringify({ to }));
  process.exit(0);
}

// Helper mode: chat's tasks-view seed (src/chat-own.ts) — "you"'s own conversation through paw's narrow
// `chat-history` cred. Prints {"n": <entries>, "texts": [...]}.
if (process.argv[2] === "--read-own") {
  const [, , , space] = process.argv;
  const { CotalEndpoint } = await import("@cotal-ai/core");
  const { humanEndpointAuth } = await import("../src/addressing.ts");
  const { pawServer } = await import("../src/server.ts");
  const { humanPeer } = await import("../src/names.ts");
  const { readOwnConversation } = await import("../src/chat-own.ts");
  const ep = new CotalEndpoint({ space: space!, servers: pawServer(space), ...(await humanEndpointAuth(space!, "operator")), card: { name: humanPeer(space!), kind: "endpoint" }, registerPresence: false, consume: false, watchPresence: false });
  ep.on("error", () => {});
  await ep.start();
  const conv = await readOwnConversation(ep, space!, pawServer(space));
  await ep.stop();
  console.log(JSON.stringify({ n: conv.length, texts: conv.map((e) => e.text) }));
  process.exit(0);
}

// Helper modes for "machine 2" (run with ITS PAW_HOME). Both machines share this host in the test, and
// paw recognises its daemons by command signature (space-exact pgrep), so a second paw CLI on the same
// space would adopt — or `paw down` would kill — machine 1's manager. Machine 2 therefore drives paw's
// library directly against a manager of its own, started with a different argument order. On two real
// machines none of this is needed: each has its own process table.
if (process.argv[2] === "--m2") {
  const [, , , op, space, ...rest] = process.argv;
  const { pawServer } = await import("../src/server.ts");
  const server = pawServer(space);
  if (op === "manager") {
    const { openSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const { cotaldViaNode, daemonEnv } = await import("../src/lifecycle.ts");
    const { pawCotalRoot } = await import("../src/cotal-root.ts");
    const [exec, args] = cotaldViaNode(["supervise", "--server", server, "--space", space!]);
    const fd = openSync(rest[0]!, "a");
    const child = spawn(exec, args, { detached: true, stdio: ["ignore", fd, fd], env: daemonEnv(), cwd: pawCotalRoot(space) });
    child.unref();
    console.log(JSON.stringify({ pid: child.pid }));
    process.exit(0);
  }
  const { withManagerControl } = await import("../src/control.ts");
  if (op === "spawn") {
    const { ensureAgentSpawned, setFolderName } = await import("../src/addressing.ts");
    const [dir, want] = rest;
    const name = setFolderName(space!, dir!, want!).name;
    let r: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        r = await withManagerControl(space!, server, (ctl) => ensureAgentSpawned(ctl, { space: space!, name, cwd: dir! }));
        break;
      } catch (e) {
        if (i === 19) throw e;
        await new Promise((res) => setTimeout(res, 3000)); // its manager may still be registering
      }
    }
    console.log(JSON.stringify({ name, r }));
    process.exit(0);
  }
  if (op === "status") {
    const { collectStatus } = await import("../src/status.ts");
    console.log(JSON.stringify(await collectStatus(space!, undefined, { git: false })));
    process.exit(0);
  }
  if (op === "refuse") {
    const { readManagerPs } = await import("../src/status.ts");
    const { assertNotHostedElsewhere } = await import("../src/sleep.ts");
    const name = rest[0]!;
    try {
      await withManagerControl(space!, server, async (ctl) => assertNotHostedElsewhere(space!, name, (await readManagerPs(ctl)).get(name)));
      console.log(JSON.stringify({ refused: false }));
    } catch (e) {
      console.log(JSON.stringify({ refused: true, message: (e as Error).message }));
    }
    process.exit(0);
  }
  if (op === "despawn") {
    const r = await withManagerControl(space!, server, (ctl) => ctl.despawn(rest[0]!));
    console.log(JSON.stringify(r));
    process.exit(0);
  }
  throw new Error(`unknown --m2 op ${op}`);
}

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
/** nats-servers THIS run could have started: their config lies under its temp dirs (the remote broker
 *  under `work`, anything paw would wrongly start under a test PAW_HOME's spaces dir). A concurrent
 *  e2e's brokers (or the live fleet's) on this host are not ours to count. */
const runDirs = [home, homeB, work].flatMap((d) => [d, realpathSync(d)]).map((d) => `${d}/`);
const ourBrokers = () =>
  procs("nats-server").filter((l) => {
    const conf = /\s(?:-c|--config)\s+(\S+)/.exec(l)?.[1];
    return !!conf && runDirs.some((d) => conf.startsWith(d));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function inboxHas(word: string, ms: number, env = withCa): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (out(paw(["inbox", "--space", R, "--json"], env)).toLowerCase().includes(word)) return true;
    await sleep(3000);
  }
  return false;
}
type Row = { name?: string; live?: boolean; mesh?: string; inbox?: { kind: string; queued?: number; unread?: number } };
function statusJson(env = withCa): { rows: Row[]; errors: string[]; raw: string } {
  const r = paw(["status", "--space", R, "--json"], env);
  try {
    const parsed = JSON.parse(r.stdout) as { rows: Row[]; errors: string[] };
    return { ...parsed, raw: "" };
  } catch {
    return { rows: [], errors: [], raw: out(r).slice(0, 400) };
  }
}
/** Poll status until `name`'s inbox reads as a measured lag (a real number), or give up. */
async function lagOf(name: string, env = withCa, ms = 60_000): Promise<{ row?: Row; errors: string[]; raw: string }> {
  const deadline = Date.now() + ms;
  let last: { row?: Row; errors: string[]; raw: string } = { errors: [], raw: "" };
  while (Date.now() < deadline) {
    const s = statusJson(env);
    last = { row: s.rows.find((r) => r.name === name), errors: s.errors, raw: s.raw };
    if (last.row?.inbox?.kind === "lag") return last;
    await sleep(3000);
  }
  return last;
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
  // cotal ≤0.84 printed "detached from <name>"; 0.100 a "Detached" report naming the agent.
  const detached = code === 0 && /detached from |Detached\s*$/m.test(plain());
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

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "");
/** Lines that mean a subscription or publish was refused by the broker's ACLs. */
const DENIED = /Permissions Violation|permission denied/i;

/** A `paw chat <args…> --space R` over piped stdin: type lines, wait for output, quit on EOF. */
function startChat(args: string[]) {
  const child = spawn(process.execPath, [join(REPO, "bin/paw.ts"), "chat", ...args, "--space", R], { env: withCa, cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  const s = { output: "", exited: false };
  child.stdout.on("data", (d: Buffer) => (s.output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (s.output += d.toString()));
  child.on("exit", () => (s.exited = true));
  const until = async (want: RegExp, ms: number, from = 0): Promise<{ ok: boolean; after: string }> => {
    const deadline = Date.now() + ms;
    while (!s.exited && Date.now() < deadline && !want.test(plain(s.output.slice(from)))) await sleep(500);
    const after = plain(s.output.slice(from));
    return { ok: want.test(after), after };
  };
  return {
    output: () => plain(s.output),
    until,
    /** Type `line`; resolve with the output that followed it once `want` shows up there (or time runs out). */
    say: (line: string, want: RegExp, ms: number) => {
      const from = s.output.length;
      if (!s.exited) child.stdin.write(`${line}\n`);
      return until(want, ms, from);
    },
    /** EOF = quit: chat retires the inbox footprint it provisioned. True when it exited by itself. */
    quit: async (): Promise<boolean> => {
      child.stdin.end();
      for (let i = 0; i < 20 && !s.exited; i++) await sleep(500);
      const clean = s.exited;
      if (!s.exited) child.kill("SIGKILL");
      return clean;
    },
  };
}
const tail = (s: string, n = 6) => s.trim().split("\n").slice(-n).join(" | ");

try {
  // ── the "remote": JWT auth + TLS, broker only ────────────────────────────────────────
  const up = cotal(["up", "--detach", "--no-manager", "--space", R, "--server", server, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")]);
  ok("remote broker up (JWT + TLS, --no-manager, delivery daemon)", up.status === 0 && /delivery daemon/.test(out(up)), out(up).trim().split("\n").pop());
  const signer = join(localRoot, ".cotal", "auth", "auth.json");
  // cotal 0.100 moved the signer export from `mint --signer` to `auth signer`, and refuses an `--out`
  // inside any `.cotal/` (LIFECYCLE_BLOCKED) — export beside, then copy in, as an operator does.
  const exported = join(work, "signer.json");
  const mint = cotal(["auth", "signer", "--out", exported]);
  ok("cotal auth signer", mint.status === 0 && existsSync(exported), out(mint).trim().split("\n").pop());
  mkdirSync(dirname(signer), { recursive: true });
  copyFileSync(exported, signer);

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
  const natsBefore = ourBrokers().length;
  const noCa = paw(["status", "--space", R], base);
  ok("without the CA, ensure() fails loud naming TLS trust", noCa.status !== 0 && /NODE_EXTRA_CA_CERTS/.test(out(noCa)), out(noCa).trim().split("\n")[0]);
  ok("…and no paw daemon started for it", procs(`--space ${R}`).filter((l) => !l.includes(COTAL)).length === 0);

  // ── 3. spawn through paw + DM ────────────────────────────────────────────────────────────────────
  const dm = paw(["dm", "--space", R, agentDir, "reply with just the word: pong"]);
  ok("paw dm --space R spawns the folder's agent and sends", dm.status === 0, out(dm).trim().split("\n").pop());
  ok("the agent's reply lands in paw inbox --space R", await inboxHas("pong", 150_000));
  // exactly the remote broker (`cotal up` above, under `work`) — before and after
  ok("paw started no broker", natsBefore === 1 && ourBrokers().length === 1, ourBrokers().join(" | "));
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
  // One section per manager: cotal ≤0.84 put the count on the `manager <id>` line, 0.100 on the line under it.
  const psLines = out(psB).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const headers = psLines.flatMap((l, i) => (/^manager \S+/.test(l) ? [`${l.trim()} ${psLines.slice(i + 1).find((n) => n.trim())?.trim() ?? ""}`] : []));
  ok(
    "paw cotal ps --space R (from B's root) sees two manager instances, the agent on one",
    headers.length === 2 && headers.some((l) => /1 agent/.test(l)) && headers.some((l) => /no agents/.test(l)),
    headers.join(" | ") || out(psB).trim().split("\n").slice(-3).join(" | "),
  );
  // B's `paw cotal ps`/`attach` still run ensure() for home B: it pgrep-adopts the managers, but the
  // mailbox is pid-file based, so home B starts its OWN "operator-b" mailbox (+ sleep host) — what a
  // real machine B would do. It is stopped below with B's manager, so nothing of B outlives this step.
  const attB = await ptyAttach(["cotal", "attach", "--name", name, "--space", R], { ...withCaB, PAW_SPACE: R }, 90_000);
  ok("attach from machine B's root reaches the seat A's manager hosts", attB.attached && attB.tui && attB.detached, attB.attached ? `${attB.streamed} bytes, exit ${attB.code}` : tail(attB.output));
  mgrB.kill("SIGTERM");
  for (let i = 0; i < 20 && mgrB.exitCode === null; i++) await sleep(500);
  if (mgrB.exitCode === null) mgrB.kill("SIGKILL");
  const mbPidB = join(homeB, "spaces", R, "mailbox.pid");
  if (existsSync(mbPidB)) {
    const pid = Number(readFileSync(mbPidB, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 20 && procs(`paw.ts mailbox --space ${R}`).some((l) => l.trim().startsWith(`${pid} `)); i++) await sleep(250);
  }
  ok("…machine B's mailbox is gone, machine A's is still up", procs(`paw.ts mailbox --space ${R}`).length === 1, procs(`paw.ts mailbox --space ${R}`).join(" | "));
  ok("…and the agent is still live", out(paw(["who", "--space", R])).includes(name));

  // ── 4. paw chat: a CONSUMING "you" (binds its own durable inbox) on the authed mesh ──────────────
  // Two sessions: the second (`--all`) only watches, so the cross-session echo is proven on both of
  // its narrowed taps (own DMs via the chat-echo cred, own channel posts via the agent cred).
  const durablesBefore = humanDurables();
  const watcher = startChat(["--all"]);
  await sleep(8000); // connect + bind
  const chat = startChat([`@${name}`]);
  await sleep(8000);
  const live = humanDurables();
  const reply = await chat.say("reply with only the word pong spelled backwards, nothing else", /gnop/i, 150_000);
  ok("paw chat --space R binds its inbox and shows the agent's reply", reply.ok, reply.ok ? "" : tail(chat.output()));
  const dmEcho = await watcher.until(/↗ you → .*\(other session\):[\s\S]*pong spelled backwards/, 20_000);
  ok("…another paw chat session mirrors that DM (↗ other session) — the chat-echo tap", dmEcho.ok, dmEcho.ok ? "" : tail(watcher.output()));
  const whoOut = await chat.say("/who", new RegExp(`Roster:[\\s\\S]*${name}`), 15_000);
  ok("chat /who lists the agent", whoOut.ok, whoOut.ok ? "" : tail(whoOut.after));
  const psOut = await chat.say("/ps", new RegExp(`\\b${name}\\s+\\S+ · \\S+`), 30_000);
  ok("chat /ps lists the agent from the manager", psOut.ok && !/\/ps failed/.test(psOut.after), tail(psOut.after, 3));
  const chanTag = `chan${process.pid}x${Date.now() % 100000}`;
  // A post prints no receipt of its own; give an error the time to surface, then require none.
  const chanOut = await chat.say(`#general ${chanTag}`, /^\s*!|failed/m, 5_000);
  ok("chat #general <msg> broadcasts without error", !chanOut.ok, tail(chanOut.after, 3));
  const chanEcho = await watcher.until(new RegExp(`#general.*\\(other session\\):[\\s\\S]*${chanTag}`), 20_000);
  ok("…the other session mirrors the channel post (own-post tap on the agent cred)", chanEcho.ok, chanEcho.ok ? "" : tail(watcher.output()));
  let inHistory = false;
  for (let i = 0; i < 10 && !inHistory; i++) {
    inHistory = out(paw(["history", "general", "--space", R])).includes(chanTag);
    if (!inHistory) await sleep(1500);
  }
  ok("…and it is on the broker's #general (paw history general --space R)", inHistory);
  const sw = await chat.say(`@${name} reply with only the word ping spelled backwards, nothing else`, /gnip/i, 150_000);
  ok("chat @name <msg> (re)targets the agent and its reply appears", sw.ok, sw.ok ? "" : tail(sw.after));
  const chatClean = await chat.quit();
  const watcherClean = await watcher.quit();
  const durablesAfter = humanDurables();
  const both = `${chat.output()}\n${watcher.output()}`;
  ok(
    "…both quit on EOF, retiring the inbox durables they provisioned",
    chatClean && watcherClean && !/left its inbox footprint/.test(both) && live.length >= 4 && durablesAfter.length === durablesBefore.length,
    `"you" durables before ${durablesBefore.length}, during ${live.length}, after ${durablesAfter.length}${both.match(/.*footprint.*/)?.[0] ?? ""}`,
  );
  const denied = both.split("\n").filter((l) => DENIED.test(l));
  ok("no permission error printed by either chat session", denied.length === 0, denied.slice(0, 3).join(" | "));

  // The tasks view's last-exchange seed reads "you"'s own conversation with the one-shot history cred.
  const own = run(process.execPath, [fileURLToPath(import.meta.url), "--read-own", R], withCa);
  let ownConv: { n: number; texts: string[] } | undefined;
  try {
    ownConv = JSON.parse(own.stdout.trim().split("\n").pop() ?? "") as { n: number; texts: string[] };
  } catch {
    /* reported below */
  }
  ok(
    'chat\'s tasks-view seed reads "you"\'s conversation (both directions) on the remote space',
    !!ownConv && ownConv.texts.some((t) => /gnop/i.test(t)) && ownConv.texts.some((t) => /pong spelled backwards/.test(t)),
    ownConv ? `${ownConv.n} entries` : out(own).slice(0, 300),
  );

  // The tasks + logs views under a real pty (←/→ only work on a tty).
  {
    const { spawn: ptySpawn } = await import("@lydell/node-pty");
    const p = ptySpawn(process.execPath, [join(REPO, "bin/paw.ts"), "chat", `@${name}`, "--space", R], { name: "xterm-256color", cols: 120, rows: 40, cwd: REPO, env: withCa as Record<string, string> });
    let buf = "";
    let exited = false;
    p.onData((d) => (buf += d));
    p.onExit(() => (exited = true));
    await sleep(10_000);
    const before = buf.length;
    p.write("\x1b[C"); // → tasks
    await sleep(8000);
    const tasksView = plain(buf.slice(before));
    p.write("\x1b[D"); // ← chat
    await sleep(1000);
    const logsAt = buf.length;
    p.write("\x1b[D"); // ← logs
    await sleep(6000);
    const logsView = plain(buf.slice(logsAt));
    p.write("\x1b[C");
    await sleep(500);
    p.write("/quit\r");
    for (let i = 0; i < 20 && !exited; i++) await sleep(500);
    if (!exited) p.kill();
    ok("chat tasks view (pty) seeds the last exchange with no error", !DENIED.test(tasksView) && !/couldn't read the conversation history/.test(tasksView) && /gnip|gnop/i.test(tasksView), tail(tasksView, 4));
    ok("chat logs view (pty) shows the agent's transcript with no error", !DENIED.test(logsView) && !/no logs for/.test(logsView) && /gnip|gnop|pong|ping/i.test(logsView), tail(logsView, 4));
    ok("…and the pty session quits cleanly", exited);
  }

  // paw web: its live tap must not ask for the space wildcard either.
  {
    const webPort = await new Promise<number>((r) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const pt = (srv.address() as { port: number }).port;
        srv.close(() => r(pt));
      });
    });
    const web = spawn(process.execPath, [join(REPO, "bin/paw.ts"), "web", "--space", R, "--port", String(webPort), "--no-open"], { env: withCa, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let webOut = "";
    web.stdout.on("data", (d: Buffer) => (webOut += d.toString()));
    web.stderr.on("data", (d: Buffer) => (webOut += d.toString()));
    let served = false;
    for (let i = 0; i < 60 && !served; i++) {
      await sleep(500);
      served = await fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.ok, () => false);
    }
    const dm3 = paw(["dm", "--space", R, name, "reply with just the word: webcheck"]);
    await sleep(15_000);
    web.kill("SIGTERM");
    await sleep(1000);
    const webDenied = plain(webOut).split("\n").filter((l) => DENIED.test(l));
    ok("paw web --space R serves with no permission error from its live tap", served && dm3.status === 0 && webDenied.length === 0, webDenied.slice(0, 3).join(" | ") || (served ? "" : tail(plain(webOut))));
  }

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

  // ── 5. INBOX lag on the remote space (this machine's agent) ─────────────────────────────────────
  const lag1 = await lagOf(name);
  ok(
    "status --space R: INBOX lag is a real number for the local agent",
    lag1.row?.inbox?.kind === "lag" && typeof lag1.row.inbox.queued === "number" && !lag1.errors.some((e) => /inbox lag/.test(e)),
    `${JSON.stringify(lag1.row?.inbox)} ${lag1.errors.filter((e) => /inbox/.test(e)).join(" | ")}${lag1.raw}`,
  );
  const lagCreds = join(home, "spaces", R, "creds", "inbox-lag.creds");
  ok("…read with paw's cached consumer-INFO-only cred (0600)", existsSync(lagCreds) && (statSync(lagCreds).mode & 0o777) === 0o600);

  // ── 6. a SECOND machine on the same remote space: its own PAW_HOME, root and signer copy ────────
  // (driven through paw's library — see the --m2 helper for why not the CLI on a shared host)
  const home2 = mkdtempSync("/tmp/pr2-");
  const root2 = join(work, "local2");
  const agentDir2 = join(work, "other");
  for (const d of [join(root2, ".cotal", "auth"), agentDir2, join(work, "cotalhome2"), join(work, "xdg2")]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: agentDir2 });
  copyFileSync(join(localRoot, ".cotal", "auth", "auth.json"), join(root2, ".cotal", "auth", "auth.json"));
  chmodSync(join(root2, ".cotal", "auth", "auth.json"), 0o600);
  const env2: NodeJS.ProcessEnv = { ...withCa, PAW_HOME: home2, COTAL_HOME: join(work, "cotalhome2"), XDG_CONFIG_HOME: join(work, "xdg2") };
  const m2 = (args: string[], timeout = 300_000) => run(process.execPath, [fileURLToPath(import.meta.url), "--m2", args[0]!, R, ...args.slice(1)], env2, REPO, timeout);
  const m2json = <T>(r: SpawnSyncReturns<string>): T | undefined => {
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as T;
    } catch {
      return undefined;
    }
  };
  const other = "other";
  let m2pid: number | undefined;
  try {
    ok("machine 2: mesh add (its own root + signer copy)", paw(["mesh", "add", R, "--server", server, "--root", root2], env2).status === 0);
    m2pid = m2json<{ pid: number }>(m2(["manager", join(work, "manager2.log")]))?.pid;
    ok("machine 2: its own manager is up", typeof m2pid === "number");
    const sp = m2(["spawn", agentDir2, other]);
    ok("machine 2: its manager spawns ITS agent", sp.status === 0 && m2json<{ name: string }>(sp)?.name === other, out(sp).trim().split("\n").slice(-2).join(" | "));
    ok("two managers serve the space side by side", procs("supervise").filter((l) => l.includes(`--space ${R}`)).length >= 2);
    let st2: { rows: Row[]; errors: string[] } | undefined;
    for (let i = 0; i < 20; i++) {
      st2 = m2json<{ rows: Row[]; errors: string[] }>(m2(["status"]));
      if (st2?.rows.find((r) => r.name === other)?.inbox?.kind === "lag") break;
      await sleep(3000);
    }
    ok("machine 2 reads ITS agent's lag", st2?.rows.find((r) => r.name === other)?.inbox?.kind === "lag", JSON.stringify(st2?.rows.find((r) => r.name === other)?.inbox));
    ok("…and never claims machine 1's agent", !st2?.rows.some((r) => r.name === name));
    const st1 = statusJson();
    const foreignRow = st1.rows.find((r) => r.name === other);
    ok("machine 1's status never claims machine 2's agent or its lag", !foreignRow && !st1.errors.some((e) => e.includes(`"${other}"`)), JSON.stringify(foreignRow));
    ok("…and machine 1's own agent still reads a real lag", st1.rows.find((r) => r.name === name)?.inbox?.kind === "lag");
    const who1 = paw(["who", "--space", R]);
    ok("machine 2's agent is live on the shared mesh (machine 1 sees it on the roster)", out(who1).includes(other), out(who1).trim().split("\n")[0]);
    // The operator's `paw chat @evals --space team2027` (evals hosted by another machine's manager):
    // no permission line, the DM round-trips, and `!pwd` says where the agent lives instead of
    // "no registered folder".
    const far = startChat([`@${other}`]);
    await sleep(8000);
    const farReply = await far.say("reply with only the word pong spelled backwards, nothing else", /gnop/i, 150_000);
    ok("machine 1: paw chat @<machine 2's agent> --space R — the DM round-trips", farReply.ok, farReply.ok ? "" : tail(far.output()));
    const farBang = await far.say("!pwd", /!cmd runs only|no registered folder|^\s*!/m, 15_000);
    // Both "machines" share this host here, and the seat's card reports `meta.host` = this hostname, so
    // the honest line is the same-host form; on two real machines it reads "hosted on another machine (<host>)".
    ok("…`!pwd` says the agent is not hosted here (never \"no registered folder\")", /"other" (is hosted on another machine|runs on this host but not under this paw).*!cmd runs only for agents hosted here/.test(farBang.after) && !/no registered folder/.test(farBang.after), tail(farBang.after, 3));
    const farClean = await far.quit();
    const farDenied = far.output().split("\n").filter((l) => DENIED.test(l));
    ok("…no permission error printed, and it quits cleanly", farDenied.length === 0 && farClean, farDenied.slice(0, 3).join(" | "));
    const sleepForeign = paw(["sleep", other, "--now", "--space", R]);
    ok("machine 1: paw sleep <machine 2's agent> fails loud — hosted on another machine", sleepForeign.status !== 0 && /"other" is hosted on another machine/.test(out(sleepForeign)), out(sleepForeign).trim().split("\n").slice(-1)[0]);
    const sleepForceForeign = paw(["sleep", other, "--now", "--force", "--space", R]);
    ok("…even with --force", sleepForceForeign.status !== 0 && /hosted on another machine/.test(out(sleepForceForeign)));
    const optIn = paw(["sleep", other, "--after", "60m", "--space", R]);
    ok("…and opting it in to hibernation is refused the same way", optIn.status !== 0 && /hosted on another machine/.test(out(optIn)));
    ok("…nothing of it was recorded, stood in for or minted here", !existsSync(join(home, "spaces", R, "sleep", `${other}.json`)) && !existsSync(join(home, "spaces", R, "sleep", `${other}.standin.nkey`)));
    const back = m2json<{ refused: boolean; message?: string }>(m2(["refuse", name]));
    ok("machine 2: sleeping machine 1's agent is refused the same way", back?.refused === true && /"agent" is hosted on another machine/.test(back.message ?? ""), back?.message);
    ok("machine 1's agent is still live", statusJson().rows.find((r) => r.name === name)?.live === true);
  } finally {
    const d = m2json<{ ok: boolean }>(m2(["despawn", other]));
    ok("machine 2: despawns its agent through ITS pinned rail", d?.ok === true);
    if (m2pid) {
      try {
        process.kill(m2pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    rmSync(home2, { recursive: true, force: true });
  }
  await sleep(3000);
  ok("…machine 1's agent survived machine 2 going away", (await lagOf(name)).row?.live === true);


  // ── 7. paw sleep on the remote space: sleep, stand-in, a DM to the stand-in wakes it, delivered ─
  let slept: SpawnSyncReturns<string> | undefined;
  for (let i = 0; i < 12; i++) {
    slept = paw(["sleep", name, "--now", "--space", R]);
    if (slept.status === 0) break;
    console.log(`  (not yet: ${out(slept).trim().split("\n").pop()})`);
    await sleep(10_000);
  }
  ok("paw sleep <agent> --now --space R puts it to sleep (the gate read its inbox lag)", slept?.status === 0, out(slept!).trim().split("\n").pop());
  const sleepDir = join(home, "spaces", R, "sleep");
  let beacon = false;
  for (let i = 0; i < 30 && !beacon; i++) {
    beacon = existsSync(join(sleepDir, `${name}.beacon`));
    if (!beacon) await sleep(1000);
  }
  const mbLog = join(home, "spaces", R, "mailbox.log");
  ok("the mailbox's sleep host raised the stand-in", beacon, beacon ? "" : (existsSync(mbLog) ? readFileSync(mbLog, "utf8") : "").split("\n").filter((l) => /sleep/i.test(l)).slice(-6).join(" | "));
  const rec = existsSync(join(sleepDir, `${name}.json`)) ? (JSON.parse(readFileSync(join(sleepDir, `${name}.json`), "utf8")) as { instanceId?: string }) : undefined;
  ok("the sleep record pins this machine's manager instance", typeof rec?.instanceId === "string" && rec.instanceId.length > 0);
  const standInFile = join(sleepDir, `${name}.standin.nkey`);
  const standIn = (existsSync(standInFile) ? JSON.parse(readFileSync(standInFile, "utf8")) : { id: "<none>" }) as { id: string };
  ok("the stand-in nkey is its own, 0600", standIn.id.startsWith("U") && (statSync(join(sleepDir, `${name}.standin.nkey`)).mode & 0o777) === 0o600);
  await sleep(3000);
  ok("status reads it asleep", statusJson().rows.find((r) => r.name === name)?.mesh === "asleep");
  const raw = run(process.execPath, [fileURLToPath(import.meta.url), "--send-raw", R, name, "you were asleep. reply with just the word: awake"], withCa);
  let to = "";
  try {
    to = (JSON.parse(raw.stdout.trim().split("\n").pop() ?? "{}") as { to?: string }).to ?? "";
  } catch {
    /* reported below */
  }
  ok("a DM by name resolves to the stand-in (not the agent's old seat)", to.endsWith(standIn.id), `${to} ${out(raw).slice(0, 300)}`);
  ok("the DM wakes it and is delivered — its reply lands in paw inbox", await inboxHas("awake", 180_000));
  // The reply can land BEFORE the host finishes: it answers the FIRST forward pass, while the host
  // still runs the straggler pass (STRAGGLER_MS + a fresh watch connection) and only then clears the
  // record and logs the wake. Measured 2026-10-20: forward 05:53:37, reply 05:53:39, "woke" logged
  // 05:53:42 — a ~3s window (longer on a loaded host) in which reading once fails a correct wake.
  const sleepLogFile = join(home, "spaces", R, "sleep.log");
  const readSleepLog = () => (existsSync(sleepLogFile) ? readFileSync(sleepLogFile, "utf8") : "");
  const woke = new RegExp(`woke agent — DM from ${HUMAN}; re-delivered [1-9]`);
  const cleared = () => !existsSync(join(sleepDir, `${name}.json`)) && !existsSync(join(sleepDir, `${name}.waking`)) && !existsSync(join(sleepDir, `${name}.beacon`));
  for (let i = 0; i < 60 && !(woke.test(readSleepLog()) && cleared()); i++) await sleep(1000);
  const log = readSleepLog();
  ok("sleep.log: woke it and re-delivered the DM", woke.test(log), log.trim().split("\n").slice(-3).join(" | "));
  ok("record and stand-in cleared", cleared());
  const lag3 = await lagOf(name);
  ok("after the wake its lag reads again (the new incarnation's durable)", lag3.row?.inbox?.kind === "lag", JSON.stringify(lag3.row?.inbox));
} finally {
  // ── 6. teardown ─────────────────────────────────────────────────────────────────────────────────
  const down = paw(["down", "--space", R]);
  console.log(out(down).trim());
  const cdown = cotal(["down"]);
  console.log(out(cdown).trim());
  ok("nothing left naming the remote space", procs(R).length === 0, procs(R).join(" | "));
  ok("nothing left naming the decoy space", procs(DECOY).length === 0);
  if (process.env.E2E_KEEP) console.log(`E2E_KEEP: kept ${home} ${homeB} ${work}`);
  else {
    rmSync(home, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
if (fails) {
  console.error(`\ne2e:remote — ${fails} failure(s)`);
  process.exit(1);
}
console.log("\ne2e:remote — all ok");

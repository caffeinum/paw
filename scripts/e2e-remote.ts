/**
 * e2e:remote — a paw space on a REMOTE JWT + TLS broker, end to end, fully isolated. It asserts what a
 * user sees (a reply arrives, an attach works, a refusal names the problem), never paw's internals, so it
 * can tell whether a broker running ANOTHER cotal version still serves paw's pinned clients.
 *
 * The "remote" is stood up as the Fly box runs it: `cotal up --no-manager` with a self-signed TLS cert,
 * then `cotal auth signer` into a separate root. Every paw command runs with `--space <remote>` while
 * PAW_SPACE names a DIFFERENT (decoy) space and PAW_SERVER a dead port — so any path that ignored
 * --space, or dialled the local broker, fails here instead of touching the operator's live mesh.
 *
 *   1. join: `paw mesh add` (refuses a world-readable signer); without the CA paw fails loud naming TLS
 *      trust and starts nothing;
 *   2. a DM spawns the folder's agent and its reply reaches `paw inbox`;
 *   3. a #general post reaches the agent (it answers it by DM);
 *   4. `paw attach` streams the agent's live TUI and Ctrl-] detaches, the agent still live;
 *   5. after `paw restart` DMs and channel posts still work;
 *   6. a SECOND machine (own PAW_HOME + root + signer copy + its own manager, no mailbox — see --m2)
 *      runs its own agent: machine 1 DMs it, the two agents DM each other, and `paw sleep` across
 *      machines is refused both ways;
 *   7. `paw sleep` → a DM to the sleeping agent wakes it and is delivered;
 *   8. teardown leaves no process naming either space.
 *
 *   COTAL_BIN=<cotal-ai@0.100.0>/dist/cotal.js node scripts/e2e-remote.ts
 *
 * COTAL_BIN must be the `cotal-ai` package at the repo's @cotal-ai/cli version (it runs the broker and
 * its delivery daemon). Install it OUTSIDE the repo, e.g. `npm i --prefix /tmp/cotal100 --ignore-scripts
 * cotal-ai@0.100.0`. E2E_ALLOW_COTAL_VERSION=1 runs the BROKER on another version on purpose (paw's own
 * clients stay on the pinned cotal) — the broker-upgrade question. E2E_HUMAN=<name> joins with `--as`.
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:remote needs COTAL_BIN=<cotal-ai package>/dist/cotal.js (see the header)");
const want = JSON.parse(readFileSync(join(REPO, "node_modules/@cotal-ai/cli/package.json"), "utf8")).version as string;
const have = JSON.parse(readFileSync(join(dirname(dirname(COTAL)), "package.json"), "utf8")) as { name: string; version: string };
if (have.name !== "cotal-ai") throw new Error(`COTAL_BIN is ${have.name}, not the cotal-ai package`);
if (have.version !== want) {
  if (process.env.E2E_ALLOW_COTAL_VERSION !== "1") throw new Error(`COTAL_BIN is cotal-ai@${have.version}; the repo pins cotal ${want} (E2E_ALLOW_COTAL_VERSION=1 to run the broker on it anyway)`);
  console.log(`! broker on cotal-ai@${have.version}, paw's clients on cotal ${want} (E2E_ALLOW_COTAL_VERSION=1)`);
}

// Helper (re-exec'd under the CA env, since NODE_EXTRA_CA_CERTS is read at node startup): DM <name> as
// the human through the roster WITHOUT paw's wake path — the way another agent's `cotal_dm` reaches a
// sleeping agent.
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
  process.exit(0);
}

// Helper modes for "machine 2" (run with ITS PAW_HOME). Both machines share this host's process table,
// and paw finds its daemons by command signature: a second paw CLI on the same space would adopt (or
// `paw down` would kill) machine 1's manager, and its ensure() refuses machine 1's mailbox as "another
// PAW_HOME". So machine 2 drives paw's library against a manager of its own and runs no mailbox; on two
// real machines each has its own process table and none of this is needed.
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
    const [dir, wantName] = rest;
    const name = setFolderName(space!, dir!, wantName!).name;
    for (let i = 0; ; i++) {
      try {
        await withManagerControl(space!, server, (ctl) => ensureAgentSpawned(ctl, { space: space!, name, cwd: dir! }));
        break;
      } catch (e) {
        if (i === 19) throw e;
        await new Promise((res) => setTimeout(res, 3000)); // its manager may still be registering
      }
    }
    console.log(JSON.stringify({ name }));
    process.exit(0);
  }
  if (op === "refuse") {
    const { readManagerPs } = await import("../src/status.ts");
    const { assertNotHostedElsewhere } = await import("../src/sleep.ts");
    try {
      await withManagerControl(space!, server, async (ctl) => assertNotHostedElsewhere(space!, rest[0]!, (await readManagerPs(ctl)).get(rest[0]!)));
      console.log(JSON.stringify({ refused: false }));
    } catch (e) {
      console.log(JSON.stringify({ refused: true, message: (e as Error).message }));
    }
    process.exit(0);
  }
  if (op === "despawn") {
    console.log(JSON.stringify(await withManagerControl(space!, server, (ctl) => ctl.despawn(rest[0]!))));
    process.exit(0);
  }
  throw new Error(`unknown --m2 op ${op}`);
}

const HUMAN = process.env.E2E_HUMAN?.trim() || "you";
const tag = `${process.pid}`;
const R = `remotetest-${tag}`; // the remote space
const DECOY = `remotedecoy-${tag}`; // PAW_SPACE: a local space nothing should touch
const home = mkdtempSync("/tmp/pr-"); // short: the hub socket path must fit sun_path
const home2 = mkdtempSync("/tmp/pr2-");
const work = realpathSync(mkdtempSync(join("/tmp", "pr-work-")));
const remoteRoot = join(work, "remote");
const localRoot = join(work, "local");
const root2 = join(work, "local2");
const agentDir = join(work, "agent");
const agentDir2 = join(work, "other");
for (const d of [remoteRoot, join(localRoot, ".cotal", "auth"), join(root2, ".cotal", "auth"), agentDir, agentDir2, join(work, "cotalhome"), join(work, "cotalhome2"), join(work, "xdg"), join(work, "xdg2")]) mkdirSync(d, { recursive: true });
for (const d of [agentDir, agentDir2]) execFileSync("git", ["init", "-q"], { cwd: d });
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
const env2: NodeJS.ProcessEnv = { ...withCa, PAW_HOME: home2, COTAL_HOME: join(work, "cotalhome2"), XDG_CONFIG_HOME: join(work, "xdg2") };

let fails = 0;
let checks = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  checks++;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
/** Setup that is not itself a behavior under test: failing it makes the rest meaningless. */
const must = (what: string, r: SpawnSyncReturns<string>) => {
  if (r.status !== 0) throw new Error(`e2e:remote setup failed — ${what}: ${out(r).trim()}`);
};
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO, timeout = 180_000): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { env, cwd, encoding: "utf8", timeout });
const paw = (args: string[], env = withCa) => run(process.execPath, [join(REPO, "bin/paw.ts"), ...args], env);
const cotal = (args: string[]) => run(process.execPath, [COTAL, ...args], withCa, remoteRoot);
const out = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "");
const last = (r: SpawnSyncReturns<string>) => out(r).trim().split("\n").pop() ?? "";
const procs = (needle: string) =>
  execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(needle) && !l.includes("e2e-remote"));
/** nats-servers THIS run could have started (config under its temp dirs) — never a concurrent run's. */
const runDirs = [home, home2, work].flatMap((d) => [d, realpathSync(d)]).map((d) => `${d}/`);
const ourBrokers = () =>
  procs("nats-server").filter((l) => {
    const conf = /\s(?:-c|--config)\s+(\S+)/.exec(l)?.[1];
    return !!conf && runDirs.some((d) => conf.startsWith(d));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (s: string, n = 6) => s.trim().split("\n").slice(-n).join(" | ");
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)/g, "");
async function inboxHas(word: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (out(paw(["inbox", "--space", R, "--json"])).toLowerCase().includes(word)) return true;
    await sleep(3000);
  }
  return false;
}
/** A DM to `to` whose reply (containing `word`) must reach machine 1's `paw inbox`. */
async function dmAnswered(to: string, text: string, word: string): Promise<{ ok: boolean; detail: string }> {
  const r = paw(["dm", "--space", R, to, text]);
  if (r.status !== 0) return { ok: false, detail: `dm failed: ${last(r)}` };
  const got = await inboxHas(word, 150_000);
  return { ok: got, detail: got ? "" : `no "${word}" in paw inbox` };
}
/** A #general post reaches the agent: it is told by DM to expect one, then answers the post's code by DM. */
async function channelReaches(name: string, code: string): Promise<{ ok: boolean; detail: string }> {
  const ready = await dmAnswered(name, `A message carrying a code word will be posted on the #general channel shortly. When it arrives, send me (${HUMAN}) a DM with only that code word followed by "-ack", e.g. "word-ack". Right now reply with just the word: ready${code}`, `ready${code}`);
  if (!ready.ok) return ready;
  const post = paw(["msg", "general", `code word: ${code}`, "--space", R]);
  if (post.status !== 0) return { ok: false, detail: `paw msg failed: ${last(post)}` };
  const got = await inboxHas(`${code}-ack`, 150_000);
  return { ok: got, detail: got ? "" : `no "${code}-ack" in paw inbox` };
}

/** `paw attach` under a REAL pty: the agent's TUI must stream through, then Ctrl-] must exit 0. */
async function ptyAttach(args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<{ ok: boolean; detail: string }> {
  const p = ptySpawn(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { name: "xterm-256color", cols: 120, rows: 40, cwd: REPO, env: env as Record<string, string> });
  let output = "";
  let code: number | undefined;
  p.onData((d) => (output += d));
  p.onExit((e) => (code = e.exitCode));
  const deadline = Date.now() + ms;
  while (code === undefined && Date.now() < deadline && !/attached to /.test(plain(output))) await sleep(500);
  const at = output.length;
  for (let i = 0; i < 20 && code === undefined && output.length - at < 200; i++) await sleep(500);
  if (code === undefined) p.write(" ");
  await sleep(2000);
  // claude's own chrome, seen AFTER cotal said "attached" — bytes from the seat, not from paw/cotal.
  const after = plain(output).slice(Math.max(0, plain(output).search(/attached to /)));
  const tui = /attached to /.test(plain(output)) && /bypass permissions|❯|for shortcuts/.test(after);
  if (code === undefined) p.write("\x1d");
  for (let i = 0; i < 30 && code === undefined; i++) await sleep(500);
  if (code === undefined) p.kill();
  return { ok: tui && code === 0, detail: tui && code === 0 ? "" : `tui=${tui} exit=${code} — ${tail(plain(output))}` };
}

/** `cotal down` off a tty: newer cotal wants `--yes` for a whole-stack stop; 0.100 takes it too. */
function cotalDown(): SpawnSyncReturns<string> {
  const r = cotal(["down", "--yes"]);
  return r.status !== 0 && /unknown (option|flag|argument)/i.test(out(r)) ? cotal(["down"]) : r;
}

/** A `paw chat <args…> --space R` over piped stdin: type lines, wait for output, quit on EOF. */
function startChat(args: string[]) {
  const child = spawn(process.execPath, [join(REPO, "bin/paw.ts"), "chat", ...args, "--space", R], { env: withCa, cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  const s = { output: "", exited: false };
  child.stdout.on("data", (d: Buffer) => (s.output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (s.output += d.toString()));
  child.on("exit", () => (s.exited = true));
  const until = async (want: RegExp, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!s.exited && Date.now() < deadline && !want.test(plain(s.output))) await sleep(500);
    return want.test(plain(s.output));
  };
  return {
    output: () => plain(s.output),
    until,
    type: (line: string) => void (!s.exited && child.stdin.write(`${line}\n`)),
    quit: async () => {
      child.stdin.end();
      for (let i = 0; i < 20 && !s.exited; i++) await sleep(500);
      if (!s.exited) child.kill("SIGKILL");
    },
  };
}

const name = "agent";
const other = "other";
let m2pid: number | undefined;
try {
  // ── the "remote": JWT auth + TLS, broker only (setup, not a behavior) ──────────────────────────────
  must("cotal up", cotal(["up", "--detach", "--no-manager", "--space", R, "--server", server, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")]));
  // `auth signer` refuses an `--out` inside any `.cotal/` — export beside, then copy in, as an operator does.
  const exported = join(work, "signer.json");
  must("cotal auth signer", cotal(["auth", "signer", "--out", exported]));
  const signer = join(localRoot, ".cotal", "auth", "auth.json");
  copyFileSync(exported, signer);
  const brokersBefore = ourBrokers().length;

  // ── 1. join ──────────────────────────────────────────────────────────────────────────────────────
  chmodSync(signer, 0o644);
  const loose = paw(["mesh", "add", R, "--server", server, "--root", localRoot]);
  chmodSync(signer, 0o600);
  const add = paw(["mesh", "add", R, "--server", server, "--root", localRoot, ...(HUMAN !== "you" ? ["--as", HUMAN] : [])]);
  const joined = loose.status !== 0 && /chmod 600/.test(out(loose)) && add.status === 0 && !out(add).includes("signingSeed");
  ok("paw mesh add joins the remote space (and refuses a world-readable signer)", joined, joined ? "" : add.status === 0 ? `0644 refusal: ${last(loose)}` : last(add));
  const noCa = paw(["status", "--space", R], base);
  ok(
    "without the CA paw fails loud naming TLS trust, and starts nothing",
    noCa.status !== 0 && /NODE_EXTRA_CA_CERTS/.test(out(noCa)) && procs(`--space ${R}`).filter((l) => !l.includes(COTAL)).length === 0,
    out(noCa).trim().split("\n")[0],
  );

  // ── 2. DM spawns + reply ────────────────────────────────────────────────────────────────────────────
  const first = await dmAnswered(agentDir, "reply with just the word: pong", "pong");
  ok("a DM to a folder spawns its agent on the remote space and the reply reaches paw inbox", first.ok, first.detail);
  ok("paw started no broker of its own and nothing for the decoy space", brokersBefore === 1 && ourBrokers().length === 1 && procs(DECOY).length === 0, brokersBefore === 1 && ourBrokers().length === 1 ? "" : ourBrokers().join(" | "));

  // ── 3. channel ─────────────────────────────────────────────────────────────────────────────────────
  const chan = await channelReaches(name, `mango${tag}`);
  ok("a #general post reaches the agent", chan.ok, chan.detail);

  // ── 3b. two chat windows: what one sends, the other shows ──────────────────────────────────────────
  {
    const watcher = startChat(["--all"]);
    const sender = startChat([`@${name}`]);
    await sleep(10_000); // both connected
    const dmTag = `plum${tag}`;
    const postTag = `fig${tag}`;
    sender.type(`reply with just the word: ${dmTag}`);
    sender.type(`#general ${postTag}`);
    const dmSeen = await watcher.until(new RegExp(`you \\(elsewhere\\) →[^\\n]*${name}[\\s\\S]*${dmTag}`), 30_000);
    const postSeen = await watcher.until(new RegExp(`you \\(elsewhere\\) →[^\\n]*#general[\\s\\S]*${postTag}`), 30_000);
    ok("a second paw chat window shows the DM and the #general post sent from the first", dmSeen && postSeen, dmSeen && postSeen ? "" : tail(watcher.output()));
    await sender.quit();
    await watcher.quit();
  }

  // ── 4. attach ──────────────────────────────────────────────────────────────────────────────────────
  const att = await ptyAttach(["attach", name, "--space", R], withCa, 60_000);
  ok("paw attach streams the agent's live session and Ctrl-] detaches cleanly", att.ok, att.detail);
  ok("…and the agent is still live after the detach", out(paw(["who", "--space", R])).includes(name));

  // ── 5. restart ─────────────────────────────────────────────────────────────────────────────────────
  const rs = paw(["restart", "--space", R]);
  ok("paw restart --space R succeeds", rs.status === 0, last(rs));
  const again = await dmAnswered(name, "reply with just the word: again", "again");
  ok("after the restart a DM is answered", again.ok, again.detail);
  const chan2 = await channelReaches(name, `kiwi${tag}`);
  ok("after the restart a #general post still reaches the agent", chan2.ok, chan2.detail);

  // ── 6. a second machine on the same space ──────────────────────────────────────────────────────────
  copyFileSync(signer, join(root2, ".cotal", "auth", "auth.json"));
  chmodSync(join(root2, ".cotal", "auth", "auth.json"), 0o600);
  must("machine 2 mesh add", paw(["mesh", "add", R, "--server", server, "--root", root2, "--as", "machine2"], env2));
  const m2 = (args: string[]) => run(process.execPath, [fileURLToPath(import.meta.url), "--m2", args[0]!, R, ...args.slice(1)], env2, REPO, 300_000);
  const m2json = <T>(r: SpawnSyncReturns<string>): T | undefined => {
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as T;
    } catch {
      return undefined;
    }
  };
  m2pid = m2json<{ pid: number }>(m2(["manager", join(work, "manager2.log")]))?.pid;
  if (!m2pid) throw new Error("e2e:remote setup failed — machine 2's manager did not start");
  const sp = m2(["spawn", agentDir2, other]);
  const toOther = sp.status === 0 ? await dmAnswered(other, "reply with just the word: crossover", "crossover") : { ok: false, detail: `machine 2 spawn failed: ${tail(out(sp), 2)}` };
  ok("machine 2's own manager runs its agent, and machine 1's DM to it is answered", toOther.ok, toOther.detail);
  const relay = await dmAnswered(
    name,
    `Use your cotal_dm tool to send the agent named "${other}" exactly this message: Please send "${HUMAN}" a DM (cotal_dm) with just the word: relayed${tag}. Then reply to me with just the word: asked${tag}`,
    `relayed${tag}`,
  );
  ok("machine 1's agent DMs machine 2's agent, which acts on it", relay.ok, relay.detail);
  const sleepForeign = paw(["sleep", other, "--now", "--space", R]);
  const back = m2json<{ refused: boolean; message?: string }>(m2(["refuse", name]));
  ok(
    "paw sleep across machines is refused both ways — hosted on another machine",
    sleepForeign.status !== 0 && /hosted on another machine/.test(out(sleepForeign)) && back?.refused === true && /hosted on another machine/.test(back.message ?? ""),
    `${last(sleepForeign)} / ${back?.message}`,
  );
  const d = m2json<{ ok: boolean }>(m2(["despawn", other]));
  if (d?.ok !== true) console.log(`  (machine 2 despawn: ${JSON.stringify(d)})`);
  process.kill(m2pid, "SIGTERM");
  m2pid = undefined;

  // ── 7. sleep → a DM wakes it and is delivered ─────────────────────────────────────────────────────
  let slept: SpawnSyncReturns<string> | undefined;
  for (let i = 0; i < 12; i++) {
    slept = paw(["sleep", name, "--now", "--space", R]);
    if (slept.status === 0) break;
    console.log(`  (not yet: ${last(slept)})`);
    await sleep(10_000);
  }
  ok("paw sleep --now puts the agent to sleep", slept?.status === 0, last(slept!));
  await sleep(5000); // the stand-in comes up under the mailbox
  const raw = run(process.execPath, [fileURLToPath(import.meta.url), "--send-raw", R, name, "you were asleep. reply with just the word: awake"], withCa);
  ok("a DM to the sleeping agent wakes it and is delivered (its reply reaches paw inbox)", raw.status === 0 && (await inboxHas("awake", 180_000)), raw.status === 0 ? "" : tail(out(raw), 2));
} finally {
  // ── 8. teardown ───────────────────────────────────────────────────────────────────────────────────
  if (m2pid) {
    try {
      process.kill(m2pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  console.log(out(paw(["down", "--space", R])).trim());
  console.log(out(cotalDown()).trim());
  await sleep(2000);
  const left = [...procs(R), ...procs(DECOY)];
  ok("teardown leaves no process naming the remote or decoy space", left.length === 0, left.join(" | "));
  for (const l of left) {
    try {
      process.kill(Number(l.trim().split(/\s+/)[0]), "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (process.env.E2E_KEEP) console.log(`E2E_KEEP: kept ${home} ${home2} ${work}`);
  else for (const d of [home, home2, work]) rmSync(d, { recursive: true, force: true });
}
console.log(`\ne2e:remote — ${checks} checks, ${fails} failure(s)`);
if (fails) process.exit(1);

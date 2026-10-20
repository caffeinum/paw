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
 *   4. who / status see it; paw restart --space R revives it and a second DM is answered;
 *   5. status: INBOX lag is a real number for the local agent (paw's cached consumer-INFO-only cred);
 *   6. a SECOND machine (own PAW_HOME, root, signer copy → its own manager) spawns its agent: machine 1
 *      never lists it or claims its lag, and `paw sleep` across machines fails "hosted on another machine";
 *   7. paw sleep agent --now: stand-in under its own nkey; a raw DM by name reaches the stand-in, wakes
 *      the agent, and is re-delivered (its reply lands in paw inbox);
 *   8. paw down --space R + cotal down: nothing left naming either space.
 *
 *   COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-remote.ts
 *
 * COTAL_BIN must be the `cotal-ai` package at the version of the repo's @cotal-ai/cli (it runs the
 * broker's delivery daemon, which @cotal-ai/cli alone cannot start). Install it OUTSIDE the repo,
 * e.g. `npm i --prefix /tmp/cotal084 --ignore-scripts cotal-ai@0.84.0`.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
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
  const ep = new CotalEndpoint({ space: space!, servers: pawServer(space), ...(await humanEndpointAuth(space!, "operator")), card: { name: "you", kind: "endpoint" }, registerPresence: false, consume: false, watchPresence: true });
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

  // ── 4. who / status / restart ───────────────────────────────────────────────────────────────────
  const name = "agent";
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
  ok("the mailbox's sleep host raised the stand-in", beacon);
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
  const log = existsSync(join(home, "spaces", R, "sleep.log")) ? readFileSync(join(home, "spaces", R, "sleep.log"), "utf8") : "";
  ok("sleep.log: woke it and re-delivered the DM", /woke agent — DM from you; re-delivered [1-9]/.test(log), log.trim().split("\n").slice(-3).join(" | "));
  ok("record and stand-in cleared", !existsSync(join(sleepDir, `${name}.json`)) && !existsSync(join(sleepDir, `${name}.waking`)) && !existsSync(join(sleepDir, `${name}.beacon`)));
  const lag3 = await lagOf(name);
  ok("after the wake its lag reads again (the new incarnation's durable)", lag3.row?.inbox?.kind === "lag", JSON.stringify(lag3.row?.inbox));
} finally {
  // ── 5. teardown ─────────────────────────────────────────────────────────────────────────────────
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

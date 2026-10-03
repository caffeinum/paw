/**
 * Hermetic checks for the cotal hub (PAW_COTAL_HUB=1): no broker, no claude.
 *
 *  - pure parts: the flag, the socket path bound, the pgrep signature, the MCP-config rewrite, the
 *    handshake parser;
 *  - the REAL C shim against a fake hub: env handshake, relay, a hub drop (pending + new requests get
 *    errors, never a hang), reconnect replays `initialize` and swallows the duplicate reply, the
 *    exit line, stdin close;
 *  - the REAL hub daemon as a subprocess under hostile input: it must survive every case and keep
 *    serving a well-formed session (its broker is unreachable on purpose — MCP still answers);
 *  - the stall watchdog really kills a process whose event loop is blocked.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Short: the hub socket lives under PAW_HOME and unix socket paths are capped at 103 bytes.
process.env.PAW_HOME = mkdtempSync("/tmp/pawhubchk-");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const { hubEnabled, hubSocketPath, buildShim, writeHubMode, readHubMode, hubModePath } = await import("../src/hub/paths.js");
const { routeCotalToHub } = await import("../src/hub/route.js");
const { parseHandshake, EXIT_LINE } = await import("../src/hub/daemon.mjs");
const { hubMatchPattern, formatHubLine } = await import("../src/lifecycle.js");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !cond(); t += 50) await sleep(50);
  return cond();
};

// ── pure parts ──────────────────────────────────────────────────────────────────────────────────
ok("hub off when unset (no env, no mode file)", hubEnabled("m1", {}) === false);
ok("env 1 overrides an absent mode", hubEnabled("m1", { PAW_COTAL_HUB: "1" }) === true);
ok("garbage env fails loud", throws(() => hubEnabled("m1", { PAW_COTAL_HUB: "yes" })));
writeHubMode("m1", "on");
ok("sticky mode on ⇒ on with a bare env (a launchd job, the manager)", hubEnabled("m1", {}) === true);
ok("env 0 overrides a sticky on (transient)", hubEnabled("m1", { PAW_COTAL_HUB: "0" }) === false);
writeHubMode("m1", "off");
ok("sticky mode off ⇒ off", hubEnabled("m1", {}) === false && readHubMode("m1") === "off");
writeFileSync(hubModePath("m1"), "maybe\n");
ok("a garbage mode file is no choice (off), not a crash", hubEnabled("m1", {}) === false && readHubMode("m1") === undefined);
ok("socket path under PAW_HOME/spaces/<s>", hubSocketPath("t1") === join(process.env.PAW_HOME!, "spaces", "t1", "hub.sock"));
{
  const home = process.env.PAW_HOME;
  process.env.PAW_HOME = "/tmp/" + "x".repeat(100);
  ok("an over-long socket path fails loud (not EINVAL at bind)", throws(() => hubSocketPath("s")));
  process.env.PAW_HOME = home;
}
const re = new RegExp(hubMatchPattern("owntest-1"));
ok("pgrep signature matches the hub", re.test("/n/node --max-old-space-size=1024 /r/src/hub/daemon.mjs --space owntest-1 --socket /h/hub.sock"));
ok("pgrep signature matches the supervisor shell", re.test("/bin/sh -c d=1 paw-cotal-hub /n/node --max-old-space-size=1024 /r/src/hub/daemon.mjs --space owntest-1 --socket /h"));
ok("pgrep signature is space-exact", !re.test("/r/src/hub/daemon.mjs --space owntest-11 --socket /h"));
ok("pgrep signature ignores the mailbox", !re.test("paw.ts mailbox --space owntest-1"));

{
  const base = { on: true, source: "sticky" as const, supervisor: [1], hub: [2], answers: true, shims: 3 };
  ok("status line: healthy hub", formatHubLine(base) === "cotal hub: on · hub pid 2 · supervised · socket answers · 3 agents on shims");
  ok("status line: a dead hub warns", /NOT running.*⚠/.test(formatHubLine({ ...base, hub: [], answers: false }) ?? ""));
  ok("status line: off and gone prints nothing", formatHubLine({ ...base, on: false, source: "default", supervisor: [], hub: [], answers: false, shims: 0 }) === undefined);
  ok("status line: off but still serving says so", /still serving/.test(formatHubLine({ ...base, on: false }) ?? ""));
}
{
  const args = ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { cotal: { command: "node", args: ["/x/mcp.cjs"] }, other: { command: "o" } } })];
  routeCotalToHub(args, "/s/cotal-shim", "/h/hub.sock");
  const cfg = JSON.parse(args[2]!);
  ok("inline mcp-config: cotal → shim", cfg.mcpServers.cotal.command === "/s/cotal-shim" && cfg.mcpServers.cotal.args.join() === "/h/hub.sock");
  ok("inline mcp-config: other servers untouched", cfg.mcpServers.other.command === "o");
  const f = join(process.env.PAW_HOME!, "mcp.json");
  writeFileSync(f, JSON.stringify({ mcpServers: { cotal: { command: "node", args: ["/x/mcp.cjs"], env: { A: "1" } } } }));
  const fargs = ["--mcp-config", f];
  routeCotalToHub(fargs, "/s/cotal-shim", "/h/hub.sock");
  const fc = JSON.parse(readFileSync(f, "utf8"));
  ok("file mcp-config rewritten in place, env kept", fargs[1] === f && fc.mcpServers.cotal.command === "/s/cotal-shim" && fc.mcpServers.cotal.env.A === "1");
  ok("no --mcp-config fails loud", throws(() => routeCotalToHub(["--x"], "s", "h")));
  ok("no cotal entry fails loud", throws(() => routeCotalToHub(["--mcp-config", '{"mcpServers":{}}'], "s", "h")));
}

{
  const good = parseHandshake(JSON.stringify({ v: 1, pid: 1, env: { COTAL_NAME: "a", COTAL_SPACE: "s", HOME: "/h", PATH: "/bin", AWS_SECRET: "x", COTAL_N: 5 } }));
  ok("handshake keeps COTAL_* + HOME", "env" in good && good.env.COTAL_NAME === "a" && good.env.HOME === "/h");
  ok("handshake drops ambient env (PATH, secrets) and non-strings", "env" in good && !("PATH" in good.env) && !("AWS_SECRET" in good.env) && !("COTAL_N" in good.env));
  ok("handshake: malformed refused", "error" in parseHandshake("{nope"));
  ok("handshake: wrong version refused", "error" in parseHandshake(JSON.stringify({ v: 2, env: { COTAL_NAME: "a" } })));
  ok("handshake: array env refused", "error" in parseHandshake(JSON.stringify({ v: 1, env: [] })));
  ok("handshake: no identity refused", "error" in parseHandshake(JSON.stringify({ v: 1, env: { HOME: "/h" } })));
}

// ── the C shim against a fake hub ───────────────────────────────────────────────────────────────
const tree = mkdtempSync(join(tmpdir(), "pawhubtree-"));
mkdirSync(join(tree, "src", "hub"), { recursive: true });
writeFileSync(join(tree, "src", "hub", "cotal-shim.c"), readFileSync(join(REPO, "src", "hub", "cotal-shim.c")));
const shim = buildShim(tree);
ok("shim builds with the system cc", spawnSync(shim, [], { stdio: "ignore" }).status === 1);

{
  const sockPath = join(process.env.PAW_HOME!, "fake.sock");
  const hubLines: string[][] = [];
  let hubSock: Socket | undefined;
  const fake = createServer((s) => {
    const lines: string[] = [];
    hubLines.push(lines);
    hubSock = s;
    let b = "";
    s.on("data", (d) => {
      b += d;
      for (let nl = b.indexOf("\n"); nl >= 0; nl = b.indexOf("\n")) {
        const l = b.slice(0, nl);
        b = b.slice(nl + 1);
        lines.push(l);
        let m: { method?: string; id?: unknown };
        try {
          m = JSON.parse(l);
        } catch {
          continue; // the shim relays malformed lines as-is; the real hub's transport logs and skips them
        }
        if (m.method === "initialize") s.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { conn: hubLines.length } }) + "\n");
        if (m.method === "ping") s.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => fake.listen(sockPath, r));
  const child = spawn(shim, [sockPath], {
    env: { COTAL_NAME: "alpha", COTAL_SPACE: "s", HOME: "/h", TMPDIR: "/t", PATH: "/bin", SECRET_TOKEN: "x" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const out: Array<Record<string, unknown>> = [];
  let ob = "";
  child.stdout!.on("data", (d) => {
    ob += d;
    for (let nl = ob.indexOf("\n"); nl >= 0; nl = ob.indexOf("\n")) {
      out.push(JSON.parse(ob.slice(0, nl)));
      ob = ob.slice(nl + 1);
    }
  });
  const send = (m: Record<string, unknown>) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  await waitFor(() => hubLines.length === 1 && hubLines[0]!.length >= 1);
  const hello = JSON.parse(hubLines[0]![0]!);
  ok("shim handshake carries COTAL_*, HOME and TMPDIR", hello.v === 1 && hello.env.COTAL_NAME === "alpha" && hello.env.HOME === "/h" && hello.env.TMPDIR === "/t");
  ok("shim handshake leaves ambient env behind", !("PATH" in hello.env) && !("SECRET_TOKEN" in hello.env));
  send({ id: 1, method: "initialize", params: { capabilities: {} } });
  send({ method: "notifications/initialized" });
  send({ id: "p1", method: "ping" });
  ok("relay: initialize + ping answered through the shim", await waitFor(() => out.some((m) => m.id === 1) && out.some((m) => m.id === "p1")));
  // a request the hub never answers, then the hub drops the connection
  send({ id: 7, method: "slow/never" });
  await waitFor(() => hubLines[0]!.some((l) => l.includes("slow/never")));
  fake.close(); // stop accepting FIRST, so the shim's immediate reconnect finds nobody
  hubSock!.destroy();
  ok("hub drop: the in-flight request gets an error, not a hang", await waitFor(() => out.some((m) => m.id === 7 && m.error)));
  await sleep(200);
  send({ id: 8, method: "ping" });
  ok("hub down: a new request is answered with an error at once", await waitFor(() => out.some((m) => m.id === 8 && m.error), 2000));
  // hub back: shim reconnects and replays initialize; the duplicate reply must not reach claude
  await new Promise<void>((r) => fake.listen(sockPath, r));
  ok("shim reconnects after the hub comes back", await waitFor(() => hubLines.length === 2 && hubLines[1]!.length >= 3, 15000));
  const replay = hubLines[1]!.slice(1).map((l) => JSON.parse(l).method);
  ok("reconnect replays initialize then initialized", replay[0] === "initialize" && replay[1] === "notifications/initialized", replay.join());
  ok("the replayed initialize's reply is swallowed", out.filter((m) => m.id === 1).length === 1);
  send({ id: "p2", method: "ping" });
  ok("traffic flows again after the reconnect", await waitFor(() => out.some((m) => m.id === "p2" && m.result)));
  // hostile input from claude's side must never crash the shim or produce invalid JSON
  child.stdin!.write('{"jsonrpc":"2.0","id":"unterminated\n');
  child.stdin!.write('{"a":"\\\n');
  const longId = "x".repeat(300);
  send({ id: longId, method: "ping" });
  ok("a request id too long to track is refused with a valid JSON error (id null)", await waitFor(() => out.some((m) => m.id === null && m.error)));
  for (let i = 0; i < 1030; i++) send({ id: 10_000 + i, method: "slow/never" });
  ok("past 1024 in-flight requests the shim refuses loudly instead of dropping", await waitFor(() => out.filter((m) => (m.error as { message?: string })?.message?.includes("too many")).length >= 6));
  send({ id: "p3", method: "ping" });
  // the table is full of never-answered calls, so p3 is refused too — but answered, at once
  ok("the shim still answers every request after the hostile input", await waitFor(() => out.some((m) => m.id === "p3")));
  hubSock!.write(EXIT_LINE);
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  ok("the hub's exit line ends the shim cleanly (no reconnect)", code === 0);

  const c2 = spawn(shim, [sockPath], { env: { COTAL_NAME: "beta" }, stdio: ["pipe", "ignore", "ignore"] });
  await sleep(300);
  c2.stdin!.end();
  ok("claude closing stdin ends the shim", (await new Promise<number | null>((r) => c2.once("exit", r))) === 0);
  fake.close();
}

// ── the hub daemon under hostile input ──────────────────────────────────────────────────────────
{
  const space = "hubchk";
  const sock = hubSocketPath(space);
  const log: string[] = [];
  const hub: ChildProcess = spawn(process.execPath, [join(REPO, "src", "hub", "daemon.mjs"), "--space", space, "--socket", sock], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub.stderr!.on("data", (d) => log.push(String(d)));
  let exited = false;
  hub.once("exit", () => (exited = true));
  const listening = await waitFor(() => log.join("").includes("listening on"), 20000);
  ok("hub daemon starts and listens", listening, log.join("").slice(-300));

  const probe = async (label: string, payload: (s: Socket) => void, ms = 1500) => {
    const s = connect(sock);
    s.on("error", () => {});
    await new Promise((r) => s.once("connect", r));
    payload(s);
    await sleep(ms);
    s.destroy();
    ok(`hub survives: ${label}`, !exited);
  };
  const ctl = join(process.env.PAW_HOME!, "c");
  mkdirSync(ctl, { recursive: true });
  const env = (name: string, extra: Record<string, string> = {}) => ({
    COTAL_NAME: name,
    COTAL_SPACE: space,
    COTAL_ID: name,
    COTAL_SERVERS: "nats://127.0.0.1:1",
    COTAL_CHANNEL: "1",
    COTAL_CONTROL_SOCKET: join(ctl, `${name}.sock`),
    COTAL_CONTROL_TOKEN: `t-${name}`,
    ...extra,
  });
  const init = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "0" } } }) + "\n";
  await probe("binary garbage, no newline", (s) => s.write(Buffer.from([0, 255, 1, 2])));
  await probe("garbage line", (s) => s.write("not json\n"));
  await probe("100KB handshake with no newline", (s) => s.write("{".repeat(100_000)));
  await probe("handshake without identity", (s) => s.write(JSON.stringify({ v: 1, env: { HOME: "/x" } }) + "\n"));
  await probe("missing launch material", (s) => s.write(JSON.stringify({ v: 1, env: env("m1", { COTAL_LAUNCH_MATERIAL: "/nonexistent/m.json" }) }) + "\n"));
  await probe("unbindable control socket", (s) => s.write(JSON.stringify({ v: 1, env: env("m2", { COTAL_CONTROL_SOCKET: "/nonexistent/d/x.sock" }) }) + "\n"));
  await probe("JSON-RPC garbage after a valid handshake", (s) => s.write(JSON.stringify({ v: 1, env: env("m3") }) + "\n" + init + "}}{{\n[1]\nnull\n"));
  await probe("10MB line", (s) => s.write(JSON.stringify({ v: 1, env: env("m4") }) + "\n" + init + "x".repeat(10 * 1024 * 1024)), 3000);
  await probe("a client that never reads (5000 tools/list)", (s) => {
    s.pause();
    s.write(JSON.stringify({ v: 1, env: env("m5") }) + "\n" + init);
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
    for (let i = 0; i < 5000; i++) s.write(call);
  }, 6000);
  {
    const many: Socket[] = [];
    for (let i = 0; i < 200; i++) {
      const c = connect(sock);
      c.on("error", () => {});
      many.push(c);
    }
    await sleep(500);
    // a real session must still get in while 200 idle connections squat
    const good = connect(sock);
    let got = "";
    good.on("data", (d) => (got += d));
    good.on("error", () => {});
    await new Promise((r) => good.once("connect", r));
    good.write(JSON.stringify({ v: 1, env: env("good") }) + "\n" + init + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    ok("a real session is served while 200 idle connections squat", await waitFor(() => got.includes('"id":2'), 10000), got.slice(0, 200) || log.join("").split("\n").filter((l) => l.includes("good")).join(" | ").slice(-400));
    ok("tools/list answered with cotal tools", got.includes("cotal_dm"));
    many.forEach((c) => c.destroy());
    good.destroy();
  }
  ok("hub process still alive after every case", !exited);
  ok("nothing escaped as uncaught", !/UNCAUGHT|UNHANDLED/.test(log.join("")), log.join("").match(/(UNCAUGHT|UNHANDLED)[^\n]*/)?.[0] ?? "");
  hub.kill("SIGTERM");
  await waitFor(() => exited, 5000);
}

// ── the stall watchdog ──────────────────────────────────────────────────────────────────────────
{
  const tsx = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const f = join(process.env.PAW_HOME!, "stall.mts");
  writeFileSync(f, `const { startWatchdog } = await import(${JSON.stringify(join(REPO, "src", "hub", "daemon.mjs"))}); startWatchdog(1500); setTimeout(() => { const t = Date.now(); while (Date.now() - t < 20000); console.log("survived"); }, 300);`);
  const r = spawnSync(process.execPath, [tsx, f], { encoding: "utf8", timeout: 30000 });
  // tsx runs the script in a child and relays its fate: a SIGKILLed child surfaces as signal or 137.
  ok("a stalled event loop is SIGKILLed by the watchdog", (r.signal === "SIGKILL" || r.status === 137) && !r.stdout.includes("survived"), `signal=${r.signal} status=${r.status}`);
}

{
  // Laptop sleep freezes BOTH threads. SIGSTOP is the same thing seen from outside: after SIGCONT
  // the loop is healthy, and the watchdog must not count the frozen interval as a stall.
  const tsx = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const f = join(process.env.PAW_HOME!, "sleep.mts");
  writeFileSync(f, `const { startWatchdog } = await import(${JSON.stringify(join(REPO, "src", "hub", "daemon.mjs"))}); startWatchdog(2000); setTimeout(() => { console.log("survived"); process.exit(0); }, 9000);`);
  const p = spawn(process.execPath, [tsx, f], { stdio: ["ignore", "pipe", "pipe"] });
  let so = "";
  p.stdout!.on("data", (d) => (so += d));
  await sleep(2500);
  const kids = spawnSync("pgrep", ["-P", String(p.pid)], { encoding: "utf8" }).stdout.split("\n").map(Number).filter(Boolean);
  for (const k of [p.pid!, ...kids]) process.kill(k, "SIGSTOP");
  await sleep(6000);
  for (const k of [p.pid!, ...kids]) process.kill(k, "SIGCONT");
  const code = await new Promise<number | null>((r) => p.once("exit", r));
  ok("a 6s process freeze (laptop sleep) is not taken for a stall", code === 0 && so.includes("survived"), `exit ${code}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall hub checks passed");
process.exit(fails ? 1 : 0);

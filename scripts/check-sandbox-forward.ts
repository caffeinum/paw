/**
 * Hermetic check for a sandboxed agent's port forwarding (bin/paw-sandbox-forward.mjs): the /proc/net/tcp parser,
 * the add/remove diff, the host side binding loopback only, a busy host port skipped (never stolen) and picked up
 * once free, the state file `paw sandbox ls` reads, and the persona opt-out — with a FAKE transport (a local relay
 * instead of `container exec`), so no VM is needed. Run: pnpm check:sandbox-forward
 * PAW_FORWARD_SMOKE=<running container id> additionally forwards from a real container (see docs/notes/sandbox.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-fwd-")));
process.env.PAW_HOME = join(home, ".paw");

let failures = 0;
const assert = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const until = async (pred: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !pred(); ) await new Promise((r) => setTimeout(r, 50));
  return pred();
};

const fwd = await import("../bin/paw-sandbox-forward.mjs");

console.log("/proc/net/tcp parsing");
{
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1 0 100 0 0 10 0",
    "   1: 0100007F:D1F2 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1002 1 0 100 0 0 10 0",
    "   2: 0240A8C0:0016 0140A8C0:C350 01 00000000:00000000 00:00000000 00000000     0        0 1003 1 0 100 0 0 10 0",
    "   3: 0240A8C0:1388 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1004 1 0 100 0 0 10 0",
  ].join("\n");
  const tcp6 = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1 0 100 0 0 10 0",
    "   1: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2002 1 0 100 0 0 10 0",
    "   2: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2003 1 0 100 0 0 10 0",
    "   3: 00000000000000000000000001000000:2329 00000000000000000000000001000000:9C40 06 00000000:00000000 00:00000000 00000000     0        0 2004 1 0 100 0 0 10 0",
  ].join("\n");
  const got = fwd.parseProcNetTcp(`${tcp}\n${tcp6}\n`);
  const by = new Map(got.map((g: { port: number; addrs: string[] }) => [g.port, g.addrs.join(",")]));
  assert(got.map((g: { port: number }) => g.port).join() === "3000,5000,8080,9000,53746", "LISTEN (0A) rows only, sorted; ESTABLISHED / TIME_WAIT ignored");
  assert(by.get(8080) === "0.0.0.0,::", "a port on v4 AND v6 is one entry (deduped), with both addresses");
  assert(by.get(53746) === "127.0.0.1", "v4 loopback decodes (little-endian 0100007F = 127.0.0.1)");
  assert(by.get(9000) === "::1" && by.get(3000) === "127.0.0.1" && by.get(5000) === "192.168.64.2", "v6 loopback, a v4-mapped v6 address and a specific v4 address decode");
  assert(fwd.parseProcNetTcp("").length === 0, "no sockets ⇒ nothing");
  assert(fwd.relayTarget(["0.0.0.0", "::"]) === "127.0.0.1" && fwd.relayTarget(["::"]) === "::1" && fwd.relayTarget(["192.168.64.2"]) === "192.168.64.2", "the in-VM dial target: loopback for wildcard/loopback binds, else the server's own address");
}

console.log("add/remove diff");
{
  const d = fwd.diffPorts(new Map([[80, 1], [443, 1]]), [443, 8080, 3000]);
  assert(d.add.join() === "3000,8080" && d.remove.join() === "80", "new ports are added, gone ones removed, kept ones untouched");
  const same = fwd.diffPorts(new Set([1, 2]), [2, 1]);
  assert(!same.add.length && !same.remove.length, "an unchanged listing is a no-op");
}

// The "VM": servers on THEIR OWN ports (the host side must bind the forwarded port number), reached by a relay
// child that speaks the same stdio contract as `container exec -i … node -e <relay>`.
const echoServer = (tag: string) =>
  new Promise<{ srv: Server; port: number }>((resolve) => {
    const srv = createServer((s) => s.on("data", (d) => s.write(`${tag}:${d}`)));
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: (srv.address() as { port: number }).port }));
  });
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const ask = (port: number, msg: string) =>
  new Promise<string>((resolve, reject) => {
    import("node:net").then(({ connect }) => {
      const c = connect(port, "127.0.0.1");
      let out = "";
      c.on("data", (d) => {
        out += d;
        if (out.includes(msg)) {
          c.end();
          resolve(out);
        }
      });
      c.on("error", reject);
      c.write(msg);
      setTimeout(() => {
        c.destroy();
        reject(new Error("timeout"));
      }, 5000).unref();
    });
  });

console.log("the forwarder (fake transport)");
const vmA = await echoServer("A");
const P = await freePort();
const BUSY = await freePort();
const busy = createServer((s) => s.on("data", (d) => s.end(`HOST:${d}`))).listen(BUSY, "127.0.0.1");
await new Promise((r) => busy.once("listening", r));
let listing: Array<{ port: number; addrs: string[] }> = [];
const relayed: string[] = [];
const transport = {
  listListening: async () => listing,
  relay: (host: string, port: number) => {
    relayed.push(`${host}:${port}`);
    return spawn(process.execPath, ["-e", `const s=require("net").connect(${vmA.port},"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("close",()=>process.exit(0))`], { stdio: ["pipe", "pipe", "pipe"] });
  },
};
const notes: string[] = [];
const stateDir = join(home, ".paw", "spaces", "sp", "sandbox", "ag");
mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, "forwards.json");
const f = fwd.startForwarder({ transport, note: (m: string) => notes.push(m), stateFile, container: "paw-sp-ag-abc123", pollMs: 60_000 });
{
  await f.poll();
  assert(f.forwarded().length === 0 && !existsSync(join(stateDir, "nope")), "nothing listening ⇒ nothing forwarded");
  listing = [{ port: P, addrs: ["127.0.0.1"] }, { port: BUSY, addrs: ["0.0.0.0"] }];
  await f.poll();
  assert(f.forwarded().join() === String(P), "a port listening in the VM is forwarded at the SAME port number");
  const addrs = f.addresses() as Array<{ address: string; port: number }>;
  assert(addrs.length > 0 && addrs.every((a) => (a.address === "127.0.0.1" || a.address === "::1") && a.port === P), `the host side binds loopback only (${addrs.map((a) => a.address).join(", ")}), never a wildcard`);
  assert(addrs.some((a) => a.address === "127.0.0.1"), "…127.0.0.1 always");
  assert((await ask(P, "ping")) === "A:ping", "a host connection to 127.0.0.1:<port> reaches the VM server through the relay, both ways");
  assert(relayed.at(-1) === `127.0.0.1:${P}`, "the relay dials the VM server's loopback at the same port");
  assert(f.skipped().join() === String(BUSY) && notes.filter((n) => n.includes(`forward ${BUSY}: NOT forwarded`)).length === 1, "a port busy on the host is skipped and logged");
  await f.poll();
  assert(notes.filter((n) => n.includes(`forward ${BUSY}: NOT forwarded`)).length === 1, "…once, not on every poll");
  assert((await ask(BUSY, "x")) === "HOST:x", "…and the host's own listener on it keeps answering (not stolen)");
  const st = JSON.parse(readFileSync(stateFile, "utf8"));
  assert(st.container === "paw-sp-ag-abc123" && st.ports.join() === String(P) && st.skipped.join() === String(BUSY), "forwards.json records the container, forwarded and skipped ports");
  const { readForwards } = await import("../src/commands/sandbox.ts");
  assert(readForwards(join(home, ".paw"), "sp", "ag", "paw-sp-ag-abc123")?.ports.join() === String(P), "`paw sandbox ls` reads them for that container");
  assert(readForwards(join(home, ".paw"), "sp", "ag", "paw-sp-ag-other0") === undefined, "…and ignores a file left by another launch");
  await new Promise((r) => busy.close(r));
  await f.poll();
  assert(f.forwarded().includes(BUSY) && f.skipped().length === 0, "once the host frees the port, the next poll forwards it");
  listing = [];
  await f.poll();
  assert(f.forwarded().length === 0, "a port no longer listening in the VM is closed");
  assert((await ask(P, "gone").catch(() => "refused")) === "refused", "…and the host port refuses connections again");
  listing = [{ port: P, addrs: ["::"] }];
  await f.poll();
  f.stop();
  assert(!existsSync(stateFile) && f.forwarded().length === 0, "stop() closes every listener and removes forwards.json");
}

console.log("listing failures");
{
  const n: string[] = [];
  const g = fwd.startForwarder({ transport: { listListening: async () => Promise.reject(new Error("container not running")), relay: transport.relay }, note: (m: string) => n.push(m), container: "x", pollMs: 60_000 });
  await until(() => n.length > 0, 5000);
  await g.poll();
  await g.poll();
  g.stop();
  assert(n.filter((m) => m.includes("container not running")).length === 1, "a failing `container exec` (VM not up yet) is logged once, not every poll");
}

console.log("persona sandboxForward: + the launcher flag");
{
  const sbx = await import("../src/sandbox.ts");
  const p = (v: string) => {
    const file = join(home, `p-${v || "none"}.md`);
    writeFileSync(file, `---\nname: x\n${v ? `sandboxForward: ${v}\n` : ""}---\n`);
    return file;
  };
  assert(sbx.readSandboxForward(p("")) === true && sbx.readSandboxForward(p("true")) === true, "default on");
  assert(sbx.readSandboxForward(p("false")) === false, "sandboxForward: false opts out");
  let threw = false;
  try {
    sbx.readSandboxForward(p("nope"));
  } catch (e) {
    threw = /sandboxForward/.test((e as Error).message);
  }
  assert(threw, "any other value fails loud");
  const bad = spawnSync(process.execPath, [sbx.SANDBOX_RUNNER, "--container", "/bin/false", "--token-file", "/x", "--name", "n", "--space", "s", "--agent", "a", "--log", join(home, "l.log"), "--forward", "maybe", "--", "run"], { encoding: "utf8" });
  assert(bad.status === 2 && /--forward is on\|off/.test(bad.stderr), "the launcher refuses a --forward that isn't on|off");
}

// A real container: PAW_FORWARD_SMOKE=<id of a THROWAWAY running container from the paw-sandbox image>.
const smokeId = process.env.PAW_FORWARD_SMOKE;
if (smokeId) {
  console.log(`real container ${smokeId}`);
  const bin = process.env.PAW_CONTAINER || "container";
  const port = await freePort();
  const srv = spawn(bin, ["exec", smokeId, "node", "-e", `require("http").createServer((q,r)=>r.end("vm-says-hi "+q.url)).listen(${port},"127.0.0.1")`], { stdio: "ignore" });
  const n: string[] = [];
  const g = fwd.startForwarder({ transport: fwd.containerTransport(bin, smokeId), note: (m: string) => n.push(m), container: smokeId, pollMs: 500 });
  assert(await until(() => g.forwarded().includes(port), 15_000), `a server on the VM's 127.0.0.1:${port} is forwarded`);
  // curl as an ASYNC child: the forwarder lives in this process's event loop.
  const curlAsync = (url: string) =>
    new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const c = spawn("curl", ["-sS", "--max-time", "10", url]);
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", () => resolve({ stdout, stderr }));
    });
  const curl = await curlAsync(`http://127.0.0.1:${port}/callback?code=x`);
  assert(curl.stdout === "vm-says-hi /callback?code=x", `curl http://127.0.0.1:${port}/callback on the host reaches it (${curl.stdout || curl.stderr})`);
  const curl6 = await curlAsync(`http://localhost:${port}/`);
  assert(curl6.stdout === "vm-says-hi /", "…and via http://localhost (whichever loopback the resolver picks)");
  srv.kill();
  spawnSync(bin, ["exec", smokeId, "pkill", "-f", `listen\\(${port}`]);
  assert(await until(() => !g.forwarded().includes(port), 15_000), "the server stopping in the VM closes the host port");
  g.stop();
  console.log(n.map((m) => `      log: ${m}`).join("\n"));
}

console.log(failures ? `\n${failures} FAILED` : "\ncheck:sandbox-forward passed");
process.exit(failures ? 1 : 0);

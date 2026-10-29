/**
 * Port forwarding for a sandboxed agent (docs/notes/sandbox.md#port-forwarding): every TCP port something
 * LISTENS on inside the VM is offered on the HOST's loopback at the same port number, like OrbStack / VS Code —
 * so an OAuth callback server a CLI starts in the VM (`neonctl auth`, `gh auth login`, …) receives the redirect
 * the operator's host browser sends to http://localhost:<port>/….
 *
 * - Discovery: `container exec <id> cat /proc/net/tcp /proc/net/tcp6` every ~1.5s (the image has no ss/netstat);
 *   state 0A = LISTEN.
 * - Transport: one `container exec -i <id> node -e <relay>` per host connection, piping its stdio to the server's
 *   own listen address inside the VM. That reaches servers bound to the VM's 127.0.0.1 (which the VM's IP does
 *   not) and never depends on the vmnet IP.
 * - The host side binds 127.0.0.1 (and ::1 when free) ONLY, never a wildcard. A port already taken on the host's
 *   127.0.0.1 is skipped — never stolen, never moved to another number — and logged once.
 *
 * Plain node ESM, no dependencies: imported by bin/paw-sandbox-run.mjs, which runs in the manager's node.
 */
import { spawn } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

export const FORWARD_POLL_MS = 1_500;
export const HOST_BIND = ["127.0.0.1", "::1"];

/** hex `0100007F` (little-endian v4) or 32 hex chars (v6, four little-endian words) → printable address. */
function hexAddr(hex) {
  if (hex.length === 8) return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
  if (hex.length !== 32) throw new Error(`paw forward: unexpected /proc/net address ${hex}`);
  const bytes = [];
  for (let w = 0; w < 4; w++) for (let b = 3; b >= 0; b--) bytes.push(hex.slice(w * 8 + b * 2, w * 8 + b * 2 + 2));
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(parseInt(bytes[i] + bytes[i + 1], 16).toString(16));
  const v6 = groups.join(":");
  if (v6 === "0:0:0:0:0:0:0:0") return "::";
  if (v6 === "0:0:0:0:0:0:0:1") return "::1";
  if (v6.startsWith("0:0:0:0:0:ffff:")) {
    const [hi, lo] = groups.slice(6).map((g) => parseInt(g, 16));
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return v6;
}

/**
 * `/proc/net/tcp` + `/proc/net/tcp6` text (concatenated, headers included) → the LISTENING ports, one entry per
 * port: `{ port, addrs }` with every address it listens on, sorted by port.
 */
export function parseProcNetTcp(text) {
  const byPort = new Map();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+:$/.test(f[0]) || f[3] !== "0A") continue;
    const [hex, portHex] = f[1].split(":");
    const port = parseInt(portHex, 16);
    if (!port) continue;
    const addrs = byPort.get(port) ?? new Set();
    addrs.add(hexAddr(hex));
    byPort.set(port, addrs);
  }
  return [...byPort].sort((a, b) => a[0] - b[0]).map(([port, addrs]) => ({ port, addrs: [...addrs].sort() }));
}

/** Where to dial inside the VM for a server listening on `addrs`: loopback when it's wildcard/loopback, else its own address. */
export function relayTarget(addrs) {
  if (addrs.some((a) => a === "0.0.0.0" || a.startsWith("127."))) return "127.0.0.1";
  if (addrs.some((a) => a === "::" || a === "::1")) return "::1";
  return addrs[0];
}

/** `wanted` port numbers vs the `current` (Set or Map keys) → what to open and what to close. */
export function diffPorts(current, wanted) {
  const have = new Set(current instanceof Map ? current.keys() : current);
  const want = new Set(wanted);
  return { add: [...want].filter((p) => !have.has(p)).sort((a, b) => a - b), remove: [...have].filter((p) => !want.has(p)).sort((a, b) => a - b) };
}

// Runs IN THE VM: one connection to the server at argv[1]:argv[2], piped to stdio. Exits when either side ends.
const RELAY = `const s=require("net").connect(+process.argv[2],process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",e=>{process.stderr.write(e.message);process.exit(1)});s.on("close",()=>process.exit(0))`;

/** The default transport: `container exec -i <id> node -e <relay> <host> <port>`. */
export function containerTransport(container, id) {
  return {
    listListening: () =>
      new Promise((resolve, reject) => {
        const c = spawn(container, ["exec", id, "cat", "/proc/net/tcp", "/proc/net/tcp6"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("error", reject);
        c.on("close", (code) => (code === 0 ? resolve(parseProcNetTcp(out)) : reject(new Error(`container exec exited ${code}: ${err.trim().slice(0, 200)}`))));
      }),
    relay: (host, port) => spawn(container, ["exec", "-i", id, "node", "-e", RELAY, host, String(port)], { stdio: ["pipe", "pipe", "pipe"] }),
  };
}

function listenOn(host, port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen({ host, port, exclusive: true, ipv6Only: host.includes(":") }, () => {
      srv.removeListener("error", reject);
      resolve(srv);
    });
  });
}

/**
 * Start forwarding. `transport` = { listListening(): Promise<{port,addrs}[]>, relay(host, port): ChildProcess }
 * (containerTransport by default). `note(msg)` logs to launcher.log; `stateFile` (optional) is rewritten with
 * `{ container, ports, skipped }` on every change and removed on stop. Returns { stop(), poll(), forwarded(), skipped(), addresses() }.
 */
export function startForwarder({ transport, note, stateFile = /** @type {string | undefined} */ (undefined), container: id, pollMs = FORWARD_POLL_MS, bind = HOST_BIND }) {
  const open = new Map(); // port → { servers, target }
  const skipped = new Map(); // port → reason (logged once)
  const children = new Set();
  let stopped = false;
  let polling = false;
  let lastError = "";
  let lastState = "";

  const writeState = () => {
    if (!stateFile) return;
    const state = JSON.stringify({ container: id, ports: [...open.keys()].sort((a, b) => a - b), skipped: [...skipped.keys()].sort((a, b) => a - b) });
    if (state === lastState) return;
    lastState = state;
    try {
      writeFileSync(`${stateFile}.tmp`, `${state}\n`);
      renameSync(`${stateFile}.tmp`, stateFile);
    } catch (e) {
      note(`forward: can't write ${stateFile}: ${e.message}`);
    }
  };

  const onConnection = (port) => (sock) => {
    const entry = open.get(port);
    if (!entry) return sock.destroy();
    const child = transport.relay(entry.target, port);
    children.add(child);
    let errText = "";
    child.stderr?.on("data", (d) => (errText += d));
    sock.pipe(child.stdin);
    child.stdout.pipe(sock);
    sock.on("error", () => child.kill());
    child.stdin.on("error", () => sock.destroy());
    child.on("error", (e) => {
      note(`forward ${port}: relay failed to start: ${e.message}`);
      sock.destroy();
    });
    child.on("close", (code) => {
      children.delete(child);
      if (code) note(`forward ${port}: relay exited ${code}${errText ? ` (${errText.trim().slice(0, 200)})` : ""}`);
      sock.end();
    });
  };

  async function openPort({ port, addrs }) {
    const servers = [];
    for (const host of bind) {
      try {
        servers.push(await listenOn(host, port));
      } catch (e) {
        if (host === bind[0]) {
          for (const s of servers) s.close();
          if (!skipped.has(port)) note(`forward ${port}: NOT forwarded — host ${host}:${port} is taken (${e.code ?? e.message}); free it and it is picked up on the next poll`);
          skipped.set(port, e.code ?? e.message);
          return;
        }
        if (e.code !== "EADDRNOTAVAIL" && e.code !== "EAFNOSUPPORT") note(`forward ${port}: host ${host}:${port} not bound (${e.code ?? e.message}) — ${bind[0]} only`);
      }
    }
    if (stopped) return void servers.forEach((s) => s.close());
    const target = relayTarget(addrs);
    for (const s of servers) s.on("connection", onConnection(port));
    open.set(port, { servers, target });
    if (skipped.delete(port)) note(`forward ${port}: host port free again`);
    note(`forward ${port}: localhost:${port} → VM ${target}:${port}`);
  }

  function closePort(port) {
    const entry = open.get(port);
    if (!entry) return;
    open.delete(port);
    for (const s of entry.servers) s.close();
    note(`forward ${port}: closed (no longer listening in the VM)`);
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      let listening;
      try {
        listening = await transport.listListening();
        lastError = "";
      } catch (e) {
        // Before the VM is up / while it goes down every exec fails — log a NEW error once, not every poll.
        if (e.message !== lastError) note(`forward: can't list the VM's ports: ${e.message}`);
        lastError = e.message;
        return;
      }
      if (stopped) return;
      const byPort = new Map(listening.map((l) => [l.port, l]));
      for (const p of [...skipped.keys()]) if (!byPort.has(p)) skipped.delete(p);
      const { add, remove } = diffPorts(open, byPort.keys());
      for (const p of remove) closePort(p);
      for (const p of add) await openPort(byPort.get(p));
      writeState();
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(poll, pollMs);
  timer.unref();
  void poll();
  return {
    poll,
    forwarded: () => [...open.keys()].sort((a, b) => a - b),
    skipped: () => [...skipped.keys()].sort((a, b) => a - b),
    addresses: () => [...open.values()].flatMap((e) => e.servers.map((s) => s.address())),
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const p of [...open.keys()]) {
        for (const s of open.get(p).servers) s.close();
        open.delete(p);
      }
      for (const c of children) c.kill();
      if (stateFile) rmSync(stateFile, { force: true });
    },
  };
}

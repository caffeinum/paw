/**
 * The cotal hub — ONE process serving the cotal MCP server for every claude in a space.
 *
 *   node src/hub/daemon.mjs --space <s> --socket <path>   (started by lifecycle under its supervisor)
 *
 * PLAIN NODE, NO TSX, on purpose: measured, loading cotal's 4MB mcp.cjs through tsx's require hook
 * cost ~400MB of V8 heap (485MB vs 85MB footprint, same file) — more than the hub saves at 5 agents.
 * So this file is .mjs, type-checked by tsc via allowJs, and imports only node builtins + mcp.cjs.
 *
 * Opt-in (PAW_COTAL_HUB=1). Each agent's claude launches the C shim (src/hub/cotal-shim.c) as its
 * cotal MCP server; the shim connects here, sends one handshake line `{"v":1,"pid":…,"env":{COTAL_*…}}`
 * and relays newline-delimited JSON-RPC. Per connection this calls cotal's own
 * `serveClaudeSession` (the export upstreamed in Cotal-AI/Cotal#2401, patched into 0.58.0 until it
 * ships) — the SAME code `node mcp.cjs` runs, just handed a socket and an env instead of stdio and
 * `process.env`. So each session is its own mesh endpoint, hook control socket and wake policy,
 * and its identity comes from the launch env every time it (re)connects: a hub restart is the same
 * peer re-binding the same DM durable, and DMs sent during the gap are delivered.
 *
 * ISOLATION: a fault in one session may only end that session. Every per-session entry point is
 * guarded; a throw or rejection closes that connection (the shim reconnects or, if claude is gone,
 * exits). Inputs are bounded: handshake size and deadline, line length, unflushed output, session
 * and pending-connection counts.
 *
 * CRASH-ONLY for what isolation can't contain: a stalled event loop (a watchdog thread SIGKILLs the
 * process) and a burst of uncaught errors (exit). The supervisor loop lifecycle starts the hub under
 * restarts it within seconds, and the shims reconnect and replay their MCP handshake, so claude sees
 * a few tool calls answered with "hub unavailable" and nothing else.
 */
import { createConnection, createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const HANDSHAKE_MAX_BYTES = 64 * 1024;
const HANDSHAKE_DEADLINE_MS = 5_000;
/** One JSON-RPC line from claude. A tool call carrying a big DM is KBs; 8MB is a runaway. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Unflushed output a shim may leave unread before its session is cut (it reconnects fresh). */
const MAX_UNFLUSHED_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 512;
/** Connections that have not handshaken yet. Counted apart from sessions, and when full the OLDEST
 *  is dropped for the newcomer: a real shim sends its handshake the moment it connects, so a burst
 *  of idle connects can delay it by one retry at most, never lock it out. */
const MAX_PENDING = 64;
const STALL_MS = Number(process.env.PAW_HUB_STALL_MS ?? 15_000);
/** More uncaught errors than this in a minute means the process is no longer trustworthy. */
const UNCAUGHT_BUDGET = 5;
/** The line that tells a shim its session is OVER (the manager shut the agent down): exit, don't
 *  reconnect. Not JSON-RPC; the shim intercepts it. */
export const EXIT_LINE = '{"cotal_hub":"exit"}\n';
/** Env a handshake may carry into a session: the session's own launch env, nothing ambient. */
const HANDSHAKE_ENV = /^(COTAL_|HOME$|XDG_CONFIG_HOME$|TMPDIR$)/;

/** @typedef {import("@cotal-ai/connector-claude-code/mcp").ClaudeSession} ClaudeSession */
/** @typedef {import("@cotal-ai/connector-claude-code/mcp").ClaudeSessionOptions} ClaudeSessionOptions */
/** @typedef {{ id: number, name: string, sock: import("node:net").Socket, closed: boolean, session?: ClaudeSession }} Conn */

/** @param {string} m */
const log = (m) => {
  try {
    process.stderr.write(`[cotal-hub] ${new Date().toISOString()} ${m}\n`);
  } catch {
    /* stderr gone — nothing left to tell */
  }
};

/** Parse + filter one handshake line. Pure; exported for check:hub. */
/** @param {string} line @returns {{ env: NodeJS.ProcessEnv } | { error: string }} */
export function parseHandshake(line) {
  /** @type {{ v?: unknown, env?: unknown }} */
  let hello;
  try {
    hello = JSON.parse(line);
  } catch {
    return { error: "malformed handshake" };
  }
  if (!hello || typeof hello !== "object" || hello.v !== 1 || !hello.env || typeof hello.env !== "object" || Array.isArray(hello.env))
    return { error: "bad handshake shape" };
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (hello.env))) if (typeof v === "string" && HANDSHAKE_ENV.test(k)) env[k] = v;
  if (!env.COTAL_NAME && !env.COTAL_AGENT_FILE && !env.COTAL_LINK) return { error: "handshake carries no COTAL identity" };
  return { env };
}

/** Event-loop stall watchdog on its own thread: the loop it guards can't run its own timer.
 *  Exported for check:hub, which proves it actually kills a stalled process. */
export function startWatchdog(stallMs = STALL_MS) {
  const beat = new Int32Array(new SharedArrayBuffer(4));
  const t0 = Date.now();
  const tick = () => Atomics.store(beat, 0, Math.floor((Date.now() - t0) / 1000));
  tick();
  setInterval(tick, 1000).unref();
  const w = new Worker(
    `const { workerData } = require("node:worker_threads"); const fs = require("node:fs");
     const { beat, t0, stallMs } = workerData;
     setInterval(() => {
       const ageMs = Date.now() - t0 - Atomics.load(beat, 0) * 1000;
       if (ageMs > stallMs) {
         try { fs.writeSync(2, "[cotal-hub] event loop stalled " + ageMs + "ms — exiting for the supervisor to restart\\n"); } catch {}
         process.kill(process.pid, "SIGKILL");
       }
     }, 1000);`,
    { eval: true, workerData: { beat, t0, stallMs } },
  );
  w.unref();
  w.on("error", (e) => log(`watchdog thread failed: ${e.message} — running WITHOUT stall protection`));
}

/** Serve until signalled. @param {{ space: string, socket: string }} opts */
export async function runHub({ space, socket: path }) {
  // Resolved at RUN time, never at import: check:hub imports this module for its pure parts.
  /** @type {{ serveClaudeSession?: (o: ClaudeSessionOptions) => Promise<ClaudeSession> }} */
  const { serveClaudeSession } = createRequire(import.meta.url)("@cotal-ai/connector-claude-code/mcp");
  if (typeof serveClaudeSession !== "function")
    throw new Error("paw: @cotal-ai/connector-claude-code has no serveClaudeSession export — the pnpm patch (patches/) is missing; run `pnpm install`");

  /** @type {Map<number, Conn>} */
  const conns = new Map();
  /** Not yet handshaken, oldest first. @type {Map<number, import("node:net").Socket>} */
  const pending = new Map();
  let nextId = 1;

  /** @param {Conn} c @param {string} why */
  const end = (c, why, final = false) => {
    if (c.closed) return;
    c.closed = true;
    if (conns.delete(c.id)) log(`session ${c.name}#${c.id} closing: ${why}`);
    if (final) {
      try {
        c.sock.end(EXIT_LINE);
      } catch {
        /* already gone */
      }
      setTimeout(() => c.sock.destroy(), 1000).unref();
    } else c.sock.destroy();
    const s = c.session;
    if (s) {
      const t = setTimeout(() => log(`session ${c.name}#${c.id}: close() exceeded 5s — abandoned`), 5000);
      t.unref();
      void s
        .close()
        .catch((/** @type {Error} */ e) => log(`session ${c.name}#${c.id}: close failed: ${e.message}`))
        .finally(() => clearTimeout(t));
    }
  };

  /** Bound what one claude can push in and what the hub buffers for a shim that stopped reading. */
  /** @param {Conn} c */
  const bound = (c) => {
    let lineBytes = 0;
    c.sock.on("data", (/** @type {Buffer} */ d) => {
      const nl = d.lastIndexOf(10);
      lineBytes = nl < 0 ? lineBytes + d.length : d.length - nl - 1;
      if (lineBytes > MAX_LINE_BYTES) end(c, `inbound line exceeds ${MAX_LINE_BYTES} bytes`);
    });
    /** @type {(...a: unknown[]) => boolean} */
    const write = /** @type {any} */ (c.sock.write.bind(c.sock));
    /** @type {any} */ (c.sock).write = (/** @type {unknown[]} */ ...a) => {
      if (c.closed) return false;
      if (c.sock.writableLength > MAX_UNFLUSHED_BYTES) {
        end(c, `shim not reading — ${c.sock.writableLength} bytes unflushed`);
        return false;
      }
      return write(...a);
    };
  };

  /** @param {Conn} c @param {NodeJS.ProcessEnv} env */
  const start = (c, env) => {
    c.name = env.COTAL_NAME ?? "?";
    if (conns.size >= MAX_SESSIONS) return end(c, `${MAX_SESSIONS} sessions live — refusing`);
    conns.set(c.id, c);
    bound(c);
    serveClaudeSession({
      env,
      input: c.sock,
      output: c.sock,
      fatalBind: false,
      log: (line) => log(`${c.name}#${c.id} ${line}`),
      onShutdown: () => end(c, "manager shut the agent down", true),
    }).then(
      (session) => {
        if (c.closed) return void session.close().catch(() => {});
        c.session = session;
        c.sock.resume();
        log(`session ${c.name}#${c.id} serving; ${conns.size} live`);
      },
      (/** @type {Error} */ e) => end(c, `could not start: ${e.message}`),
    );
  };

  /** @param {import("node:net").Socket} sock */
  const onConnection = (sock) => {
    /** @type {Conn} */
    const c = { id: nextId++, name: "?", sock, closed: false };
    sock.on("error", (e) => end(c, `socket error: ${e.message}`));
    sock.on("close", () => end(c, "shim disconnected"));
    if (pending.size >= MAX_PENDING) {
      const [oldestId, oldest] = /** @type {[number, import("node:net").Socket]} */ (pending.entries().next().value);
      pending.delete(oldestId);
      oldest.destroy();
    }
    pending.set(c.id, sock);
    const done = () => void pending.delete(c.id);
    let buf = Buffer.alloc(0);
    const deadline = setTimeout(() => {
      done();
      c.closed = true;
      sock.destroy();
    }, HANDSHAKE_DEADLINE_MS);
    deadline.unref();
    sock.once("close", () => {
      clearTimeout(deadline);
      done();
    });
    /** @param {Buffer} d */
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > HANDSHAKE_MAX_BYTES) {
          done();
          c.closed = true;
          sock.destroy();
        }
        return;
      }
      sock.off("data", onData);
      clearTimeout(deadline);
      done();
      const hs = parseHandshake(buf.subarray(0, nl).toString("utf8"));
      if ("error" in hs) {
        log(`rejected connection: ${hs.error}`);
        c.closed = true;
        sock.destroy();
        return;
      }
      // HOLD the stream until the session's transport is listening: the shim sends `initialize`
      // right behind its handshake, and bytes emitted to no listener are gone.
      sock.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length) sock.unshift(rest);
      try {
        start(c, hs.env);
      } catch (e) {
        end(c, `could not start: ${/** @type {Error} */ (e).message}`);
      }
    };
    sock.on("data", onData);
  };

  // ── process-level backstop ──────────────────────────────────────────────────────────────────────
  /** @type {number[]} */
  const uncaught = [];
  /** @param {string} kind @param {unknown} e */
  const contain = (kind, e) => {
    log(`${kind}: ${/** @type {Error} */ (e)?.stack ?? String(e)}`);
    const now = Date.now();
    uncaught.push(now);
    while (uncaught.length && now - /** @type {number} */ (uncaught[0]) > 60_000) uncaught.shift();
    if (uncaught.length > UNCAUGHT_BUDGET) {
      log(`${uncaught.length} uncaught errors in a minute — exiting for the supervisor to restart`);
      process.exit(70);
    }
  };
  process.on("uncaughtException", (e) => contain("UNCAUGHT", e));
  process.on("unhandledRejection", (e) => contain("UNHANDLED REJECTION", e));
  /** @param {string} sig */
  const shutdownAll = (sig) => {
    log(`${sig}: closing ${conns.size} sessions`);
    for (const c of [...conns.values()]) end(c, sig);
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => shutdownAll("SIGTERM"));
  process.on("SIGINT", () => shutdownAll("SIGINT"));

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A live hub already answering on this path means we are a duplicate: leave it alone.
  if (existsSync(path)) {
    const live = await new Promise((resolve) => {
      const probe = createConnection(path);
      probe.once("connect", () => (probe.destroy(), resolve(true)));
      probe.once("error", () => resolve(false));
    });
    if (live) {
      log(`another hub already serves ${path} — exiting`);
      process.exit(0);
    }
    unlinkSync(path);
  }
  const server = createServer(onConnection);
  server.maxConnections = MAX_SESSIONS + MAX_PENDING;
  server.on("error", (e) => {
    log(`listener error: ${e.message}`);
    process.exit(1); // the listener is the one thing the hub can't run without; the supervisor restarts it
  });
  server.listen(path, () => {
    chmodSync(path, 0o600);
    log(`listening on ${path} (pid ${process.pid}, space ${space})`);
  });
  startWatchdog();
  setInterval(() => {
    const m = process.memoryUsage();
    log(`stats: ${conns.size} sessions, ${pending.size} pending, rss ${(m.rss / 1048576).toFixed(0)}MB heap ${(m.heapUsed / 1048576).toFixed(0)}MB`);
  }, 60_000).unref();
  await new Promise(() => {}); // park; SIGTERM (paw down / restart) ends it
}

/** `node daemon.mjs --space <s> --socket <path>` — run as the hub. Imported (check:hub), it only exports. */
const argv = process.argv.slice(2);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flag = (/** @type {string} */ f) => {
    const i = argv.indexOf(f);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v) throw new Error(`cotal-hub: ${f} is required`);
    return v;
  };
  runHub({ space: flag("--space"), socket: flag("--socket") }).catch((e) => {
    log(`fatal: ${e?.stack ?? e}`);
    process.exit(1);
  });
}

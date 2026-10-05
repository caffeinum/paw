// @ts-check
/**
 * The hub's side of a HEADLESS agent (docs/notes/headless.md): a `claude -p` stream-json process with
 * no TUI, so Claude Code drops cotal's `claude/channel` wake push. The hub sees that push go by on the
 * session's MCP output and writes it into the agent's stdin FIFO as a stream-json user turn instead.
 * Everything else is cotal's own hook machinery, which -p keeps: SessionStart / UserPromptSubmit inject
 * the queued peer messages as additionalContext and ack them on handoff, Stop/UserPromptSubmit drive
 * presence (idle/working), Stop re-requests a wake when more arrived mid-turn.
 *
 * QUEUEING: a wake that arrives while a turn runs is HELD and coalesced — one turn after the current
 * one ends, never one turn per message (each wasted turn re-reads the whole context). The turn end is
 * the `result` line in `out.jsonl` (claude's stream-json stdout), tailed by polling its size. A hold
 * longer than HOLD_MAX_MS is written anyway: claude -p queues stdin turns itself, so a missed `result`
 * costs one extra turn, never a deaf agent.
 *
 * Plain node ESM like daemon.mjs (no tsx in the hub — see docs/notes/hub.md).
 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 500;
const HOLD_MAX_MS = 10 * 60_000;
/** A `result` line is a few KB (usage, cost, the final text); anything longer is never one. */
const RESULT_LINE_MAX = 256 * 1024;
const READ_CHUNK = 256 * 1024;

/** The turn terminal in claude's stream-json output. Key order is NOT stable (`result` lines start
 *  with `duration_api_ms` on 2.1.289), so parse the candidates rather than match a prefix. Exported
 *  for check:headless. @param {string} line */
export function isResult(line) {
  if (!line.includes('"type":"result"')) return false;
  try {
    return JSON.parse(line)?.type === "result";
  } catch {
    return false;
  }
}

/** The pipe dir for `name`, derived from the hub socket's dir (the space dir) — the same path
 *  src/hub/paths.ts `headlessDir` gives the connector. Undefined for a name that can't be a dir. */
/** @param {string} spaceDir @param {string} name */
export function headlessDirFor(spaceDir, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes("..")) return undefined;
  return join(spaceDir, "headless", name);
}

/** Is a live claude reading `<dir>/in`? Opening a FIFO write-only non-blocking fails with ENXIO when no
 *  process holds it for reading — so a stale FIFO left by an agent switched back to the TUI is not
 *  mistaken for a headless agent. @param {string} dir */
export function hasReader(dir) {
  let fd;
  try {
    fd = openSync(join(dir, "in"), constants.O_WRONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFIFO();
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The stream-json user turn for one channel push. Pure; exported for check:headless.
 *  @param {{ content?: unknown, meta?: unknown }} params */
export function wakeTurn(params) {
  const content = typeof params.content === "string" ? params.content : "";
  if (!content) throw new Error("channel push without content");
  const meta = params.meta && typeof params.meta === "object" ? /** @type {Record<string, unknown>} */ (params.meta) : {};
  const attrs = Object.entries(meta)
    .filter(([k, v]) => /^[A-Za-z0-9_]+$/.test(k) && typeof v === "string")
    .map(([k, v]) => ` ${k}="${String(v).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"`)
    .join("");
  const text = `<channel source="cotal"${attrs}>\n${content}\n</channel>`;
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** Does a channel push sit in this chunk of MCP output? Returns its params, else undefined.
 *  @param {unknown} chunk */
export function channelPush(chunk) {
  const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
  if (!s.includes('"notifications/claude/channel"')) return undefined;
  for (const line of s.split("\n")) {
    if (!line.includes('"notifications/claude/channel"')) continue;
    try {
      const m = JSON.parse(line);
      if (m?.method === "notifications/claude/channel" && m.params && typeof m.params === "object") return m.params;
    } catch {
      /* not one whole JSON line — the stdio transport writes one message per write */
    }
  }
  return undefined;
}

/**
 * One headless agent's driver. `push(params)` on every channel push; `close()` when the session ends.
 * @param {{ dir: string, name: string, log: (m: string) => void }} o
 */
export function createHeadlessDriver({ dir, name, log }) {
  const outPath = join(dir, "out.jsonl");
  const inPath = join(dir, "in");
  /** A turn we started has not reported its `result` yet. Unknown at (re)connect ⇒ assume idle:
   *  being wrong costs a turn claude queues, never a lost wake. */
  let busy = false;
  /** @type {{ params: { content?: unknown, meta?: unknown }, count: number, since: number } | undefined} */
  let held;
  let offset = 0;
  try {
    offset = statSync(outPath).size; // history is not ours to replay
  } catch {
    /* not written yet */
  }
  let carry = "";
  /** Inside a line too long to be a `result` — ignored up to its newline. */
  let skipping = false;
  let decoder = new StringDecoder("utf8");
  /** @type {number | undefined} */
  let ino;
  let closed = false;
  /** After a failed write, no retry before this (a dead reader would otherwise log twice a second). */
  let retryAt = 0;

  /** @param {string} line */
  const write = (line) => {
    let fd;
    try {
      fd = openSync(inPath, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(fd, line);
      return true;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      // ENXIO: no reader — claude is gone; the message stays un-acked in its durable and is surfaced
      // by the next SessionStart. EAGAIN: the pipe is full (claude not reading) — keep it held.
      log(`headless ${name}: could not write a wake (${code ?? /** @type {Error} */ (e).message})`);
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  /** @param {{ content?: unknown, meta?: unknown }} params */
  const deliver = (params) => {
    if (write(wakeTurn(params))) {
      busy = true;
      return;
    }
    held ??= { params, count: 1, since: Date.now() };
    retryAt = Date.now() + 5_000;
  };

  const flushHeld = () => {
    if (!held) return;
    const h = held;
    held = undefined;
    const params = h.count > 1 ? { content: `📨 ${h.count} Cotal wakes arrived while you were working — delivering your inbox now.`, meta: { kind: "batch" } } : h.params;
    deliver(params);
  };

  /** Read what claude appended to out.jsonl; a `result` line ends the turn. */
  const poll = () => {
    let st;
    try {
      st = statSync(outPath);
    } catch {
      return;
    }
    if (st.size < offset || (ino !== undefined && st.ino !== ino)) {
      // A new claude rotated the file: a fresh process is idle until its first turn.
      offset = 0;
      carry = "";
      skipping = false;
      decoder = new StringDecoder("utf8");
      busy = false;
    }
    ino = st.ino;
    let fd;
    try {
      fd = openSync(outPath, "r");
      const buf = Buffer.alloc(READ_CHUNK);
      while (offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, st.size - offset), offset);
        if (n <= 0) break;
        offset += n;
        const text = decoder.write(buf.subarray(0, n));
        let start = 0;
        for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
          if (!skipping && isResult(carry + text.slice(start, nl))) busy = false;
          carry = "";
          skipping = false;
          start = nl + 1;
        }
        if (!skipping) {
          carry += text.slice(start);
          // Longer than any result line: a tool result or a transcript dump. Skip to its end.
          if (carry.length > RESULT_LINE_MAX) {
            carry = "";
            skipping = true;
          }
        }
      }
    } catch (e) {
      log(`headless ${name}: reading ${outPath} failed: ${/** @type {Error} */ (e).message}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (held && Date.now() >= retryAt && (!busy || Date.now() - held.since > HOLD_MAX_MS)) {
      if (busy) log(`headless ${name}: turn still running after ${HOLD_MAX_MS / 60_000}min — writing the held wake anyway (claude queues it)`);
      flushHeld();
    }
  };
  const timer = setInterval(() => {
    if (!closed) poll();
  }, POLL_MS);
  timer.unref();

  return {
    /** @param {{ content?: unknown, meta?: unknown }} params */
    push(params) {
      if (closed) return;
      poll(); // a result written since the last tick must count before we decide to hold
      if (busy || held) {
        if (held) held.count++;
        else held = { params, count: 1, since: Date.now() };
        return;
      }
      deliver(params);
    },
    /** For check:headless. */
    state: () => ({ busy, held: held?.count ?? 0 }),
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

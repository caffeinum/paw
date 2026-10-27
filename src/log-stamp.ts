/**
 * ISO-timestamp every line a paw daemon writes into its log (manager.log, mailbox.log, mesh.log,
 * restart.log, adopt.log), so a failure can be lined up with the broker's metrics.
 *
 * In-process, not a pipe: the daemons are detached with stdout/stderr on a FILE fd, and a line-prefixing
 * pipe would need a second process that outlives the spawner and can fill and block the daemon. Instead
 * the daemon's entry point (bin/cotald.ts, bin/paw.ts) wraps its own process.stdout/stderr.write —
 * console.* and cotal's logger both write through them. File writes stay synchronous; nothing is
 * buffered, so no line is ever held back or lost. Works on bytes, so a multibyte character split
 * across two writes is never corrupted.
 *
 * Opt-in by env: the spawner sets {@link STAMP_ENV} only on a log-redirected daemon, and the daemon
 * DELETES it on read, so nothing it spawns (agents, a `paw cotal` passthrough) inherits stamping.
 * Not covered: bytes written straight to the fd (node's own fatal-error trace — an
 * uncaughtExceptionMonitor line stamps its moment) and a child's inherited stdio.
 */
export const STAMP_ENV = "PAW_LOG_STAMP";

const STAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;
const NL = 0x0a;

/** A log line without its timestamp prefix (unchanged when it has none) — for readers that match line starts. */
export function stripStamp(line: string): string {
  return line.replace(STAMP_RE, "");
}

/** The shared at-line-start state of one log file (stdout and stderr share the fd). */
export interface StampState {
  atLineStart: boolean;
}

/** `chunk` with `<iso> ` inserted at every line start it contains. Pure; advances `state`. */
export function stampChunk(chunk: Uint8Array, state: StampState, now: Date): Buffer {
  if (chunk.length === 0) return Buffer.from(chunk);
  const prefix = Buffer.from(`${now.toISOString()} `);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (state.atLineStart) {
      parts.push(prefix);
      state.atLineStart = false;
    }
    if (chunk[i] === NL) {
      parts.push(chunk.subarray(from, i + 1));
      from = i + 1;
      state.atLineStart = true;
    }
  }
  if (from < chunk.length) parts.push(chunk.subarray(from));
  return Buffer.concat(parts);
}

type Write = NodeJS.WriteStream["write"];

function wrap(stream: NodeJS.WriteStream, state: StampState, clock: () => Date): void {
  const orig = stream.write.bind(stream) as (chunk: Uint8Array, cb?: (err?: Error | null) => void) => boolean;
  stream.write = ((chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
    const done = (typeof encOrCb === "function" ? encOrCb : cb) as ((err?: Error | null) => void) | undefined;
    const enc = typeof encOrCb === "string" ? (encOrCb as BufferEncoding) : undefined;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, enc) : (chunk as Uint8Array);
    return orig(stampChunk(bytes, state, clock()), done);
  }) as Write;
}

/** Wrap this process's stdout+stderr when the spawner asked for it; consumes the env flag. True if wrapped. */
export function installLogStamp(env: NodeJS.ProcessEnv = process.env, clock: () => Date = () => new Date()): boolean {
  const flag = env[STAMP_ENV];
  if (flag === undefined) return false;
  if (flag !== "1") throw new Error(`paw: ${STAMP_ENV} must be "1" or unset, got ${JSON.stringify(flag)}`);
  delete env[STAMP_ENV];
  const state: StampState = { atLineStart: true };
  wrap(process.stdout, state, clock);
  wrap(process.stderr, state, clock);
  process.on("uncaughtExceptionMonitor", (err) => {
    process.stderr.write(`${state.atLineStart ? "" : "\n"}uncaught exception, trace follows: ${err?.message ?? String(err)}\n`);
  });
  return true;
}

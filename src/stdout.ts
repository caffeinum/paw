/**
 * Write to stdout in a way that CANNOT be truncated by process exit.
 *
 * THE BUG (2026-08-03, surfaced by the Raycast extension): `paw inbox --json` run under **bun** with
 * stdout on a **pipe** delivered a 150 KB payload as 64900, 97259 or 129725 bytes — a different cut
 * each run, exit code 0, no error on either side. The extension reported it as "paw returned
 * unparseable output" on a body that *began* as valid JSON. The same command under node+tsx was
 * byte-correct on every run, and switching the emitter to `writeSync` made bun correct on every run.
 *
 * WHAT IS AND ISN'T ESTABLISHED: the failure and the fix are both reproduced repeatedly against the
 * real command. The MECHANISM is not isolated — minimal repros (a large `console.log` under bun, with
 * an explicit exit, with a natural exit, and after a socket teardown) all came out WHOLE, so "bun
 * drops buffered stdout on exit" is NOT a sufficient explanation and should not be repeated as one.
 * Something about paw's actual teardown (many sockets, JetStream consumers, timers) is required to
 * trigger it. Treat this as a defence whose necessity is measured, not understood.
 *
 * It also hides easily, which is why it survived: redirecting to a FILE writes synchronously and comes
 * out whole, and `paw … | wc -c` comes out whole too because a fast reader keeps the pipe drained. It
 * bites a consumer that pipes and reads at its own pace — exactly the machine-readable `--json` paths.
 *
 * `writeSync(1, …)` bypasses the stream layer entirely: the bytes are in the kernel before the call
 * returns, so exit has nothing left to drop. Any output that must arrive INTACT — not merely mostly —
 * goes through here rather than console.log. (Human-facing prose is fine on console.log: a torn line at
 * the end of a 150 KB dump is visible to a person; silently truncated JSON is not.)
 */
import { writeSync } from "node:fs";

/** Sleep without a callback — a partial write needs to yield, and there's no async escape here. */
const PARK = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void {
  Atomics.wait(PARK, 0, 0, ms);
}

/**
 * Write `text` to fd 1, completely. Loops because a pipe accepts only what fits: a short write is
 * normal, not an error, and treating it as done is precisely the truncation this exists to prevent.
 */
export function writeOut(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EAGAIN: the pipe is full and fd 1 is non-blocking — the reader will drain it, so wait and
      // retry. EINTR: interrupted by a signal, resume. Anything else is a real I/O failure (EPIPE on a
      // closed reader) and must surface, never be swallowed into a half-written payload.
      if (code === "EAGAIN") {
        pause(2);
        continue;
      }
      if (code === "EINTR") continue;
      throw e;
    }
  }
}

/** The machine-readable emitter: one JSON document, whole, with the trailing newline a line-reader wants. */
export function writeJson(value: unknown): void {
  writeOut(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The manager's own word on why a seat died, read back from manager.log for a spawn failure.
 *
 * cotal's manager logs a seat's end as `seat reaped: <name> (…) - <cause>; exit code …; diagnostic: <why>`
 * and a failed launch as `<name> exited on launch - last output: …; diagnostic: <why>` — e.g. "Cotal
 * startup confirmation failed: prompt "WARNING: Loading development channels" did not appear within
 * 15000ms." paw's spawn error used to say only "its process is gone", so the reason sat unread in the
 * log (caffeinum/paw#1). Reads only what the manager appended AFTER the spawn began, so an older death
 * of the same name is never reported as this one's.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { stripStamp } from "./log-stamp.ts";

/** Bytes read back at most — a seat's lines land within seconds of the spawn, the log is huge. */
const MAX_READ = 1 << 20;

/** The log's current size: the offset a spawn reads from later. 0 for a log that does not exist yet. */
export function logOffset(path: string): number {
  try {
    return statSync(path).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

/** The last `diagnostic:` the manager logged for seat `name` after `from`, or undefined when it logged none. */
export function seatDiagnostic(path: string, name: string, from: number): string | undefined {
  for (const line of seatLines(path, name, from).reverse()) {
    const m = /[;,] diagnostic: (.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** The cause half of the last `seat reaped: <name> (…) - <cause>` line after `from` — e.g. "its own
 *  process exited and this manager did not stop it; exit code 1, signal 0" — for a seat that died
 *  without a diagnostic (kit: its own error went to the seat's terminal). Undefined when none. */
export function seatExit(path: string, name: string, from: number): string | undefined {
  const line = seatLines(path, name, from).reverse().find((l) => l.startsWith(`seat reaped: ${name} (`));
  return line ? /\) - (.+)$/.exec(line)?.[1].trim() : undefined;
}

function seatLines(path: string, name: string, from: number): string[] {
  const size = logOffset(path);
  if (size <= from) return [];
  const start = Math.max(from, size - MAX_READ);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const ours = (line: string) => line.startsWith(`seat reaped: ${name} (`) || line.startsWith(`${name} exited on launch`) || line.includes(` ${name} exited on launch`);
  return buf.toString("utf8").split("\n").map(stripStamp).filter(ours);
}

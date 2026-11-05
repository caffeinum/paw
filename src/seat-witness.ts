/**
 * The OS's word on a seat the manager just launched: which pid runs it, and is that pid alive.
 *
 * WHY: paw's readiness wait read only the manager's ps. On 2026-11-05 (team2027, #96) the manager
 * launched `canary` as pid 49934, then dropped the seat from its table within two seconds and retired
 * the incarnation, without stopping the process. The ps row was missing, so paw said "its process is
 * gone" and blamed a connector refusal, while pid 49934 ran on and was on the mesh. The manager's
 * table is one witness; the process table is the other, and a verdict about a process needs it.
 *
 * cotal stamps every seat it launches with COTAL_NAME / COTAL_SPACE / COTAL_LIFECYCLE_UID. The uid
 * is per incarnation and comes back in the spawn reply, so it picks out THIS launch and never an
 * older seat of the same name. Only the seat's ROOT counts: its children (MCP servers, shells)
 * inherit the same environment.
 */
import { execFileSync } from "node:child_process";
import { PS_ALL_ENV } from "./ps-env.ts";

export type SeatKey = { space: string; name: string; uid?: string };

function envVal(cmd: string, key: string): string | undefined {
  let last: string | undefined;
  for (const m of cmd.matchAll(new RegExp(`(?:^|\\s)${key}=(\\S*)`, "g"))) last = m[1];
  return last;
}

/** Pure: root pids in `ps <env> -o pid=,ppid=,command=` output that carry this seat's stamps. */
export function seatPidsIn(psText: string, key: SeatKey): number[] {
  const hits: { pid: number; ppid: number }[] = [];
  for (const line of psText.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[3];
    if (envVal(cmd, "COTAL_NAME") !== key.name || envVal(cmd, "COTAL_SPACE") !== key.space) continue;
    if (key.uid !== undefined && envVal(cmd, "COTAL_LIFECYCLE_UID") !== key.uid) continue;
    hits.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  const pids = new Set(hits.map((h) => h.pid));
  return hits.filter((h) => !pids.has(h.ppid)).map((h) => h.pid);
}

/** The seat's root pids, from one `ps` of every process with its environment. */
export function seatPids(key: SeatKey): number[] {
  const out = execFileSync("ps", [...PS_ALL_ENV, "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  return seatPidsIn(out, key);
}

/** Is `pid` a running process (signal 0: exists, and is ours to signal)? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

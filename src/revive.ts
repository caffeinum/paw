/**
 * `paw restart`'s revive list — the agents that were live when it began, written to disk BEFORE the
 * manager bounce despawns them, so a restart that fails half-way can still be finished.
 *
 * The 2026-10-26 incident (team2027, a remote fly broker): `paw restart --space team2027` despawned
 * queue-ea, stopped the old manager, hit a broker stall (`could not acquire the manager lease …:
 * timeout`) and exited 1. The names it meant to revive lived only in that process's memory, so the
 * re-run two hours later started a manager and brought nobody back — the operator had to know to
 * `paw start queue-ea`.
 *
 * Now: `spaces/<s>/restart-revive.json` = `{ space, at, names }`. A successful restart revives the
 * names and deletes it. A failed one leaves it and says how to finish. The next `paw restart` merges it
 * into its own list; the next ensure() that brings the manager up revives it (both under one lock, so
 * one process does it). A list older than {@link REVIVE_FRESH_MS} is dropped, said out loud — it
 * predates whatever the operator has done since. Only the listed agents, through the usual wake gate
 * (ensureAgentSpawned: a live agent is reused, a live-but-stuck seat is never restarted without consent).
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ensureAgentSpawned, folderForName } from "./addressing.ts";
import { withManagerControl } from "./control.ts";
import { awaitSpawnHeadroom } from "./pacing.ts";
import { pawServer } from "./server.ts";
import { withFileLockAsync } from "./lock.ts";
import { codeRootFromCommand, describeCodeRoot } from "./manager-features.ts";
import { daemonRoot } from "./release.ts";
import { mailboxProcs, managerProcs, reviveListPath } from "./lifecycle.ts";

export const REVIVE_FRESH_MS = 24 * 60 * 60 * 1000;

export interface ReviveList {
  space: string;
  at: string;
  names: string[];
}

/** The list on disk, or undefined when there is none. A malformed file throws: it was written by paw. */
export function readReviveList(space: string): ReviveList | undefined {
  const p = reviveListPath(space);
  if (!existsSync(p)) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${p} is not valid JSON (${(e as Error).message}) — it lists the agents a failed restart left down; fix or remove it`);
  }
  const l = v as Partial<ReviveList>;
  if (l?.space !== space || typeof l.at !== "string" || Number.isNaN(Date.parse(l.at)) || !Array.isArray(l.names) || !l.names.every((n) => typeof n === "string"))
    throw new Error(`paw: ${p} is not a revive list for space ${space} ({space, at, names}) — fix or remove it`);
  return l as ReviveList;
}

export function isFresh(list: ReviveList, now = Date.now()): boolean {
  return now - Date.parse(list.at) < REVIVE_FRESH_MS;
}

export function clearReviveList(space: string): void {
  rmSync(reviveListPath(space), { force: true });
}

/** A fresh pending list's names; a stale one is removed and said (never silently revived or dropped). */
export function pendingNames(space: string, now = Date.now(), say: (l: string) => void = (l) => console.error(l)): string[] {
  const list = readReviveList(space);
  if (!list) return [];
  if (isFresh(list, now)) return list.names;
  say(`paw: dropping a revive list from ${list.at} (older than ${REVIVE_FRESH_MS / 3_600_000}h): ${list.names.join(", ") || "(empty)"} — \`paw start <name>\` if any should still run`);
  clearReviveList(space);
  return [];
}

/** Write `names` ∪ the fresh pending list (order kept, pending first). Nothing to revive → no file. */
export function writeReviveList(space: string, names: string[], now = new Date()): ReviveList | undefined {
  const merged = [...new Set([...pendingNames(space, now.getTime()), ...names])];
  if (!merged.length) {
    clearReviveList(space);
    return undefined;
  }
  const list: ReviveList = { space, at: now.toISOString(), names: merged };
  const p = reviveListPath(space);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  renameSync(tmp, p);
  return list;
}

/** One process at a time revives a list. `wait: false` (ensure()) skips when another holds it. */
export async function withReviveLock<T>(space: string, fn: () => Promise<T>, wait: boolean): Promise<T | undefined> {
  const path = `${reviveListPath(space)}.lock`;
  const opts = { maxWaitMs: wait ? 15 * 60_000 : 0, staleMs: 2 * 60 * 60_000 };
  try {
    return await withFileLockAsync(path, fn, opts);
  } catch (e) {
    if (!wait && /timed out after \d+s acquiring lock/.test((e as Error).message)) return undefined;
    throw e;
  }
}

export type Skipped = { name: string; why: string };

/** Re-spawn `names` (paw's folder→name registry) under the current manager — each resumes its pinned
 *  session. Idempotent: ensureAgentSpawned reuses a live agent. A name with no folder, a vanished
 *  folder, a stuck seat or a refused spawn is SKIPPED with its reason, never fabricated. */
export async function reviveAgents(
  space: string,
  names: string[],
  say: (l: string) => void = (l) => console.log(l),
): Promise<{ revived: string[]; skipped: Skipped[] }> {
  const revived: string[] = [];
  const skipped: Skipped[] = [];
  if (!names.length) return { revived, skipped };
  await withManagerControl(space, pawServer(space), async (ctl) => {
    for (const name of names) {
      const folder = folderForName(space, name);
      if (!folder) {
        skipped.push({ name, why: "no folder registered for it" });
        continue;
      }
      if (!existsSync(folder)) {
        skipped.push({ name, why: `its folder ${folder} is gone` });
        continue;
      }
      // Anti-thundering-herd: a revival after a load-induced lease loss must not deepen the
      // starvation that caused it. Bounded — after the cap the spawn proceeds regardless.
      const headroom = await awaitSpawnHeadroom({
        onWait: (load, thr) => say(`  load ${load.toFixed(0)} > ${thr} — pausing revival until the machine has headroom…`),
      });
      if (headroom === "gave-up") say(`  still loaded after the wait cap — spawning ${name} anyway`);
      try {
        const r = await ensureAgentSpawned(ctl, { space, name, cwd: folder });
        if (r.stuck) skipped.push({ name, why: r.stuck });
        else revived.push(name);
      } catch (e) {
        skipped.push({ name, why: (e as Error).message }); // e.g. the two-writer guard — the rest still revive
      }
    }
  });
  return { revived, skipped };
}

/** The loud end of a revival that left someone down. Pure. */
export function revivalFailure(space: string, total: number, skipped: Skipped[]): string {
  return (
    `paw: ${skipped.length}/${total} agent(s) the restart meant to bring back did not start:\n` +
    skipped.map((s) => `  ${s.name}: ${s.why}`).join("\n") +
    `\n  start them by hand once fixed: paw start ${skipped.map((s) => s.name).join(" ")} --space ${space}`
  );
}

/** ensure()'s half: a manager is up and a failed restart's list is waiting — revive it, then delete it.
 *  A failure is printed loud but doesn't fail the unrelated command that happened to bring the manager up. */
export async function revivePending(space: string, revive: typeof reviveAgents = reviveAgents): Promise<void> {
  await withReviveLock(
    space,
    async () => {
      const names = pendingNames(space);
      if (!names.length) return clearReviveList(space);
      const at = readReviveList(space)!.at;
      console.error(`paw: a \`paw restart\` at ${at} failed after despawning — reviving ${names.join(", ")}`);
      const { revived, skipped } = await revive(space, names, (l) => console.error(l));
      clearReviveList(space);
      if (revived.length) console.error(`paw: revived ${revived.join(", ")}`);
      if (skipped.length) console.error(`${revivalFailure(space, names.length, skipped)}`);
    },
    false,
  );
}

/** A mailbox beacon's code root from its command line (`<root>/bin/paw.ts mailbox …`). Pure. */
export function mailboxRootFromCommand(cmd: string): string | undefined {
  return /(?:^|\s)(\/\S+)\/bin\/paw\.ts mailbox\b/.exec(cmd)?.[1];
}

function commandOf(pid: number): string {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

export interface LeftState {
  space: string;
  manager: { pids: number[]; root?: string };
  mailbox: { pids: number[]; root?: string };
  /** The release the restart was moving onto (daemonRoot()), or why it can't be named. */
  target: string;
  pending: string[];
  revivePath: string;
}

/** What a failed restart left behind, read from the live processes. */
export function readLeftState(space: string, pending: string[]): LeftState {
  const rootOf = (pids: number[], parse: (c: string) => string | undefined) => {
    for (const pid of pids) {
      const r = parse(commandOf(pid));
      if (r) return r;
    }
    return undefined;
  };
  const mgr = managerProcs(space);
  const mbx = mailboxProcs(space);
  let target: string;
  try {
    target = daemonRoot();
  } catch (e) {
    target = `(no release: ${(e as Error).message})`;
  }
  return {
    space,
    manager: { pids: mgr, root: rootOf(mgr, codeRootFromCommand) },
    mailbox: { pids: mbx, root: rootOf(mbx, mailboxRootFromCommand) },
    target,
    pending,
    revivePath: reviveListPath(space),
  };
}

/** The failed restart's message: the cause, then exactly what is up, down and pending, then how to finish. Pure. */
export function describeFailedRestart(cause: string, s: LeftState, describe: (root: string) => string = describeCodeRoot): string {
  const code = (root: string | undefined) => (root ? describe(root) : "unknown code");
  const manager = s.manager.pids.length
    ? `running (pid ${s.manager.pids.join(", ")}, ${code(s.manager.root)})`
    : "DOWN — no manager process for this space";
  const mailbox = !s.mailbox.pids.length
    ? "not running"
    : s.mailbox.root === s.target
      ? `running on ${code(s.mailbox.root)} (the new release)`
      : `running on ${code(s.mailbox.root)} — NOT the release this restart was moving to (${code(s.target)})`;
  const agents = s.pending.length ? `${s.pending.length} pending revive (saved in ${s.revivePath}): ${s.pending.join(", ")} (any still running are reused, not restarted)` : "none were live, nothing to revive";
  return (
    `${cause}\n\n` +
    `paw restart --space ${s.space} did not finish. left behind:\n` +
    `  manager: ${manager}\n` +
    `  mailbox: ${mailbox}\n` +
    `  agents:  ${agents}\n` +
    (s.pending.length
      ? `to finish: \`paw restart --space ${s.space}\` will bring back: ${s.pending.join(", ")} (any command that starts the manager in the next 24h revives them too)`
      : `to finish: \`paw restart --space ${s.space}\``)
  );
}

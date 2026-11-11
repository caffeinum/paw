/**
 * The launchd jobs paw installs, read-only: their labels, plist paths, the fleet job's argv shape and
 * each job's launchctl state. A LEAF (no registry import) so `paw doctor` can read the jobs without
 * registering `paw launchd`; src/commands/launchd.ts imports and re-exports everything here.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FLEET_LABEL = "dev.cotal.paw";
export const WEB_LABEL = "dev.cotal.paw-web";
/** The keeper for `global` — the one agent that must ALWAYS be up, because it is the wake authority
 *  (`cotal_dm("global", "wake <name>")`): when global itself is down the whole convention is dead
 *  and agents can only escalate to a human (2026-08-26: `personal` found vibeos-landing offline AND
 *  global offline, and had to shell out). Shaped as `paw global` on a StartInterval: idempotent
 *  (ensureAgentSpawned reuses a live one), so a healthy tick costs one ps round-trip and a dead
 *  global is back within the interval. NOT KeepAlive (the job exits by design) and NOT the fleet
 *  job's re-run (that would re-wake agents the operator deliberately stopped — only global is
 *  supposed to be un-stoppable). */
export const GLOBAL_LABEL = "dev.cotal.paw-global";
export const GLOBAL_INTERVAL_S = 60;

export function plistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * The fleet job's argv with agent `from` renamed to `to`, or undefined when that job doesn't start
 * `from` in `space`. Only the names between `start` and `--space` are touched, so a rename to or from
 * a word that is also the space (`paw`) can't rewrite the flag's value.
 */
export function renameInFleetArgs(args: string[], space: string, from: string, to: string): string[] | undefined {
  const start = args.indexOf("start");
  const flag = args.indexOf("--space", start + 1);
  if (start < 0 || flag < 0 || args[flag + 1] !== space) return undefined;
  const at = args.slice(start + 1, flag).indexOf(from);
  if (at < 0) return undefined;
  const out = [...args];
  out[start + 1 + at] = to;
  return out;
}

/** Does a fleet job's argv bring back every space (`paw start --boot`)? Older installs ran a plain `paw start`. */
export function fleetJobBoots(args: string[]): boolean {
  const start = args.indexOf("start");
  return start >= 0 && args.slice(start + 1).includes("--boot");
}

export type JobPlist = { path: string; plist: Record<string, unknown> & { ProgramArguments: string[] } };

/** An installed job's plist (path + its JSON), or undefined when there is none. A malformed one throws. */
export function readJobPlist(label: string, plutil: (path: string) => string = plutilJson): JobPlist | undefined {
  const path = plistPath(label);
  if (!existsSync(path)) return undefined;
  const plist = JSON.parse(plutil(path)) as Record<string, unknown>;
  const args = plist.ProgramArguments;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`paw: ${path} has no string ProgramArguments — fix or reinstall it (\`paw launchd install\`)`);
  }
  return { path, plist: { ...plist, ProgramArguments: args } };
}

function plutilJson(path: string): string {
  return execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
}

export const launchdDomain = (): string => `gui/${process.getuid?.() ?? 501}`;

export type Launchctl = (args: string[]) => { ok: boolean; out: string };

export const launchctl: Launchctl = (args) => {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: (err.stderr || err.stdout || err.message).trim() };
  }
};

/** One job's state as launchctl reports it: `not installed`, `installed, not loaded`, `running (pid N)`,
 *  `loaded, idle (last exit N)`. */
export function jobState(label: string, run: Launchctl = launchctl): string {
  if (!existsSync(plistPath(label))) return "not installed";
  const r = run(["print", `${launchdDomain()}/${label}`]);
  if (!r.ok) return "installed, not loaded";
  const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
  const exit = /last exit code = (\S+)/.exec(r.out)?.[1];
  return pid ? `running (pid ${pid})` : `loaded, idle${exit ? ` (last exit ${exit})` : ""}`;
}

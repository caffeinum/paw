/**
 * What the RUNNING manager's code can do — the CLI and the manager are different builds. The CLI is the
 * checkout (`~/.local/bin/paw` execs ~/Github/paw); the manager runs an immutable release it loaded at
 * startup (src/release.ts), and a manager that predates a persona key ignores it or refuses the launch
 * AFTER accepting the spawn, which cotal logs nowhere: paw only saw a seat that never reached the mesh.
 * (2026-10-20: `paw restart ccswitch --agent kit -- -m grok-4.7` wrote `kitArgs:` with no `provider:`;
 * the manager ran release 7b8139964144, whose kit connector requires `provider:` — the seat was
 * stopped and never came back, and the CLI sat silent in its readiness wait.)
 *
 * The contract: `src/manager-features.json` lists what this tree's manager-side code (the connectors
 * the manager loads) supports. A release snapshots it with the rest of src/, so the file in the
 * manager's OWN root is the truth about the manager. A root with no file predates the contract and has
 * no features. Add a feature name to the json when a connector learns something the CLI must not ask of
 * an older manager, and check it with {@link assertManagerFeature} before writing or spawning anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { managerProcs } from "./lifecycle.ts";
import { daemonRoot, releasesDir } from "./release.ts";

export const MANAGER_FEATURES_FILE = join("src", "manager-features.json");

/** `kitArgs:` (kit's own flags, verbatim) and a kit persona with no `provider:` (a `-m`/`-P` stands in). */
export const KIT_ARGS_FEATURE = "kit-args";

/** A kit persona with no `provider:` and no `-m`/`-P`: kit picks its own defaults (kit fe1d8f4). */
export const KIT_DEFAULTS_FEATURE = "kit-defaults";

/** The tree a manager process runs: `<root>/bin/cotald.ts supervise …` from its command line. Pure. */
export function codeRootFromCommand(cmd: string): string | undefined {
  return /(?:^|\s)(\/\S+)\/bin\/cotald\.ts supervise\b/.exec(cmd)?.[1];
}

/** The code root of `space`'s live paw-owned manager, or undefined when none runs. A live manager whose
 *  command line names no root is a contract break — said, never guessed. */
export function runningManagerRoot(space: string, pids: number[] = managerProcs(space)): string | undefined {
  for (const pid of pids) {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const cmd = r.status === 0 ? r.stdout.trim() : "";
    if (!cmd.includes("supervise")) continue;
    const root = codeRootFromCommand(cmd);
    if (!root) throw new Error(`paw: space ${space}'s manager (pid ${pid}) runs \`${cmd}\` — no <root>/bin/cotald.ts in it to say which paw it is`);
    return root;
  }
  return undefined;
}

/** The features `root`'s manager-side code supports. No file = predates the contract = none. */
export function codeRootFeatures(root: string): string[] {
  const file = join(root, MANAGER_FEATURES_FILE);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${file} is not valid JSON (${(e as Error).message})`);
  }
  const features = (parsed as { features?: unknown })?.features;
  if (!Array.isArray(features) || !features.every((f) => typeof f === "string")) throw new Error(`paw: ${file} has no "features" list of strings`);
  return features;
}

/** "release 7b8139964144" for a release root, else the path (the checkout under PAW_RELEASE=dev). */
export function describeCodeRoot(root: string): string {
  const rel = relative(releasesDir(), root);
  return rel && !rel.startsWith("..") && !rel.includes("/") ? `release ${rel}` : root;
}

/**
 * Refuse (before anything is written or spawned) when the manager that would launch `space`'s agent
 * can't do `feature`: the live manager's root, else the root ensure() would start one from. `need` says
 * what asked for it. The fix bounces every agent in the space, so it is printed for the operator, never run.
 */
export function assertManagerFeature(
  space: string,
  feature: string,
  need: string,
  deps: { running?: () => string | undefined; next?: () => string } = {},
): void {
  const live = (deps.running ?? (() => runningManagerRoot(space)))();
  const root = live ?? (deps.next ?? daemonRoot)();
  if (codeRootFeatures(root).includes(feature)) return;
  const which = describeCodeRoot(root);
  throw new Error(
    live
      ? `paw: ${need} needs a manager that supports "${feature}", but space ${space}'s manager runs ${which}, which predates it — ` +
          `nothing was changed. Cut a release from this checkout and restart the manager first (it restarts every agent in ${space}, ` +
          `each resuming its session): \`paw release\`, then \`paw restart --space ${space}\``
      : `paw: ${need} needs a manager that supports "${feature}", but the manager space ${space} would start runs ${which}, which predates it — ` +
          `nothing was changed. \`paw release\` snapshots this checkout first`,
  );
}

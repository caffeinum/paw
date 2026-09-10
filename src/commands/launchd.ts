/**
 * `paw launchd` — bring the fleet (and `paw web`) up at LOGIN, without a human typing a paw command.
 *
 *   paw launchd install <name>… [--no-web] [--web-port N] [--space s]
 *   paw launchd uninstall [--space s]
 *   paw launchd [status] [--space s]
 *
 * WHY: paw's daemons are lazy — mesh, manager, mailbox and web come up on the first paw command that
 * `ensure()`s them, and after a reboot NOTHING runs until the operator types one. The 2026-08-21
 * reboot left the fleet down for hours for exactly that reason. The Telegram bridge already had a
 * launchd job (`dev.cotal.telegram`); paw itself didn't.
 *
 * TWO jobs, deliberately shaped differently:
 *  - `dev.cotal.paw` runs `paw start <names…>` ONCE at login (RunAtLoad, NO KeepAlive). `paw start`
 *    is a one-shot that exits after the fleet is up; the daemons it ensures are DETACHED and outlive
 *    it. KeepAlive on a one-shot would make launchd re-run it every ThrottleInterval forever — and a
 *    periodic `paw start` would also re-wake any agent the operator had deliberately `paw stop`ped.
 *  - `dev.cotal.paw-web` runs `paw web --no-open` with KeepAlive: a long-lived server is what
 *    KeepAlive is FOR (it dies → launchd restarts it).
 *
 * The agent LIST is explicit, baked into the plist: `paw start` with no names starts EVERY registered
 * agent (28 on this machine), which is the thundering herd that took the box down. With no names
 * given, install captures the agents LIVE right now — "make what's running come back at login" — and
 * fails loud if nothing is live, rather than guessing. The spawn-pacing gate (src/pacing.ts) still
 * staggers the boot.
 *
 * Runs the CLI the documented way — node + tsx over the CHECKOUT's bin/paw.ts (the daemons it
 * ensures resolve through the pinned release, as always). PATH is written into the plist from
 * `toolDirs()` because launchd starts jobs with a minimal environment — the same class of failure
 * `nodeBin`/`withToolPath` exist for.
 *
 * LOCAL — it writes plists and talks to launchctl; out of bin/paw.ts's NEEDS_* gating.
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { psRowAlive, type PsRow } from "../addressing.js";
import { withManagerControl } from "../control.js";
import { nodeBin, resolveSpace, toolDirs } from "../lifecycle.js";
import { REPO_ROOT } from "../release.js";

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

export interface LaunchdArgs {
  action: "install" | "uninstall" | "status";
  names: string[];
  web: boolean;
  global: boolean;
  webPort?: number;
  space?: string;
}

export function parseLaunchdArgs(argv: string[]): LaunchdArgs {
  const out: LaunchdArgs = { action: "status", names: [], web: true, global: true };
  let actionSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--no-web") out.web = false;
    else if (a === "--no-global") out.global = false;
    else if (a === "--web-port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`paw: --web-port needs a port number, got "${argv[i]}"`);
      out.webPort = n;
    } else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — launchd install|uninstall|status [<name>…] [--no-web] [--web-port N] [--space <s>]`);
    else if (!actionSet && (a === "install" || a === "uninstall" || a === "status")) {
      out.action = a;
      actionSet = true;
    } else if (actionSet && out.action === "install") out.names.push(a);
    else throw new Error(`paw: unexpected "${a}" — launchd install|uninstall|status [<name>…]`);
  }
  return out;
}

export interface JobSpec {
  label: string;
  args: string[];
  keepAlive: boolean;
  /** Re-run every N seconds (launchd StartInterval). For a one-shot reconcile, not a daemon. */
  startInterval?: number;
  log: string;
  cwd: string;
  env: Record<string, string>;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The plist body for a job. Pure — asserted byte-for-byte in check:commands. */
export function renderPlist(job: JobSpec): string {
  const env = Object.entries(job.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(job.label)}</string>
  <key>ProgramArguments</key>
  <array>
${job.args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(job.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <${job.keepAlive ? "true" : "false"}/>${job.startInterval ? `\n  <key>StartInterval</key>\n  <integer>${job.startInterval}</integer>` : ""}
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(job.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(job.log)}</string>
</dict>
</plist>
`;
}

/** A node path that SURVIVES upgrades. A plist bakes ONE absolute path for the life of the job, and every
 *  real node binary lives in a VERSIONED directory — brew's Cellar (a `brew upgrade node` deleted it and
 *  took paw-web/fleet/global down at once, 2026-08-31) and nvm's `versions/node/vX` alike. On this box
 *  node comes from nvm, never brew (operator rule), and nvm has no fixed symlink — so the stable thing
 *  paw can bake is a SHIM it owns (`$PAW_HOME/bin/node`) that sources nvm.sh and execs `nvm which default`
 *  at launch: nvm itself picks the node every time the job starts, so an `nvm install`/`alias default`
 *  later needs no reinstall. Falls back to nodeBin() (resolved once, baked) when nvm isn't installed. */
export function stableNodeBin(): string {
  const nvmDir = process.env.NVM_DIR ?? join(homedir(), ".nvm");
  if (!existsSync(join(nvmDir, "nvm.sh"))) return nodeBin();
  const dir = join(pawHome(), "bin");
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "node");
  writeFileSync(shim, nvmShim(nvmDir), { mode: 0o755 });
  chmodSync(shim, 0o755);
  return shim;
}
/** The shim body: nvm's own resolution, no re-implementation. `--no-use` skips the slow auto-use on
 *  source; `nvm which default` prints the absolute binary; exec so the job's pid IS node. */
export function nvmShim(nvmDir: string): string {
  return `#!/bin/sh
# paw-owned node shim: let nvm pick the DEFAULT node at launch time (written by \`paw launchd install\`).
export NVM_DIR=${JSON.stringify(nvmDir)}
. "$NVM_DIR/nvm.sh" --no-use || { echo "paw node shim: can't source $NVM_DIR/nvm.sh" >&2; exit 78; }
NODE="$(nvm which default 2>/dev/null)"
[ -x "$NODE" ] || { echo "paw node shim: nvm has no usable default node (nvm alias default <v>)" >&2; exit 78; }
exec "$NODE" "$@"
`;
}
function pawHome(): string {
  return process.env.PAW_HOME ?? join(homedir(), ".paw");
}

/** The CLI invocation every job shares: absolute node, the checkout's tsx, the checkout's bin/paw.ts. */
function pawCli(): string[] {
  return [stableNodeBin(), join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO_ROOT, "bin", "paw.ts")];
}

function jobEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: toolDirs().join(":"), HOME: homedir() };
  // The state root + a pinned release are the two things a login shell might carry that the job must
  // agree with; forward them only when the operator actually set them.
  for (const k of ["PAW_HOME", "PAW_RELEASE", "PAW_RUNTIME"]) if (process.env[k]) env[k] = process.env[k] as string;
  return env;
}

export function fleetJob(space: string, names: string[], opts: { cli?: string[]; env?: Record<string, string>; log: string; cwd: string }): JobSpec {
  return {
    label: FLEET_LABEL,
    args: [...(opts.cli ?? pawCli()), "start", ...names, "--space", space],
    keepAlive: false,
    log: opts.log,
    cwd: opts.cwd,
    env: opts.env ?? jobEnv(),
  };
}

export function webJob(space: string, port: number | undefined, opts: { cli?: string[]; env?: Record<string, string>; log: string; cwd: string }): JobSpec {
  return {
    label: WEB_LABEL,
    args: [...(opts.cli ?? pawCli()), "web", "--no-open", ...(port ? ["--port", String(port)] : []), "--space", space],
    keepAlive: true,
    log: opts.log,
    cwd: opts.cwd,
    env: opts.env ?? jobEnv(),
  };
}

export function globalJob(space: string, opts: { cli?: string[]; env?: Record<string, string>; log: string; cwd: string }): JobSpec {
  return {
    label: GLOBAL_LABEL,
    args: [...(opts.cli ?? pawCli()), "global", "--space", space],
    keepAlive: false,
    startInterval: GLOBAL_INTERVAL_S,
    log: opts.log,
    cwd: opts.cwd,
    env: opts.env ?? jobEnv(),
  };
}

export function plistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function logPath(space: string, name: string): string {
  const dir = join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "spaces", space);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.log`);
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: (err.stderr || err.stdout || err.message).trim() };
  }
}

/** Write + (re)load one job. bootout first so a re-install replaces the running definition.
 *  The bootstrap RETRIES once: launchd answers `Bootstrap failed: 5: Input/output error` when the
 *  bootout it just did hasn't finished tearing the old instance down (seen live 2026-09-01 on the
 *  KeepAlive web job — the same plist bootstrapped fine by hand two seconds later). Returns the
 *  failure instead of throwing so `install` can finish writing EVERY plist before it reports: the
 *  first version threw here, and one job's race left the jobs after it on their STALE definition
 *  (global still pointed at the deleted brew node while the command said it had installed it). */
function loadJob(job: JobSpec): string | undefined {
  const path = plistPath(job.label);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  launchctl(["bootout", `${domain()}/${job.label}`]); // absent is fine
  writeFileSync(path, renderPlist(job));
  let r = launchctl(["bootstrap", domain(), path]);
  if (!r.ok && /Input\/output error/.test(r.out)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // let the bootout settle (sync command path)
    r = launchctl(["bootstrap", domain(), path]);
  }
  // launchd sometimes answers EIO for a bootstrap that nevertheless took (the job is listed, with a
  // pid, seconds later — seen live 2026-09-01). The truth is whether the label is loaded, so ask.
  if (!r.ok && launchctl(["print", `${domain()}/${job.label}`]).ok) return undefined;
  return r.ok ? undefined : `paw: launchctl bootstrap ${job.label} failed: ${r.out}`;
}

function unloadJob(label: string): boolean {
  const path = plistPath(label);
  launchctl(["bootout", `${domain()}/${label}`]);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Who's live right now — the default install list. Empty when the manager's down. */
async function liveNames(space: string): Promise<string[]> {
  try {
    return await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
      const ps = await ctl.ps();
      return ps.ok ? ((ps.data as PsRow[]) ?? []).filter(psRowAlive).map((r) => r.name) : [];
    });
  } catch {
    return [];
  }
}

function jobState(label: string): string {
  if (!existsSync(plistPath(label))) return "not installed";
  const r = launchctl(["print", `${domain()}/${label}`]);
  if (!r.ok) return "installed, not loaded";
  const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
  const exit = /last exit code = (\S+)/.exec(r.out)?.[1];
  return pid ? `running (pid ${pid})` : `loaded, idle${exit ? ` (last exit ${exit})` : ""}`;
}

async function run(argv: string[]): Promise<void> {
  const a = parseLaunchdArgs(argv);
  const space = a.space ?? resolveSpace();

  if (a.action === "status") {
    console.log(`${FLEET_LABEL}      ${jobState(FLEET_LABEL)}`);
    console.log(`${WEB_LABEL}  ${jobState(WEB_LABEL)}`);
    console.log(`${GLOBAL_LABEL}  ${jobState(GLOBAL_LABEL)}  (every ${GLOBAL_INTERVAL_S}s: \`paw global\`)`);
    console.log(`  plists: ${plistPath(FLEET_LABEL)} · ${plistPath(WEB_LABEL)} · ${plistPath(GLOBAL_LABEL)}`);
    return;
  }

  if (a.action === "uninstall") {
    const f = unloadJob(FLEET_LABEL);
    const w = unloadJob(WEB_LABEL);
    const g = unloadJob(GLOBAL_LABEL);
    console.log(`✓ paw launchd — removed ${[f && FLEET_LABEL, w && WEB_LABEL, g && GLOBAL_LABEL].filter(Boolean).join(", ") || "nothing (not installed)"}`);
    return;
  }

  let names = a.names;
  if (!names.length) {
    names = await liveNames(space);
    if (!names.length) {
      throw new Error(
        "paw: nothing is live to capture and no agents were named — `paw launchd install <name>…`\n" +
          "  (not the whole registry: starting every registered agent at login is the herd that took the machine down)",
      );
    }
    console.log(`  capturing the live fleet: ${names.join(", ")}`);
  }

  const cwd = homedir();
  // Every plist is WRITTEN and every bootstrap ATTEMPTED before any failure is reported: a job that
  // won't load must not leave the jobs after it on their stale definition (2026-09-01: the web job's
  // bootstrap race aborted the install and global kept pointing at a node that no longer existed).
  const failures: string[] = [];
  const load = (job: JobSpec, okLine: string): void => {
    const err = loadJob(job);
    if (err) { failures.push(err); console.log(`✗ ${job.label}: not loaded — ${err}`); } else console.log(okLine);
  };
  load(fleetJob(space, names, { log: logPath(space, "launchd"), cwd }), `✓ ${FLEET_LABEL}: \`paw start ${names.join(" ")}\` at login (running now)`);
  if (a.web) {
    load(webJob(space, a.webPort, { log: logPath(space, "launchd-web"), cwd }), `✓ ${WEB_LABEL}: \`paw web --no-open${a.webPort ? ` --port ${a.webPort}` : ""}\` kept alive`);
  } else {
    unloadJob(WEB_LABEL);
  }
  if (a.global) {
    load(globalJob(space, { log: logPath(space, "launchd-global"), cwd }), `✓ ${GLOBAL_LABEL}: \`paw global\` every ${GLOBAL_INTERVAL_S}s — global can't stay down`);
  } else {
    unloadJob(GLOBAL_LABEL);
  }
  console.log(`  logs: ${logPath(space, "launchd")}${a.web ? ` · ${logPath(space, "launchd-web")}` : ""}`);
  console.log("  `paw launchd status` to check · `paw launchd uninstall` to remove");
  if (failures.length) {
    throw new Error(`${failures.length} launchd job(s) did not load (plists are written; re-run \`paw launchd install\` or \`launchctl bootstrap gui/$UID ~/Library/LaunchAgents/<label>.plist\`):\n  ${failures.join("\n  ")}`);
  }
}

const launchdCommand: Command = {
  kind: "command",
  name: "launchd",
  group: "Lifecycle",
  summary: "start the fleet (and paw web) at login via launchd — install <name>… | uninstall | status",
  usage: "launchd install <name>… [--no-web] [--web-port N] [--no-global] · launchd uninstall · launchd status   [--space <s>]",
  run: (a) => run([...a.raw]),
};

registry.register(launchdCommand);

/**
 * paw's daemon lifecycle: bring the mesh + control-plane manager up on demand so the operator
 * never runs `paw up` / `paw supervise` by hand, and tear down only what paw itself started.
 *
 * This builds on cotal — it never forks it. The mesh/manager are started by DRIVING cotal's public
 * `up`/`supervise` commands through bin/cotald.ts (the cotal composition root) under node+tsx
 * (cotaldViaTsx) — never the current CLI runtime, which may be bun (bun can't host the mesh
 * manager's native node-pty). Reachability is
 * probed with cotal's isReachable, and the control plane with a real `ps` round-trip over a CotalEndpoint.
 * paw layers on top: a machine-wide default space (one shared mesh for all folder-named agents),
 * a serialized ensure() sequence, a one-shot respawn (never a loop), readiness gates so a following
 * `start` can't race, and per-space ownership markers under ~/.paw so stop() only kills paw's own
 * daemons — never the operator's hand-run mesh.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
} from "@cotal-ai/core";
// The machine-local workstation layer (auth paths, mesh registry) split out of core into
// @cotal-ai/workspace in cotal v0.8 (#120).
import { authDir, loadSpaceAuth, saveSpaceAuth } from "@cotal-ai/workspace";
import { daemonRoot } from "./release.js";
import { pawCotalRoot } from "./cotal-root.js";
import { withManagerControl } from "./control.js";
import { withFileLock } from "./lock.js";

export interface EnsureOpts {
  /** Bring up (or adopt) the NATS mesh. Commands that talk to the mesh need this. */
  needMesh?: boolean;
  /** Bring up (or adopt) the control-plane manager. `start`/`ps`/`attach`/`stop` need this. */
  needManager?: boolean;
  /** Override the resolved space (defaults to resolveSpace()). */
  space?: string;
}

/** Machine-wide default space. A folder maps to an agent NAME, not a space, so every paw agent
 *  shares ONE mesh and can address its peers. PAW_SPACE overrides for an isolated mesh. */
const DEFAULT_SPACE = "paw";

/** The single space all paw agents share unless explicitly overridden. */
export function resolveSpace(): string {
  const override = process.env.PAW_SPACE?.trim();
  return override && override.length > 0 ? override : DEFAULT_SPACE;
}

/** The manager runtimes bin/cotald.ts registers (pty ships with the manager; tmux/cmux are the
 *  imported integrations). `pty` = headless warm agents (paw's default); `cmux`/`tmux` give each
 *  agent its own visible terminal tab/pane. */
export type Runtime = "pty" | "tmux" | "cmux";
export const RUNTIMES: readonly Runtime[] = ["pty", "tmux", "cmux"];

/** Parse a string into a Runtime, or undefined if it isn't one — for validating persisted/env values. */
function asRuntime(v: string | undefined): Runtime | undefined {
  const t = v?.trim();
  return t && (RUNTIMES as readonly string[]).includes(t) ? (t as Runtime) : undefined;
}

/** The runtime paw brings the manager up under, in precedence order:
 *    1. `PAW_RUNTIME` env (a one-shot override) — fails LOUD on garbage, never silently falls back;
 *    2. the space's sticky preference file (`paw runtime <r>`), only when a `space` is passed;
 *    3. `pty` (paw's headless default).
 *  The env stays fail-loud (a typo'd runtime should stop, not headlessly ignore the operator); a
 *  garbage preference FILE is ignored (it's read back, not typed live — treat corruption as unset). */
export function resolveRuntime(space?: string): Runtime {
  const env = process.env.PAW_RUNTIME?.trim();
  if (env) {
    const r = asRuntime(env);
    if (!r) throw new Error(`paw: PAW_RUNTIME="${env}" is not a runtime — expected ${RUNTIMES.join(", ")}`);
    return r;
  }
  if (space !== undefined) {
    const pref = readRuntimePreference(space);
    if (pref) return pref;
  }
  return "pty";
}

/**
 * Refuse a runtime paw's lifecycle structurally can't drive, BEFORE it kills a working manager to
 * switch. `cmux` spawns each agent into a cmux surface, which needs `CMUX_SOCKET_PATH` in the
 * spawning process — but paw starts the manager as a DETACHED daemon. That daemon inherits the
 * launching shell's env, so cmux works ONLY when `paw` itself is run from inside a cmux surface;
 * otherwise the manager comes up but every agent spawn fails ("cmux couldn't reach the app"). Fail
 * loud early so `paw runtime cmux` never strands the operator with a manager that can't spawn. `pty`
 * and `tmux` are always usable (tmux auto-starts its own server). Raw `paw cotal supervise --runtime
 * cmux` from inside cmux stays available — this only gates paw's OWN auto-managed daemon.
 */
export function assertRuntimeUsable(runtime: Runtime): void {
  if (runtime !== "cmux") return;
  // cmux is a SINGLETON app reachable over a stable DEFAULT unix socket — `cmux ping` finds it from
  // any shell, no cmux surface needed. paw starts the manager WITHOUT a surface-tied CMUX_SOCKET_PATH
  // (see startManagerDaemon), so probe exactly the way the manager will reach it: with that var unset.
  // (A stale surface socket the CLI would PREFER over the default is the "only works from the same
  // tab" bug — probing the default is the honest reachability signal.)
  const env = withToolPath({ ...process.env });
  delete env.CMUX_SOCKET_PATH;
  const r = spawnSync(cmuxBin(), ["ping"], { stdio: "ignore", env });
  if (r.error || r.status !== 0) {
    throw new Error(
      "paw: cmux runtime requested but the cmux app isn't reachable (`cmux ping` failed) — is cmux " +
        "running? Use `paw runtime tmux` or `paw runtime pty` otherwise.",
    );
  }
}

/** paw's per-space state dir under ~/.paw (pid/lock/log + ownership markers). Kept separate from
 *  cotal's `.cotal/` so paw owns its own singleton bookkeeping and cotal keeps creds/agent-files. */
function pawDir(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const dir = join(root, "spaces", space);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function meshPidPath(space: string): string {
  return join(pawDir(space), "mesh.pid");
}
function managerPidPath(space: string): string {
  return join(pawDir(space), "manager.pid");
}
/** Records the runtime paw last started the manager under, next to manager.pid — so ensure() can
 *  tell a running pty manager from a requested cmux one and restart on a mismatch. */
function managerRuntimePath(space: string): string {
  return join(pawDir(space), "manager.runtime");
}
/** The recorded runtime of the manager paw started, or undefined if there's no (valid) marker.
 *  Exported for `paw runtime` (the "last started" line) — a per-space daemon marker, dropped on down. */
export function readRuntimeMarker(space: string): Runtime | undefined {
  return asRuntime(existsSync(managerRuntimePath(space)) ? readFileSync(managerRuntimePath(space), "utf8") : undefined);
}

/** The sticky per-space runtime preference the operator last set with `paw runtime <r>`. Unlike the
 *  manager.runtime MARKER (which daemon paw started, dropped on `paw down`), this is a DURABLE choice
 *  that outlives daemons — `stop()`/`paw down` keeps it. `~/.paw/spaces/<space>/runtime`. */
export function runtimePreferencePath(space: string): string {
  return join(pawDir(space), "runtime");
}
/** The space's runtime preference, or undefined if unset / garbage on disk (corruption → treat as
 *  unset so resolveRuntime falls through to pty, never fails loud on a file it read back itself). */
export function readRuntimePreference(space: string): Runtime | undefined {
  const p = runtimePreferencePath(space);
  return asRuntime(existsSync(p) ? readFileSync(p, "utf8") : undefined);
}
/** Persist the space's sticky runtime preference (validated by the caller against RUNTIMES). */
export function writeRuntimePreference(space: string, r: Runtime): void {
  writeFileSync(runtimePreferencePath(space), r);
}
function mailboxPidPath(space: string): string {
  return join(pawDir(space), "mailbox.pid");
}
function mailboxLogPath(space: string): string {
  return join(pawDir(space), "mailbox.log");
}
function meshLogPath(space: string): string {
  return join(pawDir(space), "mesh.log");
}
function managerLogPath(space: string): string {
  return join(pawDir(space), "manager.log");
}
function lockPath(space: string): string {
  return join(pawDir(space), "lifecycle.lock");
}
/** Where cotal drops the detached mesh's JetStream store; pinned by paw so it's stable per space. */
function meshStoreDir(space: string): string {
  return join(pawDir(space), "nats");
}

/** True if `pid` is a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read a recorded pid from one of paw's ownership markers, or undefined if absent/garbage. */
function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/** Record a pid paw started, so stop() knows it owns this daemon. */
function writePid(path: string, pid: number): void {
  writeFileSync(path, String(pid));
}

/** Last `tailN` lines of a log file (for surfacing a failed boot), or a note if it's missing. */
function tail(path: string, tailN = 25): string {
  if (!existsSync(path)) return `(no log at ${path})`;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  return lines.slice(-tailN).join("\n");
}

/**
 * Serialize the whole ensure/stop sequence under an exclusive lock keyed at paw's per-space root,
 * mirroring connector.ts withLock(): exclusive-create a lock file, retry with a short sync sleep,
 * and break a stale lock left by a crashed process. Async fn so the lock spans the awaited boot.
 */
async function withLock<T>(space: string, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(space);
  const maxWaitMs = 30_000; // a cold mesh+manager boot can take seconds — wait it out
  const staleMs = 60_000;
  const stepMs = 25;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; ; waited += stepMs) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid)); // record holder so a crashed holder is detectable
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Break a crashed holder immediately (its recorded pid is dead); else fall back to mtime age.
      const holder = readPid(path);
      if (holder !== undefined && !alive(holder)) {
        rmSync(path, { force: true });
        continue;
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (waited >= maxWaitMs) throw new Error(`paw: timed out acquiring lifecycle lock ${path}`);
      Atomics.wait(sleeper, 0, 0, stepMs);
      continue;
    }
    try {
      return await fn();
    } finally {
      closeSync(fd);
      rmSync(path, { force: true });
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the argv to drive `entry` (one of paw's composition roots) under **node+tsx, regardless of
 * how this CLI process was launched**. The CLI may run under bun (fast startup), but the daemons
 * MUST be node+tsx: bun can't drive @lydell/node-pty's native ioctl, so a bun-spawned manager
 * produces pty stubs that never become claude (it bricked every agent twice). Invoke the repo's tsx
 * bin directly (what the launcher itself uses); fall back to the current runtime + process.execArgv
 * only if the bin is missing. Returns [exec, args].
 */
/**
 * The node binary to run the daemons with, resolved ABSOLUTELY — never via PATH.
 *
 * WHY (2026-08-04): `node_modules/.bin/tsx` is a shell shim whose last line is a bare `exec node …`,
 * so spawning a daemon through it needs `node` resolvable in the CHILD's PATH. paw's launcher already
 * resolves bun absolutely, so the CLI itself runs from anywhere — which is exactly what hid this: paw
 * works right up until it has to START a daemon, and then dies with
 * `tsx: line 20: exec: node: not found` in mesh.log/manager.log while the operator's terminal shows a
 * generic "mesh failed to start". The caller that exposed it is the Raycast extension, which invokes
 * paw with Raycast's minimal PATH (no shell rc, no nvm, no /opt/homebrew/bin) — but a launchd job or
 * any stripped environment does the same.
 *
 * Order: the runtime we're already in (when that IS node — the common case under tsx), then the usual
 * absolute installs, then nvm's default alias. Fails LOUD rather than handing back a bare "node" that
 * would fail later, in a log, as somebody else's error.
 */
/** Resolve nvm's DEFAULT node the way nvm does, without sourcing nvm.sh: follow the alias chain
 *  (`default` → `stable` / `lts/*` / `24` / `v24.13.0`) to a versioned install under `<nvmDir>/versions/node`.
 *  `stable`/`node`/`latest` = highest installed; `lts/*` = its alias file if present, else the highest
 *  installed EVEN major; a bare/partial version = highest installed match. Returns undefined when nvm
 *  isn't here or nothing matches — never a fabricated path. nvmDir is injectable so tests can build a
 *  fake tree. */
export function resolveNvmDefault(nvmDir = join(homedir(), ".nvm")): string | undefined {
  const versionsDir = join(nvmDir, "versions", "node");
  let installed: string[];
  try {
    installed = readdirSync(versionsDir).filter((d) => /^v\d+\.\d+\.\d+$/.test(d));
  } catch {
    return undefined;
  }
  const byNewest = [...installed].sort((a, b) => cmpSemver(b, a));
  const readAlias = (name: string): string | undefined => {
    try { return readFileSync(join(nvmDir, "alias", name), "utf8").trim() || undefined; } catch { return undefined; }
  };
  let ref = readAlias("default");
  for (let hops = 0; ref && hops < 8; hops++) {
    if (ref === "stable" || ref === "node" || ref === "latest") { ref = byNewest[0]; break; }
    if (ref === "lts/*") { const a = readAlias("lts/*"); ref = a ?? byNewest.find((v) => Number(v.slice(1).split(".")[0]) % 2 === 0); if (!a) break; continue; }
    if (/^v\d+\.\d+\.\d+$/.test(ref)) break;
    const partial = ref.replace(/^v/, "");
    if (/^\d+(\.\d+)?$/.test(partial)) { ref = byNewest.find((v) => v.slice(1) === partial || v.slice(1).startsWith(partial + ".")); break; }
    const next = readAlias(ref); // a named alias pointing at another alias/version
    if (!next) return undefined;
    ref = next;
  }
  if (!ref) return undefined;
  const bin = join(versionsDir, ref, "bin", "node");
  return existsSync(bin) ? bin : undefined;
}
function cmpSemver(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number), pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The node the DAEMONS run under. nvm's default comes FIRST — on this box node comes from nvm, never
 *  brew (operator rule, 2026-09-01); brew node is merely what sits in PATH, which is why `process.execPath`
 *  kept resolving to it and a `brew upgrade node` then took every daemon down. The running process's own
 *  node is next (a CLI already under nvm), then the fixed system paths as a last resort. Fails loud when
 *  nothing is found — a bare "node" would fail later as somebody else's error. */
export function nodeBin(): string {
  const nvm = resolveNvmDefault();
  if (nvm) return nvm;
  if (basename(process.execPath) === "node") return process.execPath;
  const candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `paw: can't find a node binary to run the daemons with (no nvm default under ~/.nvm; looked in ${candidates.join(", ")}). ` +
        `paw's daemons must run under node+tsx; install node via nvm (\`nvm alias default <v>\`) or put it at one of those paths.`,
    );
  }
  return found;
}

/**
 * Build the argv to run `entry` under node+tsx. Invokes tsx's cli.mjs with an ABSOLUTE node rather
 * than the `.bin/tsx` shell shim, so the spawn carries no PATH dependency at all (see nodeBin).
 */
function viaTsx(entry: string, sub: string[]): [string, string[]] {
  // The RELEASE's tsx, not the checkout's (src/release.ts): a daemon must be ONE self-consistent
  // tree — an entry file from one paw paired with node_modules from another mid-install is exactly
  // the version split that put two incompatible managers on the mesh and took the fleet down.
  const root = daemonRoot();
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsxCli)) return [nodeBin(), [tsxCli, entry, ...sub]];
  const tsxBin = join(root, "node_modules", ".bin", "tsx");
  return existsSync(tsxBin) ? [tsxBin, [entry, ...sub]] : [process.argv[0], [...process.execArgv, entry, ...sub]];
}

/** Resolve one of paw's composition roots INSIDE the pinned release, never inside the operator's
 *  checkout. Every daemon entry — bin/cotald.ts and bin/paw.ts alike — goes through here, so
 *  "which paw is about to run" is one lookup, taken fresh at spawn time. */
function daemonEntry(...parts: string[]): string {
  return join(daemonRoot(), ...parts);
}

/** Drive a raw cotal verb through bin/cotald.ts — the COTAL composition root (runCli + manager +
 *  connector). Used for the daemons (`up`, `supervise`) and exported for bin/paw.ts's
 *  `paw cotal <verb>` passthrough (runtime coordination, never a compile-time import). */
export function cotaldViaTsx(sub: string[]): [string, string[]] {
  return viaTsx(daemonEntry("bin", "cotald.ts"), sub);
}

/** Drive a PAW command through bin/paw.ts — for daemons that ARE paw commands (the mailbox beacon,
 *  and `paw web` re-execing itself off bun — see {@link reexecUnderNode}). */
export function pawViaTsx(sub: string[]): [string, string[]] {
  return viaTsx(daemonEntry("bin", "paw.ts"), sub);
}

/**
 * Re-exec a paw command under node+tsx when the CLI is running under bun, and return true if we did.
 *
 * paw's rule has always been "the CLI may run under bun, the DAEMONS must be node+tsx" — written for
 * node-pty's ioctl, which bun cannot drive. `paw web` is a long-running daemon started through that
 * same CLI, so it inherited bun, and hit a SECOND incompatibility: **bun's node:http server never
 * emits `upgrade`**, so the WebSocket handshake gets no reply at all. Measured side by side on the same
 * code: bun answers nothing (the client sits on "connecting…" until it times out), node returns
 * `101 Switching Protocols` immediately. Without the socket the browser has only its 2s poll, which
 * the browser itself throttles hard in a background tab — so messages appear to arrive only when you
 * focus or reload the page, which is exactly how it was reported.
 *
 * Re-exec rather than refuse: the operator asked for a server, and "run it a different way" is paw's
 * job, not theirs. The child inherits stdio so it looks identical from the terminal, and its exit code
 * becomes ours.
 */
export function reexecUnderNode(sub: string[]): boolean {
  if (!process.versions.bun) return false;
  const [cmd, args] = pawViaTsx(sub);
  const child = spawn(cmd, args, { stdio: "inherit", env: daemonEnv(process.env) });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  // Forward the signals an operator actually sends a foreground server, so Ctrl-C stops the CHILD
  // rather than orphaning it behind a dead parent.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  return true;
}

/**
 * Are we running INSIDE a cotal-managed agent (vs a plain operator shell)? cotal stamps COTAL_NAME +
 * COTAL_SPACE on a managed agent's process, and every tool subprocess it spawns inherits them; an
 * operator shell has neither. Returns the agent's name when it belongs to THIS space, else undefined —
 * this is how `paw restart` knows it's about to kill its own caller and must hand off to a detached
 * child rather than bounce synchronously (which would die mid-revive).
 */
export function agentSelfName(space: string): string | undefined {
  const name = process.env.COTAL_NAME?.trim();
  if (!name) return undefined;
  const s = process.env.COTAL_SPACE?.trim();
  if (s && s !== space) return undefined; // an agent bound to a DIFFERENT space — not our caller here
  return name;
}

function restartPidPath(space: string): string {
  return join(pawDir(space), "restart.pid");
}
/** Where a detached self-restart streams its progress (the caller is dead by then — this is the record). */
export function restartLogPath(space: string): string {
  return join(pawDir(space), "restart.log");
}

/** True while a detached self-restart is in flight (its pidfile names a LIVE process). The guard that
 *  stops a second `paw restart` from stacking a competing bounce — the multi-manager mess of 2026-07-13. */
export function restartInFlight(space: string): boolean {
  const pid = readPid(restartPidPath(space));
  return pid !== undefined && alive(pid);
}

/**
 * Hand the fleet restart to a DETACHED child that outlives this process. `paw restart` run from INSIDE a
 * managed agent (see {@link agentSelfName}) can't finish synchronously: the bounce's revive step kills
 * its own caller mid-command → half-restart / stacked managers. So the caller spawns a detached
 * `paw restart` (node+tsx, reparented to launchd, COTAL_* stripped so the child isn't seen as an agent
 * and can't re-detach) that completes bounce + revive, then wakes `wakeAgent` back into a turn (a
 * respawned claude session sits idle until messaged). Pidfile-guarded so it can't stack. Returns false
 * if a restart is already in flight.
 */
export function spawnDetachedRestart(space: string, runtime: Runtime | undefined, wakeAgent: string): boolean {
  if (restartInFlight(space)) return false;
  const out = openSync(restartLogPath(space), "a");
  try {
    const [cmd, args] = pawViaTsx(["restart", ...(runtime ? [runtime] : []), "--space", space]);
    const env = daemonEnv({ PAW_WAKE_AGENT: wakeAgent });
    for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k]; // not an agent → don't re-detach
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", out, out], env });
    child.unref();
    if (child.pid) writePid(restartPidPath(space), child.pid);
    return true;
  } finally {
    closeSync(out);
  }
}

/** The detached child's final step: wake the agent it just revived so it RESUMES (a respawned session
 *  is idle until it gets a turn), then drop the in-flight pidfile. Best-effort — nudges via `paw dm` so
 *  it rides the same ensure/resolve/retry path a normal DM does. */
export function finishDetachedRestart(space: string, agent: string): void {
  try {
    const [cmd, args] = pawViaTsx(["dm", agent, "↻ restarted onto the latest code — resume where you left off", "--space", space]);
    spawnSync(cmd, args, { stdio: "inherit", timeout: 90_000, env: daemonEnv() });
  } catch {
    /* best-effort wake — a delivery failure must not strand the pidfile */
  } finally {
    rmSync(restartPidPath(space), { force: true });
  }
}

// ---- detached self-adopt (mirror of the self-restart handoff above) ----------------------------
function adoptPidPath(space: string): string {
  return join(pawDir(space), "adopt.pid");
}
/** Where a detached self-adopt streams progress (the claude that launched it is dead by the time the
 *  new mesh agent is live — this log is the record). */
export function adoptLogPath(space: string): string {
  return join(pawDir(space), "adopt.log");
}
/** True while a detached self-adopt is in flight (its pidfile names a LIVE process). Stops a second
 *  `paw adopt .` from stacking a competing takeover. */
export function adoptInFlight(space: string): boolean {
  const pid = readPid(adoptPidPath(space));
  return pid !== undefined && alive(pid);
}
/**
 * Hand a self-adopt to a DETACHED child that outlives the claude it's about to kill. `paw adopt .` run
 * from INSIDE a claude session can't finish synchronously: making the session a mesh agent means killing
 * the very claude whose Bash tool is running this command. So the caller spawns a detached `paw adopt`
 * (node+tsx, reparented to launchd, COTAL_* stripped so it isn't seen as an agent, PAW_ADOPT_INFLIGHT
 * set so it drops the pidfile when done) that runs the SYNCHRONOUS make-before-break takeover — it has
 * no claude ancestor, so it brings the new agent up, confirms it live, THEN kills the old claude.
 * Pidfile-guarded so it can't stack. Returns false if an adopt is already in flight.
 */
export function spawnDetachedAdopt(space: string, folder: string, sessionId: string, name: string | undefined): boolean {
  // Serialize the in-flight CHECK + pidfile WRITE under a lock so two near-simultaneous `paw adopt .`
  // can't both pass the check and spawn competing takeovers of the same session (TOCTOU). The caller's
  // own adoptInFlight check is advisory — this locked one is authoritative.
  return withFileLock(`${adoptPidPath(space)}.lock`, () => {
    if (adoptInFlight(space)) return false;
    const out = openSync(adoptLogPath(space), "a");
    try {
      const sub = ["adopt", folder, "--resume", sessionId, "--force", "--no-attach", "--space", space];
      if (name) sub.push("--name", name);
      const [cmd, args] = pawViaTsx(sub);
      const env = daemonEnv({ PAW_ADOPT_INFLIGHT: "1" });
      for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k]; // child isn't an agent
      const child = spawn(cmd, args, { detached: true, stdio: ["ignore", out, out], env });
      child.unref();
      if (child.pid) writePid(adoptPidPath(space), child.pid);
      return true;
    } finally {
      closeSync(out);
    }
  });
}
/** The detached self-adopt child's final step: drop the in-flight pidfile. No wake-dm — unlike a restart
 *  (which nudges the agent to resume its task), an adopted session comes up idle and the operator
 *  attaches it, so there's nothing to wake. */
export function finishDetachedAdopt(space: string): void {
  rmSync(adoptPidPath(space), { force: true });
}

/** Where `cotal up --detach` records the detached mesh server's pid. Root-RELATIVE, so it must use
 *  the space's PINNED root (see pawCotalRoot) — resolved from the cwd it would read, and `paw down`
 *  would then kill, whichever unrelated checkout the operator happened to be standing in. */
function cotalNatsPidPath(space: string): string {
  return join(pawCotalRoot(space), ".cotal", "nats.pid");
}

/** NODE_OPTIONS preload flags, in both `--flag path` and `--flag=path` spellings. */
const PRELOAD_FLAGS = ["--require", "-r", "--import"];

/**
 * Drop preloads from NODE_OPTIONS whose target no longer exists; undefined when nothing survives.
 *
 * WHY: cmux wraps a claude session with `NODE_OPTIONS=--require=<tmp>/cmux-claude-node-options/
 * restore-node-options.cjs`, then REAPS that temp dir out from under the still-running session (the
 * same reaping src/images.ts stages pasted images around). Every node process spawned from such a
 * session dies at preload with MODULE_NOT_FOUND before reaching a line of its own code. paw's
 * detached children inherit the operator's env, so `paw adopt .` from that terminal printed its
 * "⟳ adopting…" banner from the PARENT while the child was already dead — the traceback went to
 * adopt.log, so the terminal showed a success banner and nothing happened, twice (2026-07-29).
 *
 * A preload that isn't on disk cannot be honoured and isn't paw's to keep, so drop it and say so,
 * rather than let node kill a daemon with a stack trace about a file the operator never named.
 * Only ABSOLUTE (and `file://`) targets are checked: a bare specifier (`--import tsx`) resolves from
 * node_modules at load time and a relative one against the CHILD's cwd, so neither is ours to judge.
 */
export function sanitizeNodeOptions(value: string | undefined): string | undefined {
  if (!value?.trim()) return value;
  const toks = value.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const eq = tok.indexOf("=");
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    if (!PRELOAD_FLAGS.includes(flag)) {
      kept.push(tok);
      continue;
    }
    const inline = eq !== -1;
    const target = inline ? tok.slice(eq + 1) : toks[i + 1];
    // A preload flag with no target is malformed — pass it through untouched; node's own error names
    // the real problem better than a silent paw edit would.
    if (target === undefined || !stalePreload(target)) {
      kept.push(tok);
      if (!inline && target !== undefined) kept.push(toks[++i]);
      continue;
    }
    dropped.push(target);
    if (!inline) i++;
  }
  if (dropped.length)
    console.error(`paw: dropped ${dropped.length} stale NODE_OPTIONS preload(s) — ${dropped.join(", ")} (no longer on disk)`);
  return kept.length ? kept.join(" ") : undefined;
}

/** Is this preload target a path we can check AND missing? Unresolvable shapes answer false. */
function stalePreload(target: string): boolean {
  let path = target;
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return false; // a malformed URL is node's to complain about, not ours to drop
    }
  } else if (!isAbsolute(path)) {
    return false; // bare specifier or child-cwd-relative — not resolvable from here
  }
  return !existsSync(path);
}

/**
 * Directories paw's daemons need on PATH, in fallback order. Everything paw's toolchain actually
 * shells out to lives in one of these on a normal macOS box: node, tmux, cmux, gh (Homebrew),
 * bun and the `paw`/`claude` launchers (~/.bun/bin, ~/.local/bin).
 */
export function toolDirs(): string[] {
  const home = homedir();
  return [
    dirname(nodeBin()),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".opencode", "bin"), // opencode's curl installer (the operator's chosen install)
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/**
 * Guarantee the child can find paw's toolchain, whatever PATH we inherited.
 *
 * WHY (2026-08-04): a daemon inherits the env of whoever ran `paw`, and Raycast runs extensions with a
 * MINIMAL PATH — no shell rc, no nvm, no `/opt/homebrew/bin`. On this class of box that means node,
 * tmux, cmux, gh and claude are ALL unreachable. Resolving node absolutely (see nodeBin) only fixed the
 * first hop: the manager would then come up and fail to exec `tmux`, never spawn an agent, and never
 * answer ps — surfacing as "manager started but did not answer ps within 8s (is tmux running and
 * reachable?)", which reads like a tmux problem and is not one.
 *
 * Missing dirs are APPENDED, never prepended: the operator's own PATH ordering is a deliberate choice
 * (it is how a chosen node version or a shimmed binary wins) and paw must not reorder it — only
 * backfill what isn't there at all. Non-existent dirs are skipped so PATH doesn't accumulate noise.
 */
function withToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const present = new Set((env.PATH ?? "").split(":").filter(Boolean));
  const missing = toolDirs().filter((d) => !present.has(d) && existsSync(d));
  if (missing.length) env.PATH = [...(env.PATH ? [env.PATH] : []), ...missing].join(":");
  return env;
}

/**
 * The env every paw-spawned child gets: the operator's, minus preloads that would kill it before it
 * runs (see sanitizeNodeOptions), plus whatever it needs to find paw's toolchain (see withToolPath).
 * `extra` wins over the inherited env.
 */
/**
 * Claude Code stamps its OWN process tree with session markers (`CLAUDE_CODE_CHILD_SESSION`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, the messaging socket/token, …). A `paw restart`/`paw start`
 * typed INSIDE a claude session — an agent restarting the fleet, the operator's `!paw …`, or a claude
 * tool call — inherits them, the detached manager inherits them from paw, and every agent the manager
 * spawns then boots as a "child session": **transcript saving is OFF** ("inherited
 * CLAUDE_CODE_CHILD_SESSION marker", 2026-09-08, operator screenshot), which silently breaks the one
 * thing paw's durability rests on. These describe the session paw was invoked FROM, never the one
 * being launched, so they are dropped at every daemon boundary. Operator CONFIG under the same prefix
 * (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, …) is deliberately kept — this is an
 * explicit marker list, not a prefix wipe.
 */
export const HARNESS_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_NO_FLICKER",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

export function stripHarnessMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of HARNESS_SESSION_MARKERS) delete out[k];
  return out;
}

export function daemonEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = stripHarnessMarkers({ ...process.env, ...extra });
  const opts = sanitizeNodeOptions(env.NODE_OPTIONS);
  if (opts === undefined) delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = opts;
  return withToolPath(env);
}

/** Ephemeral privileged creds for a control-plane probe, mirroring cotal up's authSetup: ensure
 *  the space's trust material exists, then mint a one-shot "manager"-profile creds. Returns
 *  undefined when no auth material is on disk (open/dev mesh — probes connect bare). */
async function probeCreds(space: string): Promise<string | undefined> {
  const dir = authDir(pawCotalRoot(space));
  const auth = loadSpaceAuth(dir, space);
  if (!auth) return undefined;
  // cotal 0.25 requires a lifecycleUid for an operator instrument's ep caller rows: the reply rail is
  // lifecycle-keyed (SPEC 13.1/13.2), so a cred minted without one is refused at MINT time — which
  // under PAW_AUTH took down `ensure()` before the mesh was even probed.
  return mintCreds(auth, newIdentity(), "control-caller-privileged", { lifecycleUid: mintLifecycleUid() });
}

/** Ensure the space's auth material exists on disk before the mesh boots under JWT auth, so the
 *  detached server and later probes share one account. mirrors cotal up's authSetup. Only runs when
 *  PAW_AUTH=1 — the default open mesh skips it. */
async function ensureSpaceAuth(space: string): Promise<void> {
  const dir = authDir(pawCotalRoot(space));
  if (loadSpaceAuth(dir, space)) return;
  saveSpaceAuth(dir, await createSpaceAuth(space));
}

/**
 * One control-plane `ps` round-trip scoped to `space`: connect a request/reply-only endpoint, ask
 * the manager for its agent list, disconnect. Returns true iff a manager answered ok — used to
 * adopt an already-running manager (the operator's or a prior paw) instead of starting a second
 * one that would split queue-grouped control requests.
 */
async function managerAnswers(space: string, server: string): Promise<boolean> {
  // `creds` used to be a parameter (probeCreds' output). ManagerControl mints its own per-tier
  // instrument from the same space auth material, so passing one in would be a second answer to
  // "which credential does a control call use" — and the tier now follows the command, which a
  // caller-supplied cred cannot express.
  try {
    return await withManagerControl(space, server, async (ctl) => (await ctl.ps(2000)).ok, { resolveMs: READY_PROBE_MS });
  } catch {
    return false; // a probe failure is just "no manager" — never a thrown startup
  }
}

/**
 * Can we actually open a connection to the mesh in our mode (not merely reach the port)? isReachable
 * counts an auth-rejecting server as reachable, so it can't prove ownership; a real ep.start() throws
 * on auth-reject. Used to refuse adopting a foreign/auth-mismatched mesh squatting the port.
 */
async function meshConnectable(space: string, server: string, creds?: string): Promise<boolean> {
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    card: { name: "paw-meshprobe", kind: "endpoint" },
  });
  ep.on("error", () => {});
  try {
    await ep.start();
    return true;
  } catch {
    return false;
  } finally {
    await ep.stop().catch(() => {});
  }
}

/**
 * Bring the mesh up, or adopt a running one. ALWAYS the detached path (never a terminal-tied
 * foreground spawn) — this is the bug-1 fix: a foreground mesh died with the launching command.
 *
 * Order:
 *  1. reachable -> reuse (nothing to do).
 *  2. a paw mesh.pid that's alive-but-unreachable (hung) -> SIGTERM once, then respawn ONCE.
 *  3. otherwise -> drive `up --detach` (node+tsx) and adopt the nats pid it records.
 * On a respawn that still fails, surface the mesh log tail and throw — NO retry loop.
 */
async function ensureMesh(space: string, server: string): Promise<void> {
  // Default to an OPEN localhost mesh so CLI verbs connect with no creds (zero-config). Opt into
  // JWT auth with PAW_AUTH=1, in which case we set up trust material and probe/connect with creds.
  const open = process.env.PAW_AUTH !== "1";
  if (!open) await ensureSpaceAuth(space);
  const creds = open ? undefined : await probeCreds(space);

  if (await isReachable(server, creds ? { creds } : undefined)) {
    // isReachable() returns true even when the server AUTH-REJECTS us, so it can't distinguish our
    // mesh from a foreign / auth-mismatched one squatting the port. Confirm we can actually open a
    // connection in our mode before adopting; otherwise fail loud rather than adopt an unusable mesh.
    if (await meshConnectable(space, server, creds)) return;
    throw new Error(
      `paw: ${server} is already held by a mesh paw can't use (auth-mode mismatch — set PAW_AUTH to match it, or free the port).`,
    );
  }

  const recorded = readPid(meshPidPath(space));
  if (recorded !== undefined && alive(recorded)) {
    // Alive but unreachable: a hung server holding the port. SIGTERM once, wait briefly, respawn ONCE.
    try {
      process.kill(recorded, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 20 && alive(recorded); i++) await sleep(100);
    rmSync(meshPidPath(space), { force: true });
  }

  // Start the mesh by DRIVING the registered `up` command through bin/cotald.ts under node+tsx (never
  // the current runtime — the CLI may be bun, which can't host the mesh manager's native node-pty).
  // `up --detach` boots nats in the background and writes .cotal/nats.pid; adopt that pid as paw-owned
  // so stop() tears down only the mesh paw started. spawnSync: `up` is a short-lived bootstrapper.
  const [meshExec, upArgs] = cotaldViaTsx([
    "up",
    "--detach",
    "--space",
    space,
    "--server",
    server,
    ...(open ? ["--open"] : []),
    "--store-dir",
    meshStoreDir(space),
  ]);
  const meshFd = openSync(meshLogPath(space), "a");
  const res = spawnSync(meshExec, upArgs, {
    stdio: ["ignore", meshFd, meshFd],
    timeout: 60_000,
    cwd: pawCotalRoot(space),
    env: daemonEnv(),
  });
  closeSync(meshFd);
  if (res.status !== 0) {
    throw new Error(
      `paw: mesh failed to start at ${server} (cotal up exited ${res.status ?? res.signal ?? "?"}).\n--- mesh.log tail ---\n${tail(meshLogPath(space))}`,
    );
  }
  const natsPid = readPid(cotalNatsPidPath(space)); // `up --detach` recorded the server pid here
  if (natsPid !== undefined) writePid(meshPidPath(space), natsPid);

  if (!(await isReachable(server))) {
    throw new Error(
      `paw: mesh started but is not reachable at ${server}.\n--- mesh.log tail ---\n${tail(meshLogPath(space))}`,
    );
  }
}

/** How long to wait for a freshly-started manager to answer ps (the readiness gate).
 *
 *  RAISED from 8s for cotal 0.25, and the reason is structural rather than "it got slower": on the v0.4
 *  service rail a control call is not one request. The caller must DESCRIBE the endpoint, fetch its
 *  contract documents from the store and recompile them before it can invoke anything — and none of
 *  that can succeed until the manager has finished REGISTERING its service, which happens after the
 *  process is up. Measured on an idle machine: registration lands a few seconds in, and the whole
 *  resolve then costs ~450ms. 8s left almost no room for the first successful attempt, and a manager
 *  that was in fact healthy failed the gate. */
const MANAGER_READY_MS = 20_000;

/** The resolve deadline for ONE readiness probe. Deliberately short, and this is the load-bearing half
 *  of the fix above: the probe runs in a RETRY LOOP, so an attempt made before the manager registers
 *  must FAIL FAST and let the next attempt run. With the default 10s resolve deadline a single early
 *  attempt outlived the entire readiness window — one probe, no retries, a false "didn't answer". */
const READY_PROBE_MS = 1500;

/**
 * Spawn the `supervise` daemon under `runtime` through bin/cotald.ts under node+tsx (NOT the current
 * runtime — a bun-hosted manager can't drive node-pty, so its agents never boot). Detached + paw
 * owns the child pid. `--runtime` only for non-pty: pty is supervise's default (auto→pty), and the
 * known-good path stays flag-free. Records the runtime marker so a later ensure() can detect a switch.
 * Shared by ensureManagerUp's fresh-start, switch, and rollback paths.
 */
function startManagerDaemon(space: string, server: string, runtime: Runtime): void {
  const mgrFd = openSync(managerLogPath(space), "a");
  const [mgrExec, supArgs] = cotaldViaTsx([
    "supervise",
    "--space",
    space,
    "--server",
    server,
    ...(runtime === "pty" ? [] : ["--runtime", runtime]),
  ]);
  let env = daemonEnv();
  if (runtime === "tmux") {
    // Pin the manager's tmux to the standard default socket (see defaultTmuxEnv) so its
    // `cotal-<space>` session is visible to the operator's plain shell + `paw attach`, not stranded
    // on the launching shell's/surface's inherited socket.
    env = defaultTmuxEnv(env);
  }
  if (runtime === "cmux") {
    // A manager launched from INSIDE a cmux surface inherits that window's whole anchor —
    // CMUX_SOCKET/SURFACE_ID/PANEL_ID/TAB_ID/WORKSPACE_ID/PORT/AGENT_LAUNCH_* — which goes stale the
    // moment that window changes, so a LATER spawn targets a dead surface ("cmux couldn't reach the
    // app"), i.e. spawns "only work from the same tab". Strip EVERY CMUX_* var so the detached manager
    // opens tabs via the singleton app's DEFAULT socket, no surface context — a spawn works from
    // wherever paw was launched. Keep only the resolved CLI path (the manager runs detached, often
    // outside a surface where CMUX_BUNDLED_CLI_PATH is unset).
    const cli = env.CMUX_BUNDLED_CLI_PATH?.trim() || cmuxBin();
    for (const k of Object.keys(env)) if (k.startsWith("CMUX_")) delete env[k];
    env.CMUX_BUNDLED_CLI_PATH = cli;
    // cmux also injects a per-surface shim dir onto PATH (…/cmux-cli-shims/<panelId>/…); it goes
    // stale with the surface and shadows the real `cmux`, so drop those entries too.
    if (env.PATH) env.PATH = env.PATH.split(":").filter((p) => !p.includes("cmux-cli-shims")).join(":");
    // Present the socket password so the detached manager (no cmux lineage) passes cmux's
    // `socketControlMode: "password"` gate — the default `cmuxOnly` rejects it outright. Without a
    // password set, the manager only works while it still has cmux ancestry (fresh from a surface),
    // then breaks the moment it detaches. See cmuxSocketPassword + CLAUDE.md.
    const pw = cmuxSocketPassword();
    if (pw) env.CMUX_SOCKET_PASSWORD = pw;
  }
  const child = spawn(mgrExec, supArgs, { detached: true, stdio: ["ignore", mgrFd, mgrFd], env, cwd: pawCotalRoot(space) });
  child.unref();
  closeSync(mgrFd);
  if (child.pid) writePid(managerPidPath(space), child.pid);
  writeFileSync(managerRuntimePath(space), runtime);
}

/** All agent names the manager currently lists (alive or not), via one ps round-trip — captured
 *  BEFORE a bounce so {@link reapRuntimeUi} can target exactly this space's tabs/windows (cmux labels
 *  carry no space, so we need the names). Best-effort: empty on any failure, never throws. */
async function managerAgentNames(space: string, server: string): Promise<string[]> {
  try {
    return await withManagerControl(space, server, async (ctl) => {
      const reply = await ctl.ps(2000);
      if (!reply.ok) return [];
      const rows = (reply.data as Array<{ name?: unknown }>) ?? [];
      return rows.map((r) => r.name).filter((n): n is string => typeof n === "string" && n.length > 0);
    });
  } catch {
    return [];
  }
}

/** The cmux CLI: the bundled absolute path when paw runs inside a cmux surface, else `cmux` on PATH.
 *  Mirrors @cotal-ai/cmux's driver so paw's reap talks to the same app the manager spawned tabs into. */
/**
 * Env for any tmux command paw runs (the manager spawn + the reap), normalized to tmux's STANDARD
 * default socket by stripping `$TMUX` and `$TMUX_TMPDIR`.
 *
 * WHY: paw starts the manager as a DETACHED daemon that inherits whatever `$TMUX` / `$TMUX_TMPDIR`
 * the launching shell or surface had. tmux's socket is chosen from those vars, so the manager's tmux
 * server can land on a socket the operator's plain shell (and `paw attach`) never look at — then
 * `tmux ls` reports "no server running", the `cotal-<space>` session is invisible, and the agents are
 * effectively headless though marked tmux (bug c). Stripping both vars pins the manager to
 * `/tmp/tmux-<uid>/default` — exactly where a fresh operator shell and attachTmux resolve `tmux`.
 * Directly mirrors the CMUX_* stripping the cmux runtime already needs (same detached-daemon /
 * inherited-surface-socket class of bug). CAVEAT: an operator who sets a CUSTOM `TMUX_TMPDIR` in
 * their own interactive shell must export the same value for `paw attach`/`tmux attach` to find the
 * default-socket session — the fix targets the common (default-socket) setup.
 */
export function defaultTmuxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.TMUX; // don't bind to the launching tmux server (it may close, or be a foreign socket)
  delete env.TMUX_TMPDIR; // fall back to the standard per-user socket dir
  return env;
}

function cmuxBin(): string {
  const explicit = process.env.CMUX_BUNDLED_CLI_PATH?.trim();
  if (explicit) return explicit;
  // CMUX_BUNDLED_CLI_PATH is only set INSIDE a cmux surface; paw often runs outside one, so fall
  // back to the macOS app's bundled CLI (it talks to the singleton app over its default socket),
  // else a bare `cmux` on PATH.
  const bundled = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  return existsSync(bundled) ? bundled : "cmux";
}

/**
 * The cmux socket password from the operator's `~/.config/cmux/cmux.json`, or undefined if unset.
 * cmux's `automation.socketControlMode: "password"` gates socket control by a password; paw's manager
 * is a DETACHED daemon with no cmux-surface lineage, so under the default `cmuxOnly` it's rejected
 * entirely — the operator must switch to `password` mode (see CLAUDE.md). The manager's cmux CLI does
 * NOT reliably auto-read the file-managed password, so paw injects it as `CMUX_SOCKET_PASSWORD`
 * explicitly. Tolerant of JSONC (the config is commented) — a targeted match on the key, no full parse.
 */
function cmuxSocketPassword(): string | undefined {
  const cfg = join(process.env.HOME ?? homedir(), ".config", "cmux", "cmux.json");
  if (!existsSync(cfg)) return undefined;
  try {
    // Ignore commented-out lines (`// "socketPassword" : "…"`) so a template default isn't picked up.
    for (const raw of readFileSync(cfg, "utf8").split("\n")) {
      if (/^\s*\/\//.test(raw)) continue;
      const m = raw.match(/"socketPassword"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch {
    /* unreadable config — treat as unset */
  }
  return undefined;
}

/**
 * Close the given runtime's leftover UI for `space`, so a restart/switch doesn't leave the OLD
 * manager's windows/tabs orphaned next to the freshly-revived ones (the duplicate window/tab bug).
 * The manager DOES tear its own children down on a clean SIGTERM — proven for tmux — but that can
 * miss under cmux (the detached daemon's socket close can fail/lag on shutdown), so paw reaps
 * DEFENSIVELY after the old manager is stopped and before revival recreates anything. Best-effort
 * and NEVER throws: a stale/unreachable runtime must not abort the restart.
 *
 *  - tmux: nuke the whole per-space session `cotal-<space>` — safe on a restart, since reviveAgents
 *    and the new manager's `ensureSession` recreate the session + windows. Session-scoped, so no
 *    agent names are needed (this is also `stop()`/`paw down`'s reap).
 *  - cmux: each agent is its OWN `cotal-<name>` tab and cmux labels carry no space, so we can only
 *    SAFELY close the tabs of the KNOWN agents — closing every `cotal-*` would nuke other spaces'
 *    agents. List workspaces, match each `cotal-<name>` label, close it by ref. No names → no-op.
 *  - pty: no visible UI — no-op.
 */
export function reapRuntimeUi(space: string, runtime: Runtime | undefined, agentNames: string[] = []): void {
  if (runtime === "tmux") {
    // Reap on the SAME (default) socket the manager was pinned to (defaultTmuxEnv) — else a paw
    // launched with a surface-specific TMUX_TMPDIR would kill-session on the wrong socket and leave
    // the real cotal-<space> session orphaned.
    spawnSync("tmux", ["kill-session", "-t", `cotal-${space}`], { stdio: "ignore", env: withToolPath(defaultTmuxEnv(process.env)) });
    return;
  }
  if (runtime === "cmux") {
    if (!agentNames.length) return; // no known agents → nothing safe to close (labels carry no space)
    const bin = cmuxBin();
    const listed = spawnSync(bin, ["list-workspaces"], { encoding: "utf8", env: withToolPath({ ...process.env }) });
    if (listed.error || listed.status !== 0 || typeof listed.stdout !== "string") return; // cmux unreachable
    const wanted = agentNames.map((n) => `cotal-${n}`);
    for (const line of listed.stdout.split("\n")) {
      const ref = (line.match(/workspace:\d+/) ?? line.match(/[0-9a-f-]{36}/i))?.[0];
      if (!ref) continue;
      // Match the WHOLE label (a leading glyph → endsWith) so `cotal-web` never matches `cotal-web-2`.
      const label = line.slice(line.indexOf(ref) + ref.length).replace(/\s*\[selected\]\s*$/, "").trim();
      if (!wanted.some((w) => label === w || label.endsWith(` ${w}`))) continue;
      spawnSync(bin, ["close-workspace", "--workspace", ref], { stdio: "ignore", env: withToolPath({ ...process.env }) }); // best-effort
    }
  }
  // pty / undefined: nothing to reap.
}

/**
 * Identify paw's long-lived daemons by COMMAND SIGNATURE, not by the recorded spawn().pid.
 *
 * WHY: paw records `spawn().pid` for the manager (and mailbox), but those daemons run under tsx,
 * which spawns a re-exec CHILD for the real module graph — and cotal's supervise may itself detach.
 * The pid paw sees is only the tsx WRAPPER; correctness then hinges on that wrapper staying alive AND
 * forwarding signals, and a SINGLE recorded pid can't represent the DUPLICATE managers that a night of
 * restart churn leaves behind (each overwrites the marker, orphaning the last). So stop/restart could
 * miss the real, ppid=1 orphan → "no paw-owned manager" on restart, a still-running manager after down.
 *
 * FIX: since ONLY paw ever starts a `cotald supervise` / `paw.ts mailbox` for a given space, a pgrep
 * match on that exact command line IS paw's daemon — no pid bookkeeping required. The pattern is
 * SPACE-EXACT so space `owntest-1` never matches `owntest-11`: the manager pattern is bounded by the
 * always-emitted trailing ` --server`, the mailbox pattern by end-of-arg (`--space` is its last arg).
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** pgrep -f pattern → pids (empty on no match / pgrep unavailable). Never throws. */
function pgrepF(pattern: string): number[] {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (r.error || typeof r.stdout !== "string") return [];
  return r.stdout
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}
/** The pgrep -f regex that matches paw's manager daemon (`cotald supervise`) for exactly `space`.
 *  Space-EXACT via the trailing ` --server` (always emitted right after `--space <space>`), so
 *  `owntest-1` never matches `owntest-11`'s command line. Exported for hermetic unit coverage. */
export function managerMatchPattern(space: string): string {
  return `cotald\\.ts supervise --space ${escapeRegex(space)} --server`;
}
/** The pgrep -f regex that matches paw's "you" mailbox beacon (`paw.ts mailbox`) for exactly `space`.
 *  `--space <space>` is the LAST arg, so anchor the value at a space-or-end boundary — again so
 *  `owntest-1` never matches `owntest-11`. Exported for hermetic unit coverage. */
export function mailboxMatchPattern(space: string): string {
  return `paw\\.ts mailbox --space ${escapeRegex(space)}( |$)`;
}
/** All live pids of paw's manager daemon for `space` (tsx wrapper + its re-exec child, plus any
 *  duplicates left by prior churn). The signature-based source of truth for stop/restart ownership. */
export function managerProcs(space: string): number[] {
  return pgrepF(managerMatchPattern(space));
}
/** All live pids of paw's "you" mailbox beacon for `space`. */
export function mailboxProcs(space: string): number[] {
  return pgrepF(mailboxMatchPattern(space));
}
/**
 * The runtime the manager is ACTUALLY running, read from its live command line — never the
 * `manager.runtime` marker file. startManagerDaemon only emits `--runtime <r>` for non-pty (pty is
 * supervise's default), so an owned supervise proc with no flag IS pty. The marker can lie: it's
 * written at spawn time, so failed/rolled-back switches and daemon churn leave it naming a runtime
 * no live process runs — that stale marker made `paw runtime cmux` "adopt" a pty manager as
 * already-cmux and never restart (the 2026-07-12 empty-cmux-tabs bug). Undefined when no owned
 * manager proc is alive.
 */
export function actualManagerRuntime(space: string): Runtime | undefined {
  for (const pid of managerProcs(space)) {
    const res = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const cmd = res.status === 0 ? res.stdout : "";
    if (!cmd.includes("supervise")) continue;
    const m = /--runtime (\S+)/.exec(cmd);
    if (!m) return "pty"; // owned supervise with no --runtime flag = supervise's default
    return (RUNTIMES as readonly string[]).includes(m[1]) ? (m[1] as Runtime) : undefined;
  }
  return undefined;
}
/** SIGTERM (or SIGKILL) a set of pids; a pid already gone is fine. */
function signalProcs(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      /* already exited */
    }
  }
}

/** Poll `ps` until a manager answers or `ms` elapses. True iff one answered — the readiness gate so
 *  a following `start` doesn't race a not-yet-listening manager. NO loop beyond the deadline. */
/**
 * Turn a manager-startup failure into something an operator can act on.
 *
 * The old message dumped ~20 lines of manager.log and asked "is tmux running and reachable?" —
 * which is the WRONG question in every case except one, and reads as a tmux fault when the real cause
 * is usually visible three lines up in the log it just printed. Reported live (2026-08-20) with the
 * operator's own diagnosis attached: their connection was on a dead LTE link, and nothing in the
 * message connected the two.
 *
 * So: read the tail, name the cause, keep it SHORT, and point at the file rather than reprinting it.
 * The log is still there for anyone who wants all of it — a path is a better offer than 20 lines of
 * someone else's output.
 *
 * Exported + pure for tests: this is error text, which is exactly the code that never gets exercised
 * until it matters.
 */
export function explainManagerFailure(o: { logTail: string; runtime: string; space: string; logPath: string }): string {
  const lines = o.logTail.split("\n").filter((l) => l.trim());
  const last = lines.slice(-3).join("\n");
  const leaseLosses = lines.filter((l) => l.includes("lost its singleton lease")).length;
  const head = `paw: the manager didn't answer within ${Math.round(MANAGER_READY_MS / 1000)}s (space "${o.space}", runtime ${o.runtime}).`;

  // A SECOND manager is a different fault with a different fix, and it says so itself in the log.
  //
  // Detected ONLY from that self-report, never from a process count: a healthy manager is TWO
  // processes — the tsx wrapper and the node child it re-execs — so `managerProcs().length > 1` is
  // true on every working install. I shipped that heuristic and it would have called every single
  // failure a duplicate-manager fault (caught the same day, by reading `ps` on a healthy box).
  if (lines.some((l) => l.includes("already serves space"))) {
    return `${head}\n\n  another manager is already serving this space — they compete and neither wins.\n  fix: \`paw down\` and try again.\n\n  log: ${o.logPath}`;
  }
  // Lease churn: the manager IS starting, repeatedly, and tearing its agents down each time.
  if (leaseLosses > 0) {
    return (
      `${head}\n\n  it started but keeps LOSING ITS LEASE and restarting (${leaseLosses}× in this log), which drops\n` +
      `  every agent each time. cotal ≤0.20 treats any mesh timeout as "another manager took over", so a\n` +
      `  loaded or slow machine causes it — a fleet of agents booting at once will do it.\n` +
      `  fix: \`paw down\`, wait for the load to drop, then retry. (cotal 0.21 fixes the underlying bug.)\n\n  log: ${o.logPath}`
    );
  }
  // A missing binary is the ONE case where naming the runtime is the right question.
  if (lines.some((l) => /not found|ENOENT|couldn't reach|no such file/i.test(l))) {
    return `${head}\n\n  it couldn't launch its runtime — something it needs isn't on PATH${o.runtime !== "pty" ? ` (is ${o.runtime} installed and running?)` : ""}.\n\n  ${last}\n\n  log: ${o.logPath}`;
  }
  return `${head}\n\n  ${last || "(nothing in the log yet — it may still be starting)"}\n\n  log: ${o.logPath}`;
}

async function managerReady(space: string, server: string, creds: string | undefined, ms = MANAGER_READY_MS): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await managerAnswers(space, server)) return true;
    await sleep(150);
  }
  return false;
}

/** Stop paw's manager for `space` by COMMAND SIGNATURE (all matching procs — there may be duplicates
 *  from prior churn, plus the tsx wrapper + re-exec child of each), wait until the signature clears
 *  (bounded ~4s), SIGKILL any straggler, then drop the now-secondary pid + runtime markers. A process
 *  gone is stronger than "stopped answering ps", so a following start binds a free control subject.
 *  Best-effort, never throws. */
async function stopOwnedManager(space: string): Promise<void> {
  const pids = managerProcs(space);
  if (pids.length) {
    signalProcs(pids, "SIGTERM");
    console.error(`paw: stopped manager (pid ${pids.join(", ")})`);
  }
  for (let i = 0; i < 40 && managerProcs(space).length > 0; i++) await sleep(100);
  signalProcs(managerProcs(space), "SIGKILL"); // any straggler that ignored SIGTERM
  rmSync(managerPidPath(space), { force: true });
  rmSync(managerRuntimePath(space), { force: true });
}

/** Stop paw's "you" mailbox beacon for `space` by COMMAND SIGNATURE — same rationale as the manager
 *  (the recorded pid is only the tsx wrapper; churn can leave duplicate beacons, each a stale "you").
 *  Wait for the signature to clear so a fresh beacon doesn't briefly double-register "you". */
async function stopMailbox(space: string): Promise<void> {
  const pids = mailboxProcs(space);
  if (pids.length) {
    signalProcs(pids, "SIGTERM");
    console.error(`paw: stopped mailbox (pid ${pids.join(", ")})`);
  }
  for (let i = 0; i < 20 && mailboxProcs(space).length > 0; i++) await sleep(100);
  signalProcs(mailboxProcs(space), "SIGKILL");
  rmSync(mailboxPidPath(space), { force: true });
}

/**
 * Bring the control-plane manager up under the resolved runtime (env > space preference > pty), or
 * adopt a running one.
 *
 * Order:
 *  1. probe `ps` -> a manager answers:
 *       - it's the runtime we want (or one paw doesn't own / can't identify) -> ADOPT (don't start a second).
 *       - it's ours but a DIFFERENT runtime -> the operator switched the preference; the manager is a
 *         background daemon so the setting alone can't change it -> RESTART it into the new runtime.
 *         paw agents are durable (resume pins), so they re-wake on the next chat/open.
 *  2. DRIVE the registered `supervise` daemon (node+tsx, detached) under the runtime, own its pid,
 *     and record the runtime marker.
 *  3. poll `ps` until it serves, or ~8s — a readiness gate so a following `start` doesn't race a
 *     not-yet-listening manager. On timeout surface the manager log tail and throw — NO loop.
 *
 * ROLLBACK NET: a runtime SWITCH kills the (known-good) old manager BEFORE starting the new one, so a
 * new runtime that never comes up (e.g. cmux not installed/reachable) would leave NO manager. When a
 * switch's new manager misses the readiness window, we roll back — restart the PREVIOUS runtime and
 * throw — so the operator always ends with a working manager. A fresh start (no previous manager) has
 * nothing to roll back to and just throws the readiness-timeout error.
 */
async function ensureManagerUp(space: string, server: string): Promise<void> {
  const runtime = resolveRuntime(space);
  const creds = await probeCreds(space);
  let previous: Runtime | undefined; // the known-good runtime we killed on a switch — the rollback target

  if (await managerAnswers(space, server)) {
    // OWNERSHIP BY SIGNATURE, not the recorded pid: only paw starts a `cotald supervise` for a space,
    // so a running one IS paw's even when the pid marker went stale (the whole bug). The RUNNING
    // runtime comes from the live process's own command line (actualManagerRuntime) — NEVER the
    // manager.runtime marker, which is written at spawn time and survives failed switches/churn: a
    // stale cmux marker over a pty process made this adopt-branch skip the restart and strand every
    // agent headless while `paw runtime cmux` reported "already running cmux" (2026-07-12). A manager
    // answering ps that has NO cotald supervise proc is a foreign one paw didn't start — stays
    // unidentified, never killed.
    const ownedByUs = managerProcs(space).length > 0;
    const running: Runtime | undefined = ownedByUs ? (actualManagerRuntime(space) ?? "pty") : undefined;
    // ADOPT a running manager whose runtime matches (or one we don't own) — no surface needed to
    // merely talk to a live manager, so `paw ps`/`dm` from a NON-cmux shell reach a running cmux
    // manager fine. The assertRuntimeUsable gate is only for STARTING/SWITCHING cmux (below).
    if (!ownedByUs || running === runtime) {
      // Unconditional — not just when PAW_RUNTIME is explicitly set. A foreign manager (one this pgrep
      // signature doesn't recognize as paw's own, e.g. a leftover from an earlier code/version, a
      // crash, or a differently-shaped invocation) silently answering ps means the operator's runtime
      // PREFERENCE (paw runtime <r> / paw start) gets silently adopted-around instead of honored — with
      // no visible switch message, so a "why did my agents come up pty when I set tmux" mystery has NO
      // diagnostic trail. Costs nothing to always print; only fires on the actually-surprising path.
      if (!ownedByUs) {
        console.error(
          `paw: adopting an existing manager paw doesn't own — its runtime may not be ${runtime}. ` +
            `\`paw down\` then re-run to force ${runtime}.`,
        );
      }
      return;
    }
    // Ours, identified, and it differs → restart into the requested runtime (the point of the knob).
    // Assert we CAN start the target BEFORE we kill the known-good manager, else a cmux-no-surface
    // switch would strand us with none.
    assertRuntimeUsable(runtime);
    console.error(
      `paw: switching manager runtime ${running} → ${runtime} — restarting (durable agents re-wake on next chat/open)`,
    );
    // Capture the OLD runtime's agent names (cmux tabs are `cotal-<name>`) BEFORE we stop it, so we
    // can reap its orphaned UI once it's down — the manager can miss its own cmux teardown on SIGTERM.
    const uiNames = running === "cmux" ? await managerAgentNames(space, server) : [];
    await stopOwnedManager(space);
    reapRuntimeUi(space, running, uiNames); // reap the OLD runtime's windows/tabs before revival re-creates them
    previous = running; // keep the known-good runtime so we can roll back if the new one won't boot
  } else {
    // No manager running → we're about to START one fresh under `runtime`; cmux needs a surface.
    assertRuntimeUsable(runtime);
  }

  startManagerDaemon(space, server, runtime);
  if (await managerReady(space, server, creds)) return;

  const logTail = tail(managerLogPath(space));
  if (previous !== undefined) {
    // The switch's new runtime never came up — restore the previous, known-good manager so the
    // operator isn't left with NONE, then fail loud naming both runtimes.
    await stopOwnedManager(space); // reap the half-started (possibly-alive) new daemon
    startManagerDaemon(space, server, previous);
    await managerReady(space, server, creds);
    throw new Error(
      `paw: manager failed to start under ${runtime} (is it installed + reachable?) — restored the ${previous} manager.\n` +
        `--- manager.log tail ---\n${logTail}`,
    );
  }
  throw new Error(explainManagerFailure({ logTail, runtime, space, logPath: managerLogPath(space) }));
}

/**
 * Ensure the persistent "you" mailbox beacon is up: a paw-owned daemon that holds the human's "you"
 * identity online so agents can always resolve + deliver replies to you (read with `paw inbox`).
 * Cheap when already up (a pid-alive check); otherwise spawn it DETACHED — same runtime + entrypoint
 * as this process (`node <execArgv> bin/paw.ts mailbox --space <s>`), stdout/stderr to mailbox.log, then
 * unref so it outlives this command. Best-effort + non-blocking: the beacon comes up in ~1s, long
 * before an agent could reply, so we don't gate on it (keeps `paw ps` snappy). NOT under JWT auth's
 * critical path — a beacon failure must never block a real command, so errors here are swallowed.
 */
function ensureMailbox(space: string): void {
  try {
    const recorded = readPid(mailboxPidPath(space));
    if (recorded !== undefined && alive(recorded)) return; // already present
    const out = openSync(mailboxLogPath(space), "a");
    try {
      // Spawn the beacon under node+tsx no matter how this process was launched (see viaTsx) — a
      // bare `node bin/paw.ts` child dies with ERR_MODULE_NOT_FOUND on the first .ts import, and a
      // dead "you" beacon silently drops replies. The mailbox is a PAW command, so it runs through
      // bin/paw.ts (the paw composition root), not cotald.
      const [cmd, args] = pawViaTsx(["mailbox", "--space", space]);
      const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", out, out],
        env: daemonEnv(),
        cwd: pawCotalRoot(space),
      });
      child.unref();
      if (child.pid) writePid(mailboxPidPath(space), child.pid);
    } finally {
      closeSync(out);
    }
  } catch (e) {
    // A beacon we couldn't start just means replies are presence-TTL bounded — warn, never fail the command.
    console.error(`paw: could not start the "you" mailbox beacon — replies are presence-TTL bounded until it's up (${(e as Error).message})`);
  }
}

/**
 * Ensure paw's daemons are up for this invocation. Serialized under paw's per-space lock so two
 * paw commands racing don't each boot a mesh/manager. start-once-per-invocation: on failure the
 * underlying step surfaces the relevant log tail and throws non-zero — NO background respawn loop,
 * NO idle GC.
 */
export async function ensure(opts: EnsureOpts = {}): Promise<{ space: string; server: string }> {
  const space = opts.space ?? resolveSpace();
  const server = DEFAULT_SERVER;
  if (opts.needManager) resolveRuntime(space); // fail loud on a bad PAW_RUNTIME before booting; the cmux-surface gate is in ensureManagerUp (adopt needs no surface)
  await withLock(space, async () => {
    if (opts.needMesh || opts.needManager) await ensureMesh(space, server);
    if (opts.needManager) await ensureManagerUp(space, server);
    // Any mesh-up context keeps "you" reachable — so a fire-and-forget `paw dm` gets a reply later.
    if (opts.needMesh || opts.needManager) ensureMailbox(space);
  });
  return { space, server };
}

/**
 * Force-restart the paw-owned manager under the resolved runtime — the bounce `paw restart` needs
 * that ensure()/ensureManagerUp() won't do on its own (they only restart on a runtime MISMATCH, so
 * they can't reload a same-runtime manager after e.g. a connector edit). Under the lifecycle lock:
 * ensure the mesh, stop the paw-owned manager (drop its pid + runtime markers, wait for it to stop
 * answering), start it fresh via ensureManagerUp (resolved runtime + rollback net), then re-arm the
 * mailbox beacon. Fails loud if paw doesn't OWN the running manager — paw can only restart a daemon
 * it started (`paw down` won't help either; the operator must stop a foreign manager themselves).
 */
export async function restartManager(opts: { space?: string } = {}): Promise<void> {
  const space = opts.space ?? resolveSpace();
  const server = DEFAULT_SERVER;
  assertRuntimeUsable(resolveRuntime(space)); // fail loud BEFORE stopping the manager (else a cmux-no-surface restart strands us)
  await withLock(space, async () => {
    await ensureMesh(space, server);
    const creds = await probeCreds(space);
    // OWNERSHIP BY SIGNATURE: paw owns the manager iff a `cotald supervise` for this space is running
    // (only paw starts one). No running manager isn't an error — `paw restart` with nothing up should
    // just START one (ensureManagerUp below does), not fail loud. This replaces the old dead-pid-marker
    // guard that mis-reported "no paw-owned manager" whenever the tsx wrapper's pid had gone stale.
    const wasRunning = managerProcs(space).length > 0;
    if (!wasRunning) console.error(`paw: no manager running in space ${space} — starting one.`);
    // The RUNNING runtime (marker) is the one whose windows/tabs exist — capture it + the agent names
    // (for cmux) BEFORE the stop drops the marker, so we can reap the old UI. `paw restart <r>` can be
    // a SWITCH (the command layer wrote the new preference first), so `running` may differ from the
    // runtime ensureManagerUp brings up next — always reap the OLD one, not the new.
    const running = readRuntimeMarker(space);
    if (wasRunning) {
      const uiNames = running === "cmux" ? await managerAgentNames(space, server) : [];
      await stopOwnedManager(space);
      reapRuntimeUi(space, running, uiNames); // old UI gone before ensureManagerUp + revival create the new
    }
    await ensureManagerUp(space, server);
    // Refresh the beacon too — a restart renews the whole daemon set. A STALE beacon (old paw code or
    // an old @cotal-ai in its long-lived memory) can hold "you" under a mismatched id (e.g. a
    // server-minted nkey instead of the current stableHumanId), so agents reply to a "you" that
    // `paw inbox` doesn't read → replies vanish. Kill it by SIGNATURE (all beacons, stale wrapper pid
    // and all) so a fresh one registers under the current identity.
    await stopMailbox(space);
    ensureMailbox(space);
  });
}

/** Tear down ONLY the daemons paw started for this space (identified by paw's ownership markers).
 *  Never touches a mesh/manager paw merely adopted — those have no paw pid marker. Idempotent and
 *  serialized under the same lock as ensure(). */
export async function stop(opts: { space?: string } = {}): Promise<void> {
  const space = opts.space ?? resolveSpace();
  await withLock(space, async () => {
    // Manager + mailbox first (both ride on the mesh), then the mesh under them. Manager + mailbox
    // are killed by COMMAND SIGNATURE (stopOwnedManager/stopMailbox) — the pid markers only track the
    // tsx wrapper and can't catch a re-exec'd orphan or a duplicate from churn, so a marker-only kill
    // is exactly what left a manager running after `paw down`. The MESH pid is correct (it's cotal's
    // own nats.pid, not a spawn() pid), so it stays a marker kill.
    const runtime = readRuntimeMarker(space); // before stopOwnedManager drops the marker below
    await stopOwnedManager(space);
    // The tmux runtime's per-window teardown closes agent windows but leaves the session's shell
    // window behind (`cotal-<space>`), so stopping the manager alone orphans the session. Reap it via
    // the shared helper (tmux → kill-session; cmux → no-op here with no agent names; pty → nothing).
    reapRuntimeUi(space, runtime);
    await stopMailbox(space);
    killOwned(meshPidPath(space), "mesh");
  });
}

/** SIGTERM a pid paw recorded, then drop the marker. A pid that's already gone is fine. */
function killOwned(path: string, label: string): void {
  const pid = readPid(path);
  if (pid === undefined) return;
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      console.error(`paw: stopped ${label} (pid ${pid})`);
    } catch {
      /* raced to exit */
    }
  }
  rmSync(path, { force: true });
}

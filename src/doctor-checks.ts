/**
 * `paw doctor`'s checks: one exported function per check id, each a fact about THIS machine's paw state,
 * read from one process snapshot ({@link DoctorCtx}) and the files under $PAW_HOME. Every external input
 * (ps, launchctl, plutil, statfs, git, tmux, container, the network probes, the one write each fix makes)
 * goes through the ctx, so check:doctor drives every check from fixtures.
 *
 * Safety classes (docs/notes/cli.md#paw-doctor): a row's `fix` (class A) touches no live agent and loses
 * no data — a stale lock, a registry record nothing runs, a gone home's mailbox, a missing mailbox, a torn
 * release snapshot, the tmp dir, the signer's mode, a dead chat's inboxes. Everything else is a `command`
 * (class B) doctor prints and never runs.
 *
 * Never imported by the manager (bin/cotald.ts): nothing here is in the manager fingerprint.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { meshesDir, readMeshRegistry, removeMesh, type MeshEntry } from "@cotal-ai/workspace";
import type { ConnectTrace } from "./connect-diag.ts";
import { connectVerdict, diagnoseConnect, serverHostPort } from "./connect-diag.ts";
import { STALE_KINDS, inspectLock, removeStaleLock, type CmdOf, type LockInspection } from "./doctor-locks.ts";
import { FLEET_LABEL, GLOBAL_LABEL, WEB_LABEL, fleetJobBoots, jobState, launchctl, launchdDomain, plistPath, readJobPlist, type Launchctl } from "./launchd-plist.ts";
import {
  LIFECYCLE_LOCK_OPTS,
  classifyManagerFailure,
  cmuxAutomation,
  defaultTmuxEnv,
  durableTmpPath,
  ensureMailbox,
  mailboxMatchPattern,
  mailboxOwnerHome,
  managerLogPath,
  managerMatchPattern,
  nodeBin,
  readRuntimePreference,
  runtimeOfCommands,
  sameHome,
  stalePreloads,
  stripsTypesNatively,
  withoutBenignWarnings,
} from "./lifecycle.ts";
import { pidAlive } from "./lock.ts";
import { classify, localNameFor, localSpaces, readPersonaFact } from "./namespace.ts";
import { spacesInArgv } from "./prune.ts";
import { PS_ENV } from "./ps-env.ts";
import { currentRelease, daemonRoot, listReleases, releasePath, releasesDir, releasesInUse } from "./release.ts";
import { readRemoteMesh, type RemoteMesh } from "./remote-mesh.ts";
import { containerBin, claudeTokenFile } from "./sandbox.ts";
import { localServer } from "./server.ts";
import { personaTranscriptRoots, readResumeId, readSandbox, transcriptPath } from "./session.ts";
import { checkSignerRoot } from "./signer-root.ts";
import { listSleeping, scanRecords } from "./sleep-state.ts";
import { DEFAULT_SPACE } from "./space.ts";
import { ORIGIN, readTeleported } from "./teleport-plan.ts";
import { reasonOf, reasonWord, secsText } from "./ux.ts";
import { localHost, machineLabel } from "./host-stamp.ts";
import { claudeUserSettingsPath } from "./bypass-consent.ts";
import { outsideGuiSession } from "./gui-session.ts";
import { apiserverPlistPath, diagnoseInstallRoot, installRootOf, readApiserverInstallRoot, systemStartCommand } from "../bin/paw-container-root.mjs";
import type { PresenceHealth } from "./presence-health.ts";

// ---- the row model ---------------------------------------------------------------------------------

export type Status = "ok" | "warn" | "fail";

export interface Row {
  /** Stable id, e.g. "locks", "manager", "launchd.fleet". */
  id: string;
  /** Absent = a machine row. */
  space?: string;
  status: Status;
  /** ONE line: the fact. */
  fact: string;
  /** What --verbose / --json list. */
  items?: string[];
  /** Class A: what `--fix` does, and the doing (re-validates its precondition first; returns what it did). */
  fix?: { action: string; run: () => Promise<string> };
  /** Class B: the exact command for the operator, never run by doctor. */
  command?: string;
  /** A class-A repair `--fix` will not run here, and why. */
  skipped?: string;
}

/** What a bounce command always says. */
export const bounces = (space: string): string => `(bounces every agent in ${space} — your go)`;
const fullRestart = (space: string): string => `paw restart --full --space ${space}  ${bounces(space)}`;

// ---- the context -----------------------------------------------------------------------------------

export interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

/** Every system call a check makes, injectable. */
export interface DoctorSh {
  /** `ps -axww -o pid=,ppid=,command=` — the ONE process snapshot. */
  ps(): string;
  /** One process's command line, or undefined when it's gone. */
  psCmd(pid: number): string | undefined;
  /** One process's command line with its environment appended (`ps -E`), or undefined. */
  psEnv(pid: number): string | undefined;
  launchctl: Launchctl;
  plutil(path: string): string;
  statfs(path: string): { bavail: number; bsize: number; blocks: number };
  nodeVersion(bin: string): string;
  git(args: string[]): { ok: boolean; out: string };
  tmuxHasSession(session: string): boolean;
  containerStatus(bin: string, capMs: number): Promise<{ timedOut: boolean; ok: boolean; out: string }>;
  /** True over ssh (a macOS Background session). */
  outsideGui(): boolean;
}

/** The network probes — only in the network phase, never under --offline. */
export interface DoctorNet {
  diagnose(server: string, stepMs: number): Promise<ConnectTrace>;
  /** The manager's ps: the agents it lists. Throws on any refusal. */
  managerPs(space: string, server: string): Promise<string[]>;
  presence(space: string, server: string, ms: number): Promise<PresenceHealth>;
  sweep(space: string): Promise<{ retired: string[]; skipped: string[] }>;
}

export interface DoctorCtx {
  pawHome: string;
  home: string;
  cotalHome: string;
  env: NodeJS.ProcessEnv;
  now: number;
  platform: NodeJS.Platform;
  uid: number;
  host: string;
  offline: boolean;
  /** The spaces this run checks (scope), in display order. */
  spaces: string[];
  sh: DoctorSh;
  net: DoctorNet;
  nodeBin: () => string;
  ensureMailbox: (space: string) => void;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  removeMesh: (space: string) => void;
  readMeshRegistry: () => { entries: MeshEntry[]; unusable: Array<Error & { file?: string }> };
  /** PAW_HOME is unset or ~/.paw — machine-wide repairs (another home's mailbox) may run. */
  defaultHome: boolean;
  /** COTAL_HOME is set — the registry doctor reads is a chosen one. */
  cotalHomeSet: boolean;
  /** How long a capped network probe may take. */
  capMs: number;
  /** Lazily parsed snapshot; a ps failure throws from here, so only the checks that need it fail. */
  procs(): Proc[];
  /** The snapshot's raw text (what releasesInUse/spacesInArgv read). */
  listing(): string;
  /** Manager answers already probed this run (one per space), shared by `manager` and `agents.folder`. */
  managerAnswer: Map<string, Promise<ManagerAnswer>>;
  /** Broker probes, shared by `broker` and `presence`. */
  brokerAnswer: Map<string, Promise<BrokerAnswer>>;
}

export type ManagerAnswer = { ok: true; agents: string[] } | { ok: false; why: string };
export type BrokerAnswer = { ok: true; trace: ConnectTrace } | { ok: false; trace?: ConnectTrace; capped: boolean };

/** Parse `ps -axww -o pid=,ppid=,command=`. A line in another shape is thrown, never skipped. */
export function parseListing(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) throw new Error(`unexpected ps line: ${JSON.stringify(line.slice(0, 120))}`);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]!.trim() });
  }
  return out;
}

/** A promise raced against `ms`; the loser is abandoned (process.exit ends it). */
export async function capped<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<{ done: false }>((r) => {
    timer = setTimeout(() => r({ done: false }), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), cap]);
  } finally {
    clearTimeout(timer);
  }
}

const capWord = (ms: number): string => `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)}s`;

/** The real system: one ps, real launchctl/plutil/git/tmux/container, real network probes. */
export function realSh(): DoctorSh {
  return {
    ps() {
      const r = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error(`can't list processes (ps: ${r.error?.message ?? r.stderr?.trim() ?? r.status})`);
      return r.stdout;
    },
    psCmd(pid) {
      const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    },
    psEnv(pid) {
      const r = spawnSync("ps", [...PS_ENV, "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    },
    launchctl,
    plutil: (path) => execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }),
    statfs: (path) => {
      const s = statfsSync(path);
      return { bavail: Number(s.bavail), bsize: Number(s.bsize), blocks: Number(s.blocks) };
    },
    nodeVersion: (bin) => (bin === process.execPath && !process.versions.bun ? process.version : execFileSync(bin, ["-v"], { encoding: "utf8", timeout: 10_000 }).trim()),
    git(args) {
      const r = spawnSync("git", args, { encoding: "utf8" });
      if (r.error) throw new Error(`git: ${r.error.message}`);
      return { ok: r.status === 0, out: r.status === 0 ? r.stdout : (r.stderr || r.stdout).trim() };
    },
    tmuxHasSession(session) {
      const r = spawnSync("tmux", ["has-session", "-t", session], { env: defaultTmuxEnv(process.env), stdio: "ignore" });
      if (r.error) throw new Error(`tmux: ${r.error.message}`);
      return r.status === 0;
    },
    containerStatus(bin, capMs) {
      return new Promise((resolve) => {
        const child = spawn(bin, ["system", "status"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ timedOut: true, ok: false, out });
        }, capMs);
        child.on("error", (e) => (clearTimeout(t), resolve({ timedOut: false, ok: false, out: e.message })));
        child.on("close", (code) => (clearTimeout(t), resolve({ timedOut: false, ok: code === 0, out })));
      });
    },
    outsideGui: outsideGuiSession,
  };
}

export function realNet(): DoctorNet {
  return {
    diagnose: (server, stepMs) => diagnoseConnect(server, { stepMs }),
    async managerPs(space, server) {
      const { withManagerControl } = await import("./control.ts");
      return withManagerControl(
        space,
        server,
        async (ctl) => {
          const r = await ctl.ps(2000, 2000);
          if (!r.ok) throw new Error(r.error ?? "no reply");
          return ((r.data as Array<{ name: string }>) ?? []).map((row) => row.name);
        },
        { resolveMs: 2000, only: ["ps"] },
      );
    },
    async presence(space, server, ms) {
      const { probePresenceWrites } = await import("./presence-health.ts");
      return probePresenceWrites(space, server, undefined, ms);
    },
    async sweep(space) {
      const { sweepOrphanInboxes } = await import("./human-inbox.ts");
      return sweepOrphanInboxes(space);
    },
  };
}

const SELF = /\bpaw(?:\.ts|\.mjs)? doctor(?: |$)/;

/** One process snapshot, the env, the paths. Nothing here writes. */
export function gatherCtx(opts: { offline: boolean; spaces: string[]; sh?: DoctorSh; net?: DoctorNet; capMs?: number } & Partial<DoctorCtx>): DoctorCtx {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const pawHome = opts.pawHome ?? (env.PAW_HOME?.trim() || join(home, ".paw"));
  const sh = opts.sh ?? realSh();
  let snapshot: { procs: Proc[]; text: string } | { error: Error } | undefined;
  const snap = (): { procs: Proc[]; text: string } => {
    if (!snapshot) {
      try {
        // Doctor's own process (and a launcher in front of it) names `--space <s>` too: never evidence.
        const procs = parseListing(sh.ps()).filter((p) => p.pid !== process.pid && !SELF.test(p.cmd));
        snapshot = { procs, text: procs.map((p) => `${p.pid} ${p.ppid} ${p.cmd}`).join("\n") };
      } catch (e) {
        snapshot = { error: e as Error };
      }
    }
    if ("error" in snapshot) throw snapshot.error;
    return snapshot;
  };
  return {
    pawHome,
    home,
    cotalHome: opts.cotalHome ?? (env.COTAL_HOME?.trim() || join(home, ".cotal")),
    env,
    now: opts.now ?? Date.now(),
    platform: opts.platform ?? process.platform,
    uid: opts.uid ?? process.getuid?.() ?? 0,
    host: opts.host ?? machineLabel(localHost()),
    offline: opts.offline,
    spaces: opts.spaces,
    sh,
    net: opts.net ?? realNet(),
    nodeBin: opts.nodeBin ?? nodeBin,
    ensureMailbox: opts.ensureMailbox ?? ((s) => ensureMailbox(s)),
    kill: opts.kill ?? ((pid, sig) => process.kill(pid, sig)),
    removeMesh: opts.removeMesh ?? removeMesh,
    readMeshRegistry: opts.readMeshRegistry ?? readMeshRegistry,
    defaultHome: opts.defaultHome ?? (!env.PAW_HOME?.trim() || sameHome(env.PAW_HOME.trim(), join(home, ".paw"))),
    cotalHomeSet: opts.cotalHomeSet ?? !!env.COTAL_HOME?.trim(),
    capMs: opts.capMs ?? 2500,
    procs: () => snap().procs,
    listing: () => snap().text,
    managerAnswer: new Map(),
    brokerAnswer: new Map(),
  };
}

// ---- small helpers ---------------------------------------------------------------------------------

export const tildeOf = (home: string) => (p: string): string => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

/** `4s`, `3m`, `5h`, `58d` — ux.ts's words, with days past 48h. */
export function ageText(ms: number): string {
  return ms >= 48 * 3_600_000 ? `${Math.round(ms / 86_400_000)}d` : secsText(ms);
}

/** GiB, one decimal under 10. */
export function gib(bytes: number): string {
  const g = bytes / 2 ** 30;
  return g < 10 ? g.toFixed(1) : String(Math.round(g));
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const strip = (msg: string): string => msg.replace(/^paw( doctor)?: /, "").split("\n")[0]!.trim();
const spaceDir = (ctx: DoctorCtx, s: string): string => join(ctx.pawHome, "spaces", s);
const re = (pattern: string): RegExp => new RegExp(pattern);
const darwin = (ctx: DoctorCtx): boolean => ctx.platform === "darwin";

/** Each persona of a space: name + file. Read-only. */
function personaFiles(ctx: DoctorCtx, s: string): Array<{ name: string; file: string }> {
  const dir = join(spaceDir(ctx, s), "personas");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f.slice(0, -".md".length), file: join(dir, f) }));
}

/** Manager processes of `space`: wrapper/child pairs (a pre-native release ran two) count once. */
export function managerProcs(ctx: DoctorCtx, space: string): Proc[] {
  const m = re(managerMatchPattern(space));
  const all = ctx.procs().filter((p) => m.test(p.cmd));
  const pids = new Set(all.map((p) => p.pid));
  return all.filter((p) => !pids.has(p.ppid));
}

export function mailboxProcs(ctx: DoctorCtx, space: string): Proc[] {
  const m = re(mailboxMatchPattern(space));
  return ctx.procs().filter((p) => m.test(p.cmd));
}

/** Run a check; a throw is a ✕ row naming it, never a skip. */
export async function guard(id: string, space: string | undefined, f: () => Row[] | Promise<Row[]>): Promise<Row[]> {
  try {
    return await f();
  } catch (e) {
    return [{ id, ...(space ? { space } : {}), status: "fail", fact: `check failed: ${strip((e as Error).message || String(e))}` }];
  }
}

// ---- locks (machine + space) -----------------------------------------------------------------------

const SPAWN_LOCK_STALE_MS = 443_000; // addressing.ts SPAWN_LOCK_OPTS.staleMs (check:doctor asserts they agree)
export const LOCK_STALE = { lifecycle: LIFECYCLE_LOCK_OPTS.staleMs ?? 540_000, spawn: SPAWN_LOCK_STALE_MS, revive: 2 * 3_600_000, other: 60_000 };

/** The stale age lock.ts uses for a lock of this file name. */
export function lockStaleMs(file: string): number {
  if (file === "lifecycle.lock") return LOCK_STALE.lifecycle;
  if (/^spawn\..+\.lock$/.test(file)) return LOCK_STALE.spawn;
  if (/revive.*\.lock$/.test(file)) return LOCK_STALE.revive;
  return LOCK_STALE.other;
}

const cmdOfCtx = (ctx: DoctorCtx): CmdOf => (pid) => ctx.sh.psCmd(pid);

/** One locks row over `files` (label → path, stale age). Undefined when there are none. */
function locksRow(ctx: DoctorCtx, id: string, space: string | undefined, files: Array<{ label: string; path: string; staleMs: number }>): Row | undefined {
  const seen: Array<{ label: string; path: string; staleMs: number; got: LockInspection }> = [];
  for (const f of files) {
    const got = inspectLock(f.path, f.staleMs, ctx.now, cmdOfCtx(ctx));
    if (got) seen.push({ ...f, got });
  }
  if (!seen.length) return undefined;
  const item = (x: (typeof seen)[number]): string => `${x.path} ${x.got.pid !== undefined ? `pid=${x.got.pid}` : "no pid"} ${x.got.kind === "held" || x.got.kind === "fresh" ? "live" : x.got.kind} age=${ageText(x.got.ageMs)}`;
  const items = seen.map(item);
  const stale = seen.filter((x) => STALE_KINDS.has(x.got.kind));
  const base = { id, ...(space ? { space } : {}), items };
  if (!stale.length) {
    const pids = seen.map((x) => x.got.pid).filter((p): p is number => p !== undefined);
    const fact = pids.length === seen.length
      ? seen.length === 1 ? `1 held by pid ${pids[0]} (live)` : `${seen.length} held (pids ${pids.join(", ")}, live)`
      : `${seen.length} held, none stale`;
    return { ...base, status: "ok", fact };
  }
  const name = (x: (typeof stale)[number]): string => {
    const why = x.got.kind === "dead" ? `pid ${x.got.pid}` : x.got.kind === "reused" ? `pid ${x.got.pid} reused` : "no pid";
    return `${x.label} (${why}, ${ageText(x.got.ageMs)})`;
  };
  const n = stale.length;
  const fact = `${n} stale ${plural(n, "lock", "locks")} — ${plural(n, "holder", "holders")} gone: ${stale.map(name).join(", ")}`;
  return {
    ...base,
    status: "warn",
    fact,
    fix: {
      action: `remove ${plural(n, "it", "them")} (paw breaks ${plural(n, "it", "each")} on its next use anyway)`,
      run: async () => {
        const removed: string[] = [];
        const kept: string[] = [];
        for (const x of stale) {
          const r = removeStaleLock(x.path, x.staleMs, Date.now(), cmdOfCtx(ctx));
          if (r.removed) removed.push(x.label);
          else if (r.found) kept.push(`kept ${x.label}: pid ${r.found.pid ?? "?"} took it`);
        }
        return [removed.length ? `removed ${removed.length}: ${removed.join(", ")}` : "removed none", ...kept].join("; ");
      },
    },
  };
}

export function checkMachineLocks(ctx: DoctorCtx): Row[] {
  const tilde = tildeOf(ctx.home);
  const files = [join(ctx.home, ".claude.json.paw-lock"), `${claudeUserSettingsPath()}.paw-lock`].map((path) => ({ label: tilde(path), path, staleMs: LOCK_STALE.other }));
  const row = locksRow(ctx, "locks", undefined, files);
  if (row?.status === "warn") {
    const what = row.items!.filter((i) => !/ live /.test(i)).length;
    row.fact = `${row.fact} — every spawn's folder pre-trust waits on ${plural(what, "it", "them")}`;
  }
  return row ? [row] : [];
}

export function checkSpaceLocks(ctx: DoctorCtx, s: string): Row[] {
  const dir = spaceDir(ctx, s);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".lock"))
    .sort()
    .map((f) => ({ label: f.slice(0, -".lock".length), path: join(dir, f), staleMs: lockStaleMs(f) }));
  const row = locksRow(ctx, "locks", s, files);
  return row ? [row] : [];
}

// ---- machine rows ----------------------------------------------------------------------------------

export function checkDisk(ctx: DoctorCtx): Row[] {
  let at = ctx.pawHome;
  while (!existsSync(at) && at !== "/") at = join(at, "..");
  const st = ctx.sh.statfs(at);
  const free = st.bavail * st.bsize;
  const used = Math.round((1 - st.bavail / st.blocks) * 100);
  const where = `where ${tildeOf(ctx.home)(ctx.pawHome)} lives`;
  const command = `du -sh ${tildeOf(ctx.home)(ctx.pawHome)}/* | sort -h  (paw's share; paw release --prune 3 · paw spaces prune free some)`;
  const g = free / 2 ** 30;
  if (g < 10) return [{ id: "disk", status: g < 2 ? "fail" : "warn", fact: `${gib(free)} GiB free ${where} — a full disk latched presence and took the fleet down (2026-10-13)`, command }];
  return [{ id: "disk", status: "ok", fact: `${gib(free)} GiB free (${used}% used) ${where}` }];
}

export function checkNode(ctx: DoctorCtx): Row[] {
  const tilde = tildeOf(ctx.home);
  const command = "nvm install --lts && nvm alias default lts/*";
  let bin: string;
  try {
    bin = ctx.nodeBin();
  } catch (e) {
    return [{ id: "node", status: "fail", fact: strip((e as Error).message), command }];
  }
  const version = ctx.sh.nodeVersion(bin);
  if (bin.startsWith("/opt/homebrew/") || bin.startsWith("/usr/local/Cellar/")) {
    return [{ id: "node", status: "warn", fact: `daemons' node is Homebrew's (${bin}) — a brew upgrade deletes it under running jobs`, command }];
  }
  if (!stripsTypesNatively(version)) return [{ id: "node", status: "warn", fact: `node ${version} can't strip types — the CLI falls back to tsx (slow)`, command }];
  return [{ id: "node", status: "ok", fact: `${tilde(bin)} (${version}, native TS)` }];
}

export function checkNodeOptions(ctx: DoctorCtx): Row[] {
  const v = ctx.env.NODE_OPTIONS;
  if (!v?.trim()) return [];
  const stale = stalePreloads(v);
  if (!stale.length) return [{ id: "node-options", status: "ok", fact: "NODE_OPTIONS preloads all present" }];
  return [{
    id: "node-options",
    status: "warn",
    fact: `NODE_OPTIONS preloads a missing file: ${stale.join(", ")} — daemons drop it; every other node errors`,
    items: stale,
    command: "remove it from your shell rc (grep -n NODE_OPTIONS ~/.zshrc ~/.zprofile)",
  }];
}

export function checkEnvSpace(ctx: DoctorCtx): Row[] {
  const v = ctx.env.PAW_SPACE;
  if (v === undefined) return [];
  if (!v.trim()) return [{ id: "env.space", status: "fail", fact: "PAW_SPACE is set but empty — every paw verb refuses", command: "unset PAW_SPACE" }];
  return [{ id: "env.space", status: "ok", fact: `PAW_SPACE=${v.trim()} in this shell — bare verbs act there` }];
}

export function checkTmpdir(ctx: DoctorCtx): Row[] {
  const tilde = tildeOf(ctx.home);
  const dir = durableTmpPath();
  const durable = dir === join(ctx.pawHome, "tmp");
  const label = durable ? "durable" : "per-home fallback (PAW_HOME is too long for a socket path)";
  if (!existsSync(dir)) {
    return [{
      id: "tmpdir",
      status: "warn",
      fact: `${tilde(dir)} is missing — daemons create it on start`,
      fix: { action: "create it (0700)", run: async () => {
        if (existsSync(dir)) return `${tilde(dir)} exists now — left alone`;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        return `created ${tilde(dir)} (0700)`;
      } },
    }];
  }
  const mode = statSync(dir).mode & 0o777;
  if (mode !== 0o700) {
    return [{
      id: "tmpdir",
      status: "warn",
      fact: `${tilde(dir)} is ${mode.toString(8).padStart(4, "0")} — seat control tokens live there`,
      fix: { action: "chmod 700 it", run: async () => {
        if ((statSync(dir).mode & 0o777) === 0o700) return `${tilde(dir)} is 0700 now — left alone`;
        chmodSync(dir, 0o700);
        return `chmod 700 ${tilde(dir)}`;
      } },
    }];
  }
  return [{ id: "tmpdir", status: "ok", fact: `${tilde(dir)}, ${label} (0700, ${readdirSync(dir).length} entries)` }];
}

export function checkRelease(ctx: DoctorCtx): Row[] {
  const pin = ctx.env.PAW_RELEASE?.trim();
  if (pin === "dev") return [{ id: "release", status: "warn", fact: "PAW_RELEASE=dev — daemons start from the checkout", command: "unset PAW_RELEASE" }];
  if (pin) {
    const path = releasePath(pin);
    if (!existsSync(path)) return [{ id: "release", status: "fail", fact: `PAW_RELEASE=${pin} but ${tildeOf(ctx.home)(path)} is gone`, command: "unset PAW_RELEASE" }];
    return [{ id: "release", status: "ok", fact: `PAW_RELEASE=${pin} (${ageText(ctx.now - statSync(path).mtimeMs)})` }];
  }
  const cur = currentRelease();
  if (!cur) return [{ id: "release", status: "fail", fact: "no release pinned — daemons can't start", command: "paw release" }];
  return [{ id: "release", status: "ok", fact: `current ${cur.id} (${ageText(ctx.now - cur.createdAt)})` }];
}

/** Torn snapshots: `.staging-<id>-<pid>` dirs whose writer is gone (a live one is a snapshot in progress). */
export function checkReleaseStaging(ctx: DoctorCtx): Row[] {
  const dir = releasesDir();
  if (!existsSync(dir)) return [];
  const torn = (): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(".staging-"))
      .filter((e) => {
        const pid = Number(/-(\d+)$/.exec(e.name)?.[1]);
        return !(pid > 0 && pidAlive(pid));
      })
      .map((e) => e.name);
  const found = torn();
  if (!found.length) return [];
  return [{
    id: "release.staging",
    status: "warn",
    fact: `${found.length} torn release ${plural(found.length, "snapshot", "snapshots")} (${found.length === 1 ? found[0] : ".staging-…"})`,
    items: found.map((n) => join(dir, n)),
    fix: { action: `remove ${plural(found.length, "it", "them")} (a crashed \`paw release\` left ${plural(found.length, "it", "them")})`, run: async () => {
      const now = torn();
      for (const n of now) rmSync(join(dir, n), { recursive: true, force: true });
      return `removed ${now.length}: ${now.join(", ")}`;
    } },
  }];
}

export function checkReleaseCount(ctx: DoctorCtx): Row[] {
  const all = listReleases();
  if (!all.length) return [];
  const inUse = releasesInUse(ctx.listing());
  const used = all.filter((r) => inUse.has(r.id)).length;
  if (all.length <= 10) return [{ id: "release.count", status: "ok", fact: `${all.length} ${plural(all.length, "release", "releases")} on disk (${used} in use)` }];
  return [{
    id: "release.count",
    status: "warn",
    fact: `${all.length} releases on disk (${used} in use, current kept)`,
    items: all.map((r) => `${r.id}${inUse.has(r.id) ? " (in use)" : ""}`),
    command: "paw release --prune 3  (keeps current + every in-use)",
  }];
}

export function checkReleaseInUse(ctx: DoctorCtx): Row[] {
  const dir = releasesDir();
  const rows: Row[] = [];
  const pat = new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/\\s]+)/`);
  for (const p of ctx.procs()) {
    const id = pat.exec(p.cmd)?.[1];
    if (!id || id.startsWith(".") || id === "current" || existsSync(releasePath(id))) continue;
    const space = /--space(?:=|\s+)(\S+)/.exec(p.cmd)?.[1];
    let command: string | undefined;
    if (/cotald\.ts supervise /.test(p.cmd) && space) command = fullRestart(space);
    else if ((/paw\.ts mailbox /.test(p.cmd) || /hub\/daemon\.mjs /.test(p.cmd)) && space) command = `paw restart --space ${space}`;
    else if (/paw\.ts web\b/.test(p.cmd)) command = `launchctl kickstart -k ${launchdDomain()}/${WEB_LABEL}`;
    rows.push({ id: "release.in-use", status: "fail", fact: `pid ${p.pid} runs release ${id}, which is gone from disk`, items: [p.cmd.slice(0, 80)], ...(command ? { command } : {}) });
  }
  return rows;
}

/** The agent names a fleet argv starts (between `start` and `--space`, minus flags). */
const fleetNames = (args: string[]): string[] => {
  const start = args.indexOf("start");
  const flag = args.indexOf("--space", start + 1);
  return start < 0 ? [] : args.slice(start + 1, flag < 0 ? undefined : flag).filter((a) => !a.startsWith("-"));
};
const argSpace = (args: string[]): string | undefined => {
  const i = args.indexOf("--space");
  return i >= 0 ? args[i + 1] : undefined;
};

export function checkLaunchdFleet(ctx: DoctorCtx): Row[] {
  if (!darwin(ctx)) return [];
  const tilde = tildeOf(ctx.home);
  const command = "paw launchd install <names…>  (re-runs paw start --boot now: starts registered agents that are down, never restarts live ones)";
  let job;
  try {
    job = readJobPlist(FLEET_LABEL, ctx.sh.plutil);
  } catch (e) {
    return [{ id: "launchd.fleet", status: "fail", fact: strip((e as Error).message), command }];
  }
  if (!job) return [{ id: "launchd.fleet", status: "warn", fact: "no login job — after a reboot nothing comes back", command }];
  const args = job.plist.ProgramArguments;
  const missing = (what: string): Row[] => [{ id: "launchd.fleet", status: "fail", fact: `${FLEET_LABEL} runs ${tilde(what)}, which is missing — nothing starts at login`, command }];
  const exe = args[0];
  if (!exe || !existsSync(exe)) return missing(exe ?? "(no program)");
  const body = statSync(exe).size < 4096 ? readFileSync(exe, "utf8") : "";
  if (body.startsWith("#!/bin/sh")) {
    const nvm = /export NVM_DIR=("[^"\n]*")/.exec(body);
    const fixed = /exec ("[^"\n]*") "\$@"/.exec(body);
    if (nvm) {
      const nvmSh = join(JSON.parse(nvm[1]!) as string, "nvm.sh");
      if (!existsSync(nvmSh)) return missing(nvmSh);
    } else if (fixed) {
      const node = JSON.parse(fixed[1]!) as string;
      if (!existsSync(node)) return missing(node);
    }
  }
  if (args[1] && !existsSync(args[1])) return missing(args[1]);
  const space = argSpace(args) ?? DEFAULT_SPACE;
  if (!fleetJobBoots(args)) return [{ id: "launchd.fleet", status: "warn", fact: `the fleet job predates paw start --boot — after a reboot only ${space} comes back`, command }];
  const n = fleetNames(args).length;
  return [{ id: "launchd.fleet", status: "ok", fact: `${FLEET_LABEL}: paw start --boot (${n} ${plural(n, "agent", "agents")} in ${space}) at login` }];
}

/** A job's log (`spaces/<its --space>/<log>.log`), or undefined when its plist doesn't name a space. */
function jobLogPath(ctx: DoctorCtx, label: string, log: string): string | undefined {
  let space: string | undefined;
  try {
    space = argSpace(readJobPlist(label, ctx.sh.plutil)?.plist.ProgramArguments ?? []);
  } catch {
    space = undefined; // the state row stands on launchctl; an unreadable plist only drops the log hint
  }
  return space ? tildeOf(ctx.home)(join(ctx.pawHome, "spaces", space, `${log}.log`)) : undefined;
}
function jobLog(ctx: DoctorCtx, label: string, log: string): string {
  const path = jobLogPath(ctx, label, log);
  return path ? `  (log: ${path})` : "";
}

export function checkLaunchdWeb(ctx: DoctorCtx): Row[] {
  if (!darwin(ctx)) return [];
  const state = jobState(WEB_LABEL, ctx.sh.launchctl);
  if (state === "not installed" || state.startsWith("running")) return [{ id: "launchd.web", status: "ok", fact: `${WEB_LABEL}: ${state}` }];
  if (state === "installed, not loaded") {
    return [{ id: "launchd.web", status: "warn", fact: `${WEB_LABEL} is installed but not loaded — paw web is down`, command: `launchctl bootstrap ${launchdDomain()} ${tildeOf(ctx.home)(plistPath(WEB_LABEL))}` }];
  }
  return [{ id: "launchd.web", status: "warn", fact: `${WEB_LABEL}: ${state} — paw web is down`, command: `launchctl kickstart -k ${launchdDomain()}/${WEB_LABEL}${jobLog(ctx, WEB_LABEL, "launchd-web")}` }];
}

export function checkLaunchdGlobal(ctx: DoctorCtx): Row[] {
  if (!darwin(ctx)) return [];
  const state = jobState(GLOBAL_LABEL, ctx.sh.launchctl);
  const bootstrap = `launchctl bootstrap ${launchdDomain()} ${tildeOf(ctx.home)(plistPath(GLOBAL_LABEL))}`;
  if (state === "not installed") return [{ id: "launchd.global", status: "ok", fact: `${GLOBAL_LABEL}: not installed` }];
  if (state === "installed, not loaded") return [{ id: "launchd.global", status: "warn", fact: `${GLOBAL_LABEL} is installed but not loaded — global can stay down`, command: bootstrap }];
  if (state.startsWith("running")) return [{ id: "launchd.global", status: "ok", fact: `${GLOBAL_LABEL}: every 60s, ${state}` }];
  const exit = /last exit (-?\d+)\)/.exec(state)?.[1];
  if (exit === undefined) return [{ id: "launchd.global", status: "ok", fact: `${GLOBAL_LABEL}: every 60s, not run yet` }];
  if (exit !== "0") {
    const log = jobLogPath(ctx, GLOBAL_LABEL, "launchd-global");
    return [{ id: "launchd.global", status: "warn", fact: `${GLOBAL_LABEL}: every 60s, last exit ${exit}`, ...(log ? { command: `tail -20 ${log}` } : {}) }];
  }
  return [{ id: "launchd.global", status: "ok", fact: `${GLOBAL_LABEL}: every 60s, last exit 0` }];
}

/** `space.<hex>.json` → the space it names, or undefined. */
const spaceOfRegistryFile = (file: string | undefined): string | undefined => {
  const hex = file ? /space\.([0-9a-f]+)\.json$/.exec(basename(file))?.[1] : undefined;
  return hex ? Buffer.from(hex, "hex").toString("utf8") : undefined;
};

export function checkRegistry(ctx: DoctorCtx): Row[] {
  const where = tildeOf(ctx.home)(meshesDir());
  const { entries, unusable } = ctx.readMeshRegistry();
  const names = entries.map((e) => e.space).sort();
  const rows: Row[] = [{ id: "registry", status: "ok", fact: names.length ? `${names.length} ${plural(names.length, "mesh", "meshes")} in ${where} (${names.join(", ")})` : `no meshes in ${where}` }];
  for (const u of unusable) {
    const s = spaceOfRegistryFile(u.file);
    rows.push({ id: "registry", status: "fail", fact: strip(u.message), command: s ? `paw cotal meshes rm ${s}` : `rm ${u.file ?? "<the file named above>"}` });
  }
  return rows;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const loopback = (server: string): boolean => {
  try {
    return LOOPBACK.has(serverHostPort(server).host);
  } catch {
    return false;
  }
};

/** Registry records nothing runs, left by a dead test home: the next mesh start on that URL fails. */
export function leftoverEntries(ctx: DoctorCtx, entries: MeshEntry[]): Array<{ entry: MeshEntry; why: "store" | "shared" }> {
  const argv = spacesInArgv(ctx.listing());
  const out: Array<{ entry: MeshEntry; why: "store" | "shared" }> = [];
  for (const e of entries) {
    const origin = (e as MeshEntry & { origin?: string }).origin;
    if (origin !== undefined && origin !== "up") continue;
    if (!loopback(e.server) || e.space === DEFAULT_SPACE || argv.has(e.space)) continue;
    if (managerProcs(ctx, e.space).length || mailboxProcs(ctx, e.space).length) continue;
    if (personaFiles(ctx, e.space).length) continue; // this home's own space: its record comes back with it
    if (e.storeDir && !existsSync(e.storeDir)) out.push({ entry: e, why: "store" });
    else if (entries.some((o) => o !== e && o.server === e.server)) out.push({ entry: e, why: "shared" });
  }
  return out;
}

export function checkRegistryLeftover(ctx: DoctorCtx): Row[] {
  const where = tildeOf(ctx.home)(meshesDir());
  const allowed = ctx.cotalHomeSet || ctx.defaultHome;
  return leftoverEntries(ctx, ctx.readMeshRegistry().entries).map(({ entry, why }) => {
    const fact = why === "store"
      ? `${entry.space} claims ${entry.server}, but its store is gone and nothing runs it — the next mesh start fails "already in use"`
      : `${entry.space} claims ${entry.server} beside another record, and nothing runs it — the next mesh start fails "already in use"`;
    const row: Row = { id: "registry.leftover", status: "warn", fact, items: [`${entry.space} ${entry.server}${entry.storeDir ? ` store=${entry.storeDir}` : ""}`] };
    if (!allowed) return { ...row, skipped: "PAW_HOME is a test home; machine-wide repairs run from ~/.paw" };
    return {
      ...row,
      fix: {
        action: `drop its record from ${where} · its broker streams: paw spaces prune shows them`,
        run: async () => {
          const fresh = gatherCtx({ ...ctx, offline: ctx.offline, spaces: ctx.spaces, sh: ctx.sh, net: ctx.net });
          const still = leftoverEntries(fresh, ctx.readMeshRegistry().entries).some((l) => l.entry.space === entry.space);
          if (!still) return `${entry.space}: no longer a leftover — left alone`;
          ctx.removeMesh(entry.space);
          return `dropped ${entry.space} from ${where}`;
        },
      },
    };
  });
}

const ORPHAN_MAILBOX = /paw\.ts mailbox --space (\S+) --home (.+)$/;

export function checkDaemonsOrphan(ctx: DoctorCtx): Row[] {
  const tilde = tildeOf(ctx.home);
  const rows: Row[] = [];
  for (const p of ctx.procs()) {
    const m = ORPHAN_MAILBOX.exec(p.cmd);
    if (!m || existsSync(m[2]!)) continue;
    const [, space, home] = m as unknown as [string, string, string];
    const mgrs = managerProcs(ctx, space).map((q) => `manager pid ${q.pid} — kill ${q.pid} (your call)`);
    const row: Row = { id: "daemons.orphan", status: "warn", fact: `mailbox pid ${p.pid} (space ${space}) belongs to PAW_HOME ${tilde(home)}, which is gone`, items: mgrs };
    if (!ctx.defaultHome) {
      rows.push({ ...row, skipped: "PAW_HOME is a test home; machine-wide repairs run from ~/.paw" });
      continue;
    }
    rows.push({
      ...row,
      fix: {
        action: "stop it (SIGTERM)",
        run: async () => {
          const now = ctx.sh.psCmd(p.pid);
          const again = now ? ORPHAN_MAILBOX.exec(now) : null;
          if (!again || again[2] !== home || existsSync(home)) return `mailbox pid ${p.pid}: no longer that orphan — left alone`;
          ctx.kill(p.pid, "SIGTERM");
          return `stopped mailbox pid ${p.pid} (PAW_HOME ${tilde(home)} is gone)`;
        },
      },
    });
  }
  return rows;
}

/** Every persona of every space: the machine-wide `pins` row. */
export function checkPins(ctx: DoctorCtx): Row[] {
  const byPin = new Map<string, string[]>();
  let any = false;
  for (const s of localSpaces(ctx.pawHome)) {
    for (const { name, file } of personaFiles(ctx, s)) {
      any = true;
      if (readTeleported(file)) continue;
      const pin = readResumeId(file);
      if (pin) byPin.set(pin, [...(byPin.get(pin) ?? []), `${name}#${s}`]);
    }
  }
  if (!any) return [];
  const twice = [...byPin].filter(([, who]) => who.length > 1);
  if (!twice.length) return [{ id: "pins", status: "ok", fact: "no session pinned by two agents" }];
  return twice.map(([pin, who]) => ({
    id: "pins",
    status: "fail" as const,
    fact: `session ${pin.slice(0, 8)} is pinned by ${who.slice(0, -1).join(", ")} and ${who.at(-1)} — two writers on one transcript`,
    items: who.map((w) => `${w} resume=${pin}`),
    command: `paw rm <one>#<space>  (keeps the transcript) — or paw adopt <folder> --resume ${pin} --replace --name <keeper>`,
  }));
}

/** Does any check have a reason to look at cmux? */
function cmuxInUse(ctx: DoctorCtx): boolean {
  if (ctx.env.PAW_RUNTIME?.trim() === "cmux") return true;
  if (ctx.spaces.some((s) => readRuntimePreference(s) === "cmux")) return true;
  return ctx.procs().some((p) => /cotald\.ts supervise .*--runtime cmux\b/.test(p.cmd));
}

export function checkCmux(ctx: DoctorCtx): Row[] {
  if (!darwin(ctx) || !cmuxInUse(ctx)) return [];
  const a = cmuxAutomation(ctx.home);
  const command = `set "automation": {"socketControlMode": "fullOpenAccess"} in ${tildeOf(ctx.home)(a.file)}, then restart the cmux app`;
  if (!a.exists) return [{ id: "cmux", status: "fail", fact: `${tildeOf(ctx.home)(a.file)} is missing — cmux's default (cmuxOnly) rejects paw's detached manager`, command }];
  if (a.mode === undefined || a.mode === "cmuxOnly") return [{ id: "cmux", status: "warn", fact: "cmux automation is cmuxOnly (default) — it rejects paw's detached manager", command }];
  if (a.mode === "password" && !a.password) return [{ id: "cmux", status: "warn", fact: "cmux automation is password, but cmux.json sets no socketPassword — paw's manager can't authenticate", command }];
  return [{ id: "cmux", status: "ok", fact: `cmux automation: ${a.mode}` }];
}

/** A persona anywhere with `sandbox: container`. */
function sandboxedPersonas(ctx: DoctorCtx): boolean {
  return localSpaces(ctx.pawHome).some((s) => personaFiles(ctx, s).some(({ file }) => readSandbox(file) === "container"));
}

function containerApplies(ctx: DoctorCtx): boolean {
  return darwin(ctx) && (sandboxedPersonas(ctx) || existsSync(apiserverPlistPath(ctx.home)));
}

const containerBinOr = (ctx: DoctorCtx): string | undefined => {
  try {
    return containerBin(ctx.env);
  } catch {
    return undefined;
  }
};

export function checkContainerRoot(ctx: DoctorCtx): Row[] {
  if (!containerApplies(ctx)) return [];
  const tilde = tildeOf(ctx.home);
  const plist = apiserverPlistPath(ctx.home);
  const bin = containerBinOr(ctx);
  const diag = diagnoseInstallRoot({ bin, plistPath: plist, uid: ctx.uid }) as string | undefined;
  const recorded = readApiserverInstallRoot(plist) as string | undefined;
  if (diag === undefined) {
    return [{ id: "container.root", status: "ok", fact: recorded ? `apiserver root ${tilde(recorded)} (network plugin present)` : "no apiserver registered yet — paw registers it on the first sandboxed wake" }];
  }
  const fixLine = diag.split("\n").find((l) => l.includes("system stop;"))?.trim();
  const command = fixLine?.includes("Fix: `") ? /Fix: `([^`]+)`/.exec(fixLine)?.[1] : fixLine;
  return [{
    id: "container.root",
    status: "fail",
    fact: `apiserver registered with CONTAINER_INSTALL_ROOT=${tilde(recorded ?? "?")}, which has no container-network-vmnet — every container call times out`,
    items: diag.split("\n"),
    ...(command ? { command } : {}),
  }];
}

export async function checkContainerApiserver(ctx: DoctorCtx): Promise<Row[]> {
  if (ctx.offline || !containerApplies(ctx)) return [];
  if (ctx.sh.outsideGui()) return [{ id: "container.apiserver", status: "ok", fact: "over ssh — the GUI apiserver isn't visible from here" }];
  let bin: string;
  try {
    bin = containerBin(ctx.env);
  } catch (e) {
    return [{ id: "container.apiserver", status: "fail", fact: strip((e as Error).message) }];
  }
  const r = await ctx.sh.containerStatus(bin, ctx.capMs);
  const start = (() => {
    try {
      return systemStartCommand(installRootOf(bin)) as string;
    } catch {
      return undefined;
    }
  })();
  if (r.timedOut) return [{ id: "container.apiserver", status: "warn", fact: `container system status didn't answer in ${capWord(ctx.capMs)}`, ...(start ? { command: start } : {}) }];
  if (/not running|not registered/i.test(r.out)) return [{ id: "container.apiserver", status: "warn", fact: "apiserver isn't running (after a reboot?) — paw starts it on the next sandboxed wake", ...(start ? { command: start } : {}) }];
  if (!r.ok) return [{ id: "container.apiserver", status: "warn", fact: `container system status: ${r.out.trim().split("\n")[0] || "failed with no output"}`, ...(start ? { command: start } : {}) }];
  return [{ id: "container.apiserver", status: "ok", fact: "apiserver running" }];
}

export function checkContainerToken(ctx: DoctorCtx): Row[] {
  if (!darwin(ctx) || !sandboxedPersonas(ctx)) return [];
  try {
    return [{ id: "container.token", status: "ok", fact: `token file ${tildeOf(ctx.home)(claudeTokenFile(ctx.env))} (0600)` }];
  } catch (e) {
    const msg = strip((e as Error).message);
    const file = /^(\S+) \(the Claude OAuth token\)/.exec(msg)?.[1] ?? / and (\S+) does not exist/.exec(msg)?.[1];
    const command = /chmod 600 it/.test(msg) && file ? `chmod 600 ${file}` : /does not exist/.test(msg) ? `claude setup-token, then save the token to ${file} (chmod 600)` : undefined;
    return [{ id: "container.token", status: "fail", fact: msg, ...(command ? { command } : {}) }];
  }
}

export function checkWorktrees(ctx: DoctorCtx): Row[] {
  const root = join(ctx.pawHome, "repos");
  if (!existsSync(root)) return [];
  const clones: string[] = [];
  for (const owner of readdirSync(root, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const repo of readdirSync(join(root, owner.name), { withFileTypes: true })) {
      if (repo.isDirectory() && !repo.name.endsWith(".worktrees") && existsSync(join(root, owner.name, repo.name, ".git"))) clones.push(join(owner.name, repo.name));
    }
  }
  if (!clones.length) return [];
  const rows: Row[] = [];
  for (const c of clones.sort()) {
    const dir = join(root, c);
    const r = ctx.sh.git(["-C", dir, "worktree", "list", "--porcelain"]);
    if (!r.ok) {
      rows.push({ id: "worktrees", status: "fail", fact: `${c}: git worktree list failed — ${r.out.split("\n")[0]}` });
      continue;
    }
    const n = r.out.split("\n").filter((l) => /^prunable\b/.test(l)).length;
    if (n) rows.push({ id: "worktrees", status: "warn", fact: `${c}: ${n} ${plural(n, "worktree whose dir is", "worktrees whose dir is")} gone`, command: `git -C ${tildeOf(ctx.home)(dir)} worktree prune` });
  }
  if (!rows.length) rows.push({ id: "worktrees", status: "ok", fact: `${clones.length} paw ${plural(clones.length, "clone", "clones")}, no prunable worktrees` });
  return rows;
}

export async function machineChecks(ctx: DoctorCtx): Promise<Row[]> {
  const sync: Array<[string, (c: DoctorCtx) => Row[] | Promise<Row[]>]> = [
    ["disk", checkDisk],
    ["node", checkNode],
    ["node-options", checkNodeOptions],
    ["env.space", checkEnvSpace],
    ["tmpdir", checkTmpdir],
    ["release", checkRelease],
    ["release.staging", checkReleaseStaging],
    ["release.count", checkReleaseCount],
    ["release.in-use", checkReleaseInUse],
    ["launchd.fleet", checkLaunchdFleet],
    ["launchd.web", checkLaunchdWeb],
    ["launchd.global", checkLaunchdGlobal],
    ["registry", checkRegistry],
    ["registry.leftover", checkRegistryLeftover],
    ["daemons.orphan", checkDaemonsOrphan],
    ["locks", checkMachineLocks],
    ["pins", checkPins],
    ["cmux", checkCmux],
    ["container.root", checkContainerRoot],
    ["container.apiserver", checkContainerApiserver],
    ["container.token", checkContainerToken],
    ["worktrees", checkWorktrees],
  ];
  const out = await Promise.all(sync.map(([id, f]) => guard(id, undefined, () => f(ctx))));
  return out.flat();
}

// ---- space rows ------------------------------------------------------------------------------------

/** The space's broker: its remote record's, else the local one. */
export function spaceServer(s: string): { server: string; remote?: RemoteMesh } {
  const remote = readRemoteMesh(s);
  return remote ? { server: remote.server, remote } : { server: localServer() };
}

function brokerAnswer(ctx: DoctorCtx, s: string, server: string, remote: boolean): Promise<BrokerAnswer> {
  let p = ctx.brokerAnswer.get(s);
  if (!p) {
    p = (async (): Promise<BrokerAnswer> => {
      const r = await capped(ctx.net.diagnose(server, remote ? 1500 : 800), ctx.capMs);
      if (!r.done) return { ok: false, capped: true };
      const t = r.value;
      const ok = (step: string) => t.steps.some((x) => x.step === step && x.outcome === "ok");
      const answered = remote ? ok("tcp") && (ok("tls") || t.tlsFirst === true) : ok("tcp") && ok("info");
      return answered ? { ok: true, trace: t } : { ok: false, trace: t, capped: false };
    })();
    ctx.brokerAnswer.set(s, p);
  }
  return p;
}

function managerAnswer(ctx: DoctorCtx, s: string, server: string): Promise<ManagerAnswer> {
  let p = ctx.managerAnswer.get(s);
  if (!p) {
    p = (async (): Promise<ManagerAnswer> => {
      try {
        const r = await capped(ctx.net.managerPs(s, server), ctx.capMs);
        return r.done ? { ok: true, agents: r.value } : { ok: false, why: `no answer in ${capWord(ctx.capMs)}` };
      } catch (e) {
        const msg = (e as Error).message;
        const word = reasonWord(msg);
        return { ok: false, why: word === "no answer" ? "no answer in 2s" : (word ?? reasonOf(strip(msg))) };
      }
    })();
    ctx.managerAnswer.set(s, p);
  }
  return p;
}

export async function checkBroker(ctx: DoctorCtx, s: string): Promise<Row[]> {
  if (ctx.offline) return [];
  const { server, remote } = spaceServer(s);
  const a = await brokerAnswer(ctx, s, server, !!remote);
  if (a.ok) {
    if (!remote) {
      const ms = a.trace.steps.filter((x) => x.outcome === "ok").reduce((n, x) => n + x.ms, 0);
      return [{ id: "broker", space: s, status: "ok", fact: `answers (${ms}ms)` }];
    }
    const parts = a.trace.steps.filter((x) => x.outcome === "ok" && x.step !== "info").map((x) => `${x.step} ${x.ms}ms`);
    return [{ id: "broker", space: s, status: "ok", fact: `answers over TLS (${parts.join(" · ")})` }];
  }
  const verdict = a.trace ? connectVerdict("unreachable", a.trace) : { word: "no answer", hint: `no answer in ${capWord(ctx.capMs)}` };
  if (remote) return [{ id: "broker", space: s, status: "fail", fact: `${server}: ${verdict.word} — ${verdict.hint}` }];
  if (managerProcs(ctx, s).length) return [{ id: "broker", space: s, status: "fail", fact: `${server}: ${verdict.word} — the manager here has no broker`, command: `paw status --space ${s}  (ensures the mesh)` }];
  if (server !== localServer() || ctx.env.PAW_SERVER?.trim()) return [{ id: "broker", space: s, status: "fail", fact: `${server}: ${verdict.word} — ${verdict.hint}` }];
  return [{ id: "broker", space: s, status: "ok", fact: "down — starts on the next paw command" }];
}

export function checkSigner(ctx: DoctorCtx, s: string, rec: RemoteMesh): Row[] {
  const tilde = tildeOf(ctx.home);
  const auth = join(rec.root, ".cotal", "auth", "auth.json");
  if (existsSync(auth)) {
    const mode = statSync(auth).mode & 0o777;
    if (mode & 0o077) {
      return [{
        id: "signer",
        space: s,
        status: "warn",
        fact: `auth.json is ${mode.toString(8).padStart(4, "0")} — a bearer secret readable by others`,
        items: [auth],
        fix: { action: "chmod 600 it", run: async () => {
          if (!(statSync(auth).mode & 0o077)) return `${tilde(auth)} is 0600 now — left alone`;
          chmodSync(auth, 0o600);
          return `chmod 600 ${tilde(auth)}`;
        } },
      }];
    }
  }
  try {
    checkSignerRoot(s, rec.root);
  } catch (e) {
    return [{ id: "signer", space: s, status: "fail", fact: strip((e as Error).message) }];
  }
  return [{ id: "signer", space: s, status: "ok", fact: existsSync(auth) ? `${tilde(auth)} (0600)` : `${tilde(join(rec.root, ".cotal", "auth"))} (split layout)` }];
}

export function checkName(ctx: DoctorCtx, s: string, rec: RemoteMesh): Row[] {
  if (rec.human) return [{ id: "name", space: s, status: "ok", fact: `you are "${rec.human}" there` }];
  return [{
    id: "name",
    space: s,
    status: "warn",
    fact: `you are "you" there — a shared broker needs one name per machine`,
    command: `paw mesh set ${s} --as ${ctx.host}  (running daemons keep the old name until a restart)`,
  }];
}

/** Why a manager doesn't answer, from its own log (read-only). */
function managerLogCause(s: string): string {
  const path = managerLogPath(s);
  if (!existsSync(path)) return "no manager.log";
  const tail = withoutBenignWarnings(readFileSync(path, "utf8").split("\n").slice(-50).join("\n"));
  if (/already serves space/.test(tail)) return "another manager serves this space";
  const { reason } = classifyManagerFailure(tail);
  // A hung manager's log is often healthy: say that, never "a failure" nobody logged.
  return reason === "an unrecognised failure" ? "names no known cause" : reason;
}

const releaseOfCmd = (cmd: string): string => {
  const id = /\/releases\/([^/\s]+)\/bin\/cotald\.ts/.exec(cmd)?.[1];
  if (id) return `release ${id}`;
  const root = /(\S+)\/bin\/cotald\.ts/.exec(cmd)?.[1];
  return root ? `checkout ${root}` : "unknown code root";
};

export async function checkManager(ctx: DoctorCtx, s: string): Promise<Row[]> {
  const procs = managerProcs(ctx, s);
  const base = { id: "manager", space: s };
  if (!procs.length) return [{ ...base, status: "ok", fact: "not running here — starts on the next paw command" }];
  if (procs.length > 1) return [{ ...base, status: "fail", fact: `${procs.length} managers serve ${s} (pids ${procs.map((p) => p.pid).join(", ")}) — they fight for the lease`, items: procs.map((p) => `${p.pid} ${p.cmd}`), command: fullRestart(s) }];
  const p = procs[0]!;
  const argv0 = basename(p.cmd.split(/\s+/)[0]!);
  if (argv0 === "bun") return [{ ...base, status: "fail", fact: `pid ${p.pid} runs under bun — node-pty breaks every agent`, command: fullRestart(s) }];
  const head = `pid ${p.pid} · ${runtimeOfCommands([p.cmd]) ?? "unknown runtime"} · ${releaseOfCmd(p.cmd)}`;
  if (ctx.offline) return [{ ...base, status: "ok", fact: `${head} · answer not checked (--offline)` }];
  const a = await managerAnswer(ctx, s, spaceServer(s).server);
  if (a.ok) return [{ ...base, status: "ok", fact: `${head} · answers (${a.agents.length} ${plural(a.agents.length, "agent", "agents")})` }];
  return [{ ...base, status: "fail", fact: `${head} · isn't answering (${a.why}; log: ${managerLogCause(s)})`, command: fullRestart(s) }];
}

export function checkManagerTmpdir(ctx: DoctorCtx, s: string): Row[] {
  const rows: Row[] = [];
  for (const p of managerProcs(ctx, s)) {
    const env = ctx.sh.psEnv(p.pid);
    if (env === undefined) continue; // exited since the snapshot
    const tmp = /(?:^| )TMPDIR=(\S+)/.exec(env.startsWith(p.cmd) ? env.slice(p.cmd.length) : env)?.[1];
    if (tmp !== undefined && sameHome(tmp, durableTmpPath())) continue;
    rows.push({
      id: "manager.tmpdir",
      space: s,
      status: "warn",
      fact: `manager pid ${p.pid} runs with ${tmp === undefined ? "no TMPDIR" : `TMPDIR=${tmp}`} — a disk-full purge strands every seat`,
      command: fullRestart(s),
    });
  }
  return rows;
}

export function checkUi(ctx: DoctorCtx, s: string): Row[] {
  const procs = managerProcs(ctx, s);
  if (runtimeOfCommands(procs.map((p) => p.cmd)) !== "tmux") return [];
  const own = ctx.env.TMUX_TMPDIR?.trim();
  if (own) return [{ id: "ui", space: s, status: "warn", fact: `your shell sets TMUX_TMPDIR=${own}; paw's sessions are on the default socket`, command: "unset TMUX_TMPDIR" }];
  if (!ctx.sh.tmuxHasSession(`cotal-${s}`)) return [{ id: "ui", space: s, status: "warn", fact: `no cotal-${s} session on the default tmux socket — paw attach can't find the agents` }];
  return [{ id: "ui", space: s, status: "ok", fact: `tmux session cotal-${s} on the default socket` }];
}

function sleepingIn(ctx: DoctorCtx, s: string): number {
  return existsSync(join(spaceDir(ctx, s), "sleep")) ? listSleeping(s).length : 0;
}

export function checkMailbox(ctx: DoctorCtx, s: string): Row[] {
  const tilde = tildeOf(ctx.home);
  const rows: Row[] = [];
  const procs = mailboxProcs(ctx, s);
  for (const p of procs) {
    const owner = mailboxOwnerHome(p.cmd, () => ctx.sh.psEnv(p.pid));
    if (sameHome(owner, ctx.pawHome)) rows.push({ id: "mailbox", space: s, status: "ok", fact: `pid ${p.pid}, this PAW_HOME` });
    else
      rows.push({
        id: "mailbox",
        space: s,
        status: "fail",
        fact: `pid ${p.pid} belongs to PAW_HOME ${tilde(owner)} — two homes on one space mint two "you" peers`,
        command: `PAW_HOME=${owner} paw down --space ${s}  (stops that home's daemons — your go)`,
      });
  }
  if (procs.length) return rows;
  const manager = managerProcs(ctx, s).length > 0;
  const asleep = sleepingIn(ctx, s);
  if (!manager && !asleep) return [{ id: "mailbox", space: s, status: "ok", fact: "not running (nothing needs it)" }];
  const wakes = asleep ? ` (and wakes of ${asleep} sleeping ${plural(asleep, "agent", "agents")})` : "";
  return [{
    id: "mailbox",
    space: s,
    status: "warn",
    fact: `no mailbox — replies to you${wakes} have no host`,
    fix: {
      action: "start it (adopt-or-spawn from the pinned release; touches no agent)",
      run: async () => {
        const fresh = gatherCtx({ ...ctx, offline: ctx.offline, spaces: ctx.spaces, sh: ctx.sh, net: ctx.net });
        const up = mailboxProcs(fresh, s)[0];
        if (up) return `mailbox pid ${up.pid} is up now — left alone`;
        daemonRoot(); // fail loud when no release is pinned, before ensureMailbox would only warn
        ctx.ensureMailbox(s);
        for (let i = 0; i < 15; i++) {
          const seen = mailboxProcs(gatherCtx({ ...ctx, offline: ctx.offline, spaces: ctx.spaces, sh: ctx.sh, net: ctx.net }), s)[0];
          if (seen) return `started the "you" mailbox (pid ${seen.pid})`;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`the mailbox didn't come up — see ${tilde(join(spaceDir(ctx, s), "mailbox.log"))}`);
      },
    },
  }];
}

export async function checkPresence(ctx: DoctorCtx, s: string): Promise<Row[]> {
  const { server, remote } = spaceServer(s);
  if (ctx.offline || remote || !managerProcs(ctx, s).length) return [];
  const b = await brokerAnswer(ctx, s, server, false);
  if (!b.ok) return [];
  const command = `free disk first, then ${fullRestart(s)}`;
  const r = await capped(ctx.net.presence(s, server, 1500), ctx.capMs);
  if (!r.done) return [{ id: "presence", space: s, status: "fail", fact: `presence writes time out (no answer in ${capWord(ctx.capMs)}) — agents can't come online`, command }];
  const h = r.value;
  if (h.kind === "ok") return [{ id: "presence", space: s, status: "ok", fact: "presence writes land" }];
  if (h.kind === "latched") return [{ id: "presence", space: s, status: "fail", fact: "presence writes time out (latched) — agents can't come online", command }];
  if (h.kind === "not-permitted") {
    const { probeRefusedLine } = await import("./presence-health.ts");
    return [{ id: "presence", space: s, status: "fail", fact: strip(probeRefusedLine(h.message, "paw doctor")) }];
  }
  if (h.kind === "no-bucket") return [{ id: "presence", space: s, status: "warn", fact: "presence probe: no presence bucket on the broker yet" }];
  return [{ id: "presence", space: s, status: "warn", fact: `presence probe: ${reasonOf(h.message)}` }];
}

export async function checkAgentsFolder(ctx: DoctorCtx, s: string): Promise<Row[]> {
  const files = personaFiles(ctx, s);
  if (!files.length) return [];
  let live = new Set<string>();
  if (!ctx.offline && managerProcs(ctx, s).length) {
    const a = await managerAnswer(ctx, s, spaceServer(s).server);
    if (a.ok) live = new Set(a.agents);
  }
  const gone: Array<{ name: string; folder: string }> = [];
  let counted = 0;
  for (const { name, file } of files) {
    const p = readPersonaFact(file, name);
    if (!p || p.teleported) continue;
    counted++;
    const w = classify(p);
    if (w.kind === "folder-gone" && !live.has(name)) gone.push({ name, folder: w.folder });
  }
  if (!counted) return [];
  if (!gone.length) return [{ id: "agents.folder", space: s, status: "ok", fact: `${counted} ${plural(counted, "agent", "agents")}, every folder present` }];
  const wt = gone.filter((g) => g.folder.includes("/.claude/worktrees/")).length;
  return [{
    id: "agents.folder",
    space: s,
    status: "warn",
    fact: `${gone.length} ${plural(gone.length, "agent's folder is", "agents' folders are")} gone${wt ? ` (${wt} under .claude/worktrees)` : ""} — paw status shows ${plural(gone.length, "it", "them")} ⚠`,
    items: gone.map((g) => `paw rm ${g.name}#${s}   (${tildeOf(ctx.home)(g.folder)})`),
    command: `paw rm <name>#${s}  (transcript kept) — --verbose lists each`,
  }];
}

export function checkFrozen(ctx: DoctorCtx, s: string): Row[] {
  const copies: Array<{ name: string; to: string; at?: string; folder?: string; pin?: string; written?: number }> = [];
  for (const { name, file } of personaFiles(ctx, s)) {
    const t = readTeleported(file);
    if (!t) continue;
    const pin = readResumeId(file);
    const path = pin ? transcriptPath(pin, personaTranscriptRoots(file)) : undefined;
    const written = path ? statSync(path).mtimeMs : undefined;
    const p = readPersonaFact(file, name);
    copies.push({ name, to: t.to, ...(t.at ? { at: t.at } : {}), ...((t.cwd ?? p?.cwd) ? { folder: t.cwd ?? p?.cwd } : {}), ...(pin ? { pin } : {}), ...(written !== undefined ? { written } : {}) });
  }
  if (!copies.length) return [];
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const split = copies.filter((c) => c.at && c.written !== undefined && c.written > Date.parse(c.at));
  if (!split.length) {
    const shown = copies.slice(0, 2).map((c) => `${c.name} → ${c.to}`);
    const more = copies.length > 2 ? `, +${copies.length - 2}` : "";
    return [{ id: "frozen", space: s, status: "ok", fact: `${copies.length} teleported away (${shown.join(", ")}${more}) — none written here since`, items: copies.map((c) => `${c.name} → ${c.to}${c.at ? ` at ${c.at}` : ""}`) }];
  }
  return split.map((c) => ({
    id: "frozen",
    space: s,
    status: "warn" as const,
    fact: `${c.name} → ${c.to} (${day(Date.parse(c.at!))}), but its session ${c.pin!.slice(0, 8)} was written here ${day(c.written!)} — one session continued on two machines`,
    items: [`${c.name} resume=${c.pin} teleportedAt=${c.at} transcript mtime=${new Date(c.written!).toISOString()}`],
    command: `paw teleport ${c.name}#${s} --back  — or paw adopt ${c.folder ? tildeOf(ctx.home)(c.folder) : "<folder>"}, which makes ${localNameFor(s, c.name)} here (your call)`,
  }));
}

export function checkSleep(ctx: DoctorCtx, s: string): Row[] {
  if (!existsSync(join(spaceDir(ctx, s), "sleep"))) return [];
  const { records, bad } = scanRecords(s, ".json");
  const rows: Row[] = [];
  for (const b of bad) rows.push({ id: "sleep", space: s, status: "fail", fact: `sleep record corrupt: ${b.split(":")[0]}`, items: [join(spaceDir(ctx, s), "sleep", b.split(":")[0]!)] });
  const failed = records.filter((r) => r.lastError);
  if (failed.length) {
    rows.push({
      id: "sleep",
      space: s,
      status: "warn",
      fact: `wake failed: ${failed.map((r) => `${r.name} (${r.wakeFailures ?? 1}×)`).join(", ")}`,
      items: failed.map((r) => `${r.name}: ${r.lastError}`),
      command: `paw start ${failed.map((r) => r.name).join(" ")} --space ${s}`,
    });
  }
  if (records.length && !failed.length) {
    const names = records.map((r) => r.name).sort();
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? `, +${names.length - 3}` : "");
    rows.push({ id: "sleep", space: s, status: "ok", fact: `${records.length} asleep (${shown})`, items: names });
  }
  return rows;
}

/** human-inbox.ts's ledger shape, read without loading the inbox module (it pulls the whole spawn path in). */
function readInboxLedger(dir: string): Array<{ uid: string; pid: number }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const file = join(dir, f);
      const v = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; server?: unknown; channels?: unknown; startedAt?: unknown };
      if (typeof v.pid !== "number" || typeof v.server !== "string" || !Array.isArray(v.channels) || typeof v.startedAt !== "number")
        throw new Error(`${file} is not a chat-inbox ledger entry {pid, server, channels, startedAt}`);
      return { uid: f.slice(0, -".json".length), pid: v.pid };
    });
}

export function checkChatInboxes(ctx: DoctorCtx, s: string): Row[] {
  const dir = join(spaceDir(ctx, s), "chat-inboxes");
  if (!existsSync(dir)) return [];
  const ledger = readInboxLedger(dir);
  if (!ledger.length) return [];
  const dead = ledger.filter((e) => !pidAlive(e.pid));
  if (!dead.length) return [{ id: "chat-inboxes", space: s, status: "ok", fact: `${ledger.length} chat ${plural(ledger.length, "inbox", "inboxes")}, all held by running chats` }];
  const row: Row = {
    id: "chat-inboxes",
    space: s,
    status: "warn",
    fact: `${dead.length} chat ${plural(dead.length, "inbox", "inboxes")} left on the broker by dead chats (${plural(dead.length, "pid", "pids")} ${dead.map((e) => e.pid).join(", ")})`,
    items: dead.map((e) => join(dir, `${e.uid}.json`)),
  };
  if (ctx.offline) return [{ ...row, skipped: "(--offline)" }];
  return [{
    ...row,
    fix: {
      action: "retire them (what the next paw chat does)",
      run: async () => {
        const r = await capped(ctx.net.sweep(s), 8000);
        if (!r.done) throw new Error("the sweep didn't finish in 8s");
        return `retired ${r.value.retired.length}${r.value.skipped.length ? `, ${r.value.skipped.length} held by running chats` : ""}`;
      },
    },
  }];
}

export function checkEmpty(ctx: DoctorCtx, s: string): Row[] {
  if (s === DEFAULT_SPACE || personaFiles(ctx, s).length || readRemoteMesh(s)) return [];
  if (ctx.readMeshRegistry().entries.some((e) => e.space === s)) return [];
  if (spacesInArgv(ctx.listing()).has(s)) return [];
  return [{
    id: "empty",
    space: s,
    status: "warn",
    fact: "nothing lives here — no agents, no daemons, no mesh record (a mistyped space?)",
    command: `rm -r ${tildeOf(ctx.home)(spaceDir(ctx, s))}  (doctor never deletes a space)`,
  }];
}

export async function spaceChecks(ctx: DoctorCtx, s: string): Promise<Row[]> {
  let rec: RemoteMesh | undefined;
  try {
    rec = readRemoteMesh(s);
  } catch (e) {
    return [{ id: "remote", space: s, status: "fail", fact: strip((e as Error).message) }];
  }
  // Start the network probes now: the rows below await what they need.
  if (!ctx.offline) {
    const { server } = spaceServer(s);
    void brokerAnswer(ctx, s, server, !!rec);
    void guard("manager", s, () => (managerProcs(ctx, s).length ? managerAnswer(ctx, s, server).then(() => []) : []));
  }
  const checks: Array<[string, () => Row[] | Promise<Row[]>]> = [
    ["broker", () => checkBroker(ctx, s)],
    ...(rec ? ([["signer", () => checkSigner(ctx, s, rec!)], ["name", () => checkName(ctx, s, rec!)]] as Array<[string, () => Row[]]>) : []),
    ["manager", () => checkManager(ctx, s)],
    ["manager.tmpdir", () => checkManagerTmpdir(ctx, s)],
    ["ui", () => checkUi(ctx, s)],
    ["mailbox", () => checkMailbox(ctx, s)],
    ["presence", () => checkPresence(ctx, s)],
    ["locks", () => checkSpaceLocks(ctx, s)],
    ["agents.folder", () => checkAgentsFolder(ctx, s)],
    ["frozen", () => checkFrozen(ctx, s)],
    ["sleep", () => checkSleep(ctx, s)],
    ["chat-inboxes", () => checkChatInboxes(ctx, s)],
    ["empty", () => checkEmpty(ctx, s)],
  ];
  const out = await Promise.all(checks.map(([id, f]) => guard(id, s, f)));
  return out.flat();
}

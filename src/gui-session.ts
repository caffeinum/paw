/**
 * macOS security sessions. A process started from an ssh shell lives in the "Background" session: it
 * cannot reach the login keychain (claude's login → every turn "Not logged in · Please run /login") nor
 * XPC services registered in the user's GUI domain (Apple `container`'s apiserver → "not registered with
 * launchd"). A manager started there hands that blindness to every agent it spawns, for its whole life
 * (the 2026-11-06 ssh restart of the mini). launchd's `gui/<uid>` domain is reachable from ssh as the
 * same user, and a job bootstrapped into it runs in the "Aqua" session with both. See
 * docs/notes/lifecycle.md#gui-session.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let cachedSession: string | undefined;

/** `launchctl managername` — "Aqua" in a login (GUI) session, "Background" over ssh. Throws off macOS. */
export function securitySession(): string {
  if (cachedSession !== undefined) return cachedSession;
  const r = spawnSync("launchctl", ["managername"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`paw: \`launchctl managername\` failed: ${(r.stderr || r.error?.message || "").trim()}`);
  cachedSession = r.stdout.trim();
  return cachedSession;
}

/** True when a daemon spawned from here would miss the keychain and GUI-domain services. */
export function outsideGuiSession(): boolean {
  return process.platform === "darwin" && securitySession() !== "Aqua";
}

const guiDomain = (): string => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("paw: no uid — the GUI launchd domain needs one");
  return `gui/${uid}`;
};

function launchctl(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface GuiJob {
  label: string;
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: string;
  /** Where the plist is written (it carries the env, so 0600) — removed once launchd has spawned the job. */
  plistDir: string;
}

/** The plist as JSON (plutil converts it, so no XML escaping to get wrong). Pure. */
export function guiJobPlist(job: GuiJob): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(job.env)) if (v !== undefined) env[k] = v;
  return {
    Label: job.label,
    ProgramArguments: [job.program, ...job.args],
    EnvironmentVariables: env,
    WorkingDirectory: job.cwd,
    StandardOutPath: job.log,
    StandardErrorPath: job.log,
    RunAtLoad: true,
    KeepAlive: false,
    // The manager's agents must outlive it (a manager SIGTERM spares its agents); without this launchd
    // kills the whole process group when the job's main process exits.
    AbandonProcessGroup: true,
    ProcessType: "Standard",
  };
}

/**
 * Start `job` in the user's GUI launchd domain and return its pid. A leftover job under the same label
 * that is still RUNNING fails loud (two managers for one space); a finished one is replaced.
 */
export function spawnInGuiSession(job: GuiJob): number {
  const domain = guiDomain();
  const target = `${domain}/${job.label}`;
  if (!launchctl(["print", domain]).ok)
    throw new Error(
      `paw: this shell is outside the macOS login session (ssh) and no one is logged in at this Mac's screen — ` +
        `a daemon started from here could not read the keychain, so every agent would say "Not logged in". ` +
        `Log in on the Mac (auto-login survives reboots), then retry.`,
    );
  const prior = launchctl(["print", target]);
  if (prior.ok) {
    const pid = /^\s*pid = (\d+)/m.exec(prior.out)?.[1];
    if (pid) throw new Error(`paw: launchd job ${job.label} is still running (pid ${pid}) — stop it before starting another`);
    launchctl(["bootout", target]);
  }
  mkdirSync(job.plistDir, { recursive: true });
  const json = join(job.plistDir, `${job.label}.json`);
  const plist = join(job.plistDir, `${job.label}.plist`);
  writeFileSync(json, JSON.stringify(guiJobPlist(job)), { mode: 0o600 });
  try {
    execFileSync("plutil", ["-convert", "xml1", "-o", plist, json]);
    chmodSync(plist, 0o600);
  } finally {
    rmSync(json, { force: true });
  }
  try {
    const r = launchctl(["bootstrap", domain, plist]);
    if (!r.ok && !launchctl(["print", target]).ok) throw new Error(`paw: launchctl bootstrap ${job.label} failed: ${r.out}`);
    const deadline = Date.now() + 5000;
    for (;;) {
      const p = launchctl(["print", target]);
      const pid = /^\s*pid = (\d+)/m.exec(p.out)?.[1];
      if (pid) return Number(pid);
      const exit = /last exit code = (.+)/.exec(p.out)?.[1];
      if (exit && !exit.includes("never exited")) throw new Error(`paw: launchd job ${job.label} exited at once (${exit.trim()}) — see ${job.log}`);
      if (Date.now() > deadline) throw new Error(`paw: launchd job ${job.label} did not start within 5s — see ${job.log}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  } finally {
    rmSync(plist, { force: true });
  }
}

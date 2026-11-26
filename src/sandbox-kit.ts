/**
 * `agent: kit` + `sandbox: container` — kit (the lean Go harness, src/kit.ts) runs INSIDE the agent's VM, the
 * way a sandboxed claude does (src/sandbox.ts). docs/notes/sandbox.md#kit-in-the-vm.
 *
 * The kit connector builds kit's launch exactly as for a host agent, then {@link sandboxKitLaunch} turns it into
 * `node bin/paw-sandbox-run.mjs … -- container run … <image> /paw/kit/kit run <the same args>`:
 *  - the binary: a static linux/arm64 kit (`CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build`), at
 *    `$PAW_HOME/bin/linux-arm64/kit` (or `KIT_LINUX_BIN`), its dir mounted READ-ONLY at /paw/kit — the image
 *    is unchanged (kit needs nothing of it but bash for its shell tool and the CA bundle);
 *  - the mesh: kit speaks cotal itself — `--server tls://…` + `--creds <the manager-minted file>`, served from the
 *    same per-agent creds MIRROR a sandboxed claude gets (the launcher re-copies it on renewal);
 *  - the session: `storage: claude` appends to the agent's claude transcript, which in a sandbox lives in its own
 *    store `spaces/<s>/sandbox/<n>/claude` (mounted at /paw/claude = CLAUDE_CONFIG_DIR, which kit honours); kit's
 *    own store is `/root/.kit/sessions` (KIT_HOME=/root/.kit, the private home);
 *  - kit's brief + state dir (`spaces/<s>/kit/<n>`: system.md, schedules.json) at its own path, read-write;
 *  - the provider login: ONE provider's access token, mirrored (bin/paw-sandbox-kitauth.mjs) — never a refresh
 *    token, never the host's ~/.kit, ~/.codex or opencode dirs.
 * The connection, the folder, the home, the port forwarder, the watchdog and the container lifecycle are the
 * launcher's, unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { LaunchSpec } from "@cotal-ai/core";
import { hostKitLogin, KIT_AUTH_MOUNT, kitApiProvider, kitCliName, linkKitAuthMirror, vmKitLogin, vmOwnLoginHas } from "../bin/paw-sandbox-kitauth.mjs";
import { readSandboxSkills } from "./sandbox-skills.ts";
import { readAgentType, readSandbox, sandboxClaudeDir, sandboxStateDir } from "./session.ts";
import {
  assertSandboxable,
  claimSandboxHome,
  containerBin,
  containerName,
  readSandboxForward,
  readSandboxImage,
  mountSandboxSkills,
  readSandboxMemory,
  SANDBOX_CLAUDE_MOUNT,
  SANDBOX_HOME_MOUNT,
  SANDBOX_RUNNER,
  SANDBOX_SEAT_MOUNT,
  SANDBOX_VM_ENV,
  sandboxBashEnv,
  sandboxHomeDir,
  SANDBOX_BASH_ENV,
} from "./sandbox.ts";

/** Where the linux kit's directory is mounted in the VM, and the binary the seat runs. */
export const SANDBOX_KIT_MOUNT = "/paw/kit";
export const SANDBOX_KIT_BIN = `${SANDBOX_KIT_MOUNT}/kit`;
/** kit's own home in the VM: config, models cache, its own store and its own `kit auth` login — the private home. */
export const SANDBOX_KIT_HOME = `${SANDBOX_HOME_MOUNT}/.kit`;

function pawHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

/** The linux/arm64 kit the VM runs: `KIT_LINUX_BIN`, else `$PAW_HOME/bin/linux-arm64/kit`. Its DIRECTORY is
 *  mounted read-only, so it must hold nothing but kit. */
export function kitLinuxBinPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIT_LINUX_BIN?.trim() || join(pawHome(env), "bin", "linux-arm64", "kit");
}

/** The cross-build command, said in every error that needs it. */
export function kitLinuxBuildCommand(env: NodeJS.ProcessEnv = process.env): string {
  const src = env.KIT_SRC?.trim() || "<your kit checkout>";
  return `cd ${src} && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ${kitLinuxBinPath(env)} ./cmd/kit`;
}

/**
 * Make sure the linux kit exists — CLI side, before a spawn (the manager's connector only checks the path).
 * `KIT_LINUX_BIN` is the operator's: never built over. Otherwise it is cross-built from `$KIT_SRC` (the checkout
 * paw builds the host kit from) when that is set; with no checkout named, fail loud with the command.
 */
export function ensureKitLinuxBinary(env: NodeJS.ProcessEnv = process.env): string {
  const bin = kitLinuxBinPath(env);
  if (existsSync(bin)) return bin;
  if (env.KIT_LINUX_BIN?.trim()) throw new Error(`paw: KIT_LINUX_BIN=${bin} does not exist`);
  const src = env.KIT_SRC?.trim() || join(homedir(), "Github", "caffeinum", "kit");
  if (!existsSync(join(src, "go.mod")))
    throw new Error(`paw: a sandboxed kit agent runs a linux/arm64 kit, and there is none at ${bin} — build it: \`${kitLinuxBuildCommand(env)}\` (or set KIT_SRC to the checkout and paw builds it)`);
  mkdirSync(dirname(bin), { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  console.error(`paw: cross-building kit for the sandbox (linux/arm64) from ${src} → ${bin}`);
  const r = spawnSync("go", ["build", "-o", tmp, "./cmd/kit"], { cwd: src, stdio: ["ignore", "inherit", "inherit"], env: { ...env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: "arm64" } });
  if (r.status !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`paw: cross-building kit for linux/arm64 failed (${r.error?.message ?? `exit ${r.status}`}) — \`${kitLinuxBuildCommand(env)}\``);
  }
  renameSync(tmp, bin);
  return bin;
}

/** The flag values a kit argv sets (Go's flag package: the LAST copy wins). */
function lastFlag(args: string[], names: string[]): string | undefined {
  let v: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(args[i]);
    if (!m || !names.includes(m[1])) continue;
    v = m[2] ?? args[++i];
  }
  return v;
}

/** Which provider a model name implies — kit's own rule (cmd/kit/resolve.go impliedProvider), minus its
 *  models cache: a name paw can't place is "unknown", never guessed. */
function impliedProvider(model: string): string | undefined {
  const pre = model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
  if (pre !== undefined) return kitApiProvider(pre);
  if (kitApiProvider(model)) return kitApiProvider(model);
  if (model.startsWith("grok-")) return "xai";
  if (/^(gpt-|codex-|o[0-9])/.test(model)) return "openai";
  return undefined;
}

/**
 * The ONE provider a sandboxed kit agent talks to (`openai` | `xai`), or `fake` (kit's offline model — no login).
 * From what the launch will say: the persona's `provider:`/`model:`, a spawn `--model`, then `kitArgs:` (last).
 * paw mirrors only that provider's login into the VM, so an agent whose provider kit would pick from its own
 * defaults (nothing named) is refused — name it (`-m grok-4.7`, `-P grok`, or `provider:`).
 */
export function sandboxKitProvider(p: { provider?: string; model?: string; kitArgs: string[] }, name: string): string {
  const prov = lastFlag(p.kitArgs, ["P", "provider"]) ?? p.provider;
  const model = lastFlag(p.kitArgs, ["m", "model"]) ?? p.model;
  if (prov && /^fake(:|$)/.test(prov)) return "fake";
  const fromProv = prov ? kitApiProvider(prov) : undefined;
  if (prov && !fromProv) throw new Error(`paw: "${name}": kit provider "${prov}" — kit drives codex or grok`);
  const fromModel = model ? impliedProvider(model) : undefined;
  if (fromProv && fromModel && fromProv !== fromModel)
    throw new Error(`paw: "${name}": provider ${prov} but model ${model} is a ${kitCliName(fromModel)} model — say one (kit refuses it too)`);
  const got = fromProv ?? fromModel;
  if (!got)
    throw new Error(
      `paw: "${name}" is a sandboxed kit agent with ${model ? `a model paw can't place (${model})` : "no provider named"} — paw mirrors exactly ONE provider's login into its VM. ` +
        "Name it: `-m grok-4.7` / `-m codex/<model>`, `-P grok|codex`, or `provider:` in its persona",
    );
  return got;
}

/**
 * The login this sandboxed kit agent will use, or a loud refusal: its own (`kit auth` inside the VM, kept in its
 * home) when that names the provider, else the host's (kit's own store, or a borrowed codex/opencode login).
 * Never reads a token into anything but the mirror; the value is not returned.
 */
export function assertSandboxKitLogin(name: string, provider: string, env: NodeJS.ProcessEnv = process.env): "own" | "host" | "fake" {
  if (provider === "fake") return "fake";
  const home = sandboxHomeDir(name, env);
  const cli = kitCliName(provider);
  const own = vmKitLogin(home);
  if (own === "own") {
    if (vmOwnLoginHas(home, provider)) return "own";
    throw new Error(
      `paw: "${name}" has its own kit login (${join(home, ".kit", "auth.json")}) without ${cli} — \`paw sandbox shell ${name}\` → \`kit auth ${cli}\`, or delete that file to use this machine's ${cli} login`,
    );
  }
  if (own === "other") throw new Error(`paw: ${join(home, ".kit", "auth.json")} is neither paw's mirror link nor a kit login — remove it`);
  let host;
  try {
    host = hostKitLogin(provider, env);
  } catch (e) {
    throw new Error(`paw: "${name}": this machine's ${cli} login can't be read — ${(e as Error).message}`);
  }
  if (!host)
    throw new Error(
      `paw: "${name}" runs kit on ${cli} in its sandbox, and this machine has no ${cli} login to mirror — \`kit auth ${cli}\` here (or \`paw sandbox shell ${name}\` → \`kit auth ${cli}\` for a login of its own)`,
    );
  if (!host.refreshable && host.expires <= Date.now() + 2 * 60_000)
    throw new Error(`paw: "${name}": this machine's ${cli} login (${host.origin}) has expired, and paw never refreshes another tool's login — \`kit auth ${cli}\` here, or let that tool refresh it`);
  return "host";
}

/** Everything a sandboxed kit agent needs on the host, besides what every sandboxed agent needs
 *  (assertSandboxHostReady): the linux kit and the provider's login. CLI side (spawn site, swap). */
export function assertSandboxKitReady(name: string, p: { provider?: string; model?: string; kitArgs: string[] }, env: NodeJS.ProcessEnv = process.env): void {
  const provider = sandboxKitProvider(p, name);
  ensureKitLinuxBinary(env);
  assertSandboxKitLogin(name, provider, env);
}

export interface SandboxKitLaunchOpts {
  space: string;
  name: string;
  configPath: string;
  /** kit's provider (from {@link sandboxKitProvider}). */
  provider: string;
  /** kit's brief + state dir on the host (`spaces/<s>/kit/<n>`), mounted read-write at its own path. */
  kitDir: string;
  /** the HOST kit, which the launcher runs to refresh kit's own host login. */
  hostKitBin: string;
  env?: NodeJS.ProcessEnv;
  /** test seam: a fixed container id suffix */
  suffix?: string;
}

/** Env the kit seat gets in the VM, by NAME only. Paths come from the env file; no secret is ever an env var. */
const KIT_PASS_ENV = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "COTAL_SPACE", "COTAL_NAME"];

/**
 * Turn kit's host LaunchSpec into the sandboxed one. Pure apart from the agent's own dirs (home, store, mirrors,
 * the seat dir); every precondition throws.
 */
export function sandboxKitLaunch(spec: LaunchSpec, o: SandboxKitLaunchOpts): LaunchSpec {
  const env = o.env ?? process.env;
  const cwd = assertSandboxable(o.space, o.name, o.configPath);
  if (readAgentType(o.configPath) !== "kit") throw new Error(`paw: "${o.name}" is not a kit agent — the kit sandbox launch is kit's alone`);
  if (!readSandbox(o.configPath)) throw new Error(`paw: "${o.name}" is not sandboxed`);
  const bin = containerBin(env);
  const linuxKit = kitLinuxBinPath(env);
  if (!existsSync(linuxKit)) throw new Error(`paw: no linux/arm64 kit at ${linuxKit} for "${o.name}"'s sandbox — \`${kitLinuxBuildCommand(env)}\``);
  const kitBinDir = dirname(linuxKit);
  const stray = readdirSync(kitBinDir).filter((f) => f !== basename(linuxKit) && !f.endsWith(".tmp"));
  if (stray.length) throw new Error(`paw: ${kitBinDir} is mounted into the VM and must hold only kit — it also holds ${stray.join(", ")}`);
  const stateDir = sandboxStateDir(o.configPath);
  const claudeDir = sandboxClaudeDir(o.configPath);
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  const home = claimSandboxHome(o.space, o.name, env);
  mkdirSync(o.kitDir, { recursive: true });

  const args = [...spec.args];
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  if (args[0] !== "run") throw new Error(`paw: kit's launch is not \`kit run …\` (${args[0]})`);
  const brief = at("--append-system-prompt-file");
  if (!brief || dirname(brief) !== o.kitDir) throw new Error(`paw: kit's brief ${brief ?? "(none)"} is not in ${o.kitDir} — the sandbox mounts only that dir`);

  // The mesh creds: a per-agent MIRROR dir holding only this agent's file, mounted read-only AT the real dir's
  // path (the argv's path resolves unchanged); the launcher re-copies it on renewal. As for a sandboxed claude.
  const creds = at("--creds");
  if (!creds || !isAbsolute(creds) || !existsSync(creds)) throw new Error(`paw: kit's launch names no readable --creds file (${creds ?? "none"}) — a sandboxed seat could never reach the mesh`);
  const credsMirror = join(stateDir, "creds");
  rmSync(credsMirror, { recursive: true, force: true });
  mkdirSync(credsMirror, { recursive: true, mode: 0o700 });
  copyFileSync(creds, join(credsMirror, basename(creds)));

  // The provider login: ONE provider's access token, mirrored (bin/paw-sandbox-kitauth.mjs) — unless the agent
  // has a login of its own in its home, which kit then reads and refreshes itself.
  const login = assertSandboxKitLogin(o.name, o.provider, env);
  const authDir = join(stateDir, "kit-auth");
  rmSync(authDir, { recursive: true, force: true });
  if (login === "host") {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    linkKitAuthMirror(home);
  }

  // Seat files: paw's bashenv (kit's persistent shell is a non-interactive bash, so BASH_ENV → ~/.env + ~/.bashrc
  // reach it like claude's Bash tool), a TLS CA file if one is set.
  const seatDir = join(stateDir, "seat");
  rmSync(seatDir, { recursive: true, force: true });
  mkdirSync(seatDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(seatDir, basename(SANDBOX_BASH_ENV)), sandboxBashEnv(), { mode: 0o644 });
  const vmEnv: Record<string, string> = { ...SANDBOX_VM_ENV, KIT_HOME: SANDBOX_KIT_HOME, CLAUDE_CONFIG_DIR: SANDBOX_CLAUDE_MOUNT };
  // A broker on a private CA (the manager trusts it via NODE_EXTRA_CA_CERTS / SSL_CERT_FILE): kit is Go, which
  // reads SSL_CERT_FILE (REPLACES the system bundle) and SSL_CERT_DIR (dirs, colon-separated). An extra CA goes in
  // a seat dir beside the image's own /etc/ssl/certs, so public roots still verify; an explicit bundle stays one.
  const bundle = env.SSL_CERT_FILE?.trim();
  const extra = env.NODE_EXTRA_CA_CERTS?.trim();
  for (const [k, f] of [["SSL_CERT_FILE", bundle], ["NODE_EXTRA_CA_CERTS", extra]] as const)
    if (f && !existsSync(f)) throw new Error(`paw: ${k}=${f} does not exist — the sandboxed seat needs it`);
  if (bundle) {
    copyFileSync(bundle, join(seatDir, "ssl-cert.pem"));
    vmEnv.SSL_CERT_FILE = `${SANDBOX_SEAT_MOUNT}/ssl-cert.pem`;
  }
  if (extra) {
    mkdirSync(join(seatDir, "ca"));
    copyFileSync(extra, join(seatDir, "ca", "extra-ca.pem"));
    vmEnv.SSL_CERT_DIR = `/etc/ssl/certs:${SANDBOX_SEAT_MOUNT}/ca`;
  }
  // The operator's skills, read-only at /paw/claude/skills/<name> as for a sandboxed claude (the brief's
  // `/paw/claude/skills/handoff/handoff` is one). Plugins need claude's --plugin-dir, which kit has no use for.
  const skills = mountSandboxSkills(claudeDir, stateDir, readSandboxSkills(o.configPath), env).mounts.filter((m) => m.kind === "skill");
  const vmEnvFile = join(stateDir, "vm.env");
  writeFileSync(vmEnvFile, Object.entries(vmEnv).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });

  const seatEnv: Record<string, string> = { ...(spec.env ?? {}) };
  const rw = new Map<string, string>([[cwd, cwd], [claudeDir, SANDBOX_CLAUDE_MOUNT], [home, SANDBOX_HOME_MOUNT], [o.kitDir, o.kitDir]]);
  const name = containerName(o.space, o.name, o.suffix);
  const run = [
    "run", "--rm", "-i", "-t", "--init",
    "--name", name,
    "-l", `paw.space=${o.space}`,
    "-l", `paw.agent=${o.name}`,
    "-m", readSandboxMemory(o.configPath),
    "-w", cwd,
    "--env-file", vmEnvFile,
    ...[...rw].flatMap(([h, c]) => ["-v", `${h}:${c}`]),
    "-v", `${seatDir}:${SANDBOX_SEAT_MOUNT}:ro`,
    "-v", `${credsMirror}:${dirname(creds)}:ro`,
    "-v", `${kitBinDir}:${SANDBOX_KIT_MOUNT}:ro`,
    ...(login === "host" ? ["-v", `${authDir}:${KIT_AUTH_MOUNT}:ro`] : []),
    // AFTER /paw/claude: each nests inside it.
    ...skills.flatMap((m) => ["-v", `${m.host}:${m.vm}:ro`]),
    ...KIT_PASS_ENV.filter((k) => seatEnv[k] !== undefined).flatMap((k) => ["-e", k]),
    readSandboxImage(o.configPath),
    SANDBOX_KIT_BIN,
    ...args,
  ];
  const launcher = [
    SANDBOX_RUNNER,
    "--container", bin,
    "--name", name,
    "--space", o.space,
    "--agent", o.name,
    "--log", join(stateDir, "launcher.log"),
    "--forward", readSandboxForward(o.configPath) ? "on" : "off",
    "--mirror-src", creds,
    "--mirror-dst", join(credsMirror, basename(creds)),
    ...(login === "host" ? ["--kit-provider", o.provider, "--kit-auth-mirror", join(authDir, "auth.json"), "--kit-host-bin", o.hostKitBin] : []),
    "--",
    ...run,
  ];
  return { ...spec, command: process.execPath, args: launcher, env: seatEnv };
}

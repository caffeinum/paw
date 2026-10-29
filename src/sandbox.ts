/**
 * `sandbox: container` — a claude agent that runs inside its own Linux VM (Apple's `container`, macOS 26+,
 * Apple silicon) yet is the same peer on the cotal mesh. docs/notes/sandbox.md.
 *
 * The connector builds claude's launch exactly as for any agent, then {@link sandboxLaunch} turns it into
 * `container run … <image> claude <the same args>`, run by paw's launcher (bin/paw-sandbox-run.mjs). The VM
 * sees only what is mounted:
 *  - the agent's folder, read-write, at its own path (the only host folder it can change);
 *  - its own claude config dir ($PAW_HOME/spaces/<s>/sandbox/<name>/claude) at /paw/claude — transcripts,
 *    `.claude.json`, settings — so `--resume` finds the session after any restart;
 *  - its persistent HOME ($PAW_HOME/containers/<name>) at /root — `~/.env` (auto-sourced by every bash), dotfiles,
 *    CLI installs; the rest of the VM's filesystem is wiped every launch;
 *  - READ-ONLY: paw's node_modules (the cotal MCP server + plugin hooks claude starts as its children), the
 *    launch's material dir(s) (its mesh creds, persona file, paw-brief.md), a TLS CA file if one is set;
 *  - read-write: `<cotal root>/.cotal/events` (the MCP server's event write-ahead log) — never the root itself,
 *    which holds the space's signer on a remote space.
 * Claude authenticates with the operator's OAuth token, read by the launcher from a 0600 file into the
 * environment (never argv, never the LaunchSpec, never a persona or a log line).
 *
 * v1 is remote spaces only: a local broker listens on 127.0.0.1, which a VM cannot reach.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchSpec } from "@cotal-ai/core";
import { isClaudeHarness, readAgentType, readCwd, readHeadless, readSandbox, sandboxClaudeDir, sandboxStateDir } from "./session.ts";
import { isRemoteSpace } from "./server.ts";

/** Where the agent's claude config dir is mounted inside the VM (the image's CLAUDE_CONFIG_DIR). */
export const SANDBOX_CLAUDE_MOUNT = "/paw/claude";
/** Per-launch copies of the single host files the seat reads (persona, TLS CA), read-only in the VM. */
export const SANDBOX_SEAT_MOUNT = "/paw/seat";
/** The seat's control socket INSIDE the VM: the MCP server listens, the plugin hooks dial — both in the VM,
 *  so the host path cotal picked (under the host's TMPDIR, absent in the VM) is replaced. */
export const SANDBOX_CONTROL_SOCKET = "/tmp/cotal-control.sock";
export const DEFAULT_SANDBOX_MEMORY = "2G";
/** The VM's HOME: the agent's persistent home dir on the host ({@link sandboxHomeDir}) is mounted here, rw.
 *  claude runs as the VM's root, whose home is /root — tools that assume `~` find it where they expect. */
export const SANDBOX_HOME_MOUNT = "/root";
/** Sourced by every bash in the VM (BASH_ENV): PATH for the home's tools, then the agent's own `~/.env`. */
export const SANDBOX_BASH_ENV = "/paw/seat/bashenv.sh";
/** The image's claude, by absolute path: a `claude` the agent installs into its home must not replace it. */
export const SANDBOX_CLAUDE_BIN = "/usr/local/bin/claude";

const H = SANDBOX_HOME_MOUNT;
/** Tool dirs inside the persistent home, ahead of the image's own (which still resolve: node, git, …). */
const HOME_PATH = [`${H}/.local/bin`, `${H}/node_modules/.bin`, `${H}/.local/share/pnpm`, `${H}/.bun/bin`, `${H}/.cargo/bin`, `${H}/go/bin`];
const IMAGE_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
/**
 * The VM's fixed env — PATHS, never secrets — handed to `container run --env-file` from a host file paw
 * writes per launch. Every installer's default lands in the persistent home, so a plain `npm i -g x`,
 * `pip install x`, `cargo install x` or a tool's own config/auth (XDG dirs) survives the rootfs wipe.
 */
export const SANDBOX_VM_ENV: Readonly<Record<string, string>> = {
  HOME: H,
  PATH: [...HOME_PATH, ...IMAGE_PATH].join(":"),
  NPM_CONFIG_PREFIX: `${H}/.local`,
  PNPM_HOME: `${H}/.local/share/pnpm`,
  PIP_USER: "1",
  PYTHONUSERBASE: `${H}/.local`,
  CARGO_HOME: `${H}/.cargo`,
  GOPATH: `${H}/go`,
  BUN_INSTALL: `${H}/.bun`,
  XDG_CONFIG_HOME: `${H}/.config`,
  XDG_DATA_HOME: `${H}/.local/share`,
  XDG_CACHE_HOME: `${H}/.cache`,
  BASH_ENV: SANDBOX_BASH_ENV,
  ENV: SANDBOX_BASH_ENV,
};

/** BASH_ENV's body. Re-prepends the home's PATH (a login bash's /etc/profile resets PATH before BASH_ENV
 *  runs) and exports the agent's own `~/.env`. Holds no value of its own — the secrets stay in the home. */
export function sandboxBashEnv(): string {
  return [
    "# paw (src/sandbox.ts): every bash in this sandbox sources this via BASH_ENV. Your own setup goes in",
    "# ~/.bashrc / ~/.env — your home persists across launches; the rest of the VM's filesystem does not.",
    `case ":$PATH:" in *":${HOME_PATH[0]}:"*) ;; *) PATH="${HOME_PATH.join(":")}:$PATH" ;; esac`,
    "export PATH",
    'if [ -f "$HOME/.env" ]; then set -a; . "$HOME/.env"; set +a; fi',
    "",
  ].join("\n");
}

function pawHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAW_HOME?.trim() || join(homedir(), ".paw");
}
/** A sandboxed agent's persistent home on the host, `$PAW_HOME/containers/<name>` (the VM's /root): its
 *  dotfiles, `~/.env`, CLI installs. One namespace for every space — {@link assertSandboxHomeOwner} refuses
 *  a second space's agent of the same name. */
export function sandboxHomeDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(pawHomeDir(env), "containers", name);
}
/** Which space owns `containers/<name>` — kept OUTSIDE the home, where the agent can't rewrite it. */
export function sandboxHomeOwnerFile(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(pawHomeDir(env), "containers", ".owners", name);
}
export function readSandboxHomeOwner(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const f = sandboxHomeOwnerFile(name, env);
  if (!existsSync(f)) return undefined;
  const owner = readFileSync(f, "utf8").trim();
  if (!owner) throw new Error(`paw: ${f} is empty — it must name the space that owns ${sandboxHomeDir(name, env)}`);
  return owner;
}
/** `containers/<name>` belongs to at most one space: another space's agent of the same name is refused. */
export function assertSandboxHomeOwner(space: string, name: string, env: NodeJS.ProcessEnv = process.env): void {
  const owner = readSandboxHomeOwner(name, env);
  if (owner !== undefined && owner !== space)
    throw new Error(
      `paw: ${sandboxHomeDir(name, env)} is the home of sandboxed "${name}" on space "${owner}" — a sandboxed agent named "${name}" on "${space}" would share its secrets. ` +
        `Pick another name, or (if ${name}#${owner} is gone for good) delete ${sandboxHomeDir(name, env)} and ${sandboxHomeOwnerFile(name, env)}`,
    );
}
/** Create (0700) and claim the agent's home; seed a `~/.bashrc` that sources BASH_ENV for interactive shells. */
export function claimSandboxHome(space: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  assertSandboxHomeOwner(space, name, env);
  const dir = sandboxHomeDir(name, env);
  mkdirSync(dirname(sandboxHomeOwnerFile(name, env)), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dir), 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(sandboxHomeOwnerFile(name, env))) writeFileSync(sandboxHomeOwnerFile(name, env), `${space}\n`, { mode: 0o600 });
  const rc = join(dir, ".bashrc");
  if (!existsSync(rc)) writeFileSync(rc, `# interactive shells (container exec … bash): the same PATH + ~/.env as the agent's own\n[ -f ${SANDBOX_BASH_ENV} ] && . ${SANDBOX_BASH_ENV}\n`, { mode: 0o600 });
  return dir;
}

/** paw's image recipe, and the launcher that owns one container's lifetime. */
export const CONTAINERFILE = fileURLToPath(new URL("./sandbox/Containerfile", import.meta.url));
export const SANDBOX_RUNNER = fileURLToPath(new URL("../bin/paw-sandbox-run.mjs", import.meta.url));

/** The default image tag, keyed by the Containerfile's content: a recipe change asks for a rebuild instead
 *  of silently running the old image. */
export function defaultSandboxImage(): string {
  return `paw-sandbox:${createHash("sha256").update(readFileSync(CONTAINERFILE)).digest("hex").slice(0, 12)}`;
}

/** The `container` CLI: `PAW_CONTAINER`, else the first on PATH. Missing fails loud with the install. */
export function containerBin(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.PAW_CONTAINER?.trim();
  const candidates = pinned ? [pinned] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "container"));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      if (statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  throw new Error(
    pinned
      ? `paw: PAW_CONTAINER=${pinned} is not an executable file`
      : "paw: `container` (Apple's container, github.com/apple/container) is not on PATH — install its signed release .pkg, then `container system start`",
  );
}

/** The Claude OAuth token FILE (never its contents): `PAW_CLAUDE_TOKEN_FILE`, else $PAW_HOME/secrets/claude-oauth-token.
 *  Must be a non-empty regular file readable by its owner only — anything else fails loud. */
export function claudeTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const f = env.PAW_CLAUDE_TOKEN_FILE?.trim() || join(env.PAW_HOME?.trim() || join(homedir(), ".paw"), "secrets", "claude-oauth-token");
  let st;
  try {
    st = statSync(f);
  } catch {
    throw new Error(`paw: a sandboxed claude signs in with your Claude OAuth token, and ${f} does not exist — \`claude setup-token\`, save the token there, chmod 600`);
  }
  if (!st.isFile()) throw new Error(`paw: ${f} (the Claude OAuth token) is not a regular file`);
  if (st.size === 0) throw new Error(`paw: ${f} (the Claude OAuth token) is empty`);
  if (st.mode & 0o077) throw new Error(`paw: ${f} (the Claude OAuth token) is readable by others (mode ${(st.mode & 0o777).toString(8)}) — chmod 600 it`);
  return f;
}

/** Persona `sandboxImage:` (else {@link defaultSandboxImage}) and `sandboxMemory:` (else 2G). */
export function readSandboxImage(configPath: string | undefined): string {
  return scalarKey(configPath, "sandboxImage") ?? defaultSandboxImage();
}
export function readSandboxMemory(configPath: string | undefined): string {
  const v = scalarKey(configPath, "sandboxMemory") ?? DEFAULT_SANDBOX_MEMORY;
  if (!/^\d+[KMGT]?$/i.test(v)) throw new Error(`paw: sandboxMemory: in ${configPath} is "${v}" — expected an amount like 2G or 1536M`);
  return v;
}
/** Persona `sandboxForward:` — `false` turns off forwarding the VM's listening ports to the host's loopback (default on). */
export function readSandboxForward(configPath: string | undefined): boolean {
  const v = scalarKey(configPath, "sandboxForward");
  if (v === undefined || v === "true") return true;
  if (v === "false") return false;
  throw new Error(`paw: sandboxForward: in ${configPath} is "${v}" — expected true or false`);
}
function scalarKey(configPath: string | undefined, key: string): string | undefined {
  if (!configPath || !existsSync(configPath)) return undefined;
  const line = readFileSync(configPath, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1].split("\n").find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
}

/** v1: remote spaces only — a local broker listens on 127.0.0.1, which a VM cannot reach. */
export function assertSandboxSpace(space: string, name: string): void {
  if (!isRemoteSpace(space))
    throw new Error(
      `paw: "${name}" can't be sandboxed on "${space}": it is a LOCAL space, and its broker listens on 127.0.0.1, which the VM can't reach. ` +
        "v1 runs sandboxed agents on remote spaces only (`paw mesh add`); see docs/notes/sandbox.md for the local plan",
    );
}

/**
 * Everything that must hold before a sandboxed agent may launch — checked on the CLI side (ensureAgentSpawned,
 * for a clear error at the prompt) and again in the manager's buildLaunch. Returns the agent's folder.
 */
export function assertSandboxable(space: string, name: string, configPath: string | undefined): string {
  if (!configPath) throw new Error(`paw: "${name}" is sandboxed but has no persona file to read its folder from`);
  const agent = readAgentType(configPath);
  if (!isClaudeHarness(agent))
    throw new Error(`paw: "${name}" is \`agent: ${agent}\` — only claude agents run in a sandbox; drop \`sandbox:\` from ${configPath} or the agent: pin`);
  if (readHeadless(configPath))
    throw new Error(`paw: "${name}" is headless, which needs the cotal hub's host socket — a sandboxed agent can't reach it; drop one of headless:/sandbox:`);
  assertSandboxSpace(space, name);
  const cwd = readCwd(configPath);
  if (!cwd) throw new Error(`paw: "${name}" is sandboxed but its persona has no cwd: — the folder is the only thing the VM may change`);
  if (!existsSync(cwd)) throw new Error(`paw: "${name}"'s folder ${cwd} does not exist`);
  assertSandboxHomeOwner(space, name);
  return cwd;
}

/** The host side is ready: the CLI, its services, the image, the token file. Fails loud on each. */
export function assertSandboxHostReady(configPath: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const bin = containerBin(env);
  const status = spawnSync(bin, ["system", "status"], { encoding: "utf8", timeout: 20_000 });
  if (status.status !== 0) throw new Error(`paw: \`container system status\` failed — start it with \`container system start\` (${(status.stderr || status.stdout || status.error?.message || "").trim()})`);
  const image = readSandboxImage(configPath);
  const inspect = spawnSync(bin, ["image", "inspect", image], { encoding: "utf8", timeout: 20_000 });
  if (inspect.status !== 0) throw new Error(`paw: the sandbox image ${image} is not built — \`paw sandbox build\``);
  claudeTokenFile(env);
}

/** Container ids allow [A-Za-z0-9_.-]; one launch = one fresh id, so a late cleanup of the previous launch
 *  can never stop its successor. */
export function containerName(space: string, name: string, suffix = randomBytes(3).toString("hex")): string {
  return `paw-${space}-${name}-${suffix}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** The topmost `node_modules` above `p` (pnpm's virtual store resolves inside it), or undefined. */
export function nodeModulesRoot(p: string): string | undefined {
  const parts = resolve(p).split(sep);
  const i = parts.indexOf("node_modules");
  return i === -1 ? undefined : parts.slice(0, i + 1).join(sep) || undefined;
}

type McpConfig = { mcpServers?: Record<string, { command?: string; args?: string[] }> };

/** Keep ONLY the cotal server in the launch's `--mcp-config` (inline JSON or a file): servers `paw mcp`
 *  shares run host commands with host secrets in their env — neither belongs in the VM. */
export function cotalOnlyMcpConfig(value: string): { json: string; cotalPaths: string[] } {
  const raw = value.trim().startsWith("{") ? value : readFileSync(value, "utf8");
  const cfg = JSON.parse(raw) as McpConfig;
  const cotal = cfg.mcpServers?.cotal;
  if (!cotal) throw new Error("paw: the claude launch carries no cotal MCP server — a sandboxed agent would never reach the mesh");
  return { json: JSON.stringify({ mcpServers: { cotal } }), cotalPaths: (cotal.args ?? []).filter((a) => isAbsolute(a)) };
}

/** Seed the agent's own claude config so the VM's first boot needs no human: onboarding done, its folder
 *  trusted, bypass-mode consent given. Merged into what is there; claude's own keys are kept. */
export function seedSandboxClaude(dir: string, cwd: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const merge = (file: string, edit: (o: Record<string, unknown>) => void) => {
    const p = join(dir, file);
    const o = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
    edit(o);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(o, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, p);
  };
  merge(".claude.json", (o) => {
    o.hasCompletedOnboarding = true;
    const projects = (o.projects ??= {}) as Record<string, Record<string, unknown>>;
    projects[cwd] = { ...(projects[cwd] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  });
  merge("settings.json", (o) => {
    o.skipDangerousModePermissionPrompt = true;
  });
}

/** Env the VM gets, by NAME only (`-e KEY` inherits the launcher's value — no value is ever on argv). */
const PASS_ENV = ["TERM", "COLORTERM", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CLAUDE_CONFIG_DIR", "IS_SANDBOX", "CLAUDE_CODE_OAUTH_TOKEN"];
/** cotal vars that name HOST-only state and must not reach the VM. */
const HOST_ONLY_COTAL = new Set(["COTAL_HOME"]);

export interface SandboxLaunchOpts {
  space: string;
  name: string;
  configPath: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** test seam: a fixed container id suffix */
  suffix?: string;
}

/**
 * Turn the claude LaunchSpec into the sandboxed one: `node paw-sandbox-run.mjs … -- run … <image> claude <args>`.
 * Pure apart from the seeding/mkdir of the agent's own dirs; every precondition throws.
 */
export function sandboxLaunch(spec: LaunchSpec, o: SandboxLaunchOpts): LaunchSpec {
  const env = o.env ?? process.env;
  const cwd = assertSandboxable(o.space, o.name, o.configPath);
  const bin = containerBin(env);
  const tokenFile = claudeTokenFile(env);
  const configPath = o.configPath!;
  const claudeDir = sandboxClaudeDir(configPath);
  seedSandboxClaude(claudeDir, cwd);
  const home = claimSandboxHome(o.space, o.name, env);

  const args = [...spec.args];
  const ro = new Set<string>();
  const rw = new Map<string, string>([[cwd, cwd], [claudeDir, SANDBOX_CLAUDE_MOUNT], [home, SANDBOX_HOME_MOUNT]]);

  const pluginAt = args.indexOf("--plugin-dir");
  if (pluginAt !== -1) {
    const nm = nodeModulesRoot(args[pluginAt + 1]);
    if (!nm) throw new Error(`paw: the cotal plugin dir ${args[pluginAt + 1]} is not inside a node_modules — can't mount it into the sandbox`);
    ro.add(nm);
  }
  const mcpAt = args.indexOf("--mcp-config");
  if (mcpAt === -1) throw new Error("paw: the claude launch has no --mcp-config — a sandboxed agent would never reach the mesh");
  const mcp = cotalOnlyMcpConfig(args[mcpAt + 1]);
  args[mcpAt + 1] = mcp.json;
  for (const p of mcp.cotalPaths) {
    const nm = nodeModulesRoot(p);
    if (!nm) throw new Error(`paw: the cotal MCP server ${p} is not inside a node_modules — can't mount it into the sandbox`);
    ro.add(nm);
  }
  const promptFile = args.indexOf("--append-system-prompt-file");
  if (promptFile !== -1) ro.add(dirname(args[promptFile + 1]));
  for (const a of spec.artifacts ?? []) ro.add(a);
  const seatEnv: Record<string, string> = { ...(spec.env ?? {}) };
  if (seatEnv.COTAL_LAUNCH_MATERIAL) ro.add(dirname(seatEnv.COTAL_LAUNCH_MATERIAL));
  // Single host FILES the seat reads (its persona, a TLS CA) are COPIED into a per-launch dir mounted
  // read-only at /paw/seat: a file's own directory may hold what the VM must not see (the CA's key, the
  // other agents' personas).
  const seatDir = join(sandboxStateDir(configPath), "seat");
  rmSync(seatDir, { recursive: true, force: true });
  mkdirSync(seatDir, { recursive: true, mode: 0o700 });
  const copyIn = (key: string, as: string) => {
    const host = seatEnv[key];
    if (!host) return;
    if (!existsSync(host)) throw new Error(`paw: ${key}=${host} does not exist — the sandboxed seat needs it`);
    copyFileSync(host, join(seatDir, as));
    seatEnv[key] = `${SANDBOX_SEAT_MOUNT}/${as}`;
  };
  copyIn("COTAL_AGENT_FILE", "agent.md");
  writeFileSync(join(seatDir, basename(SANDBOX_BASH_ENV)), sandboxBashEnv(), { mode: 0o644 });
  // The VM's fixed env (paths only) as a host file the run CLI reads — not under /paw/seat, the VM has no use for it.
  const vmEnvFile = join(sandboxStateDir(configPath), "vm.env");
  writeFileSync(vmEnvFile, Object.entries(SANDBOX_VM_ENV).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  // The seat's mesh creds: the launch material names a file in the space's creds dir, which also holds
  // EVERY other agent's creds on this machine — so never that dir. A per-agent MIRROR dir holding only
  // this agent's file is mounted read-only AT that dir's path (the material's path resolves unchanged),
  // and the launcher re-copies it whenever the manager renews it (an atomic rename on the host, which a
  // single-file mount would not follow). A remote space always has creds; none means a launch paw can't sandbox.
  const material = seatEnv.COTAL_LAUNCH_MATERIAL;
  if (!material) throw new Error("paw: the claude launch carries no COTAL_LAUNCH_MATERIAL — nothing tells the sandboxed seat its mesh creds");
  const creds = (JSON.parse(readFileSync(material, "utf8")) as { creds?: string }).creds;
  if (!creds || !isAbsolute(creds) || !existsSync(creds)) throw new Error(`paw: the launch material ${material} names no readable creds file (${creds ?? "none"}) — a sandboxed seat could never reach the mesh`);
  const credsMirror = join(sandboxStateDir(configPath), "creds");
  rmSync(credsMirror, { recursive: true, force: true });
  mkdirSync(credsMirror, { recursive: true, mode: 0o700 });
  copyFileSync(creds, join(credsMirror, basename(creds)));
  const credsTarget = dirname(creds);
  copyIn("NODE_EXTRA_CA_CERTS", "node-extra-ca.pem");
  copyIn("SSL_CERT_FILE", "ssl-cert.pem");
  const root = seatEnv.COTAL_WORKSPACE_ROOT;
  if (root) {
    const events = join(root, ".cotal", "events");
    mkdirSync(events, { recursive: true });
    rw.set(events, events);
  }

  seatEnv.COTAL_CONTROL_SOCKET = SANDBOX_CONTROL_SOCKET;
  seatEnv.CLAUDE_CONFIG_DIR = SANDBOX_CLAUDE_MOUNT;
  seatEnv.IS_SANDBOX = "1";
  // Every cotal var naming a host path must resolve in the VM. One paw doesn't know yet (a newer cotal's)
  // fails HERE, loud, instead of a seat that boots and never reaches the mesh.
  const targets = [...rw.values(), ...ro, SANDBOX_SEAT_MOUNT, credsTarget];
  for (const [k, v] of Object.entries(seatEnv)) {
    if (!k.startsWith("COTAL_") || HOST_ONLY_COTAL.has(k) || k === "COTAL_WORKSPACE_ROOT" || !v.startsWith("/")) continue;
    if (v === SANDBOX_CONTROL_SOCKET || targets.some((t) => v === t || v.startsWith(`${t}/`))) continue;
    throw new Error(`paw: cotal's launch passes ${k}=${v}, a host path the sandbox does not mount — src/sandbox.ts has to learn it`);
  }
  const passed = [
    ...Object.keys(seatEnv).filter((k) => k.startsWith("COTAL_") && !HOST_ONLY_COTAL.has(k)),
    ...PASS_ENV.filter((k) => k === "CLAUDE_CODE_OAUTH_TOKEN" || seatEnv[k] !== undefined),
  ];

  const name = containerName(o.space, o.name, o.suffix);
  const run = [
    "run", "--rm", "-i", "-t", "--init",
    "--name", name,
    "-l", `paw.space=${o.space}`,
    "-l", `paw.agent=${o.name}`,
    "-m", readSandboxMemory(configPath),
    "-w", cwd,
    "--env-file", vmEnvFile,
    ...[...rw].flatMap(([h, c]) => ["-v", `${h}:${c}`]),
    "-v", `${seatDir}:${SANDBOX_SEAT_MOUNT}:ro`,
    "-v", `${credsMirror}:${credsTarget}:ro`,
    ...[...ro].filter((p) => ![...rw.keys()].includes(p)).flatMap((p) => ["-v", `${p}:${p}:ro`]),
    ...[...new Set(passed)].flatMap((k) => ["-e", k]),
    readSandboxImage(configPath),
    // The IMAGE's claude, never spec.command: the manager resolves that to the HOST binary's absolute
    // path (~/.local/bin/claude), which the VM doesn't have. Absolute, so a `claude` the agent installs
    // into its home's ~/.local/bin (first on the VM's PATH) never replaces the seat's own.
    SANDBOX_CLAUDE_BIN,
    ...args,
  ];
  return {
    ...spec,
    command: process.execPath,
    args: [SANDBOX_RUNNER, "--container", bin, "--token-file", tokenFile, "--name", name, "--space", o.space, "--agent", o.name, "--log", join(sandboxStateDir(configPath), "launcher.log"), "--forward", readSandboxForward(configPath) ? "on" : "off", "--mirror-src", creds, "--mirror-dst", join(credsMirror, basename(creds)), "--", ...run],
    env: seatEnv,
  };
}

/**
 * After a stop: wait (bounded) for the agent's VM to be gone — the launcher's detached `container stop` takes a
 * second or two after the seat's SIGTERM — then force-delete whatever remains, so `paw stop` returning means no
 * container is left. Returns the ids it had to force-delete.
 */
export async function reapSandbox(space: string, name: string, ms = 15_000): Promise<string[]> {
  const bin = containerBin();
  const mine = () => listSandboxContainers(bin).filter((c) => c.space === space && c.agent === name).map((c) => c.id);
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) if (!mine().length) return [];
  const left = mine();
  if (left.length) {
    const r = spawnSync(bin, ["delete", "--force", ...left], { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(`paw: "${name}"'s container(s) ${left.join(" ")} outlived the stop and \`container delete --force\` failed (${(r.stderr || r.error?.message || "").trim()})`);
  }
  return left;
}

/** One paw sandbox container as `container ls --all --format json` reports it. */
export interface SandboxContainer {
  id: string;
  space: string;
  agent: string;
  state: string;
  memoryBytes?: number;
  ip?: string;
  started?: string;
}

/** paw's containers (labelled paw.space/paw.agent), every state. */
export function listSandboxContainers(bin: string = containerBin()): SandboxContainer[] {
  const r = spawnSync(bin, ["ls", "--all", "--format", "json"], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`paw: \`container ls\` failed (${(r.stderr || r.error?.message || "").trim()})`);
  return parseContainerList(r.stdout);
}

type ListedContainer = {
  configuration?: { id?: string; labels?: Record<string, string>; resources?: { memoryInBytes?: number } };
  status?: { state?: string; startedDate?: string; networks?: Array<{ ipv4Address?: string }> };
};
export function parseContainerList(json: string): SandboxContainer[] {
  const rows = JSON.parse(json || "[]") as ListedContainer[];
  if (!Array.isArray(rows)) throw new Error("paw: `container ls --format json` did not print a list");
  return rows.flatMap((r) => {
    const labels = r.configuration?.labels ?? {};
    const space = labels["paw.space"];
    const agent = labels["paw.agent"];
    const id = r.configuration?.id;
    if (!space || !agent || !id) return [];
    return [{
      id,
      space,
      agent,
      state: r.status?.state ?? "unknown",
      memoryBytes: r.configuration?.resources?.memoryInBytes,
      ip: r.status?.networks?.[0]?.ipv4Address,
      started: r.status?.startedDate,
    }];
  });
}

/**
 * Which seat host runs an `agent: acp` agent. The default is the native Rust host (cotal-connector-acp
 * native/rust, ~6 MB RSS live vs the node host's 57–145 MB), installed by `paw acp-host install` at
 * `$PAW_HOME/bin/cotal-acp-host-<rev>`. The binary is PINNED to {@link ACP_HOST_REV}, the same commit the
 * vendored plugin tgz comes from: the host and the plugin share an env/launch contract (native/WIRE.md),
 * so paw only ever runs a host built from the plugin commit it ships. The rev is in the binary's name, so a
 * re-vendor (new rev) fails loud until the matching host is installed, and a release rollback finds its
 * own older host still there. Persona `acpHost:` overrides it: an absolute path names another native host,
 * `acpHost: ts` asks for the plugin's bundled node host. A missing default binary fails loud with the
 * install command — never a silent fall back to node.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile } from "@cotal-ai/core";

/**
 * The cotal-connector-acp commit the Rust host is built from (its native/rust), whose TS plugin is exactly
 * what vendor/cotal-connector-acp-0.1.0.tgz holds (packed at 3ed0f7d; nothing outside native/ changed up
 * to this rev). Re-vendoring bumps BOTH constants together — check:acp holds {@link ACP_PLUGIN_INTEGRITY}
 * to pnpm-lock.yaml, so a re-pack without a new rev fails the suite.
 */
export const ACP_HOST_REV = "1b8048ac6093b13bf13e1cc85c55451f828765ee";
/** pnpm-lock.yaml's integrity for the vendored tgz packed at {@link ACP_HOST_REV}. */
export const ACP_PLUGIN_INTEGRITY = "sha512-FGxiZr91BAFq45CwB7jyYcWUsmVfMOoYYsdho6eXW6Z6CMKlpcbLthtl888w6lq1r9Ik3NoAQ+UVV9OV2tjDTg==";

export const ACP_HOST_TS = "ts";
export const ACP_HOST_INSTALL = "paw acp-host install";

export type AcpHost = { kind: "ts" } | { kind: "persona"; path: string } | { kind: "default"; path: string };

/** paw's own build of the Rust seat host at {@link ACP_HOST_REV}. */
export function acpHostBinPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PAW_HOME?.trim() || join(homedir(), ".paw"), "bin", `cotal-acp-host-${ACP_HOST_REV.slice(0, 12)}`);
}

/** The cotal-connector-acp git checkout the host is built from: `$COTAL_ACP_REPO`, else ~/Github/caffeinum's. */
export function acpHostRepo(env: NodeJS.ProcessEnv = process.env): string {
  return env.COTAL_ACP_REPO?.trim() || join(homedir(), "Github", "caffeinum", "cotal-connector-acp");
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The host this persona runs on. Throws when it relies on the default binary and that is not installed. */
export function resolveAcpHost(configPath: string | undefined, env: NodeJS.ProcessEnv = process.env): AcpHost {
  const named = configPath ? loadAgentFile(configPath).meta?.acpHost?.trim() : undefined;
  if (named === ACP_HOST_TS) return { kind: "ts" };
  // Any other value is the plugin's to validate (absolute, executable) — it reads the same persona key.
  if (named) return { kind: "persona", path: named };
  const path = acpHostBinPath(env);
  if (!isExecutable(path))
    throw new Error(
      `paw: no Rust ACP seat host at ${path} — install it with \`${ACP_HOST_INSTALL}\` ` +
        `(cargo build of cotal-connector-acp ${ACP_HOST_REV.slice(0, 12)} from ${acpHostRepo(env)}), or set the persona's \`acpHost: ts\` to run the node host instead`,
    );
  return { kind: "default", path };
}

/**
 * Build the Rust host from {@link ACP_HOST_REV} and install it atomically at {@link acpHostBinPath}. The
 * source is `git archive` of that commit, never the checkout's working tree (dirty or on another commit),
 * and `--locked` builds exactly the Cargo.lock committed there.
 */
export function installAcpHost(): string {
  const repo = acpHostRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("rev-parse", "--verify", "--quiet", `${ACP_HOST_REV}^{commit}`);
  } catch {
    throw new Error(`paw: cotal-connector-acp commit ${ACP_HOST_REV} isn't in ${repo} — fetch it there, or set COTAL_ACP_REPO to a checkout that has it`);
  }
  const bin = acpHostBinPath();
  mkdirSync(join(bin, ".."), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "paw-acp-host-"));
  try {
    const tar = join(work, "src.tar");
    git("archive", "--format=tar", "-o", tar, ACP_HOST_REV, "native/rust");
    execFileSync("tar", ["-xf", tar, "-C", work], { stdio: ["ignore", "inherit", "inherit"] });
    const crate = join(work, "native", "rust");
    console.error(`paw: building cotal-acp-host at cotal-connector-acp ${ACP_HOST_REV.slice(0, 12)} (from ${repo})`);
    try {
      // cotal-rs is a private git dependency: fetch it with the git CLI so the operator's git credentials apply.
      const env = { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: "true" };
      execFileSync("cargo", ["build", "--release", "--locked"], { cwd: crate, env, stdio: ["ignore", "inherit", "inherit"] });
    } catch (e) {
      throw new Error(`paw: building cotal-acp-host at ${ACP_HOST_REV.slice(0, 12)} failed (${(e as Error).message})`);
    }
    const built = join(crate, "target", "release", "cotal-acp-host");
    if (!isExecutable(built)) throw new Error(`paw: cargo succeeded but ${built} is not an executable`);
    const tmp = `${bin}.${process.pid}.tmp`;
    try {
      copyFileSync(built, tmp);
      renameSync(tmp, bin);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return bin;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

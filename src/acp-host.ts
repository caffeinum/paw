/**
 * Which seat host runs an `agent: acp` agent. The default is the native Rust host (cotal-connector-acp
 * native/rust, ~3 MB vs the node host's 57–145 MB) at `$PAW_HOME/bin/cotal-acp-host`, installed by
 * `paw acp-host install`. Persona `acpHost:` overrides it: an absolute path names another native host,
 * `acpHost: ts` asks for the plugin's bundled node host. A missing default binary fails loud with the
 * install command — never a silent fall back to node.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentFile } from "@cotal-ai/core";

export const ACP_HOST_TS = "ts";
export const ACP_HOST_INSTALL = "paw acp-host install";

export type AcpHost = { kind: "ts" } | { kind: "persona"; path: string } | { kind: "default"; path: string };

/** paw's own build of the Rust seat host. */
export function acpHostBinPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PAW_HOME?.trim() || join(homedir(), ".paw"), "bin", "cotal-acp-host");
}

/** The Rust host's crate: `$COTAL_ACP_HOST_SRC`, else the cotal-connector-acp checkout's native/rust. */
export function acpHostSrc(env: NodeJS.ProcessEnv = process.env): string {
  return env.COTAL_ACP_HOST_SRC?.trim() || join(homedir(), "Github", "caffeinum", "cotal-connector-acp", "native", "rust");
}

function isExecutable(path: string): boolean {
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
        `(cargo build from ${acpHostSrc(env)}), or set the persona's \`acpHost: ts\` to run the node host instead`,
    );
  return { kind: "default", path };
}

/** Build the Rust host from its crate and install it atomically at {@link acpHostBinPath}. */
export function installAcpHost(): string {
  const src = acpHostSrc();
  if (!existsSync(join(src, "Cargo.toml")))
    throw new Error(`paw: no cotal-acp-host crate at ${src} — set COTAL_ACP_HOST_SRC to the cotal-connector-acp native/rust dir`);
  const bin = acpHostBinPath();
  mkdirSync(join(bin, ".."), { recursive: true });
  console.error(`paw: building cotal-acp-host in ${src}`);
  try {
    execFileSync("cargo", ["build", "--release", "--locked"], { cwd: src, stdio: ["ignore", "inherit", "inherit"] });
  } catch (e) {
    throw new Error(`paw: building cotal-acp-host failed (${(e as Error).message})`);
  }
  const built = join(src, "target", "release", "cotal-acp-host");
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
}

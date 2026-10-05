/**
 * The cotal hub's fixed points: is it on, where its socket lives, where the per-agent shim is.
 *
 * Opt-in per space (`paw hub on`): every paw claude launches a ~1.4MB C shim as its cotal MCP server
 * instead of its own `node mcp.cjs` (~55–90MB each), and ONE hub process per space serves all of
 * those sessions (src/hub/daemon.mjs, handed its socket path on argv). Leaf module — the connector
 * (inside the manager) and lifecycle read the same answers from here, so they cannot disagree.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The tree this module runs from — a release dir for the daemons, the checkout for the CLI. */
const TREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function spaceDir(space: string): string {
  return join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "spaces", space);
}

/** The space's STICKY hub mode, set by `paw hub on|off` — what every process (the CLI, the manager's
 *  connector, a launchd job with a bare env) reads, so no shell can flip the fleet by accident. */
export function hubModePath(space: string): string {
  return join(spaceDir(space), "hub");
}

/** The mode file as it stands: "on" | "off", "garbage" when it exists but says neither (or can't be
 *  read), undefined when there is none. Garbage is treated as off, and said so — never silently. */
export function hubModeFile(space: string): "on" | "off" | "garbage" | undefined {
  const p = hubModePath(space);
  if (!existsSync(p)) return undefined;
  try {
    const v = readFileSync(p, "utf8").trim();
    return v === "on" || v === "off" ? v : "garbage";
  } catch {
    return "garbage";
  }
}

/** "on" | "off" from the mode file; absent or garbage is no choice at all (⇒ off). */
export function readHubMode(space: string): "on" | "off" | undefined {
  const m = hubModeFile(space);
  return m === "on" || m === "off" ? m : undefined;
}

/** Written atomically (tmp + rename): a reader racing the write sees the old mode or the new one. */
export function writeHubMode(space: string, mode: "on" | "off"): void {
  mkdirSync(spaceDir(space), { recursive: true });
  const p = hubModePath(space);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${mode}\n`);
  renameSync(tmp, p);
}

/** Is hub mode on for `space`? `PAW_COTAL_HUB` (1/0) is a TRANSIENT override for one process tree;
 *  the durable answer is the space's mode file; neither ⇒ off (every agent on its own mcp.cjs). */
export function hubEnabled(space: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PAW_COTAL_HUB?.trim();
  if (v === "1") return true;
  if (v === "0") return false;
  if (v) throw new Error(`paw: PAW_COTAL_HUB="${v}" — expected 1 (on) or 0 (off)`);
  return readHubMode(space) === "on";
}

/** macOS `sun_path` is 104 bytes including the NUL; a longer path fails at bind with EINVAL. */
const SUN_PATH_MAX = 103;

/** The hub's listening socket for `space`, under paw's per-space state dir. */
export function hubSocketPath(space: string): string {
  const p = join(spaceDir(space), "hub.sock");
  if (Buffer.byteLength(p) > SUN_PATH_MAX)
    throw new Error(`paw: hub socket path is ${Buffer.byteLength(p)} bytes (${p}); unix sockets allow ${SUN_PATH_MAX} — use a shorter PAW_HOME`);
  return p;
}

/** A headless agent's pipe dir: `in` (the FIFO its `claude -p` reads stream-json from) and
 *  `out.jsonl` (its stream-json output). The hub derives the same path from its socket's dir
 *  (src/hub/headless.mjs `headlessDirFor`) — keep the two in step. */
export function headlessDir(space: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes("..")) throw new Error(`paw: "${name}" is not a safe agent name for a headless pipe dir`);
  return join(spaceDir(space), "headless", name);
}

export function shimSourcePath(root = TREE_ROOT): string {
  return join(root, "src", "hub", "cotal-shim.c");
}

/** Derived, so it lives under a dot-dir: release hashing and git both skip it. */
export function shimBinaryPath(root = TREE_ROOT): string {
  return join(root, ".build", "cotal-shim");
}

/** Compile the shim with the system C compiler. Fails loud without one — there is no fallback that
 *  keeps the hub's point (a node shim would cost what the hub exists to save). */
export function buildShim(root = TREE_ROOT): string {
  const src = shimSourcePath(root);
  const out = shimBinaryPath(root);
  mkdirSync(join(root, ".build"), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  const r = spawnSync("cc", ["-O2", "-Wall", "-o", tmp, src], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    rmSync(tmp, { force: true });
    const why = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "no `cc` on PATH (install the Xcode command line tools)" : (r.stderr || r.error?.message || `exit ${r.status}`).trim();
    throw new Error(`paw: could not build the cotal hub shim from ${src}: ${why}`);
  }
  renameSync(tmp, out);
  return out;
}

/** The shim binary for `root`, built if missing or older than its source. */
export function ensureShim(root = TREE_ROOT): string {
  const out = shimBinaryPath(root);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(shimSourcePath(root)).mtimeMs) return out;
  return buildShim(root);
}

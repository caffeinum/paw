/**
 * The cotal hub's fixed points: is it on, where its socket lives, where the per-agent shim is.
 *
 * Opt-in (`PAW_COTAL_HUB=1`): every paw claude launches a ~1.4MB C shim as its cotal MCP server
 * instead of its own `node mcp.cjs` (~55–90MB each), and ONE hub process per space serves all of
 * those sessions (src/hub/daemon.mjs, handed its socket path on argv). Leaf module — the connector
 * (inside the manager) and lifecycle read the same answers from here, so they cannot disagree.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The tree this module runs from — a release dir for the daemons, the checkout for the CLI. */
const TREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** `PAW_COTAL_HUB=1` turns the hub on; unset/`0` keeps every agent on its own `node mcp.cjs`. */
export function hubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PAW_COTAL_HUB?.trim();
  if (!v || v === "0") return false;
  if (v === "1") return true;
  throw new Error(`paw: PAW_COTAL_HUB="${v}" — expected 1 (on) or 0 (off)`);
}

/** macOS `sun_path` is 104 bytes including the NUL; a longer path fails at bind with EINVAL. */
const SUN_PATH_MAX = 103;

/** The hub's listening socket for `space`, under paw's per-space state dir. */
export function hubSocketPath(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const p = join(root, "spaces", space, "hub.sock");
  if (Buffer.byteLength(p) > SUN_PATH_MAX)
    throw new Error(`paw: hub socket path is ${Buffer.byteLength(p)} bytes (${p}); unix sockets allow ${SUN_PATH_MAX} — use a shorter PAW_HOME`);
  return p;
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

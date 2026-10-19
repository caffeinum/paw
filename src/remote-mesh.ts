/**
 * Per-space REMOTE mesh records — "space X lives on a broker paw does not run".
 *
 * paw grew up with one local broker: every space shares `nats://127.0.0.1:4222` (or PAW_SERVER), and
 * ensure() starts that broker when it is down. A remote space (e.g. `team2027` on a JWT+TLS broker on
 * Fly) breaks both assumptions: the broker is somebody else's to run, and connecting needs auth paw
 * cannot conjure. A record says, for ONE space: the broker URL (`tls://host:port`, TLS required) and
 * the cotal ROOT whose `.cotal/auth/auth.json` holds that space's account SIGNER (`cotal mint
 * --signer` on the box) — the material the paw manager mints per-agent creds from.
 *
 * Stored at `$PAW_HOME/spaces/<space>/remote-mesh.json` (beside the space's other paw state, so an
 * isolated PAW_HOME isolates it too). The record holds the root PATH, never the signer: it is printed
 * by `paw mesh ls`, and the signer is a bearer secret. No record ⇒ the space is local and every code
 * path behaves exactly as before.
 *
 * Zero paw imports (a leaf like space.ts/cotal-root.ts) so server.ts and cotal-root.ts can read it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface RemoteMesh {
  space: string;
  /** `tls://host:port` — the only accepted scheme: a credential never crosses a network in plaintext. */
  server: string;
  /** Absolute dir whose `.cotal/auth/auth.json` is this space's account signer. */
  root: string;
  /** ISO time the record was written. */
  ts: string;
}

function stateRoot(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

export function remoteMeshPath(space: string): string {
  return join(stateRoot(), "spaces", space, "remote-mesh.json");
}

/** `tls://host:port`, nothing else. A path, query, credentials or a missing port is refused. */
export function checkRemoteServer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`paw: --server "${raw}" is not a URL — expected tls://host:port`);
  }
  if (u.protocol !== "tls:")
    throw new Error(`paw: --server must be tls://host:port (got ${u.protocol}//) — a remote mesh is dialled with TLS required, never plaintext`);
  if (u.username || u.password) throw new Error("paw: --server must not embed credentials — the signer lives under --root");
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) throw new Error(`paw: --server must be a bare tls://host:port`);
  if (!u.hostname || !u.port) throw new Error(`paw: --server "${raw}" needs a host and an explicit port (tls://host:4222)`);
  return `tls://${u.host}`;
}

/** Space names a record may carry: what paw uses as a directory and cotal as a subject token. */
export function checkSpaceName(space: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(space)) throw new Error(`paw: space "${space}" must be letters, digits, '-' or '_'`);
  return space;
}

function parseRecord(space: string, path: string, raw: string): RemoteMesh {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error(`paw: remote mesh record ${path} is not JSON (${(e as Error).message}) — fix it or \`paw mesh rm ${space}\``);
  }
  const r = v as Partial<RemoteMesh>;
  if (typeof r !== "object" || r === null || r.space !== space || typeof r.server !== "string" || typeof r.root !== "string" || typeof r.ts !== "string")
    throw new Error(`paw: remote mesh record ${path} is malformed (needs space="${space}", server, root, ts) — fix it or \`paw mesh rm ${space}\``);
  checkRemoteServer(r.server);
  if (!isAbsolute(r.root)) throw new Error(`paw: remote mesh record ${path} has a relative root "${r.root}"`);
  return { space: r.space, server: r.server, root: r.root, ts: r.ts };
}

/** The space's remote record, or undefined when the space is local. A record that exists but cannot
 *  be read is an error, never "local": falling back would dial the local broker for a remote space. */
export function readRemoteMesh(space: string): RemoteMesh | undefined {
  const path = remoteMeshPath(space);
  if (!existsSync(path)) return undefined;
  return parseRecord(space, path, readFileSync(path, "utf8"));
}

export function writeRemoteMesh(rec: RemoteMesh): string {
  const path = remoteMeshPath(rec.space);
  mkdirSync(join(stateRoot(), "spaces", rec.space), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Every remote record under this PAW_HOME, by space name. */
export function listRemoteMeshes(): RemoteMesh[] {
  const dir = join(stateRoot(), "spaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((s) => existsSync(remoteMeshPath(s)))
    .sort()
    .map((s) => readRemoteMesh(s) as RemoteMesh);
}

/** Drop a space's record. Returns whether one existed. */
export function removeRemoteMesh(space: string): boolean {
  const path = remoteMeshPath(space);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

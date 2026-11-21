/**
 * The broker an explicit `--server <flag>` may name for a space, checked BEFORE anything boots or dials
 * (bin/paw.ts's gate runs it for every verb but `mesh`, which writes the record, and `cotal`, then hands
 * the verb the value returned here in place of the flag).
 *
 * Its own module, outside src/server.ts: that file is in the manager's import graph, and touching it
 * changes the manager fingerprint (a `paw restart` would bounce every agent instead of the mailbox).
 * Only the CLI gate imports this.
 *
 * A remote space is dialled only at its record's server, with TLS required and creds minted from its
 * signer, so a different `--server` is refused. A space with NO record is local: it takes only a local
 * broker (a loopback `nats://` URL, or PAW_SERVER). Anything else used to fall through as "local":
 * ensure() booted a local mesh, manager and mailbox for the space, then the command dialled the remote
 * URL with local creds and no TLS requirement — a raw broker auth error and side-effect daemons (#142,
 * `paw web --server tls://… --creds participant.creds`). paw joins a remote mesh only through
 * `paw mesh add` with the account signer; a participant credential can't run paw.
 *
 * A flag carrying userinfo (user:pass@, token@) is refused without being echoed, and the other refusals
 * show only its scheme and host:port. It never sees a creds path.
 */
import { checkRemoteServer, readRemoteMesh } from "./remote-mesh.ts";
import { localServer, pawServer } from "./server.ts";

export function serverFlagFor(space: string, flag: string | undefined): string {
  if (flag === undefined) return pawServer(space);
  if (flag.includes("@"))
    throw new Error("paw: --server must not embed credentials (user:pass@ or token@, not echoed here) — drop them; paw dials with creds it mints itself");
  const record = readRemoteMesh(space);
  if (record) {
    if (sameRemoteServer(flag, record.server)) return record.server;
    throw new Error(
      `paw: --server ${shown(flag)} is not space "${space}"'s broker (${record.server}) — drop --server; a remote space is dialled at its record's server, TLS required, with creds minted from its signer`,
    );
  }
  if (isLoopbackNats(flag)) return flag;
  const local = localServer();
  if (flag === local) return flag;
  throw new Error(
    `paw: --server ${shown(flag)} is not a local broker (a loopback nats:// URL, or PAW_SERVER: ${local}), and space "${space}" has no remote record here. ` +
      `paw joins a remote mesh only with its account signer, over TLS: \`paw mesh add ${space} --server ${remoteForm(flag) ?? "tls://host:port"} --root <dir>\` ` +
      "(the dir whose .cotal/auth/auth.json is `cotal auth signer`'s file). paw web then reads it as cotal's admin observer (DMs, anycast, membership). " +
      "A participant credential (the one `cotal join --creds … --lifecycle-uid …` uses) only reads its own channels and history, so paw can't run on it — " +
      "keep using that cotal join session, or ask the mesh operator for the signer.",
  );
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

function isLoopbackNats(flag: string): boolean {
  const u = parsed(flag);
  return u?.protocol === "nats:" && LOOPBACK_HOST.test(u.hostname.toLowerCase());
}

/** The same `tls://host:port` spelled differently (`TLS://`, an upper-case host, a trailing dot):
 *  hostnames compare case-insensitively, since WHATWG URL keeps a non-special scheme's host as typed.
 *  A flag that isn't a valid remote URL is simply not the same server. */
function sameRemoteServer(flag: string, recorded: string): boolean {
  const ours = remoteForm(flag);
  return ours !== undefined && hostKey(ours) === hostKey(recorded);
}

function hostKey(server: string): string {
  const u = new URL(server);
  return `${u.hostname.toLowerCase().replace(/\.$/, "")}:${u.port}`;
}

/** `flag` as `paw mesh add` would store it (`tls://host:port`, no userinfo, path or query), else undefined. */
function remoteForm(flag: string): string | undefined {
  try {
    return checkRemoteServer(flag);
  } catch {
    return undefined;
  }
}

/** The flag as an error may show it: scheme and host:port only, never a path or query. */
function shown(flag: string): string {
  const u = parsed(flag);
  if (u?.host) return `${u.protocol}//${u.host}`;
  return /^[\w.:[\]-]+$/.test(flag) ? flag : "(value not shown)";
}

function parsed(flag: string): URL | undefined {
  try {
    return new URL(flag);
  } catch {
    return undefined;
  }
}

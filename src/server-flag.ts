/**
 * The broker an explicit `--server <flag>` may name for a space, checked BEFORE anything boots or dials
 * (bin/paw.ts's gate runs it for every verb but `mesh`, which writes the record, and `cotal`).
 *
 * Its own module, outside src/server.ts: that file is in the manager's import graph, and touching it
 * changes the manager fingerprint (a `paw restart` would bounce every agent instead of the mailbox).
 * Only the CLI gate imports this.
 *
 * A remote space is dialled only at its record's server, with TLS required and creds minted from its
 * signer, so a different `--server` is refused. A `tls://` broker for a space with NO record used to
 * fall through as "local": ensure() booted a local mesh, manager and mailbox for the space, then the
 * command dialled the remote URL with local creds and no TLS requirement — a raw broker auth error and
 * side-effect daemons (#142, `paw web --server tls://… --creds participant.creds`). paw joins a remote
 * mesh only through `paw mesh add` with the account signer; a participant credential can't run paw.
 * Any other flag is returned as given (a second LOCAL `nats://` broker still works). It is only ever
 * handed the `--server` value, so it never echoes a creds path or contents.
 */
import { checkRemoteServer, readRemoteMesh } from "./remote-mesh.ts";
import { pawServer } from "./server.ts";

export function serverFlagFor(space: string, flag: string | undefined): string {
  if (flag === undefined) return pawServer(space);
  const record = readRemoteMesh(space);
  if (record) {
    if (flag === record.server || sameRemoteServer(flag, record.server)) return record.server;
    throw new Error(
      `paw: --server ${flag} is not space "${space}"'s broker (${record.server}) — drop --server; a remote space is dialled at its record's server, TLS required, with creds minted from its signer`,
    );
  }
  // localServer() is always nats:// (PAW_SERVER is validated to that), so a tls:// flag is never the local broker.
  if (/^tls:\/\//i.test(flag))
    throw new Error(
      `paw: --server ${flag} is a remote broker, but space "${space}" has no remote record here. ` +
        `paw joins a remote mesh only with its account signer: \`paw mesh add ${space} --server ${flag} --root <dir>\` ` +
        "(the dir whose .cotal/auth/auth.json is `cotal auth signer`'s file). paw web then reads it as cotal's admin observer (DMs, anycast, membership). " +
        "A participant credential (the one `cotal join --creds … --lifecycle-uid …` uses) only reads its own channels and history, so paw can't run on it — " +
        "keep using that cotal join session, or ask the mesh operator for the signer.",
    );
  return flag;
}

/** The same `tls://host:port` spelled differently (`TLS://`, an upper-case host): compared in the form
 *  `paw mesh add` stored. A flag that isn't a valid remote URL is simply not the same server. */
function sameRemoteServer(flag: string, recorded: string): boolean {
  try {
    return checkRemoteServer(flag) === recorded;
  } catch {
    return false;
  }
}

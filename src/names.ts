import { readRemoteMesh } from "./remote-mesh.ts";

/**
 * The DEFAULT mesh name the human operator joins under (and paw's UI label for "me"). paw agents are told (via the
 * connector's mesh brief) that a human may be present under this name and to reply to whoever
 * direct-messages them — so a stable, friendly name here is what closes the human↔agent loop.
 * Kept in its own module (only the leaf remote-mesh.ts beneath it) so both the connector
 * (system-prompt brief) and the chat command can share it without importing each other.
 */
export const HUMAN_PEER = "you";

/**
 * The operator's WIRE name on `space` — the card name of every human endpoint (mailbox beacon, dm,
 * chat, inbox, who, …) and the name agents' briefs tell them to reply to. A remote space's record may
 * carry its own (`paw mesh add … --as <name>` / `paw mesh set <space> --as <name>`): on a SHARED
 * broker every operator's mailbox would otherwise be "you". No record or no `human` ⇒ HUMAN_PEER, so
 * local spaces never change. (No env override on purpose: the detached mailbox, the manager that
 * writes briefs and every CLI call must agree, and a per-shell env would split them.)
 *
 * Display surfaces (web village/pending, dialog, feed `from` of your own sends) keep HUMAN_PEER as the
 * "this is me" label — that is perspective, not identity.
 */
export function humanPeer(space: string): string {
  return readRemoteMesh(space)?.human ?? HUMAN_PEER;
}

/**
 * There are deliberately NO control-subject constants here any more.
 *
 * They existed for one cotal generation: 0.25 dropped `CONTROL_PRIVILEGED` / `CONTROL_ADMIN` from
 * core's exports and paw re-declared them as `"manager"` / `"admin"`, on the reading that the
 * subjects were merely un-exported. They were not un-exported, they were DELETED — cotal's 1d slice
 * removed the manager's bespoke `ctl.<tier>.<owner>.<actor>` rail entirely (0.25's manager never
 * calls `serveControl`; a raw request to those subjects draws `no responders` in ~1ms). Two strings
 * that still type-check and name a rail nobody serves cost an evening of diagnosis, because paw's
 * `requestControl` sat on its full timeout instead of failing fast.
 *
 * The manager is reached through `src/control.ts` (`resolveService` + `invokeCommand`) and nowhere
 * else. If a constant ever comes back here, it has a subject someone serves.
 */

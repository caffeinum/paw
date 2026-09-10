/**
 * The mesh name the human operator joins under in `paw chat`. paw agents are told (via the
 * connector's mesh brief) that a human may be present under this name and to reply to whoever
 * direct-messages them — so a stable, friendly name here is what closes the human↔agent loop.
 * Kept in its own zero-dependency module so both the connector (system-prompt brief) and the chat
 * command can share one constant without importing each other.
 */
export const HUMAN_PEER = "you";

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

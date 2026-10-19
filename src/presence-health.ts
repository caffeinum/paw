/**
 * Is the space's presence plane accepting writes? A disk-full broker can LATCH the presence KV: every
 * put goes unanswered (a JetStream request timeout) while streams still accept, consumers still create
 * and the bucket still opens and watches (cotal #1356 — only a broker restart clears it). Then every
 * agent reads offline, and a wake gate trusting that would restart healthy agents into seats that can
 * never register (2026-10-14: `paw chat @evals` killed evals this way).
 *
 * The probe is one put of a non-JSON value under a throwaway key (watchers drop it: not a presence
 * record) and, on success, a filtered purge so nothing lingers. Only a TIMEOUT counts as latched: a
 * missing bucket answers "no responders" at once, a permission refusal is an error reply — neither is
 * evidence of a latch. Healthy cost: one connect + two JetStream round-trips (~ms on localhost).
 *
 * Under PAW_AUTH the probe runs with paw's control creds (`control-caller-privileged`), which hold NO
 * `$KV`/`$JS` grant, so it can never write. Measured on a real JWT mesh (nats.js 3.x): the broker's
 * `-ERR 'Permissions Violation for Publish to "$KV.…"'` rejects the request AT ONCE as a RequestError
 * whose cause is a PermissionViolationError — never a timeout, so it can't read as latched. It is
 * reported as `not-permitted` (said out loud, never blocks a wake). The connection takes the creds'
 * scoped inbox (`_INBOX_<id>`): on the default `_INBOX.` the request died one step earlier on a
 * subscribe violation and the report named the wrong subject.
 */
import { randomBytes } from "node:crypto";
import { idFromCreds, presenceBucket } from "@cotal-ai/core";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { natsTls } from "./server.ts";

/** How long a probe put may go unanswered before the store counts as latched. A healthy local put
 *  takes milliseconds; cotal's own refused write surfaces as its ~5s request timeout. */
export const PRESENCE_PROBE_MS = 3000;

export type PresenceHealth =
  | { kind: "ok" }
  | { kind: "no-bucket" }
  | { kind: "latched"; bucket: string; waitedMs: number }
  | { kind: "not-permitted"; message: string }
  | { kind: "unknown"; message: string };

function isTimeout(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string };
  return err?.name === "TimeoutError" || err?.code === "TIMEOUT" || /timeout/i.test(err?.message ?? "");
}

/** A broker permission refusal — the error itself, or nats.js's RequestError wrapping one as `cause`. */
export function isPermissionViolation(e: unknown): boolean {
  const err = e as { name?: string; message?: string; cause?: unknown } | undefined;
  if (!err) return false;
  if (err.name === "PermissionViolationError" || /permissions violation/i.test(err.message ?? "")) return true;
  return err.cause !== undefined && err.cause !== e && isPermissionViolation(err.cause);
}

function isNoResponders(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string };
  return err?.name === "NoRespondersError" || err?.code === "503" || /no responders|jetstream is not enabled/i.test(err?.message ?? "");
}

export async function probePresenceWrites(space: string, server: string, creds: string | undefined, timeoutMs = PRESENCE_PROBE_MS): Promise<PresenceHealth> {
  const bucket = presenceBucket(space);
  let nc;
  try {
    nc = await connect({
      servers: server,
      timeout: timeoutMs,
      // A remote space's control creds never cross a link that isn't TLS (src/server.ts natsTls).
      ...natsTls(space),
      ...(creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}` } : {}),
    });
  } catch (e) {
    return { kind: "unknown", message: `can't reach ${server}: ${(e as Error).message}` };
  }
  try {
    const subject = `$KV.${bucket}.paw-probe-${randomBytes(6).toString("hex")}`;
    try {
      await jetstream(nc, { timeout: timeoutMs }).publish(subject, "paw presence-write probe");
    } catch (e) {
      if (isNoResponders(e)) return { kind: "no-bucket" };
      // Checked BEFORE the timeout: a refusal is an answer, never evidence of a latch.
      // AUTH-GAP: under PAW_AUTH this ALWAYS fires (control creds hold no $KV grant), so latch detection is
      // off on authed meshes. Fix: probe with creds allowed to write+purge a probe key (see authGapWarning).
      if (isPermissionViolation(e)) return { kind: "not-permitted", message: (e as Error).message };
      if (isTimeout(e)) return { kind: "latched", bucket, waitedMs: timeoutMs };
      return { kind: "unknown", message: (e as Error).message };
    }
    const jsm = await jetstreamManager(nc, { timeout: timeoutMs });
    await jsm.streams.purge(`KV_${bucket}`, { filter: subject });
    return { kind: "ok" };
  } finally {
    await nc.close().catch(() => {});
  }
}

/** The warning for a `not-permitted` probe — shown by the wake gate and `paw status`. Pure.
 *  AUTH-GAP: loud on purpose, so the gap gets closed when auth is implemented. */
export function authGapWarning(message: string, context: string): string {
  return [
    `⚠ PRESENCE LATCH DETECTION IS DISABLED UNDER PAW_AUTH (${context})`,
    `  paw's control creds (control-caller-privileged) can't write the presence KV, so the probe was refused:`,
    `    ${message}`,
    `  A latched broker (disk full, cotal #1356) will NOT be caught: every agent reads offline and a wake may`,
    `  restart healthy agents into seats that can never register.`,
    `  follow-up (AUTH-GAP, docs/notes/addressing.md#presence-latch-guard): mint probe creds allowed to write`,
    `  AND purge a probe key in the presence bucket, and probe with those.`,
  ].join("\n");
}

/** The refusal the wake gate throws on a latched presence store. Pure. */
export function presenceLatchRefusal(name: string, h: { bucket: string; waitedMs: number }, server: string): string {
  return (
    `paw: presence store isn't accepting writes — "${h.bucket}" left a probe write unanswered for ${Math.round(h.waitedMs / 1000)}s ` +
    `(latched broker, cotal #1356). Every agent looks offline, so "${name}" can't be judged dead — nothing was stopped or started.\n` +
    `  fix: restart the mesh broker (nats-server at ${server}); no client can clear the latch. The presence KV is ephemeral.`
  );
}

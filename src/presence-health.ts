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
 * Under auth (PAW_AUTH, a remote space) the probe connects with its OWN cred, signed per probe with the
 * space's account signer (`presenceProbeCreds`, src/remote-creds.ts): publish to exactly the one throwaway key, nothing
 * else. paw's control creds hold no `$KV` grant, so they could never probe (the old AUTH-GAP). On that
 * path the cleanup is a KV purge (a rollup-purge marker on the same subject, gone with the bucket's
 * max_age) rather than a stream purge, which would need `$JS.API.STREAM.PURGE` on the WHOLE presence
 * stream. A refusal is still checked before the timeout — an answer, never a latch — and reported as
 * `not-permitted` in one line. The connection takes the cred's scoped inbox (`_INBOX_<id>`).
 */
import { randomBytes } from "node:crypto";
import { idFromCreds, presenceBucket } from "@cotal-ai/core";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator, Empty, headers } from "@nats-io/transport-node";
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

/** A fresh throwaway presence key — one per probe, so a probe cred can be pinned to exactly it. */
export function presenceProbeKey(): string {
  return `paw-probe-${randomBytes(6).toString("hex")}`;
}

/** `credsFor(key)` returns the cred to probe `key` with, or undefined on an open mesh. */
export async function probePresenceWrites(
  space: string,
  server: string,
  credsFor: ((key: string) => Promise<string | undefined>) | undefined,
  timeoutMs = PRESENCE_PROBE_MS,
): Promise<PresenceHealth> {
  const bucket = presenceBucket(space);
  const key = presenceProbeKey();
  const creds = credsFor ? await credsFor(key) : undefined;
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
    const subject = `$KV.${bucket}.${key}`;
    const js = jetstream(nc, { timeout: timeoutMs });
    try {
      await js.publish(subject, "paw presence-write probe");
    } catch (e) {
      if (isNoResponders(e)) return { kind: "no-bucket" };
      // Checked BEFORE the timeout: a refusal is an answer, never evidence of a latch.
      if (isPermissionViolation(e)) return { kind: "not-permitted", message: (e as Error).message };
      if (isTimeout(e)) return { kind: "latched", bucket, waitedMs: timeoutMs };
      return { kind: "unknown", message: (e as Error).message };
    }
    if (creds) {
      const h = headers();
      h.set("KV-Operation", "PURGE");
      h.set("Nats-Rollup", "sub");
      await js.publish(subject, Empty, { headers: h });
    } else {
      const jsm = await jetstreamManager(nc, { timeout: timeoutMs });
      await jsm.streams.purge(`KV_${bucket}`, { filter: subject });
    }
    return { kind: "ok" };
  } finally {
    await nc.close().catch(() => {});
  }
}

/** One line for a `not-permitted` probe — shown by the wake gate and `paw status`. Pure. The probe's own
 *  cred grants exactly its key, so a refusal means the broker doesn't honour the space's signer. */
export function probeRefusedLine(message: string, context: string): string {
  return `paw: presence latch probe refused by the broker (${context}) — latch detection is off for this call: ${message}`;
}

/** The refusal the wake gate throws on a latched presence store. Pure. */
export function presenceLatchRefusal(name: string, h: { bucket: string; waitedMs: number }, server: string): string {
  return (
    `paw: presence store isn't accepting writes — "${h.bucket}" left a probe write unanswered for ${Math.round(h.waitedMs / 1000)}s ` +
    `(latched broker, cotal #1356). Every agent looks offline, so "${name}" can't be judged dead — nothing was stopped or started.\n` +
    `  fix: restart the mesh broker (nats-server at ${server}); no client can clear the latch. The presence KV is ephemeral.`
  );
}

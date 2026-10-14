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
 */
import { randomBytes } from "node:crypto";
import { presenceBucket } from "@cotal-ai/core";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";

/** How long a probe put may go unanswered before the store counts as latched. A healthy local put
 *  takes milliseconds; cotal's own refused write surfaces as its ~5s request timeout. */
export const PRESENCE_PROBE_MS = 3000;

export type PresenceHealth =
  | { kind: "ok" }
  | { kind: "no-bucket" }
  | { kind: "latched"; bucket: string; waitedMs: number }
  | { kind: "unknown"; message: string };

function isTimeout(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string };
  return err?.name === "TimeoutError" || err?.code === "TIMEOUT" || /timeout/i.test(err?.message ?? "");
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
      ...(creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)) } : {}),
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

/** The refusal the wake gate throws on a latched presence store. Pure. */
export function presenceLatchRefusal(name: string, h: { bucket: string; waitedMs: number }, server: string): string {
  return (
    `paw: presence store isn't accepting writes — "${h.bucket}" left a probe write unanswered for ${Math.round(h.waitedMs / 1000)}s ` +
    `(latched broker, cotal #1356). Every agent looks offline, so "${name}" can't be judged dead — nothing was stopped or started.\n` +
    `  fix: restart the mesh broker (nats-server at ${server}); no client can clear the latch. The presence KV is ephemeral.`
  );
}

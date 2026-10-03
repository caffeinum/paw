/**
 * The broker paw talks to — `PAW_SERVER`, else cotal's `DEFAULT_SERVER` (nats://127.0.0.1:4222).
 *
 * Every paw command used `DEFAULT_SERVER` directly, so an "isolated" test space still shared the
 * operator's LIVE broker: separate streams, same nats process, same disk (the 2026-09-08 outage was
 * that disk filling). `PAW_SERVER` points a whole run — CLI, manager, mailbox, hub, agents — at a
 * broker of its own. paw never STARTS a broker on a custom URL (`cotal up` owns :4222 only), so
 * ensure() fails loud when one is set but unreachable rather than booting a mesh somewhere else.
 */
import { DEFAULT_SERVER } from "@cotal-ai/core";

export function pawServer(): string {
  const v = process.env.PAW_SERVER?.trim();
  if (!v) return DEFAULT_SERVER;
  if (!/^nats:\/\/[^\s/]+:\d+$/.test(v)) throw new Error(`paw: PAW_SERVER="${v}" must look like nats://host:port`);
  return v;
}

/** True when the operator pointed paw at a broker of their own (it is theirs to run). */
export function customServer(): boolean {
  return pawServer() !== DEFAULT_SERVER;
}

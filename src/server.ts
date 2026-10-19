/**
 * The broker paw talks to for a space.
 *
 * A space with a REMOTE record (src/remote-mesh.ts, `paw mesh add`) lives on that record's broker —
 * `tls://host:port`, TLS required. Every other space lives on the LOCAL broker: `PAW_SERVER`, else
 * cotal's `DEFAULT_SERVER` (nats://127.0.0.1:4222). PAW_SERVER never redirects a remote space.
 *
 * Every paw command used `DEFAULT_SERVER` directly, so an "isolated" test space still shared the
 * operator's LIVE broker: separate streams, same nats process, same disk (the 2026-09-08 outage was
 * that disk filling). `PAW_SERVER` points a whole run — CLI, manager, mailbox, hub, agents — at a
 * broker of its own. paw never STARTS a broker on a custom URL (`cotal up` owns :4222 only), so
 * ensure() fails loud when one is set but unreachable rather than booting a mesh somewhere else.
 */
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { readRemoteMesh } from "./remote-mesh.ts";
import { resolveSpace } from "./space.ts";

/** The local broker every space without a remote record shares. */
export function localServer(): string {
  const v = process.env.PAW_SERVER?.trim();
  if (!v) return DEFAULT_SERVER;
  if (!/^nats:\/\/[^\s/]+:\d+$/.test(v)) throw new Error(`paw: PAW_SERVER="${v}" must look like nats://host:port`);
  return v;
}

/** The broker for `space` (default: the current space): its remote record's, else the local one.
 *  PAW_SERVER names the LOCAL broker only — a test that pins it to a private nats-server keeps every
 *  local dial off the live :4222 while its remote space still reaches the remote broker. */
export function pawServer(space: string = resolveSpace()): string {
  return readRemoteMesh(space)?.server ?? localServer();
}

/** True when `space` lives on a remote broker (paw never starts or stops that broker). */
export function isRemoteSpace(space: string = resolveSpace()): boolean {
  return readRemoteMesh(space) !== undefined;
}

/** Endpoint options that REQUIRE TLS for a remote space. Local spaces get `{}` — their connect
 *  options are exactly what they were before remote records existed. */
export function meshTls(space: string): { tls?: true } {
  return isRemoteSpace(space) ? { tls: true } : {};
}

/** True when the operator pointed the LOCAL broker somewhere of their own (it is theirs to run). */
export function customServer(): boolean {
  return localServer() !== DEFAULT_SERVER;
}

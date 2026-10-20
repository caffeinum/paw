/**
 * "Is this agent hosted by THIS machine?" — for a REMOTE space, where several paw managers (one per
 * machine, each with its own record root) share one broker.
 *
 * Sleeping an agent, standing in for it, or minting an identity on its behalf is only ever this
 * machine's business for an agent this machine runs. The answer comes from real data on both sides:
 *  - the agent's persona lives in THIS `$PAW_HOME/spaces/<space>/personas/`, and
 *  - THIS machine's manager spawned it: its ps row's `instanceId` is the instance id cotal persisted
 *    for this record root (`loadManagerInstanceIdentity(root, space)`). paw's control rail is pinned
 *    to that same instance on a remote space (src/control.ts), so another machine's agents never
 *    appear in its ps at all; the row check is the second, independent half.
 * A name that is live on the mesh roster but in neither is hosted on another machine.
 *
 * Local spaces have one manager by construction — every agent is hosted here.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { personaFilePath, type PsRow } from "./addressing.ts";
import { pawCotalRoot } from "./cotal-root.ts";
import { isRemoteSpace } from "./server.ts";

/** This machine's manager instance id for a remote space, or undefined when no manager of this
 *  machine has registered there yet. */
export function localManagerInstanceId(space: string): string | undefined {
  return loadManagerInstanceIdentity(pawCotalRoot(space), space)?.instanceId;
}

export type Hosting = { here: true } | { here: false; why: string };

/** Pure: is `row` (the agent's ps row, if any) an agent this machine hosts? */
export function hostingOf(o: { name: string; personaHere: boolean; row?: PsRow; localInstanceId?: string }): Hosting {
  if (!o.localInstanceId) return { here: false, why: "no manager of this machine has registered in the space" };
  if (!o.row) return { here: false, why: "this machine's manager does not run it" };
  if (!o.row.instanceId) return { here: false, why: "its ps row carries no manager instance id" };
  if (o.row.instanceId !== o.localInstanceId) return { here: false, why: `it was spawned by manager ${o.row.instanceId}, not this machine's ${o.localInstanceId}` };
  if (!o.personaHere) return { here: false, why: "its persona is not in this machine's paw state" };
  return { here: true };
}

/** {@link hostingOf} with the local facts filled in. Local spaces: always here. */
export function hosting(space: string, name: string, row: PsRow | undefined): Hosting {
  if (!isRemoteSpace(space)) return { here: true };
  return hostingOf({ name, personaHere: existsSync(personaFilePath(space, name)), row, localInstanceId: localManagerInstanceId(space) });
}

/** The refusal for an agent on a remote space that this machine does not host. */
export function hostedElsewhereError(name: string, space: string, why: string): Error {
  return new Error(`paw: "${name}" is hosted on another machine (space "${space}": ${why}) — only the machine that runs it may sleep it or stand in for it`);
}

/**
 * Pure: why `!cmd` has no folder to run in for `name` (chat + web run it in the agent's REGISTERED
 * folder on THIS machine). On a remote space an agent whose persona is not here is another machine's
 * — say so, naming its host when its card reports one (`meta.host`; cotal's claude connector reports
 * none), instead of pointing at `paw status`, which only lists this machine's agents. Never attempts
 * remote execution.
 */
export function bangNoFolderReason(o: { name: string; remote: boolean; personaHere: boolean; host?: string; localHost: string }): string {
  if (o.remote && !o.personaHere) {
    if (o.host && o.host === o.localHost) return `"${o.name}" runs on this host but not under this paw (no persona or folder registered here) — !cmd runs only for agents hosted here`;
    return `"${o.name}" is hosted on another machine${o.host ? ` (${o.host})` : ""} — !cmd runs only for agents hosted here`;
  }
  return `no registered folder for "${o.name}" — \`paw status\` lists them`;
}

/** {@link bangNoFolderReason} with the local facts filled in; `card` is the target's roster card. */
export function bangNoFolder(space: string, name: string, card?: { meta?: Record<string, unknown> }): string {
  const host = typeof card?.meta?.host === "string" && card.meta.host ? card.meta.host : undefined;
  return bangNoFolderReason({ name, remote: isRemoteSpace(space), personaHere: existsSync(personaFilePath(space, name)), host, localHost: hostname() });
}

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
import { ORIGIN, readTeleported } from "./teleport-plan.ts";
import { localHost, machineLabel, machineName } from "./host-stamp.ts";

export { localHost, machineLabel, machineName, stampHost } from "./host-stamp.ts";

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
  return bangNoFolderReason({ name, remote: isRemoteSpace(space), personaHere: existsSync(personaFilePath(space, name)), host: cardHost(card), localHost: hostname() });
}

type Card = { meta?: Record<string, unknown> };
const cardHost = (card?: Card): string | undefined => (typeof card?.meta?.host === "string" && card.meta.host ? card.meta.host : undefined);

/**
 * An agent whose process, transcript and folder are on ANOTHER machine — the one notion of "remote
 * agent" every local-only feature (logs, ctx, `!cmd`, attach, file attachments) checks before reading
 * this machine's copy of anything:
 *  - `teleported`: its persona here carries the `teleported:` marker (src/teleport.ts). The persona,
 *    folder and transcript here are the FROZEN copy from before it left. `cwd` is the folder it runs in
 *    there, when the marker recorded it (`teleportedCwd`).
 *  - `hosted`: a remote space, no persona here — another machine's agent, known only from the roster.
 * Messaging it over the mesh works either way; everything else must say where it runs, never show
 * stale local data.
 */
export type Elsewhere = { how: "teleported" | "hosted"; where: string; cwd?: string };

/** Pure: see {@link Elsewhere}. A same-host card (another paw on this box) is not elsewhere — its files are here. */
export function elsewhereOf(o: { teleported?: { to: string; cwd?: string }; remote: boolean; personaHere: boolean; host?: string; machine?: string; localHost: string }): Elsewhere | undefined {
  if (o.teleported) return { how: "teleported", where: o.teleported.to === ORIGIN ? "the machine it came from" : o.teleported.to, ...(o.teleported.cwd ? { cwd: o.teleported.cwd } : {}) };
  if (o.remote && !o.personaHere && o.host !== o.localHost) return { how: "hosted", where: o.machine ?? (o.host ? machineLabel(o.host) : "another machine") };
  return undefined;
}

/** {@link elsewhereOf} with the local facts filled in; `card` is the agent's roster card, if live. */
export function runsElsewhere(space: string, name: string, card?: Card): Elsewhere | undefined {
  const persona = personaFilePath(space, name);
  return elsewhereOf({ teleported: readTeleported(persona), remote: isRemoteSpace(space), personaHere: existsSync(persona), host: cardHost(card), machine: machineOfCard(card)?.machine, localHost: hostname() });
}

/** `ssh:mini · /Users/aleks/.paw/repos/x` — or the host alone when its folder there is unknown. */
export const elsewhereLabel = (e: Elsewhere): string => (e.cwd ? `${e.where} · ${e.cwd}` : e.where);

/** paw chat's banner line under a remote agent: what this machine can't show, said once up front. */
export function elsewhereBanner(e: Elsewhere): string {
  return `logs, ctx, !cmd and files are on ${e.where} — from here you message it over the mesh`;
}

/** Why there are no logs to show here — chat's logs view prints it as `(no logs for <name> — …)`. */
export function elsewhereLogs(e: Elsewhere): string {
  return `logs live on ${e.where}, where it runs${e.how === "teleported" ? " — the transcript on this machine stopped when it left" : ""}`;
}

/** Why `!cmd` refuses: it would run in this machine's (stale) copy of the folder, not where the agent works. */
export function elsewhereBang(name: string, e: Elsewhere): string {
  return `!cmd runs on this machine, not on ${e.where} where ${name} works`;
}

/** Why a message carrying local file paths is not sent: the agent's machine cannot open them. */
export function elsewhereFiles(name: string, e: Elsewhere, placeholders: string[]): string {
  return `not sent — ${name} runs on ${e.where} and can't open ${placeholders.join(" ")} (${placeholders.length === 1 ? "a file" : "files"} on this machine)`;
}

/** Why attach refuses: the terminal is on the agent's machine. */
export function elsewhereAttach(name: string, e: Elsewhere): string {
  return `paw: "${name}" runs on ${e.where} — attach to it there; from here \`paw chat @${name}\` messages it`;
}

/** The `paw status` note (and chat's tasks view) for an agent running elsewhere. */
export function elsewhereStatus(e: Elsewhere): string {
  return `runs on ${elsewhereLabel(e)} — ctx, logs and folder are there`;
}

/**
 * Where an agent's process runs — the MACHINE column of `paw status` and paw chat's right-side tag —
 * with the evidence it came from, strongest first:
 *  - `mesh`:        the agent's own card says so (`meta.machine` / `meta.host` — cotal reserves `host` but
 *                   sets nothing; paw's connector stamps both into the persona at launch, src/host-stamp.ts).
 *  - `teleport`:    its persona here carries the `teleported:` marker — the TARGET it was sent to
 *                   (`ssh:mini`), shown whether or not it is live there: it lives there, not here.
 *  - `manager`:     THIS machine's manager runs it (it is in our ps — the control rail is pinned to this
 *                   machine's manager instance, so another machine's seats never appear there).
 *  - `foreground`:  a live `paw claude --fg` process on this machine (src/foreground.ts).
 *  - `local-space`: a local space's broker serves one machine's manager by construction (see the top of
 *                   this file), so a registered, not-teleported agent there runs here.
 *  - `unknown`:     it is running, and nothing above says where — rendered `?`, never a guessed name.
 * Not running and not teleported ⇒ undefined: it runs nowhere right now.
 */
export type Machine = { label: string; via: "mesh" | "teleport" | "manager" | "foreground" | "local-space" | "unknown"; here: boolean };

/** What a card says about its machine: `meta.host` (raw hostname) and `meta.machine` (its name). */
export type CardMachine = { host?: string; machine?: string };

/** Pure: see {@link Machine}. `teleportedTo` is the raw marker value (`ssh:mini`, `fly:app`, `origin`);
 *  `local` is this machine's raw hostname and its name on the space (src/host-stamp.ts machineName). */
export function machineOf(o: {
  card?: CardMachine;
  teleportedTo?: string;
  managedHere?: boolean;
  foreground?: boolean;
  localSpaceHere?: boolean;
  running: boolean;
  local: { host: string; name: string };
}): Machine | undefined {
  const { host, machine } = o.card ?? {};
  if (host || machine) {
    const here = host ? host === o.local.host : machine === o.local.name;
    return { label: machine ?? machineLabel(host!), via: "mesh", here };
  }
  if (o.teleportedTo) return { label: o.teleportedTo, via: "teleport", here: false };
  if (!o.running) return undefined;
  if (o.managedHere) return { label: o.local.name, via: "manager", here: true };
  if (o.foreground) return { label: o.local.name, via: "foreground", here: true };
  if (o.localSpaceHere) return { label: o.local.name, via: "local-space", here: true };
  return { label: "?", via: "unknown", here: false };
}

const metaString = (card: Card | undefined, k: string): string | undefined => {
  const v = card?.meta?.[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** A roster card's machine claim (`meta.host` / `meta.machine`), if it makes one. */
export function machineOfCard(card?: Card): CardMachine | undefined {
  const host = metaString(card, "host");
  const machine = metaString(card, "machine");
  return host || machine ? { ...(host ? { host } : {}), ...(machine ? { machine } : {}) } : undefined;
}

/** This machine, as {@link machineOf} wants it for `space`. */
export const localMachine = (space: string): { host: string; name: string } => ({ host: localHost(), name: machineName(space) });

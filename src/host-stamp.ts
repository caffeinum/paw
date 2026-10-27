/**
 * Which machine launched an agent, carried on its mesh card. paw's connector imports this, and the
 * manager loads the connector, so it stays light: node builtins plus the remote-mesh record reader.
 *
 * Two persona keys, both swept by cotal's agent-file loader into the card's `meta` (it keeps every
 * unmodelled scalar frontmatter key, core/dist/agent-file.js):
 *  - `host:`    the raw hostname (`os.hostname()`) — cotal's reserved `meta.host`, which cotal itself
 *               never sets. Compared, never shown: "is this card from THIS machine?".
 *  - `machine:` the short name people call the machine — see {@link machineName}. Shown.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { readRemoteMesh } from "./remote-mesh.ts";

/** This machine's raw hostname — what a card's `meta.host` is compared to. */
export const localHost = (): string => hostname();

/** `aleks-macbook.local` → `aleks-macbook`: the first label of a hostname. */
export function machineLabel(host: string): string {
  const h = host.trim();
  if (!h) throw new Error("paw: machineLabel got an empty hostname");
  return h.split(".")[0] || h;
}

/**
 * The name this machine goes by on `space`, first that is set:
 *  - `PAW_MACHINE` — the operator's explicit name for this box;
 *  - the remote record's human name (`paw mesh add … --as aleks-mac-mini`; the fly agents box boots
 *    with `--as fly-agents`): a shared broker already needs a distinct one per machine, and a fly
 *    machine's hostname is an opaque id (`683e51da039598`) nobody would recognise;
 *  - the hostname's first label (`aleks-macbook`).
 */
export function machineName(space: string, host: string = localHost()): string {
  const env = process.env.PAW_MACHINE?.trim();
  if (env) return env;
  const human = readRemoteMesh(space)?.human;
  if (human && human !== "you") return human;
  return machineLabel(host);
}

/**
 * Stamp `host:` and `machine:` (see the top of this file) into the persona at launch. Written by the
 * process about to launch the agent, so both are true at launch; a teleported persona is restamped by
 * the target's own launch. No write when both already match. Top-level keys only: an INDENTED `host:`
 * belongs to a mapping (an acp seat's `launchOptions.host`).
 */
export function stampHost(personaPath: string, stamp: { host: string; machine: string }): void {
  if (!stamp.host.trim()) throw new Error("paw: this machine reports an empty hostname — cannot stamp the persona's host");
  if (!stamp.machine.trim()) throw new Error("paw: empty machine name — cannot stamp the persona's machine");
  const text = readFileSync(personaPath, "utf8").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`paw: ${personaPath} has no frontmatter — not a paw agent file`);
  const lines = m[1].split("\n");
  const want = [`host: ${stamp.host}`, `machine: ${stamp.machine}`];
  if (want.every((w) => lines.some((l) => l.trimEnd() === w))) return;
  const head = [...lines.filter((l) => !/^(host|machine):/.test(l)), ...want];
  const tmp = `${personaPath}.host-${process.pid}.tmp`;
  writeFileSync(tmp, `---\n${head.join("\n")}\n---\n${m[2]}`);
  renameSync(tmp, personaPath);
}

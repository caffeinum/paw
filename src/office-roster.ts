/**
 * Roster mode: the office rows for EVERY agent on a space's mesh roster, from presence alone.
 *
 * The local bridge reads `collectStatus` (this paw home's registry + its manager's ps + transcripts + git),
 * so it mirrors only the agents registered here. A bridge running next to the broker (`paw office serve`,
 * cotal-host) has no registry, no manager and no transcripts: what it knows is what the mesh publishes —
 * each agent's presence record (status, its `statusSince`/`activeAt` stamps, its free-text activity, its
 * card). Pure: the daemon (src/office-daemon.ts) feeds it the observer's roster.
 *
 * Identity across machines is the mesh NAME. Two live agents with one name on two machines (their cards'
 * `meta.host` differ) are both shown, each as `<name>~<4 hex of sha256(mesh id)>` — deterministic, so a
 * restarted bridge picks the same names. Two live records of one name on ONE machine (a restart overlapping
 * the old record's last heartbeats) are the same agent: the newest record wins, no suffix.
 */
import { createHash } from "node:crypto";
import { clip, type Row } from "./office-bridge.ts";
import { presenceLive } from "./roster.ts";

/** The presence fields roster mode reads (a cotal `Presence`, structurally). */
export interface RosterPresence {
  card: { id: string; name: string; kind?: string; description?: string; meta?: Record<string, unknown> };
  status: string;
  ts: number;
  statusSince?: number;
  activeAt?: number;
  activity?: string;
}

/** A roster row: the office row plus the mesh id office chat is delivered to and the bare mesh name. */
export type RosterRow = Row & { id: string; meshName: string };

/** A `paw sleep` stand-in's card (src/sleep-host.ts): it holds a sleeping agent's name, it isn't the agent. */
const STAND_IN = "asleep (paw sleep)";
const NAME_MAX = 32;

export function rosterSuffix(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 4);
}

/** `<name>~<suffix>`, the name shortened so the whole fits the office's name budget. */
export function collisionName(name: string, id: string): string {
  const suffix = `~${rosterSuffix(id)}`;
  return `${name.slice(0, NAME_MAX - suffix.length)}${suffix}`;
}

const metaString = (meta: Record<string, unknown> | undefined, k: string): string | undefined => {
  const v = meta?.[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

function metaHue(meta: Record<string, unknown> | undefined): number | undefined {
  const v = meta?.hue;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : undefined;
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 359 ? n : undefined;
}

/** Every live agent on the roster as an office row. Endpoints (humans, observers, the `office` and `cron`
 *  senders), sleep stand-ins and stale/offline records are not agents in the office. */
export function rosterRows(roster: readonly RosterPresence[], now: number): RosterRow[] {
  const byName = new Map<string, Map<string, RosterPresence>>(); // name → machine → newest live record
  for (const p of roster) {
    if (p.card?.kind !== "agent" || !p.card.name || !p.card.id || !presenceLive(p, now)) continue;
    if (p.card.description?.startsWith(STAND_IN)) continue;
    const machines = byName.get(p.card.name) ?? new Map<string, RosterPresence>();
    byName.set(p.card.name, machines);
    const host = metaString(p.card.meta, "host") ?? "";
    const cur = machines.get(host);
    if (!cur || p.ts > cur.ts) machines.set(host, p);
  }
  const rows: RosterRow[] = [];
  for (const [name, machines] of byName) {
    const collides = machines.size > 1;
    for (const p of machines.values()) {
      const emoji = metaString(p.card.meta, "emoji");
      const hue = metaHue(p.card.meta);
      const activity = p.activity ? clip(p.activity, 120) : "";
      rows.push({
        name: collides ? collisionName(name, p.card.id) : name,
        meshName: name,
        id: p.card.id,
        mesh: p.status,
        live: true,
        // paw's own `busy` counts a waiting agent as mid-turn too; `running()` then needs turn progress after the stamp
        busy: p.status !== "idle",
        ...(typeof p.statusSince === "number" ? { statusSince: p.statusSince } : {}),
        ...(typeof p.activeAt === "number" ? { activeAt: p.activeAt } : {}),
        ...(activity ? { activity } : {}),
        ...(emoji ? { emoji } : {}),
        ...(hue !== undefined ? { hue } : {}),
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

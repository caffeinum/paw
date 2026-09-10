/**
 * The last roster paw returned, kept so a repeat open renders INSTANTLY.
 *
 * `paw status` costs ~1s of real work (a control round-trip, a JetStream query per agent, git per
 * folder) and Raycast spends another second or two starting the extension before that call even
 * begins. Blocking the whole view on it meant every open — not just the first — sat on "Reading the
 * roster…" for about four seconds with nothing on screen.
 *
 * So the roster is CACHED and shown immediately, then replaced when the real read lands. The cached
 * copy is stale by definition, which is fine for what it carries: names, folders, and a status pip
 * that is a second or two old. It is never used for anything that must be current — sending still
 * goes through the CLI, which resolves the target itself.
 *
 * Keyed by SPACE, like the read-state store: two spaces share one Raycast origin, and showing one
 * space's agents while connected to another would be worse than showing nothing.
 */
import { LocalStorage } from "@raycast/api";
import type { AgentRow } from "./paw";

const key = (space: string) => `paw.roster.${space || "?"}`;

/** Read the cached roster, or an empty list. A corrupt or half-written value reads as EMPTY rather
 *  than throwing: a cache exists to make the first paint faster, and it must never be the reason the
 *  view fails to open at all. */
export async function loadRoster(space: string): Promise<AgentRow[]> {
  try {
    const raw = await LocalStorage.getItem<string>(key(space));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AgentRow[]) : [];
  } catch {
    return [];
  }
}

/** Persist the roster for the next open. Best-effort — a failed write costs a slow open, nothing more. */
export async function saveRoster(space: string, rows: AgentRow[]): Promise<void> {
  try {
    await LocalStorage.setItem(key(space), JSON.stringify(rows));
  } catch {
    /* storage full or blocked: the next open simply waits, as it used to */
  }
}

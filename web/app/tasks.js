/**
 * The Tasks section: the fleet's shared beads task list (bd's machine-wide db — the same one every
 * agent's BEADS_DIR pins), so the operator manages work where the agents file it.
 */

/** bd's own status vocabulary, as glyphs matching `bd list`'s legend. An UNKNOWN status renders as
 *  itself rather than nothing — bd may grow vocabulary, and a blank glyph hides the one task whose
 *  state you most need to notice. */
export function taskGlyph(status) {
  if (status === "in_progress") return { glyph: "◐", cls: "prog", label: "In progress" };
  if (status === "blocked") return { glyph: "●", cls: "blocked", label: "Blocked" };
  if (status === "open") return { glyph: "○", cls: "open", label: "Open" };
  if (status === "deferred") return { glyph: "❄", cls: "deferred", label: "Deferred" };
  if (status === "closed") return { glyph: "✓", cls: "closed", label: "Closed" };
  return { glyph: "?", cls: "unknown", label: String(status ?? "unknown") };
}

/** Is this composer line the /task command, and what are its parts? `/task fix the login flow` files
 *  a task titled that; a ` -- ` splits title from description. Only a LEADING /task counts — prose
 *  mentioning "/task" sends as a message (same rule as /invite). */
export function parseTaskCommand(line) {
  const m = /^\/task\s+(.+)$/s.exec(String(line ?? "").trim());
  if (!m) return undefined;
  const rest = m[1].trim();
  if (!rest) return undefined;
  const sep = rest.indexOf(" -- ");
  if (sep === -1) return { title: rest };
  const title = rest.slice(0, sep).trim();
  const description = rest.slice(sep + 4).trim();
  if (!title) return undefined;
  return description ? { title, description } : { title };
}

/**
 * "This agent's tasks" out of the ONE global list: assigned to it, or filed by it. Decided over a
 * per-repo db (2026-08-26): every agent is pinned to the global db (BEADS_DIR), repo-local .beads
 * are deliberately shadowed, and the fleet's work spans repos — so an agent's view is a FILTER of the
 * shared list, not a second store. Pure.
 */
export function agentTasks(tasks, name) {
  const n = String(name ?? "").toLowerCase();
  if (!n) return [];
  return tasks.filter((t) => (t.assignee ?? "").toLowerCase() === n || (t.createdBy ?? "").toLowerCase() === n);
}

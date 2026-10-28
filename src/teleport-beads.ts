/**
 * `paw teleport --beads` (docs/notes/teleport.md#beads) — the agent's open beads move with it. Every agent
 * files into ONE machine-wide db (`BEADS_DIR`, src/beads-dir.ts), and each machine has its own, so the
 * agent's work list stays behind unless it moves.
 *
 * What moves: the non-closed beads ASSIGNED to the agent — with their comments and dependencies, as `bd
 * export` writes them, imported with `bd import` (ids kept; a dependency on a bead that does not move is
 * skipped by bd and listed in the plan). What it only CREATED stays: that is fleet backlog someone else may
 * own. Ownership: after the import there is verified, the source copies are closed with the reason
 * `teleported to <where>` — never deleted. Such a closed copy is the only bead an import may overwrite
 * (`--allow-stale`, so a `--back` reopens it); any other id already there refuses the teleport.
 *
 * Pure parts and the sh scripts; src/teleport.ts runs the scripts on a side.
 */
import { spawnSync } from "node:child_process";

export type BeadRow = {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  created_by?: string;
  close_reason?: string;
  dependencies?: Array<{ issue_id: string; depends_on_id: string; type?: string }>;
};

/** One side's beads db, as {@link BEADS_SIDE_SH} reports it. */
export type BeadsSide = {
  /** The db dir (`${PAW_BEADS_DIR:-$HOME/.beads}`). */
  dir: string;
  /** `bd` on PATH there (undefined = none). */
  bd?: string;
  /** `bd import` takes `--allow-stale` (needed to reopen a teleported copy). */
  allowStale: boolean;
  /** `bd export` failed there: why (the db is missing or unreadable). */
  err?: string;
  rows: BeadRow[];
  /** The raw export lines, by id — what is imported, verbatim. */
  lines: Map<string, string>;
};

/** What the manifest carries: the beads that move (raw export lines) and what stays. */
export type BeadsManifest = {
  dir: string;
  ids: string[];
  lines: string[];
  /** Non-closed beads the agent created that are assigned elsewhere (or to no one) — they stay. */
  createdStaying: number;
  /** `<id> -> <dep>` links to beads that do not move; bd skips them on the import. */
  outsideDeps: string[];
};

/** The closest bd idiom for "moved, not done": a close with this reason. */
export function teleportedReason(to: string): string {
  return `teleported to ${to}`;
}

export function isTeleportedCopy(r: Pick<BeadRow, "status" | "close_reason">): boolean {
  return r.status === "closed" && /^teleported to \S/.test(r.close_reason ?? "");
}

const SHOWN = 10;
const list = (ids: string[]) => ids.slice(0, SHOWN).join(", ") + (ids.length > SHOWN ? `, … +${ids.length - SHOWN} more` : "");

/** sh prelude: the db every paw agent is pinned to there (src/beads-dir.ts, the same override). */
const DB = `BEADS_DIR="\${PAW_BEADS_DIR:-$HOME/.beads}"; export BEADS_DIR`;

/** Reports the db, the bd there, and its full export (after a `--export--` line). Exit 0 unless sh breaks. */
export const BEADS_SIDE_SH = `${DB}
printf 'dir\\t%s\\n' "$BEADS_DIR"
B=$(command -v bd 2>/dev/null) || { printf 'end\\t1\\n'; exit 0; }
printf 'bd\\t%s\\n' "$B"
bd import --help 2>/dev/null | grep -q -- '--allow-stale' && printf 'allowstale\\t1\\n'
f=$(mktemp) || exit 1
if bd export -o "$f" >/dev/null 2>"$f.err"; then printf 'end\\t1\\n--export--\\n'; cat "$f"; else printf 'err\\t%s\\nend\\t1\\n' "$(tr '\\n' ' ' < "$f.err")"; fi
rm -f "$f" "$f.err"`;

export function beadsImportScript(allowStale: boolean): string {
  return `${DB}
exec bd import - --json${allowStale ? " --allow-stale" : ""}`;
}

/** `--force`: bd refuses to close a bead an open one blocks (a moved bead's blockers may stay open here), and
 *  since 1.3.1 a bead assigned to anyone but the actor — a moved bead belongs to the agent, not the operator. */
export function beadsCloseScript(ids: string[], reason: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${DB}
exec bd close ${ids.map(q).join(" ")} --force --reason ${q(reason)} --json`;
}

export function parseBeadsSide(label: string, stdout: string): BeadsSide {
  const cut = stdout.indexOf("\n--export--\n");
  const head = (cut === -1 ? stdout : stdout.slice(0, cut)).split("\n").filter(Boolean);
  const one = (k: string) => head.find((l) => l.startsWith(`${k}\t`))?.slice(k.length + 1);
  if (one("end") !== "1") throw new Error(`paw: the beads probe on ${label} did not finish — its output:\n${stdout.slice(0, 2000)}`);
  const dir = one("dir");
  if (!dir) throw new Error(`paw: the beads probe on ${label} named no db dir`);
  const rows: BeadRow[] = [];
  const lines = new Map<string, string>();
  if (cut !== -1)
    for (const line of stdout.slice(cut + "\n--export--\n".length).split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`paw: \`bd export\` on ${label} wrote a line that is not JSON (${(e as Error).message}): ${line.slice(0, 200)}`);
      }
      if (r._type !== undefined && r._type !== "issue") continue;
      if (typeof r.id !== "string" || typeof r.status !== "string") throw new Error(`paw: \`bd export\` on ${label} wrote an issue without id/status: ${line.slice(0, 200)}`);
      rows.push(r as unknown as BeadRow);
      lines.set(r.id, line);
    }
  const err = one("err");
  return { dir, ...(one("bd") ? { bd: one("bd") } : {}), allowStale: one("allowstale") === "1", ...(err !== undefined ? { err: err.trim() || "bd export failed" } : {}), rows, lines };
}

const open = (r: BeadRow) => r.status !== "closed" && r.status !== "tombstone";

/** The beads that move for `name`, read from one side's export. */
export function beadsManifest(side: BeadsSide, name: string): BeadsManifest {
  const moving = side.rows.filter((r) => open(r) && r.assignee === name);
  const ids = new Set(moving.map((r) => r.id));
  const outsideDeps = moving.flatMap((r) => (r.dependencies ?? []).filter((d) => !ids.has(d.depends_on_id)).map((d) => `${r.id} -> ${d.depends_on_id}`));
  return {
    dir: side.dir,
    ids: moving.map((r) => r.id),
    lines: moving.map((r) => side.lines.get(r.id)!),
    createdStaying: side.rows.filter((r) => open(r) && r.created_by === name && r.assignee !== name).length,
    outsideDeps,
  };
}

/** This machine's beads, read synchronously (buildManifest is sync). A missing bd or db throws. */
export function beadsHere(name: string): BeadsManifest {
  const r = spawnSync("sh", ["-c", BEADS_SIDE_SH], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`paw: reading the beads db here failed: ${(r.stderr || r.error?.message || "").trim()}`);
  const side = parseBeadsSide("this machine", r.stdout);
  if (!side.bd) throw new Error("paw: --beads needs `bd` here, and it is not on PATH — teleport without it (--no-beads)");
  if (side.err) throw new Error(`paw: \`bd export\` of ${side.dir} failed here: ${side.err} — teleport without it (--no-beads)`);
  return beadsManifest(side, name);
}

/** What on the destination stops the beads moving. */
export function beadsBlockers(b: BeadsManifest, d: BeadsSide | undefined, there: string): string[] {
  if (!d) return [`the beads db on ${there} was not probed`];
  if (!d.bd) return [`${there} has no \`bd\` on PATH — install beads there, or teleport without them (--no-beads)`];
  if (d.err) return [`${there}'s beads db ${d.dir} is not readable: ${d.err} — \`bd init\` it there (or point PAW_BEADS_DIR at one), or --no-beads`];
  const out: string[] = [];
  const there_ = new Map(d.rows.map((r) => [r.id, r]));
  const taken = b.ids.filter((id) => there_.has(id) && !isTeleportedCopy(there_.get(id)!));
  if (taken.length)
    out.push(`${taken.length} bead id(s) already exist in ${d.dir} on ${there} and are not teleported copies: ${list(taken)} — an import would overwrite them; reconcile them by hand, or --no-beads`);
  if (staleIds(b, d).length && !d.allowStale)
    out.push(`${there}'s bd has no \`bd import --allow-stale\`, which reopening its teleported copies needs — update bd there, or --no-beads`);
  return out;
}

/** Ids there that are this agent's earlier teleported copies — the import must overwrite (`--allow-stale`). */
export function staleIds(b: BeadsManifest, d: BeadsSide): string[] {
  const there = new Map(d.rows.map((r) => [r.id, r]));
  return b.ids.filter((id) => there.has(id) && isTeleportedCopy(there.get(id)!));
}

/** Every moved bead is there, open, assigned to `name`. Returns what is wrong (empty = verified). */
export function verifyImported(b: BeadsManifest, d: BeadsSide, name: string): string[] {
  const there = new Map(d.rows.map((r) => [r.id, r]));
  const missing = b.ids.filter((id) => !there.has(id));
  const wrong = b.ids.filter((id) => there.has(id) && (!open(there.get(id)!) || there.get(id)!.assignee !== name));
  return [
    ...(missing.length ? [`${missing.length} bead(s) missing after the import: ${list(missing)}`] : []),
    ...(wrong.length ? [`${wrong.length} bead(s) not open + assigned to ${name} after the import: ${list(wrong)}`] : []),
  ];
}

/** After the close on the source: every moved id is a teleported copy there now. */
export function verifyClosed(b: BeadsManifest, d: BeadsSide): string[] {
  const there = new Map(d.rows.map((r) => [r.id, r]));
  const open_ = b.ids.filter((id) => !there.has(id) || !isTeleportedCopy(there.get(id)!));
  return open_.length ? [`${open_.length} bead(s) not closed as teleported: ${list(open_)}`] : [];
}

/** Moved beads someone changed on the source after the export (they were closed anyway — one copy open). */
export function changedAfterExport(b: BeadsManifest, d: BeadsSide): string[] {
  return b.ids.filter((id, i) => {
    const now = d.lines.get(id);
    return now !== undefined && now !== b.lines[i];
  });
}

/** The plan's beads lines. */
export function beadsPlanLines(b: BeadsManifest, name: string, d: BeadsSide | undefined, there: string, to: string): string[] {
  const dest = d ? `${there}'s ${d.dir}` : there;
  const reopen = d ? staleIds(b, d).length : 0;
  const lines = [
    `  beads      ${b.ids.length} open, assigned to ${name} → ${dest}` +
      (reopen ? ` (${reopen} reopen its earlier teleported copies)` : "") +
      ` · ${b.createdStaying} it created (assigned elsewhere) stay here`,
  ];
  if (b.ids.length) lines.push(`             closed here after the cutover, reason "${teleportedReason(to)}" — kept, not deleted`);
  if (b.outsideDeps.length) lines.push(`             ${b.outsideDeps.length} dependency link(s) to beads that stay here are not carried: ${list(b.outsideDeps)}`);
  return lines;
}

/** `bd import --json`'s summary line for the log. */
export function importSummary(out: string): string {
  const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { created?: number; skipped?: number; skipped_dependencies?: string[]; stale_skipped_ids?: string[] };
  const parts = [`${j.created ?? 0} imported`];
  if (j.skipped) parts.push(`${j.skipped} skipped${j.stale_skipped_ids?.length ? ` (stale: ${list(j.stale_skipped_ids)})` : ""}`);
  if (j.skipped_dependencies?.length) parts.push(`${j.skipped_dependencies.length} dependency link(s) dropped`);
  return parts.join(", ");
}

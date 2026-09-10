/**
 * The fleet's shared task list, read for `paw web` — a thin seam over the beads CLI (`bd`).
 *
 * The store is bd's own machine-wide db (~/.beads, embedded dolt), the SAME one every paw agent is
 * pinned to via BEADS_DIR in its launch env (src/connector.ts) — one list spanning repos, because the
 * fleet's work does. paw deliberately does NOT read the db file: `bd list --json` is the supported
 * surface, and the db format (dolt) is bd's own business.
 *
 * Reads are CACHED (TASKS_TTL_MS): a bd invocation spins up an embedded dolt engine (~hundreds of ms),
 * and the web client polls — same reasoning as the PR section's 60s gh cache, shorter because this
 * data is local and the operator just wrote to it from the composer.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { toolDirs } from "./lifecycle.js";
import { prInfoByUrl, type PrInfo } from "./git.js";

export interface Task {
  id: string;
  title: string;
  status: string;
  priority?: number;
  assignee?: string;
  description?: string;
  parent?: string;
  /** How many comments sit on the bead — the pad shows the 💬 persistently when non-zero. */
  comments?: number;
  /** Ids of OPEN tasks this one waits on — why bd refuses to close it. */
  blockedBy?: string[];
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  /** bd's issue type (task|bug|feature|epic|chore|decision|merge-request…). */
  type?: string;
  /** bd's --external-ref: a PR/issue link or handle. */
  externalRef?: string;
  /** For a merge-request bead whose external ref is a GitHub PR: the live PR (state, checks, ±). */
  pr?: PrInfo;
  /** Closed beads stay VISIBLE (at the bottom) for {@link CLOSED_WINDOW_DAYS}: when and why. */
  closedAt?: string;
  closeReason?: string;
}

/** How long a closed bead keeps showing at the bottom of the lists. Done work is still context —
 *  "fixed" beads in the UI (operator's ask, 2026-08-26) — but a list that only grows stops being a
 *  list; a week is the shape of a sprint retro. */
export const CLOSED_WINDOW_DAYS = 7;

export const isOpen = (t: Task): boolean => t.status !== "closed";

/** in_progress first (someone is ON it), then blocked (needs the operator), then open. Unknown
 *  statuses sort LAST rather than crashing or vanishing — bd may grow vocabulary. */
const STATUS_RANK: Record<string, number> = { in_progress: 0, blocked: 1, open: 2, deferred: 3, closed: 8 }; // closed LAST — visible, never in the way

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const s = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (s !== 0) return s;
    return (a.priority ?? 9) - (b.priority ?? 9);
  });
}

/** Parse `bd list --json` output. Tolerant per-row (a malformed row is dropped, not the whole list),
 *  strict about the envelope: non-array JSON is an error — bd said something we don't understand,
 *  and rendering it as "no tasks" would hide the breakage. */
export function parseTasks(json: string): Task[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("bd list --json did not return an array");
  const out: Task[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.status !== "string") continue;
    out.push({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: typeof r.priority === "number" ? r.priority : undefined,
      assignee: typeof r.assignee === "string" && r.assignee ? r.assignee : undefined,
      description: typeof r.description === "string" && r.description ? r.description : undefined,
      parent: typeof r.parent === "string" && r.parent ? r.parent : undefined,
      blockedBy: typeof r.dependency_count === "number" && r.dependency_count > 0 ? [] : undefined, // enriched in listTasks
      comments: typeof r.comment_count === "number" && r.comment_count > 0 ? r.comment_count : undefined,
      closedAt: typeof r.closed_at === "string" && r.closed_at ? r.closed_at : undefined,
      closeReason: typeof r.close_reason === "string" && r.close_reason ? r.close_reason : undefined,
      type: typeof r.issue_type === "string" && r.issue_type ? r.issue_type : undefined,
      externalRef: typeof r.external_ref === "string" && r.external_ref ? r.external_ref : undefined,
      createdAt: typeof r.created_at === "string" ? r.created_at : undefined,
      createdBy: typeof r.created_by === "string" && r.created_by ? r.created_by : undefined,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
    });
  }
  return sortTasks(out);
}

/** The env every bd invocation gets: the shared db pinned, and PATH backfilled — under launchd the
 *  daemon's PATH may not carry /opt/homebrew/bin, where brew put bd. */
export function bdEnv(): NodeJS.ProcessEnv {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const d of toolDirs()) if (!dirs.includes(d)) dirs.push(d);
  return { ...process.env, BEADS_DIR: join(homedir(), ".beads"), PATH: dirs.join(":") };
}

function bdExec(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bd", args, { env: bdEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`bd ${args[0]}: ${(stderr || err.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

/** bd invocations are SERIALIZED: the embedded dolt engine is effectively single-writer, and two
 *  overlapping writes (the pad creating one task while updating another) made one of them fail —
 *  surfaced live as "⚠ not saved" on an ordinary edit (2026-08-25). A queue costs latency only when
 *  writes actually overlap, which is exactly when the parallel version was failing. Errors don't
 *  break the chain. */
let chain: Promise<unknown> = Promise.resolve();
function bd(args: string[], timeoutMs = 30_000): Promise<string> {
  const next = chain.then(
    () => bdExec(args, timeoutMs),
    () => bdExec(args, timeoutMs),
  );
  chain = next.catch(() => {});
  return next;
}

const TASKS_TTL_MS = 15_000;
let cache: { at: number; tasks: Task[] } | undefined;

/** The open work (bd's default list: open + in_progress + blocked), newest read ≤15s old. */
export async function listTasks(): Promise<Task[]> {
  if (cache && Date.now() - cache.at < TASKS_TTL_MS) return cache.tasks;
  // Open work (bd's default filter; `-n 0` lifts bd's silent 50-row cap) PLUS the last week's closed
  // beads, so done work stays on screen at the bottom instead of vanishing the moment it's ticked.
  const since = new Date(Date.now() - CLOSED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const open = parseTasks(await bd(["list", "--json", "-n", "0"]));
  let closed: Task[] = [];
  try {
    closed = parseTasks(await bd(["list", "--json", "-n", "0", "--status", "closed", "--closed-after", since]));
  } catch {
    /* an older bd without --closed-after: the open list is still the list */
  }
  const tasks = sortTasks([...open, ...closed]);
  // Enrich blocker IDS for the few tasks that have dependencies: `bd list` carries only the COUNT,
  // and a count can't say WHICH open task stands in the way — the one thing the operator needs when
  // a close is refused. One `bd show` per dependent task, amortized by the same 15s cache.
  const openIds = new Set(tasks.filter(isOpen).map((t) => t.id));
  for (const t of tasks) {
    if (!t.blockedBy || !isOpen(t)) continue;
    try {
      const shown: unknown = JSON.parse(await bd(["show", t.id, "--json"]));
      const d = (Array.isArray(shown) ? shown[0] : shown) as { dependencies?: Array<{ id?: unknown }> };
      t.blockedBy = (d.dependencies ?? [])
        .map((x) => (typeof x.id === "string" ? x.id : ""))
        .filter((id) => id && openIds.has(id)); // only OPEN blockers block — a closed dep is history
      if (!t.blockedBy.length) t.blockedBy = undefined;
    } catch {
      t.blockedBy = undefined; // best-effort: the list must not fail on its decoration
    }
  }
  // PR-type beads (`-t merge-request --external-ref <PR url>`) carry the LIVE PR — state, checks,
  // ± — through git.ts's 60s cache, so the pad/board render them like the PRs sidebar does. The
  // task exists to say "review this PR"; showing the PR's own state is the point.
  await Promise.all(
    tasks
      .filter((t) => t.type === "merge-request" && t.externalRef)
      .map(async (t) => {
        try {
          t.pr = await prInfoByUrl(t.externalRef as string);
        } catch {
          t.pr = undefined; // decoration, best-effort
        }
      }),
  );
  cache = { at: Date.now(), tasks };
  return tasks;
}

/** File a task. Returns the fresh list so the caller renders what the operator just did — and drops
 *  the cache, because "I created one and the list doesn't show it" reads as a lost write. */
export async function createTask(title: string, description?: string): Promise<Task[]> {
  await createTaskGetId(title, description);
  return listTasks();
}

/** File a task and return its bd-assigned id (`bd create --silent` prints exactly that) — the task
 *  pad stamps it onto the row the operator is still typing in. */
export async function createTaskGetId(title: string, description?: string, parent?: string, assignee?: string): Promise<string> {
  const args = ["create", title, "--silent"];
  if (description) args.push("-d", description);
  if (parent) args.push("--parent", parent);
  if (assignee) args.push("-a", assignee);
  const id = (await bd(args)).trim().split("\n").pop() ?? "";
  cache = undefined;
  if (!id) throw new Error("bd create returned no id");
  return id;
}

/** Edit a task in place. Only the fields given are touched; asking for nothing is a caller bug and
 *  fails loud rather than invoking bd as a no-op. */
export async function updateTask(id: string, fields: { title?: string; description?: string; status?: string; parent?: string; assignee?: string }): Promise<void> {
  const args = ["update", id];
  if (fields.assignee !== undefined) args.push("-a", fields.assignee);
  if (fields.title !== undefined) args.push("--title", fields.title);
  if (fields.description !== undefined) args.push("-d", fields.description);
  if (fields.status !== undefined) args.push("--status", fields.status);
  if (fields.parent !== undefined) args.push("--parent", fields.parent); // "" clears — bd's own convention
  if (args.length === 2) throw new Error("updateTask: no fields to update");
  await bd(args);
  cache = undefined;
}

/** Attach a comment to a bead — durable, part of the task's record (`bd show`/`bd comments`), unlike
 *  a DM which only the recipient sees. */
export async function commentTask(id: string, text: string): Promise<void> {
  await bd(["comment", id, text]);
  cache = undefined; // comment_count changed
}

/** The PRs-sidebar rows a task list contributes: one per merge-request bead with a RESOLVED PR,
 *  labelled by assignee (or "unassigned") and carrying the bead id. Pure — the sidebar merges these
 *  with the live agents' folder PRs and dedupes by url. */
export function taskPrRows(tasks: Task[]): Array<{ agent: string; folder: string; pr: PrInfo; task: string }> {
  return tasks
    .filter((t): t is Task & { pr: PrInfo } => t.type === "merge-request" && !!t.pr && isOpen(t)) // a closed review is finished work, not a PR in progress
    .map((t) => ({ agent: t.assignee ?? "unassigned", folder: "", pr: t.pr, task: t.id }));
}

export interface TaskComment {
  author: string;
  text: string;
  createdAt: string;
}

/** Parse `bd comments <id> --json`. Tolerant per row; a non-array envelope is an error. Pure. */
export function parseComments(json: string): TaskComment[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("bd comments --json did not return an array");
  const out: TaskComment[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.text !== "string") continue;
    out.push({
      author: typeof r.author === "string" && r.author ? r.author : "?",
      text: r.text,
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
    });
  }
  return out;
}

/** The comment thread on a bead, oldest first (bd's order). Not cached: it's read on demand when a
 *  card opens, and the operator just posted to it. */
export async function listComments(id: string): Promise<TaskComment[]> {
  return parseComments(await bd(["comments", id, "--json"]));
}

export async function closeTask(id: string, reason?: string): Promise<void> {
  const args = ["close", id];
  if (reason) args.push("--reason", reason);
  await bd(args);
  cache = undefined;
}

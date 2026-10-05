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
import { toolDirs } from "./lifecycle.ts";
import { beadsDir } from "./beads-dir.ts";
import { prInfoByUrl, type PrInfo } from "./git.ts";

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
  /** bd labels — `company:<slug>` ties a bead to a company (inherited by children at create). */
  labels?: string[];
  /** When bd first saw it go in_progress (bd's `started_at`) — the company feed's "started" event. */
  startedAt?: string;
  /** bd's free-form metadata object (a company epic keeps `{company, org}` here — it does NOT inherit). */
  metadata?: Record<string, unknown>;
  /** Ids this bead waits on through a `blocks` dependency (bd leaves the waiting bead `open`; who is
   *  blocking whom is computed from this). Straight from `bd list --json`'s `dependencies`, no extra call. */
  waitsOn?: string[];
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

/** bd emits metadata as an object (or, in some places, a JSON string). Empty → undefined. A string
 *  that isn't JSON is passed up as `{_unparsed}` rather than dropped — the company page quotes it. */
function parseMetadata(v: unknown): Record<string, unknown> | undefined {
  let o = v;
  if (typeof v === "string") {
    if (!v.trim()) return undefined;
    try {
      o = JSON.parse(v);
    } catch {
      return { _unparsed: v };
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  return Object.keys(o).length ? (o as Record<string, unknown>) : undefined;
}

/** `dependencies:[{depends_on_id, type}]` → the ids of `blocks` dependencies, or undefined. */
function blocksDeps(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = v
    .filter((d): d is { depends_on_id: string; type: string } => !!d && typeof d === "object" && (d as { type?: unknown }).type === "blocks" && typeof (d as { depends_on_id?: unknown }).depends_on_id === "string")
    .map((d) => d.depends_on_id);
  return ids.length ? ids : undefined;
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
      labels: Array.isArray(r.labels) && r.labels.length ? r.labels.filter((l): l is string => typeof l === "string") : undefined,
      metadata: parseMetadata(r.metadata),
      waitsOn: blocksDeps(r.dependencies),
      startedAt: typeof r.started_at === "string" && r.started_at ? r.started_at : undefined,
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
  return { ...process.env, BEADS_DIR: beadsDir(), PATH: dirs.join(":") };
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
/** Bumped on every write, so caches layered over bd (the company view's) drop with the task list's. */
let writes = 0;
export const writeGeneration = (): number => writes;
function invalidate(): void {
  cache = undefined;
  writes++;
}

/** How old a list `listTasksSWR` will still hand out (while it refreshes behind the caller). */
const STALE_MS = 5 * 60_000;
let refreshing: Promise<unknown> | undefined;

/**
 * listTasks for READ-MOSTLY views (the company page + sidebar): a list up to STALE_MS old comes back
 * at once while ONE refresh runs behind it. Each bd call boots an embedded dolt engine (~1s on the
 * live db) and calls are serialized, so a cold company page used to wait on 4–5 of them. A paw write
 * still invalidates the cache outright, so nothing written here is ever served stale.
 */
export async function listTasksSWR(): Promise<Task[]> {
  if (cache && Date.now() - cache.at < STALE_MS) {
    if (Date.now() - cache.at >= TASKS_TTL_MS && !refreshing)
      refreshing = listTasks()
        .catch(() => {})
        .finally(() => {
          refreshing = undefined;
        });
    return cache.tasks;
  }
  return listTasks();
}

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
export interface CreateExtras {
  /** bd issue type (`epic` for a company or a goal). */
  type?: string;
  labels?: string[];
  /** Don't inherit the parent's labels — a goal must not pick up the company root's member/role labels. */
  noInheritLabels?: boolean;
  metadata?: Record<string, unknown>;
  /** bd --actor: who the audit trail (created_by) names. */
  actor?: string;
}

export async function createTaskGetId(title: string, description?: string, parent?: string, assignee?: string, extras: CreateExtras = {}): Promise<string> {
  const args = ["create", title, "--silent"];
  if (extras.type) args.push("-t", extras.type);
  if (extras.labels?.length) args.push("-l", extras.labels.join(","));
  if (extras.noInheritLabels) args.push("--no-inherit-labels");
  if (extras.metadata) args.push("--metadata", JSON.stringify(extras.metadata));
  if (extras.actor) args.push("--actor", extras.actor);
  if (description) args.push("-d", description);
  if (parent) args.push("--parent", parent);
  if (assignee) args.push("-a", assignee);
  const id = (await bd(args)).trim().split("\n").pop() ?? "";
  invalidate();
  if (!id) throw new Error("bd create returned no id");
  return id;
}

/** Edit a task in place. Only the fields given are touched; asking for nothing is a caller bug and
 *  fails loud rather than invoking bd as a no-op. */
export async function updateTask(id: string, fields: { title?: string; description?: string; status?: string; parent?: string; assignee?: string; addLabels?: string[]; removeLabels?: string[]; metadata?: Record<string, unknown> }, actor?: string): Promise<void> {
  const args = ["update", id];
  if (actor) args.push("--actor", actor);
  if (fields.metadata !== undefined) args.push("--metadata", JSON.stringify(fields.metadata));
  for (const l of fields.addLabels ?? []) args.push("--add-label", l);
  for (const l of fields.removeLabels ?? []) args.push("--remove-label", l);
  if (fields.assignee !== undefined) args.push("-a", fields.assignee);
  if (fields.title !== undefined) args.push("--title", fields.title);
  if (fields.description !== undefined) args.push("-d", fields.description);
  if (fields.status !== undefined) args.push("--status", fields.status);
  if (fields.parent !== undefined) args.push("--parent", fields.parent); // "" clears — bd's own convention
  if (args.length === (actor ? 4 : 2)) throw new Error("updateTask: no fields to update");
  await bd(args);
  invalidate();
}

/** Move every OPEN task (bd's default filter: open, in_progress, blocked) from assignee `from` to `to`;
 *  returns the ids moved. Closed work keeps its historical assignee. For `paw rename`: without it the
 *  renamed agent stopped seeing its own queue (9 open beads stayed on vibeos-landing, 2026-10-03). */
export async function reassignOpenTasks(from: string, to: string): Promise<string[]> {
  const ids = parseTasks(await bd(["list", "-n", "0", "-a", from, "--json"]))
    .filter((t) => isOpen(t) && t.assignee === from)
    .map((t) => t.id);
  for (const id of ids) await updateTask(id, { assignee: to });
  return ids;
}

/** Every bead carrying ALL of `labels`, closed included (a company's goal progress counts closed
 *  work). Uncached here — the caller (company view) keeps its own cache keyed on writeGeneration. */
export async function listLabelled(labels: string[]): Promise<Task[]> {
  if (!labels.length) throw new Error("listLabelled: at least one label");
  const args = ["list", "--json", "-n", "0", "--all"];
  for (const l of labels) args.push("-l", l);
  return parseTasks(await bd(args));
}

/** Beads by metadata: `{hasKey}` → `--has-metadata-key`, `{field: [k, v]}` → `--metadata-field k=v`. Closed included. */
export async function listByMetadata(q: { hasKey?: string; field?: [string, string]; openOnly?: boolean }): Promise<Task[]> {
  const args = ["list", "--json", "-n", "0"];
  if (!q.openOnly) args.push("--all"); // --all scans every closed bead too — ~3x slower on the live db
  if (!q.hasKey && !q.field) throw new Error("listByMetadata: give hasKey or field");
  if (q.hasKey) args.push("--has-metadata-key", q.hasKey);
  if (q.field) args.push("--metadata-field", `${q.field[0]}=${q.field[1]}`);
  return parseTasks(await bd(args));
}

/** Attach a comment to a bead — durable, part of the task's record (`bd show`/`bd comments`), unlike
 *  a DM which only the recipient sees. */
/** Read-modify-write of one bead's WHOLE metadata object (bd's `--metadata` replaces it) inside the
 *  serialized chain, so no other paw write interleaves a stale read. `mutate` gets the current object
 *  (unknown keys included) and returns the next one. */
export async function mutateMetadata(id: string, mutate: (cur: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const run = async (): Promise<Record<string, unknown>> => {
    const shown: unknown = JSON.parse(await bdExec(["show", id, "--json"], 30_000));
    const row = (Array.isArray(shown) ? shown[0] : shown) as { metadata?: unknown } | undefined;
    if (!row) throw new Error(`bd show ${id}: no such bead`);
    const cur = parseMetadata(row.metadata) ?? {};
    if ("_unparsed" in cur) throw new Error(`bd show ${id}: metadata isn't JSON — fix it by hand: ${String(cur._unparsed).slice(0, 120)}`);
    const next = mutate(structuredClone(cur));
    await bdExec(["update", id, "--metadata", JSON.stringify(next)], 30_000);
    return next;
  };
  const job = chain.then(run, run);
  chain = job.catch(() => {});
  const out = await job;
  invalidate();
  return out;
}

/** `actor` = who bd records as the author (bd's --actor). Without it bd falls back to $BEADS_ACTOR /
 *  git user.name — which made the operator's page comments read "Aleksey Bykhun". */
export async function commentTask(id: string, text: string, actor?: string): Promise<void> {
  await bd(["comment", id, text, ...(actor ? ["--actor", actor] : [])]);
  invalidate(); // comment_count changed
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

export async function closeTask(id: string, reason?: string, actor?: string): Promise<void> {
  const args = ["close", id];
  if (actor) args.push("--actor", actor);
  if (reason) args.push("--reason", reason);
  await bd(args);
  invalidate();
}

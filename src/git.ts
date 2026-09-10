/**
 * What repository an agent is sitting in — branch, remote, worktree, and the PR for its branch.
 *
 * `paw status` knows an agent's FOLDER and nothing about the code in it, which is the one thing you
 * actually want when a dozen agents are working: which branch, whose repo, is this a worktree, and is
 * there a PR open.
 *
 * Split by COST, because the two halves are not comparable:
 *   - {@link gitInfo} is local and cheap (a few `git` reads), so it rides every status collect.
 *   - {@link prInfo} shells out to `gh`, which goes to GitHub over the network — so it is LAZY, asked
 *     for one agent at a time. Running it across a 38-agent roster on every poll would mean 38 network
 *     calls every few seconds, which is how you get rate-limited for a decoration.
 */
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GitInfo {
  /** `owner/repo` parsed from the origin remote, when there is one. */
  repo?: string;
  branch?: string;
  /** True when this folder is a LINKED worktree rather than the main checkout. */
  worktree: boolean;
  /** For a linked worktree, the main checkout it belongs to — the thing you'd `cd` to. */
  mainPath?: string;
  /** Uncommitted changes present. */
  dirty?: boolean;
  /** Commits ahead of the branch's upstream, when it has one. */
  ahead?: number;
}

export interface PrInfo {
  number: number;
  url: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  /** The PR's own branch — NOT the folder's current one. A worktree can be checked out elsewhere while
   *  the PR still belongs to the branch it was opened from, and naming the wrong one would send you to
   *  the wrong diff. */
  branch?: string;
  additions?: number;
  deletions?: number;
  /** Rolled up to the only three answers a UI can draw: passing, failing, still running. Undefined
   *  means NO checks are configured, which is different from "not finished" and must not render as a
   *  spinner that never resolves. */
  checks?: "pass" | "fail" | "pending";
}

/** GitHub reports per-run conclusions; a PR has one state to draw. Any failure dominates (that is the
 *  thing you need to act on), then anything still running, else pass. An unknown conclusion counts as
 *  pending rather than pass — claiming green for a state we do not understand is the one wrong
 *  direction here. */
export function rollupChecks(nodes: unknown): "pass" | "fail" | "pending" | undefined {
  if (!Array.isArray(nodes) || nodes.length === 0) return undefined;
  let sawPending = false;
  let sawAny = false;
  for (const n of nodes as { status?: string; conclusion?: string; state?: string }[]) {
    const verdict = (n?.conclusion ?? n?.state ?? "").toUpperCase();
    const status = (n?.status ?? "").toUpperCase();
    if (!verdict && !status) continue;
    sawAny = true;
    if (verdict === "FAILURE" || verdict === "TIMED_OUT" || verdict === "CANCELLED" || verdict === "ERROR" || verdict === "ACTION_REQUIRED") return "fail";
    if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") continue;
    sawPending = true; // IN_PROGRESS, QUEUED, PENDING, EXPECTED — or anything we don't recognise
  }
  if (!sawAny) return undefined;
  return sawPending ? "pending" : "pass";
}

/** Run a command, returning undefined instead of throwing — every caller here treats "couldn't tell"
 *  as a normal answer, because a folder may not be a repo at all. */
function run(cmd: string, args: string[], cwd: string, timeout = 2000): string | undefined {
  try {
    return execFileSync(cmd, args, { cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** `owner/repo` from any of the URL shapes a remote can take. Undefined for a remote we can't parse —
 *  a guess here would put a wrong link in the UI, which is worse than no link. */
export function parseRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : undefined;
}

/**
 * Cache keyed by folder, invalidated by the mtime of the ref that HEAD points at.
 *
 * A status collect runs across every registered agent, so without this a 38-agent roster is ~150 git
 * subprocesses every poll. The mtime is the honest key: a branch switch or a new commit touches it,
 * and nothing else needs to.
 */
const cache = new Map<string, { key: string; info: GitInfo }>();

export function gitInfo(folder: string): GitInfo | undefined {
  if (!existsSync(folder)) return undefined;
  const gitPath = join(folder, ".git");
  if (!existsSync(gitPath)) return undefined;

  // Keyed on HEAD's mtime: a branch switch or a new commit touches it, nothing else needs to.
  let key = "";
  try {
    // A linked worktree's `.git` is a FILE, so join() would not resolve — fall back to the folder key.
    const head = statSync(gitPath).isDirectory() ? join(gitPath, "HEAD") : gitPath;
    key = existsSync(head) ? String(statSync(head).mtimeMs) : "";
  } catch {
    key = "";
  }
  const hit = cache.get(folder);
  if (hit && hit.key === key && key) return hit.info;

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], folder);
  const repo = parseRemote(run("git", ["remote", "get-url", "origin"], folder));
  // A linked worktree's `.git` is a FILE pointing at the main checkout, not a directory. That is the
  // cheapest reliable test, and it also hands us the path to report.
  const commonDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], folder);
  const gitDir = run("git", ["rev-parse", "--path-format=absolute", "--git-dir"], folder);
  const worktree = Boolean(commonDir && gitDir && commonDir !== gitDir);
  const mainPath = worktree && commonDir ? commonDir.replace(/\/\.git$/, "") : undefined;
  const dirty = run("git", ["status", "--porcelain"], folder) !== "" ? true : false;
  const aheadRaw = run("git", ["rev-list", "--count", "@{u}..HEAD"], folder);
  const ahead = aheadRaw !== undefined && /^\d+$/.test(aheadRaw) ? Number(aheadRaw) : undefined;

  const info: GitInfo = {
    repo,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    worktree,
    mainPath,
    dirty,
    ahead,
  };
  if (key) cache.set(folder, { key, info });
  return info;
}

/**
 * The open PR for this folder's branch, via `gh`. NETWORK — call it for one agent, on demand.
 *
 * Returns undefined for "no PR", "no gh", "not authenticated" and "not a GitHub repo" alike: from the
 * UI's point of view those are the same answer — there is nothing to link to — and distinguishing them
 * would put an error where a quiet absence belongs.
 */
const PR_TTL_MS = 60_000;
/** Cached PR lookups, including MISSES. Caching only the hits would leave the common case — no PR on
 *  this branch — hitting GitHub on every single ask, which is precisely the traffic the cache exists
 *  to prevent. */
const prCache = new Map<string, { at: number; pr: PrInfo | undefined }>();

const PR_FIELDS = "number,url,title,state,isDraft,headRefName,additions,deletions,statusCheckRollup";

/** Parse one `gh pr view --json` payload. Exported for tests: this is where GitHub's shape meets
 *  paw's, and a field that silently changes name would otherwise show as "no PR". */
export function parsePr(json: string): PrInfo | undefined {
  const j = JSON.parse(json) as PrInfo & { headRefName?: string; statusCheckRollup?: unknown };
  if (typeof j?.number !== "number" || typeof j?.url !== "string") return undefined;
  return {
    number: j.number,
    url: j.url,
    title: j.title,
    state: j.state,
    isDraft: j.isDraft,
    branch: j.headRefName,
    additions: typeof j.additions === "number" ? j.additions : undefined,
    deletions: typeof j.deletions === "number" ? j.deletions : undefined,
    checks: rollupChecks(j.statusCheckRollup),
  };
}

export function prInfo(folder: string, now = Date.now()): PrInfo | undefined {
  const hit = prCache.get(folder);
  if (hit && now - hit.at < PR_TTL_MS) return hit.pr;

  const out = run("gh", ["pr", "view", "--json", PR_FIELDS], folder, 8000);
  let pr: PrInfo | undefined;
  if (out) {
    try {
      pr = parsePr(out);
    } catch {
      /* unparseable → treat as no PR, and cache that so we don't re-ask in a loop */
    }
  }
  prCache.set(folder, { at: now, pr });
  return pr;
}

/**
 * PRs for MANY folders, in parallel and through the same 60s cache (misses included).
 *
 * Concurrency is capped LOW — each of these is a network round-trip to GitHub, not a local git spawn,
 * so the limit here is about not hammering an API rather than not hammering the scheduler. The cache
 * is what makes a sidebar section affordable at all: after the first sweep, a poll costs nothing until
 * the TTL expires.
 */
export async function prInfoMany(folders: readonly string[], limit = 5): Promise<Map<string, PrInfo | undefined>> {
  const out = new Map<string, PrInfo | undefined>();
  const queue = [...new Set(folders)];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const folder = queue.shift();
      if (folder === undefined) return;
      // Each lookup is independent; one unreachable repo must not sink the sweep.
      try {
        out.set(folder, await prInfoAsync(folder));
      } catch {
        out.set(folder, undefined);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function prInfoAsync(folder: string, now = Date.now()): Promise<PrInfo | undefined> {
  const hit = prCache.get(folder);
  if (hit && now - hit.at < PR_TTL_MS) return hit.pr;
  const out = await runAsync("gh", ["pr", "view", "--json", PR_FIELDS], folder, 8000);
  let pr: PrInfo | undefined;
  if (out) {
    try {
      pr = parsePr(out);
    } catch {
      /* unparseable → no PR, cached so we don't re-ask in a loop */
    }
  }
  prCache.set(folder, { at: now, pr });
  return pr;
}

/**
 * A PR by its URL — for beads of type merge-request whose `external_ref` is a GitHub PR link. Same
 * parse, same 60s cache (keyed by the url; misses cached too), same 8s budget; `gh pr view <url>`
 * needs no checkout, so it runs from $HOME. Non-GitHub refs return undefined without a call.
 */
export async function prInfoByUrl(url: string, now = Date.now()): Promise<PrInfo | undefined> {
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return undefined;
  const key = `url:${url}`;
  const hit = prCache.get(key);
  if (hit && now - hit.at < PR_TTL_MS) return hit.pr;
  const out = await runAsync("gh", ["pr", "view", url, "--json", PR_FIELDS], homedir(), 8000);
  let pr: PrInfo | undefined;
  if (out) {
    try {
      pr = parsePr(out);
    } catch {
      /* unparseable → no PR, cached */
    }
  }
  prCache.set(key, { at: now, pr });
  return pr;
}

/** How many GitHub calls this module would make right now, for a test to assert against. */
export function prCacheSize(): number {
  return prCache.size;
}

/**
 * The same reads as {@link gitInfo}, for MANY folders at once.
 *
 * Why this exists: `paw status` calls gitInfo per agent, and each call is five `git` subprocesses. At
 * 54 registered agents that is ~184 spawns run STRICTLY SERIALLY — measured at 2.5s of a 3.9s
 * `paw status`, which is what the Raycast extension sat on showing "Reading the roster…". The work per
 * folder is trivial; it is the spawn latency, repeated, that dominates. Folders are independent, so the
 * fix is to stop waiting for them one at a time.
 *
 * Bounded concurrency, not unbounded: 54 folders × 5 git processes released at once is a thundering
 * herd on a machine already running dozens of agents — the exact contention that was knocking the
 * manager off its lease.
 */
export async function gitInfoMany(folders: readonly string[], limit = 8): Promise<Map<string, GitInfo | undefined>> {
  const out = new Map<string, GitInfo | undefined>();
  const queue = [...new Set(folders)];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const folder = queue.shift();
      if (folder === undefined) return;
      out.set(folder, await gitInfoAsync(folder));
    }
  });
  await Promise.all(workers);
  return out;
}

/** Run a command without blocking the loop, returning undefined instead of throwing — same contract as
 *  the sync {@link run}, because "couldn't tell" is a normal answer for a folder that isn't a repo. */
function runAsync(cmd: string, args: string[], cwd: string, timeout = 2000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, encoding: "utf8" }, (err, stdout) => resolve(err ? undefined : stdout.trim()));
  });
}

/** {@link gitInfo}'s reads, concurrently within one folder too — its five commands are independent. */
async function gitInfoAsync(folder: string): Promise<GitInfo | undefined> {
  if (!existsSync(folder)) return undefined;
  const gitPath = join(folder, ".git");
  if (!existsSync(gitPath)) return undefined;

  // Same HEAD-mtime cache key as the sync path, so the two share one cache and neither re-does the
  // other's work within a process.
  let key = "";
  try {
    const head = statSync(gitPath).isDirectory() ? join(gitPath, "HEAD") : gitPath;
    key = existsSync(head) ? String(statSync(head).mtimeMs) : "";
  } catch {
    key = "";
  }
  const hit = cache.get(folder);
  if (hit && hit.key === key && key) return hit.info;

  const [branch, remote, commonDir, gitDir, porcelain, aheadRaw] = await Promise.all([
    runAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], folder),
    runAsync("git", ["remote", "get-url", "origin"], folder),
    runAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], folder),
    runAsync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], folder),
    runAsync("git", ["status", "--porcelain"], folder),
    runAsync("git", ["rev-list", "--count", "@{u}..HEAD"], folder),
  ]);
  const worktree = Boolean(commonDir && gitDir && commonDir !== gitDir);
  const info: GitInfo = {
    repo: parseRemote(remote),
    branch: branch && branch !== "HEAD" ? branch : undefined,
    worktree,
    mainPath: worktree && commonDir ? commonDir.replace(/\/\.git$/, "") : undefined,
    dirty: porcelain !== "" ? true : false,
    ahead: aheadRaw !== undefined && /^\d+$/.test(aheadRaw) ? Number(aheadRaw) : undefined,
  };
  if (key) cache.set(folder, { key, info });
  return info;
}

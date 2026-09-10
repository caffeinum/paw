/**
 * GitHub-handle addressing for paw: `github:owner/repo[#branch]` adopts a REMOTE repo by cloning it
 * once into `<PAW_HOME or ~/.paw>/repos/<owner>/<repo>` and resolving to that folder, so any
 * folder-addressed verb (chat/open/create/dm) can talk to an agent rooted in it. Clone is a blobless
 * partial clone via the user's `gh` auth, the upstream directly (NO fork), idempotent (a second
 * resolve reuses the existing checkout). An optional `#branch` is checked out, CREATED if missing.
 * Everything is SYNC because `resolveFolderArg` is called synchronously across the codebase.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalDir } from "./addressing.js";

export interface GithubHandle {
  owner: string;
  repo: string;
  branch?: string;
}

// GitHub's owner/repo charset; also blocks path traversal / argv injection (`..`, `/`, leading `-`).
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse a `github:owner/repo[#branch]` handle. Returns undefined when `target` is NOT a github handle
 * (so callers can use it as a guard); throws (fail loud) when it IS one but is malformed. Splits on
 * the FIRST `#` so a branch may contain further `#`/`/`; strips a single trailing `.git` from repo.
 */
export function parseGithubHandle(target: string): GithubHandle | undefined {
  if (!target.startsWith("github:")) return undefined;
  // A pasted URL is the most common way to have a repo in hand; `github:https://github.com/o/r`
  // failed with `invalid owner "https:"`, which is technically true and useless. Peel the URL/ssh
  // forms down to owner/repo; the strict grammar below still validates what's left.
  const rest = target
    .slice("github:".length)
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\/+$/, "");
  const hash = rest.indexOf("#");
  const path = hash === -1 ? rest : rest.slice(0, hash);
  const branch = hash === -1 ? undefined : rest.slice(hash + 1);

  const slash = path.indexOf("/");
  if (slash === -1) throw new Error(`paw: "${target}" is not github:owner/repo (missing "/")`);
  const owner = path.slice(0, slash);
  let repo = path.slice(slash + 1);
  if (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
  if (!NAME.test(owner)) throw new Error(`paw: "${target}" has an invalid owner "${owner}"`);
  if (!NAME.test(repo)) throw new Error(`paw: "${target}" has an invalid repo "${repo}"`);

  if (branch !== undefined) {
    // Path-safety: the branch becomes part of git refs/checkout args, never a path under repos/, but
    // reject the obvious traversal/control shapes anyway. Slashes are allowed (feature/x branches).
    if (branch === "") throw new Error(`paw: "${target}" has an empty branch after "#"`);
    // A leading `-` would be read by `git checkout` as a flag (argv injection, e.g. --upload-pack=…).
    if (branch.includes("..") || branch.startsWith("/") || branch.startsWith("-") || /[\0-\x1f]/.test(branch)) {
      throw new Error(`paw: "${target}" has an unsafe branch "${branch}"`);
    }
  }
  return branch === undefined ? { owner, repo } : { owner, repo, branch };
}

/** The clone root: `<PAW_HOME or ~/.paw>/repos`. Mirrors spaceDir's PAW_HOME logic; repos are
 *  space-independent so they live directly under the paw root, NOT under spaces/<space>. */
function reposRoot(): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  return join(root, "repos");
}

/** The on-disk destination for a repo clone (`<reposRoot>/<owner>/<repo>`). Does NOT mkdir. */
export function repoDir(owner: string, repo: string): string {
  return join(reposRoot(), owner, repo);
}

/** The exact `gh` argv for a blobless partial clone of the upstream into `dest`. Pure (no side
 *  effects) so it's unit-testable without the network. */
export function ghCloneArgs(owner: string, repo: string, dest: string): string[] {
  return ["repo", "clone", `${owner}/${repo}`, dest, "--", "--filter=blob:none"];
}

function git(dest: string, args: string[]): void {
  execFileSync("git", ["-C", dest, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

function branchRefExists(dest: string, ref: string): boolean {
  try {
    git(dest, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** Run a `git checkout …`, capturing stderr so its real cause is visible (the shared `git()` helper
 *  drops stderr). Throws a `paw:` error with git's own message appended (e.g. a dirty tree). */
function checkout(dest: string, args: string[], branch: string): void {
  try {
    execFileSync("git", ["-C", dest, "checkout", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const reason = (err.stderr?.toString().trim() || err.message).trim();
    throw new Error(`paw: couldn't check out branch "${branch}" in ${dest} (${reason})`);
  }
}

/**
 * Check out `branch` in `dest`, CREATING it if it doesn't exist: an existing local OR remote-tracking
 * branch is checked out directly (git auto-creates a tracking branch from origin/<branch>); otherwise
 * a new branch is created with `checkout -b`. Fails loud (e.g. a dirty tree) — git's own error
 * surfaces wrapped in a `paw:` message.
 */
function ensureBranch(dest: string, branch: string): void {
  const exists =
    branchRefExists(dest, `refs/heads/${branch}`) || branchRefExists(dest, `refs/remotes/origin/${branch}`);
  if (exists) checkout(dest, [branch], branch);
  else checkout(dest, ["-b", branch], branch);
}

/**
 * Every branch known to a clone: local heads + remote-tracking branches under origin/ (the `origin/`
 * prefix stripped, `HEAD` dropped, de-duplicated). A `gh repo clone` fetches every remote head into
 * refs/remotes/origin/*, so this covers the repo's real branches WITHOUT another network round-trip.
 * Used to resolve a URL-derived ref candidate to an actual branch (see resolveUrlBranch in address.ts).
 */
export function listBranches(clone: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", clone, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    throw new Error(`paw: couldn't list branches in ${clone} (${(err.stderr?.toString().trim() || err.message).trim()})`);
  }
  const seen = new Set<string>();
  for (const raw of out.split("\n")) {
    const b = raw.trim().replace(/^origin\//, "");
    if (b && b !== "HEAD") seen.add(b);
  }
  return [...seen];
}

/**
 * Resolve a `github:owner/repo[#branch]` handle to the canonical folder of its clone, cloning once on
 * first use and checking out (creating if missing) the requested branch. Idempotent: an existing git
 * checkout at the destination is reused, never re-cloned.
 */
export function resolveGithubTarget(target: string): string {
  const handle = parseGithubHandle(target);
  if (!handle) throw new Error(`paw: "${target}" is not a github:owner/repo reference`);
  const { owner, repo, branch } = handle;
  const dest = repoDir(owner, repo);

  if (!existsSync(join(dest, ".git"))) {
    // A dest that exists but has no .git is a stray dir / interrupted clone — cloning into it would
    // fail with a misleading "check gh auth status". Fail loud and name the path so the user can fix it.
    if (existsSync(dest)) {
      throw new Error(`paw: ${dest} exists but isn't a git checkout (interrupted clone?) — remove it and retry`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    try {
      execFileSync("gh", ghCloneArgs(owner, repo, dest), { stdio: "inherit" });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`paw: \`gh\` is not installed — install GitHub CLI to clone "${owner}/${repo}"`);
      }
      throw new Error(
        `paw: failed to clone "${owner}/${repo}" (${err.message}) — check \`gh auth status\` and that the repo exists and is accessible`,
      );
    }
  }

  if (branch !== undefined) ensureBranch(dest, branch);
  return canonicalDir(dest);
}

/**
 * Worktree addressing for paw: `<repo>@<branch>` resolves to the folder of the git worktree that has
 * `<branch>` checked out. A worktree is just a folder, so once resolved everything downstream
 * (folder→name, spawn, chat/open/adopt/sessions) is unchanged. v1 is strict: it RESOLVES an existing
 * worktree and FAILS LOUD if the branch or its worktree doesn't exist — paw never auto-creates one.
 *
 * These are LEAF resolvers only. The top-level `resolveFolderArg`/`resolveAddress` chain that dispatches
 * across github:/url/worktree/folder lives in src/address.ts (it imports these), so this module stays
 * free of that cycle.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { canonicalDir } from "./addressing.js";

export interface WorktreeRef {
  repo: string; // path to the repo (or any worktree of it); "." if omitted
  branch: string;
}

/** Split `<repo>@<branch>` on the FIRST `@` (paths don't contain `@`; the branch may contain `/`).
 *  Returns null when there's no `@` (not a worktree ref). */
export function parseWorktreeRef(target: string): WorktreeRef | null {
  const i = target.indexOf("@");
  if (i === -1) return null;
  const branch = target.slice(i + 1);
  if (!branch) throw new Error(`paw: "${target}" is missing a branch after "@" (use <repo>@<branch>)`);
  return { repo: target.slice(0, i) || ".", branch };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The git top-level for a dir (the worktree's own root), or undefined if not a git repo. */
export function gitToplevel(dir: string): string | undefined {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

export interface Worktree {
  path: string;
  branch?: string; // undefined for a detached HEAD
  head?: string;
}

/** All worktrees of a repo (works from ANY worktree — git shares the list). */
export function listWorktrees(repoRoot: string): Worktree[] {
  const out = git(repoRoot, ["worktree", "list", "--porcelain"]);
  const wts: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice("worktree ".length) };
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "" && cur) {
      wts.push(cur);
      cur = null;
    }
  }
  if (cur) wts.push(cur);
  return wts;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `<repo>@<branch>` to the canonical folder of the worktree that has `<branch>` checked out.
 * Fails loud (no auto-create) if the repo isn't a git repo, the branch doesn't exist, or the branch
 * exists but isn't checked out in any worktree — with a message telling you how to create one.
 */
export function resolveWorktreeFolder(target: string): string {
  const ref = parseWorktreeRef(target);
  if (!ref) throw new Error(`paw: "${target}" is not a <repo>@<branch> reference`);
  const repoRoot = gitToplevel(resolve(ref.repo));
  if (!repoRoot) throw new Error(`paw: "${ref.repo}" is not a git repository`);

  const match = listWorktrees(repoRoot).find((w) => w.branch === ref.branch);
  if (match) return canonicalDir(match.path);

  throw new Error(
    branchExists(repoRoot, ref.branch)
      ? `paw: branch "${ref.branch}" exists in ${repoRoot} but isn't checked out in any worktree — \`git worktree add <dir> ${ref.branch}\` first`
      : `paw: no branch "${ref.branch}" in ${repoRoot} — create it + a worktree (\`git worktree add -b ${ref.branch} <dir>\`) and retry`,
  );
}

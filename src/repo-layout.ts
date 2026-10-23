/**
 * Where paw keeps repo clones and their per-branch worktrees — a leaf module (no paw imports), shared by
 * github handles (src/github.ts), URL addressing (src/address.ts) and teleport (src/teleport-plan.ts),
 * which lays a repo out the same way on ANOTHER machine's paw root.
 */
import { join } from "node:path";

/** A clone under a paw root: `<pawHome>/repos/<owner>/<repo>`. */
export function repoDirUnder(pawHome: string, owner: string, repo: string): string {
  return join(pawHome, "repos", owner, repo);
}

/** A branch name as a folder-name piece. */
export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

/** paw's per-branch worktree of a clone: `<clone>.worktrees/<repo>-<branch slug>` — a sibling of the
 *  clone, so each branch is its own folder (and agent) and never flips a warm sibling's checkout. */
export function branchWorktreeDir(clone: string, repo: string, branch: string): string {
  return `${clone}.worktrees/${repo}-${branchSlug(branch)}`;
}

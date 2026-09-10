/**
 * Smoke check for worktree addressing (src/worktree.ts): parse `<repo>@<branch>`, list worktrees, and
 * resolve a branch to its worktree folder — failing loud when the branch or its worktree is missing.
 * Builds a throwaway git repo + a real worktree. Run: pnpm check:worktree
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitToplevel, listWorktrees, parseWorktreeRef, resolveWorktreeFolder } from "../src/worktree.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@paw", "-c", "user.name=paw", ...args], { encoding: "utf8" }).trim();

// parse
assert(JSON.stringify(parseWorktreeRef("~/r@feat/x")) === JSON.stringify({ repo: "~/r", branch: "feat/x" }), "parse repo@branch (branch keeps slashes)");
assert(parseWorktreeRef("~/r@a@b")?.branch === "a@b", "parse splits on the FIRST @");
assert(parseWorktreeRef("/just/a/path") === null, "no @ → not a worktree ref");
assert(throws(() => parseWorktreeRef("repo@")), "trailing @ with no branch throws");

// a throwaway repo with one commit
const repo = realpathSync(mkdtempSync(join(tmpdir(), "paw-wt-repo-")));
g(repo, "init", "-q");
g(repo, "commit", "-q", "--allow-empty", "-m", "init");
const mainBranch = g(repo, "branch", "--show-current"); // main or master
const wtDir = realpathSync(mkdtempSync(join(tmpdir(), "paw-wt-tree-")));
rmSync(wtDir, { recursive: true, force: true }); // worktree add wants a non-existent path
g(repo, "worktree", "add", "-b", "feat/slack", wtDir);
g(repo, "branch", "bare-branch"); // exists, but NOT checked out in any worktree

// gitToplevel
assert(gitToplevel(repo) === repo, "gitToplevel returns the repo root");
assert(gitToplevel(tmpdir()) === undefined || gitToplevel(tmpdir()) !== repo, "gitToplevel is undefined / different outside the repo");

// listWorktrees (works from ANY worktree — query from the new one)
const wts = listWorktrees(wtDir);
assert(wts.some((w) => w.branch === mainBranch), "listWorktrees includes the main worktree");
assert(wts.some((w) => w.branch === "feat/slack"), "listWorktrees includes the feat/slack worktree");

// resolve
assert(resolveWorktreeFolder(`${repo}@feat/slack`) === wtDir, "resolves repo@feat/slack → its worktree folder");
assert(resolveWorktreeFolder(`${repo}@${mainBranch}`) === repo, "resolves repo@main → the main worktree");
assert(throws(() => resolveWorktreeFolder(`${repo}@no-such-branch`)), "fails loud when the branch doesn't exist");
assert(throws(() => resolveWorktreeFolder(`${repo}@bare-branch`)), "fails loud when the branch exists but has no worktree");
assert(throws(() => resolveWorktreeFolder(`${tmpdir()}@${mainBranch}`)), "fails loud when the repo path isn't a git repo");

g(repo, "worktree", "remove", "--force", wtDir);
rmSync(repo, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw worktree check(s) failed`);
  process.exit(1);
}
console.log("\nall paw worktree checks passed 🐾");

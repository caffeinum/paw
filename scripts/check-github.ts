/**
 * Smoke check for github-handle addressing (src/github.ts): parse `github:owner/repo[#branch]`
 * (fail loud on malformed / unsafe branches), the pure `ghCloneArgs` argv, and `ensureBranch` via
 * `resolveGithubTarget` against a PRE-CREATED local git repo — so the suite is hermetic (NO network
 * clone; QA owns that). Runs under an isolated PAW_HOME. Run: pnpm check:github
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const pawHome = realpathSync(mkdtempSync(join(tmpdir(), "paw-gh-home-")));
process.env.PAW_HOME = pawHome; // repos clone under here

const { parseGithubHandle, ghCloneArgs, repoDir, resolveGithubTarget } = await import("../src/github.js");

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

// parseGithubHandle
assert(JSON.stringify(parseGithubHandle("github:octocat/Hello-World")) === JSON.stringify({ owner: "octocat", repo: "Hello-World" }), "parses owner/repo");
for (const url of [
  "github:https://github.com/octocat/Hello-World",
  "github:https://github.com/octocat/Hello-World/",
  "github:http://www.github.com/octocat/Hello-World.git",
  "github:github.com/octocat/Hello-World",
  "github:git@github.com:octocat/Hello-World.git",
]) {
  assert(JSON.stringify(parseGithubHandle(url)) === JSON.stringify({ owner: "octocat", repo: "Hello-World" }), `pasted URL form parses: ${url}`);
}
assert(JSON.stringify(parseGithubHandle("github:https://github.com/octocat/Hello-World#dev")) === JSON.stringify({ owner: "octocat", repo: "Hello-World", branch: "dev" }), "pasted URL keeps #branch");
assert(parseGithubHandle("github:octocat/Hello-World#main")?.branch === "main", "parses #branch");
assert(parseGithubHandle("github:o/r#feature/x")?.branch === "feature/x", "branch keeps slashes");
assert(parseGithubHandle("github:owner/repo.git")?.repo === "repo", "strips trailing .git");
assert(parseGithubHandle("/just/a/path") === undefined, "non-github string → undefined");
assert(throws(() => parseGithubHandle("github:noslash")), "no slash → throws");
assert(throws(() => parseGithubHandle("github:/repo")), "empty owner → throws");
assert(throws(() => parseGithubHandle("github:owner/")), "empty repo → throws");
assert(throws(() => parseGithubHandle("github:o!/r")), "bad owner chars → throws");
assert(throws(() => parseGithubHandle("github:o/r!")), "bad repo chars → throws");
assert(throws(() => parseGithubHandle("github:-x/y")), "leading-dash owner → throws");
assert(throws(() => parseGithubHandle("github:o/r/extra")), "extra path segment → throws");
assert(throws(() => parseGithubHandle("github:../x/y")), "traversal owner → throws");
assert(throws(() => parseGithubHandle("github:o/r#")), "empty branch → throws");
assert(throws(() => parseGithubHandle("github:o/r#../evil")), "traversal branch → throws");
assert(throws(() => parseGithubHandle("github:o/r#/abs")), "absolute branch → throws");
assert(throws(() => parseGithubHandle("github:o/r#-flag")), "leading-dash branch → throws");
assert(throws(() => parseGithubHandle("github:o/r#--upload-pack=x")), "argv-injection branch → throws");

// ghCloneArgs (pure)
assert(
  JSON.stringify(ghCloneArgs("octocat", "Hello-World", "/dest")) ===
    JSON.stringify(["repo", "clone", "octocat/Hello-World", "/dest", "--", "--filter=blob:none"]),
  "ghCloneArgs returns the exact blobless clone argv",
);

// ensureBranch via resolveGithubTarget against a PRE-CREATED local repo (no network clone happens).
const dest = repoDir("o", "r");
mkdirSync(dirname(dest), { recursive: true });
mkdirSync(dest);
g(dest, "init", "-q");
g(dest, "commit", "-q", "--allow-empty", "-m", "init");
g(dest, "branch", "existing"); // a local branch to check out
// A remote-tracking ref (no local branch) so `checkout tracked` DWIMs a tracking branch — exercises
// the remote path WITHOUT a network clone.
g(dest, "remote", "add", "origin", "https://example.invalid/o/r.git");
const head = g(dest, "rev-parse", "HEAD");
g(dest, "update-ref", "refs/remotes/origin/tracked", head);

const canon = realpathSync(dest);

resolveGithubTarget("github:o/r#existing");
assert(g(dest, "rev-parse", "--abbrev-ref", "HEAD") === "existing", "checks out an existing branch (no re-clone)");

resolveGithubTarget("github:o/r#tracked");
assert(g(dest, "rev-parse", "--abbrev-ref", "HEAD") === "tracked", "checks out a remote-tracking branch (DWIM, no re-clone)");

resolveGithubTarget("github:o/r#brand-new");
assert(g(dest, "rev-parse", "--abbrev-ref", "HEAD") === "brand-new", "creates + checks out a brand-new branch");

resolveGithubTarget("github:o/r#feat/slash");
assert(g(dest, "rev-parse", "--abbrev-ref", "HEAD") === "feat/slash", "creates a slashed branch");

assert(resolveGithubTarget("github:o/r") === canon, "no branch → returns the canonical dir, doesn't fail");

// A dest that exists but has no .git (stray dir / interrupted clone) fails loud, never clones into it.
const strayDest = repoDir("stray", "dir");
mkdirSync(strayDest, { recursive: true });
assert(throws(() => resolveGithubTarget("github:stray/dir")), "non-git destination → throws (no clone into a stray dir)");

rmSync(pawHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); // git bg activity can leave the tree briefly busy

if (failures > 0) {
  console.error(`\n${failures} paw github check(s) failed`);
  process.exit(1);
}
console.log("\nall paw github checks passed 🐾");

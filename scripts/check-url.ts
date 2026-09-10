/**
 * Hermetic smoke check for paw's full-URL addressing — the PURE half: URL routing (src/url.ts),
 * web-host canonicalisation, name derivation, the `~/.paw` confinement island (src/cwd.ts), the
 * bare-host ambiguity guard (src/addressing.ts), and `kind:` persona-frontmatter r/w. NO network, NO
 * clone, NO mesh (the IO resolvers resolvePrTarget/resolveWebTarget need git/gh — QA owns those, same
 * split as check:github). Runs under an isolated PAW_HOME. Run: pnpm check:url
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-home-")));

const { routeUrl, canonicalizeWebUrl, HOST_RE } = await import("../src/url.js");
const { sanitizeAgentName, assertUnambiguousTarget, ensurePersonaFile, setFolderName, folderToName } = await import("../src/addressing.js");
const { resolveAddress, resolveFolderArg, resolveExistingFolderArg, isAddressHandle } = await import("../src/address.js");
const { confineCwd } = await import("../src/cwd.js");

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@paw", "-c", "user.name=paw", ...args], { encoding: "utf8" }).trim();

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

// ── routeUrl: each URL shape → the right kind + handle/number ────────────────────────────────────
{
  const repo = routeUrl("https://github.com/octocat/Hello-World");
  assert(repo.kind === "repo" && repo.ghHandle === "github:octocat/Hello-World", "bare github repo → repo + github: handle");

  const trailing = routeUrl("https://github.com/octocat/Hello-World/");
  assert(trailing.kind === "repo" && trailing.ghHandle === "github:octocat/Hello-World", "trailing-slash repo → repo");

  const tree = routeUrl("https://github.com/o/r/tree/main");
  assert(tree.kind === "worktree" && tree.owner === "o" && tree.repo === "r" && tree.ref === "main", "/tree/<branch> → worktree + owner/repo/ref");

  const blob = routeUrl("https://github.com/o/r/blob/main/src/x.ts");
  assert(blob.kind === "worktree" && blob.ref === "main/src/x.ts", "/blob/<branch>/… → worktree + GREEDY ref candidate (verified downstream)");

  // A SLASHED branch is captured greedily (not truncated to "feature") — the IO half then verifies which
  // prefix is a real branch and fails loud, so a `/tree/feature/foo` URL can never silently create "feature".
  const slashed = routeUrl("https://github.com/o/r/tree/feature/foo");
  assert(slashed.kind === "worktree" && slashed.ref === "feature/foo", "/tree/feature/foo → ref kept whole (no slashed-branch truncation)");

  const pr = routeUrl("https://github.com/o/r/pull/12");
  assert(pr.kind === "pr" && pr.prNumber === 12 && pr.owner === "o" && pr.repo === "r", "/pull/N → pr + number/owner/repo");

  assert(routeUrl("https://github.com/o/r/issues/3").stub === "github issue", "/issues/N → github issue stub");
  assert(routeUrl("https://gist.github.com/o/abc123").stub === "gist", "gist host → gist stub");
  assert(routeUrl("https://gitlab.com/o/r/-/merge_requests/5").stub === "gitlab MR", "gitlab MR → stub");
  assert(routeUrl("https://bitbucket.org/o/r/pull-requests/7").stub === "bitbucket PR", "bitbucket PR → stub");
  assert(routeUrl("https://www.npmjs.com/package/react").stub === "npm package", "npm package (www stripped) → stub");

  const web = routeUrl("https://react.dev/blog?utm=x#frag");
  assert(web.kind === "web" && web.webSlug === "react.dev" && web.webUrl === "https://react.dev/blog?utm=x#frag", "unknown host → web (slug host, original url kept)");

  const docs = routeUrl("https://docs.python.org/3/library/os.html");
  assert(docs.kind === "web" && docs.webSlug === "docs.python.org", "deep unknown path → web (per-host slug)");

  assert(throws(() => routeUrl("ftp://github.com/o/r")), "non-http(s) scheme → throws");
  assert(throws(() => routeUrl("not a url")), "malformed url → throws");
}

// ── canonicalizeWebUrl: everything collapses to one per-host key ──────────────────────────────────
{
  const slugs = [
    "https://react.dev",
    "http://react.dev",
    "https://react.dev/",
    "https://www.react.dev/blog?utm=x#frag",
    "http://React.Dev:443/x",
  ].map((s) => canonicalizeWebUrl(new URL(s)));
  assert(slugs.every((s) => s === "react.dev"), "http==https, www/port/path/query/fragment all collapse to react.dev");
  assert(throws(() => canonicalizeWebUrl(new URL("file:///etc/passwd"))), "non-http(s) scheme → throws");
}

// ── naming: ~/.paw/web/<host> basename → sanitised agent name ─────────────────────────────────────
assert(sanitizeAgentName("/x/y/web/react.dev") === "react-dev", "web host basename react.dev → react-dev");
assert(sanitizeAgentName("/x/y/web/docs.python.org") === "docs-python-org", "docs.python.org → docs-python-org");

// ── HOST_RE: dotted lowercase hosts match; plain names / paths don't ──────────────────────────────
assert(HOST_RE.test("react.dev"), "react.dev is host-shaped");
assert(HOST_RE.test("docs.python.org"), "docs.python.org is host-shaped");
assert(!HOST_RE.test("web"), "'web' (no dot) is NOT host-shaped");
assert(!HOST_RE.test("my-app"), "'my-app' (no dot) is NOT host-shaped");
assert(!HOST_RE.test("./react.dev"), "'./react.dev' (path) is NOT host-shaped");

// ── bare-host ambiguity guard (assertUnambiguousTarget) ───────────────────────────────────────────
{
  const space = "urltest";
  // Agent names can't be host-shaped: the registry cleans a dotted label to the safe charset, so a
  // registered name never carries a dot (example.com → example-com). The folderForName arm of the
  // host clause is thus defensive; the meaningful collision is a host-shaped LOCAL FOLDER (below).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-fld-")));
  assert(setFolderName(space, dir, "example.com").name === "example-com", "a host-shaped desired name is cleaned to no-dots (names can't be host-shaped)");
  // A host-shaped string that's a local FOLDER here → ambiguous, fail loud.
  const cwd0 = process.cwd();
  const here = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-cwd-")));
  mkdirSync(join(here, "react.dev"));
  process.chdir(here);
  assert(throws(() => assertUnambiguousTarget(space, "react.dev")), "host-shaped string that's ALSO a local folder → ambiguous throw");
  // A host-shaped string that's neither a name nor a folder → clean website route (no throw).
  assert(!throws(() => assertUnambiguousTarget(space, "some-unknown-host.dev")), "host-shaped, neither name nor folder → clean route (no throw)");
  // Explicit sigils are always exempt.
  assert(!throws(() => assertUnambiguousTarget(space, "web:example.com")), "web: sigil is exempt");
  assert(!throws(() => assertUnambiguousTarget(space, "https://example.com")), "https:// URL is exempt");
  assert(!throws(() => assertUnambiguousTarget(space, "gh:o/r")), "gh: sigil is exempt");
  process.chdir(cwd0);
}

// ── dispatcher: resolveAddress / resolveFolderArg / resolveExistingFolderArg / isAddressHandle ─────
// The ordering that REPLACED the old resolveFolderArg (https → web: → gh: → github: → repo@branch →
// bare-host → plain-folder, with existsSync host-vs-folder disambiguation) had no coverage. Assert the
// routing DECISION + kind here, hermetically — never a network clone (github:/gh:/https-github are
// isAddressHandle-only below; web: mkdirs under PAW_HOME/web, no network).
{
  // A plain existing folder resolves to ITSELF (canonical), kind folder.
  const fld = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-plain-")));
  const a = resolveAddress(fld);
  assert(a.cwd === fld && a.kind === "folder", "a plain existing folder → itself, kind folder");
  assert(resolveFolderArg(fld) === fld, "resolveFolderArg is the .cwd shim of resolveAddress");

  // "." and "./sub" resolve relative to the cwd.
  const cwd0 = process.cwd();
  const here = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-here-")));
  mkdirSync(join(here, "sub"));
  const sub = realpathSync(join(here, "sub"));
  process.chdir(here);
  assert(resolveAddress(".").cwd === here, '"." → the cwd');
  assert(resolveAddress("./sub").cwd === realpathSync(join(here, "sub")), '"./sub" → the subfolder');
  assert(resolveAddress(undefined).cwd === here, "undefined target → the cwd (default folder)");
  assert(resolveFolderArg(sub) === realpathSync(sub), "an absolute path resolves to itself");
  process.chdir(cwd0);

  // A <repo>@<branch> worktree still routes to the worktree LEAF (build a real repo+worktree, hermetic).
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-repo-")));
  g(repo, "init", "-q");
  g(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const wtDir = join(tmpdir(), `paw-url-wt-${process.pid}`);
  rmSync(wtDir, { recursive: true, force: true });
  g(repo, "worktree", "add", "-b", "feat/x", wtDir);
  const wtReal = realpathSync(wtDir);
  const wtAddr = resolveAddress(`${repo}@feat/x`);
  assert(wtAddr.cwd === wtReal && wtAddr.kind === "worktree", "<repo>@<branch> → the worktree leaf, kind worktree");
  assert(isAddressHandle(`${repo}@feat/x`), "a <repo>@<branch> ref is an address handle");

  // A registered agent NAME is NOT an address handle (chat/open/dm route it through the name fallback,
  // never a web mint) — and a plain unregistered name isn't a handle either.
  const space = "dispatchtest";
  folderToName(space, fld); // register fld's agent (name = its basename)
  assert(!isAddressHandle("some-agent"), "a bare agent name is NOT an address handle");
  assert(!isAddressHandle(sub), "an existing folder path is NOT an address handle");

  // A bare host-shaped string that IS a real local folder → the FOLDER, not a web mint.
  const hostCwd = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-hostfld-")));
  mkdirSync(join(hostCwd, "react.dev"));
  process.chdir(hostCwd);
  assert(!isAddressHandle("react.dev"), "a host-shaped string that's a local folder is NOT a handle (folder wins)");
  assert(resolveAddress("react.dev").cwd === realpathSync(join(hostCwd, "react.dev")), "host-shaped local folder → the folder (no web mint)");
  // A host-shaped string that is NOT local → a website mint (hermetic: mkdir under PAW_HOME/web, no network).
  assert(isAddressHandle("some-unknown-host.dev"), "a host-shaped string with no local folder IS a handle");
  const webAddr = resolveAddress("some-unknown-host.dev");
  assert(webAddr.kind === "web" && webAddr.cwd === realpathSync(join(process.env.PAW_HOME!, "web", "some-unknown-host.dev")), "bare non-local host → web scratch under PAW_HOME/web");
  process.chdir(cwd0);

  // web: FORCES the website interpretation, skipping the smart-route — github.com/o/r is a SITE, not a clone.
  const forced = resolveAddress("web:github.com/o/r");
  assert(forced.kind === "web" && forced.cwd === realpathSync(join(process.env.PAW_HOME!, "web", "github.com")), "web: forces website (github.com/o/r → web scratch, no clone)");
  assert(isAddressHandle("web:github.com/o/r") && isAddressHandle("gh:o/r") && isAddressHandle("github:o/r") && isAddressHandle("https://x.dev"), "explicit scheme handles are all address handles");

  // resolveExistingFolderArg (adopt/rename): resolves folders + worktrees, but a URL/web:/gh:/github:
  // handle FAILS LOUD (never clones/mints) — the §5 fix.
  assert(resolveExistingFolderArg(fld) === fld, "resolveExistingFolderArg resolves a plain folder");
  assert(resolveExistingFolderArg(`${repo}@feat/x`) === wtReal, "resolveExistingFolderArg resolves a worktree");
  assert(throws(() => resolveExistingFolderArg("some-host.com")), "resolveExistingFolderArg fails loud on a non-existent bare host (no web mint)");
  assert(throws(() => resolveExistingFolderArg("web:example.com")), "resolveExistingFolderArg fails loud on web:");
  assert(throws(() => resolveExistingFolderArg("gh:o/r")), "resolveExistingFolderArg fails loud on gh:");
  assert(throws(() => resolveExistingFolderArg("https://github.com/o/r")), "resolveExistingFolderArg fails loud on an https URL");

  g(repo, "worktree", "remove", "--force", wtDir);
}

// ── ~/.paw confinement island (the §4 fix): under a PAW_ROOT code tree, ~/.paw scratch is in-root ──
{
  const codeTree = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-root-")));
  process.env.PAW_ROOT = codeTree;
  const webDir = join(process.env.PAW_HOME!, "web", "react.dev");
  mkdirSync(webDir, { recursive: true });
  const r = confineCwd(realpathSync(webDir));
  assert(r.inRoot === true, "a ~/.paw/web/<host> cwd resolves in-root even under a PAW_ROOT code tree");
  // A truly out-of-root, non-paw dir still fails loud (confinement not defeated).
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "paw-url-out-")));
  assert(throws(() => confineCwd(outside)), "a non-paw out-of-root cwd still throws (confinement intact)");
  delete process.env.PAW_ROOT;
}

// ── paw-kind: persona-frontmatter r/w (write via ensurePersonaFile, read back the file) ────────────
// NOT `kind:` — cotal's own AgentDef reserves that key (hard-validates "agent"/"endpoint"), so a
// URL-sourced persona (web/pr/repo/…) carries paw's marker under its own namespaced key instead
// (the eve.md incident, 2026-07-22: a github: agent failed to load with `kind: repo` frontmatter).
{
  const space = "kindtest";
  const webFile = ensurePersonaFile(space, "react-dev", { kind: "web", brief: "You represent the website https://react.dev." });
  const webBody = readFileSync(webFile, "utf8");
  assert(/^paw-kind: web$/m.test(webBody), "ensurePersonaFile writes `paw-kind: web` frontmatter for a web agent");
  assert(webBody.includes("You represent the website https://react.dev."), "ensurePersonaFile writes the supplied brief as the body");

  const plainFile = ensurePersonaFile(space, "plain-folder"); // no opts → folder, generic body, no kind line
  const plainBody = readFileSync(plainFile, "utf8");
  assert(!/paw-kind:/m.test(plainBody), "a plain folder agent gets NO paw-kind: line (absent ⇒ folder)");
  assert(plainBody.includes('paw agent for the "plain-folder" folder'), "a plain folder agent gets the generic brief");

  const folderKind = ensurePersonaFile(space, "explicit-folder", { kind: "folder" });
  assert(!/paw-kind:/m.test(readFileSync(folderKind, "utf8")), "paw-kind: folder is not written (it's the default)");
}

rmSync(process.env.PAW_HOME!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

if (failures > 0) {
  console.error(`\n${failures} paw url check(s) failed`);
  process.exit(1);
}
console.log("\nall paw url checks passed 🐾");

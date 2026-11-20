/**
 * The folder side of `paw archive`: may a retired agent's folder go, and how `paw unarchive` puts it back.
 *
 * A folder is removed only when ALL of these hold — anything else keeps it, and every failing rule is said:
 *  - it is a LINKED git worktree, at its root: never a main checkout, a subfolder or a non-git folder;
 *  - git worktree list does not mark it locked;
 *  - `git status --porcelain` is clean apart from untracked `node_modules` (a symlinked one shows as untracked;
 *    ignored files are git's own business — `git worktree remove` takes them too);
 *  - its HEAD is in `origin/<default branch>` (fetched first, best-effort) OR is the `headRefOid` of a merged PR
 *    of its branch (`gh pr list --head <branch> --state merged`): a matching branch name alone proves nothing;
 *  - nothing is unpushed: every commit of HEAD is on a remote-tracking ref, or HEAD is that merged PR's head
 *    (GitHub has it, though the branch may be deleted there);
 *  - no live process has its cwd in it (`lsof -d cwd`);
 *  - no registered agent, in any space, has its folder there or below.
 * Removal is `git worktree remove [--force]` (--force only for an untracked node_modules) + `git worktree prune`;
 * the local branch stays, so `paw unarchive` can `git worktree add` it back at the same path.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export type Run = (cwd: string, args: string[], timeoutMs?: number) => { ok: boolean; out: string; err: string; missing?: true };

const runner =
  (bin: string): Run =>
  (cwd, args, timeoutMs = 30_000) => {
    const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return { ok: false, out: "", err: r.error.message, ...((r.error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true as const } : {}) };
    return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() || (r.signal ? `killed by ${r.signal}` : r.status ? `exit ${r.status}` : "") };
  };
export const realGit: Run = runner("git");
export const realGh: Run = runner("gh");

export type CwdHolder = { pid: number; command: string; cwd: string };

/** Every live process whose cwd is `dir` or under it (lsof -d cwd), but this one. Throws when lsof can't answer. */
export function cwdHoldersUnder(dir: string, lsof: Run = runner("lsof")): CwdHolder[] {
  const r = lsof("/", ["-n", "-P", "-w", "-d", "cwd", "-F", "pcn"], 60_000);
  // lsof exits 1 when it couldn't read SOME process; its output for the rest still stands.
  if (!r.out.trim()) throw new Error(`lsof gave no answer (${r.err || "empty output"})`);
  const out: CwdHolder[] = [];
  let pid = 0;
  let command = "";
  for (const line of r.out.split("\n")) {
    const tag = line[0];
    const v = line.slice(1);
    if (tag === "p") (pid = Number(v)), (command = "");
    else if (tag === "c") command = v;
    else if (tag === "n" && pid && pid !== process.pid && (v === dir || v.startsWith(`${dir}/`))) out.push({ pid, command, cwd: v });
  }
  return out;
}

export interface WorktreeFacts {
  folder: string;
  /** The repo's main checkout (first `git worktree list` entry) — where unarchive runs `git worktree add`. */
  mainCheckout: string;
  /** Undefined = detached HEAD. */
  branch?: string;
  head: string;
  /** The folder's top-level node_modules: a symlink's target (re-linked on unarchive), "dir", or absent. */
  nodeModules?: { link: string } | "dir";
}

export interface WorktreeVerdict {
  remove: boolean;
  /** Why it stays (empty when it may go). */
  keep: string[];
  /** Said either way: a fetch that failed, gh missing. */
  notes: string[];
  /** How "merged" was proven (set whenever it was). */
  proof?: string;
  facts?: WorktreeFacts;
  /** Untracked node_modules present: the removal needs --force. */
  force: boolean;
}

export interface JudgeDeps {
  git: Run;
  gh: Run;
  /** Live processes with their cwd in the folder; skipped (undefined) for a preview from inside the agent. */
  cwdHolders?: (dir: string) => CwdHolder[];
  /** Registered agents ("name#space") whose folder is `dir` or under it. */
  agentsUsing: (dir: string) => string[];
  /** Fetch origin's default branch first (best-effort). */
  fetch: boolean;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** `git worktree list --porcelain` → one record per worktree. */
export function parseWorktreeList(text: string): Array<{ path: string; head?: string; branch?: string; detached: boolean; locked: boolean; bare: boolean }> {
  const out: Array<{ path: string; head?: string; branch?: string; detached: boolean; locked: boolean; bare: boolean }> = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "");
    out.push({ path, ...(head ? { head } : {}), ...(branch ? { branch } : {}), detached: lines.includes("detached"), locked: lines.some((l) => l === "locked" || l.startsWith("locked ")), bare: lines.includes("bare") });
  }
  return out;
}

/** `git status --porcelain -z` entries that are not an untracked node_modules. Renames carry their source as the next entry. */
export function dirtyEntries(z: string): { dirty: string[]; nodeModules: boolean } {
  const parts = z.split("\0");
  const dirty: string[] = [];
  let nodeModules = false;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (!e) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy === "??" && /(^|\/)node_modules\/?$/.test(path)) {
      nodeModules = true;
      continue;
    }
    dirty.push(`${xy.trim() || xy} ${path}`);
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return { dirty, nodeModules };
}

const short = (sha: string): string => sha.slice(0, 8);

/** The branch `origin/HEAD` names, from the local ref, else asked of origin (a network read, bounded). */
function defaultBranch(folder: string, git: Run): { branch?: string; why?: string } {
  const sym = git(folder, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.ok && sym.out.trim().startsWith("origin/")) return { branch: sym.out.trim().slice("origin/".length) };
  const remote = git(folder, ["remote", "get-url", "origin"]);
  if (!remote.ok) return { why: "it has no `origin` remote, so nothing proves its work landed" };
  const ls = git(folder, ["ls-remote", "--symref", "origin", "HEAD"], 30_000);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(ls.out);
  if (m) return { branch: m[1] };
  return { why: `can't tell origin's default branch (no origin/HEAD here — \`git -C ${folder} remote set-head origin --auto\`; asking origin: ${ls.err || "no answer"})` };
}

/** Did a merged PR of `branch` end at exactly `head`? undefined = couldn't ask (said in `note`). */
function mergedPrAt(folder: string, branch: string, head: string, gh: Run): { pr?: { number: number; url: string }; note?: string } {
  const r = gh(folder, ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid,url", "--limit", "50"], 45_000);
  if (r.missing) return { note: "gh is not installed — only origin's default branch could prove it merged" };
  if (!r.ok) return { note: `gh couldn't list merged PRs of ${branch} (${r.err.split("\n")[0]})` };
  let prs: Array<{ number: number; headRefOid: string; url: string }>;
  try {
    prs = JSON.parse(r.out);
  } catch {
    return { note: `gh pr list answered something that isn't JSON: ${r.out.slice(0, 120)}` };
  }
  const hit = prs.find((p) => p.headRefOid === head);
  return hit ? { pr: { number: hit.number, url: hit.url } } : {};
}

/** Read every rule against `folder` (canonical). Never changes anything but origin's remote-tracking ref (the fetch). */
export function judgeWorktree(folder: string, d: JudgeDeps): WorktreeVerdict {
  const keep: string[] = [];
  const notes: string[] = [];
  const no = (why: string): WorktreeVerdict => ({ remove: false, keep: [why], notes, force: false });
  if (!existsSync(folder)) return no(`${folder} is already gone`);
  const top = d.git(folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  if (!top.ok) return no(`it is not a git checkout (${top.err.split("\n")[0]})`);
  const [toplevel, gitDir, commonDir] = top.out.trim().split("\n").map(real);
  if (toplevel !== folder) return no(`it is a subfolder of the checkout ${toplevel}, not a worktree root`);
  if (gitDir === commonDir) return no("it is the repo's main checkout, not a linked worktree");

  const list = d.git(folder, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return no(`git worktree list failed (${list.err.split("\n")[0]})`);
  const trees = parseWorktreeList(list.out);
  const main = trees[0];
  const me = trees.find((t) => real(t.path) === folder);
  if (!main || !me || !me.head) return no(`git worktree list does not list ${folder}`);
  const nm = join(folder, "node_modules");
  const nodeModules = existsSync(nm) || isLink(nm) ? (isLink(nm) ? { link: readlinkSync(nm) } : ("dir" as const)) : undefined;
  const facts: WorktreeFacts = { folder, mainCheckout: real(main.path), ...(me.branch ? { branch: me.branch } : {}), head: me.head, ...(nodeModules ? { nodeModules } : {}) };
  if (me.locked) keep.push(`git has it locked (\`git -C ${facts.mainCheckout} worktree unlock ${folder}\` if that is stale)`);

  const st = d.git(folder, ["status", "--porcelain", "-z"]);
  let force = false;
  if (!st.ok) keep.push(`git status failed (${st.err.split("\n")[0]})`);
  else {
    const { dirty, nodeModules: nmUntracked } = dirtyEntries(st.out);
    force = nmUntracked;
    if (dirty.length) keep.push(`${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}`);
  }

  // Merged: in origin/<default> (after a fetch), else the head of a merged PR of this branch.
  let merged: string | undefined;
  let prHead = false;
  const def = defaultBranch(folder, d.git);
  if (!def.branch) keep.push(def.why!);
  else {
    if (d.fetch) {
      const f = d.git(folder, ["fetch", "--quiet", "--no-tags", "origin", def.branch], 60_000);
      if (!f.ok) notes.push(`couldn't fetch origin/${def.branch} (${f.err.split("\n")[0]}) — judged against the local copy`);
    }
    const anc = d.git(folder, ["merge-base", "--is-ancestor", facts.head, `refs/remotes/origin/${def.branch}`]);
    if (anc.ok) merged = `HEAD ${short(facts.head)} is in origin/${def.branch}`;
    else if (anc.err && !/^exit 1$/.test(anc.err)) notes.push(`couldn't compare with origin/${def.branch} (${anc.err.split("\n")[0]})`);
    if (!merged && facts.branch) {
      const pr = mergedPrAt(folder, facts.branch, facts.head, d.gh);
      if (pr.note) notes.push(pr.note);
      if (pr.pr) {
        merged = `HEAD ${short(facts.head)} is the head of merged PR #${pr.pr.number} (${pr.pr.url})`;
        prHead = true;
      }
    }
    if (!merged) keep.push(`HEAD ${short(facts.head)} is not in origin/${def.branch}${facts.branch ? ` and no merged PR of ${facts.branch} ends at it` : " (detached — no branch to look up a PR by)"}`);
  }

  if (!prHead) {
    const n = d.git(folder, ["rev-list", "--count", facts.head, "--not", "--remotes"]);
    if (!n.ok) keep.push(`couldn't count unpushed commits (${n.err.split("\n")[0]})`);
    else if (Number(n.out.trim()) > 0) keep.push(`${n.out.trim()} commit(s) are on no remote (unpushed)`);
  }

  if (d.cwdHolders) {
    try {
      const holders = d.cwdHolders(folder);
      if (holders.length) keep.push(`${holders.length} live process(es) have their cwd in it: ${holders.slice(0, 5).map((h) => `${h.pid} ${h.command}`).join(", ")}${holders.length > 5 ? ", …" : ""}`);
    } catch (e) {
      keep.push(`couldn't check for processes in it: ${(e as Error).message}`);
    }
  }
  const users = d.agentsUsing(folder);
  if (users.length) keep.push(`registered agent(s) use it: ${users.join(", ")}`);
  return { remove: keep.length === 0, keep, notes, facts, force, ...(merged ? { proof: merged } : {}) };
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `git worktree remove` + prune, from the main checkout. Returns the failure, or undefined when it went. */
export function removeWorktree(facts: WorktreeFacts, force: boolean, git: Run = realGit): string | undefined {
  const rm = git(facts.mainCheckout, ["worktree", "remove", ...(force ? ["--force"] : []), facts.folder], 120_000);
  if (!rm.ok) return `git worktree remove failed: ${rm.err.split("\n")[0]}`;
  const prune = git(facts.mainCheckout, ["worktree", "prune"]);
  if (!prune.ok) return `removed, but git worktree prune failed: ${prune.err.split("\n")[0]}`;
  return undefined;
}

/** The exact command that puts the folder back, for a refusal to print. */
export function recreateCommand(f: WorktreeFacts): string {
  return f.branch ? `git -C ${f.mainCheckout} worktree add ${f.folder} ${f.branch}` : `git -C ${f.mainCheckout} worktree add --detach ${f.folder} ${f.head}`;
}

/** `paw unarchive`: put a removed worktree back at its path, on its branch (or detached at its head), and re-link a
 *  symlinked node_modules whose target still exists. Throws with the exact command when it can't. Returns notes. */
export function recreateWorktree(f: WorktreeFacts, git: Run = realGit): string[] {
  const how = recreateCommand(f);
  if (!existsSync(f.mainCheckout)) throw new Error(`paw: its repo's main checkout ${f.mainCheckout} is gone — nothing to add the worktree back from (${how})`);
  if (f.branch) {
    const b = git(f.mainCheckout, ["rev-parse", "--verify", "--quiet", `refs/heads/${f.branch}`]);
    if (!b.ok) {
      const c = git(f.mainCheckout, ["cat-file", "-e", `${f.head}^{commit}`]);
      throw new Error(
        `paw: its branch ${f.branch} no longer exists in ${f.mainCheckout}` +
          (c.ok ? ` — recreate it at its archived head, then rerun: git -C ${f.mainCheckout} branch ${f.branch} ${f.head}` : ` and its head ${f.head} is gone too — nothing to restore the folder from`),
      );
    }
  }
  const add = git(f.mainCheckout, ["worktree", "add", ...(f.branch ? [f.folder, f.branch] : ["--detach", f.folder, f.head])], 120_000);
  if (!add.ok) throw new Error(`paw: couldn't put the worktree back (${add.err.split("\n")[0]}) — fix that, then: ${how}`);
  const notes: string[] = [`worktree back at ${f.folder} (${f.branch ? `branch ${f.branch}` : `detached at ${short(f.head)}`})`];
  if (f.nodeModules && f.nodeModules !== "dir") {
    const target = f.nodeModules.link;
    const abs = target.startsWith("/") ? target : join(f.folder, target);
    if (existsSync(abs)) {
      symlinkSync(target, join(f.folder, "node_modules"));
      notes.push(`node_modules re-linked → ${target}`);
    } else notes.push(`node_modules was a link to ${target}, which is gone — install or link it again`);
  } else if (f.nodeModules === "dir") notes.push("node_modules was a real folder (untracked) — install again");
  return notes;
}

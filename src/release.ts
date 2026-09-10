/**
 * OTP-style RELEASE DISCIPLINE: paw's daemons run from an IMMUTABLE, versioned snapshot of the
 * checkout — never from the operator's live, mutable working copy.
 *
 * THE INCIDENT (2026-08-20). Every daemon (mesh `up`, manager `supervise`, the mailbox beacon,
 * `paw web`) is spawned via tsx with its entry file and its `node_modules/tsx/dist/cli.mjs` resolved
 * from REPO_ROOT — `/Users/aleks/Github/paw`, the checkout the operator also EDITS. That night a
 * `pnpm add @cotal-ai/*@0.25.0` ran in that checkout while a 0.15 manager was live; the next
 * `ensure()` started a SECOND manager off the half-installed tree, and two managers on incompatible
 * protocol versions took the fleet down. The general shape is worse than that one install: any
 * `git checkout`, `pnpm install` or half-saved edit in the repo is an UNREVIEWED live change to
 * whatever daemon happens to start next. Nobody deployed anything; the running system changed
 * underneath itself.
 *
 * THE FIX, and it is the OTP one: you do not mutate a running system in place. You stand a new
 * VERSION up beside the old one and cut over deliberately.
 *
 *   paw release       snapshot the checkout into $PAW_HOME/releases/<id>/ and flip `current`
 *   paw restart       bounce the daemons — they come up from the release `current` points at
 *
 * `<id>` is a CONTENT hash (see {@link releaseId}), so the same tree is the same release: taking a
 * snapshot twice is free and idempotent, and a changed dependency (which changes pnpm-lock.yaml) is
 * a different release by construction. A release directory is written ONCE, under a staging name,
 * and renamed into place; nothing ever writes into one afterwards. That — plus a copy that is a real
 * copy (APFS clone), never a symlink or hardlink back into the checkout — is what makes it immutable
 * in effect. **A symlink to the checkout's node_modules would BE the bug**, so it is forbidden here.
 *
 * WHERE THE BOUNDARY IS. The discipline covers DAEMONS — anything paw spawns that outlives the
 * command that spawned it (mesh, manager, mailbox, web, the detached restart/adopt children, and the
 * `paw cotal` passthrough, which must speak the same cotal version as the manager it talks to). The
 * short-lived foreground CLI keeps running straight from the checkout: it exits in a second, it can't
 * drift out from under anything, and keeping it there keeps the dev loop fast. `PAW_RELEASE=dev` puts
 * the daemons back on the checkout too — loudly, because that is the pre-incident behaviour.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** paw's checkout root, anchored at THIS file — not process.argv[1], which may be a launcher shim
 *  outside the repo. When the CLI itself runs from a release dir, this IS that release dir. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What a release must contain to run every daemon: both composition roots (bin/), the code they
 *  import (src/), the web client the `paw web` daemon serves from disk (web/), and the dependency
 *  manifest pair. node_modules is copied separately (see {@link cloneNodeModules}) — it's 100MB+ and
 *  wants the CoW clone, not a byte copy. */
const PAYLOAD = ["bin", "src", "web", "package.json", "pnpm-lock.yaml"] as const;

/** paw's state root (mirrors addressing.ts's spaceDir + github.ts's reposRoot). */
function pawHome(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

/** Where releases live: `$PAW_HOME/releases`. Machine-wide, NOT per-space — a release is a build of
 *  paw, and one machine's spaces all run the same paw. */
export function releasesDir(): string {
  return join(pawHome(), "releases");
}

/** The `current` pointer: a symlink to a release id, flipped ATOMICALLY (see {@link activateRelease}). */
export function currentPointerPath(): string {
  return join(releasesDir(), "current");
}

export function releasePath(id: string): string {
  return join(releasesDir(), id);
}

/** Every file under `dir` (relative paths), sorted, skipping node_modules and dot-dirs — the same
 *  walk on the same tree must always yield the same list, or the id isn't deterministic. */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * The release id: 12 hex of a sha256 over `<relpath>\0<sha256 of contents>` for every payload file,
 * in sorted path order.
 *
 * CONTENT-addressed on purpose: the id answers "which paw is this?", so an identical tree must give
 * an identical id (re-running `paw release` is then a no-op instead of a second copy of the same
 * bytes), and ANY change — a source edit, a bumped dependency in package.json, a changed pnpm-lock —
 * must give a different one. Deliberately NOT `git describe`: the incident's tree was DIRTY and a
 * describe would have called it the same release as the clean one it no longer was.
 *
 * node_modules is not hashed (100MB+, and hashing it would cost more than the snapshot): the
 * lockfile is the honest statement of what should be installed. The gap that leaves — a half-finished
 * `pnpm install` against an already-updated lock — is real, and the answer is that `paw release` is a
 * deliberate act you run after an install finishes, not something ensure() does behind your back.
 */
export function releaseId(root = REPO_ROOT): string {
  const h = createHash("sha256");
  for (const item of PAYLOAD) {
    const p = join(root, item);
    if (!existsSync(p)) throw new Error(`paw: can't compute a release id — ${item} is missing from ${root}`);
    const files = statSync(p).isDirectory() ? walk(p).map((r) => [join(item, r), join(p, r)] as const) : [[item, p] as const];
    for (const [rel, abs] of files) {
      h.update(rel);
      h.update("\0");
      h.update(createHash("sha256").update(readFileSync(abs)).digest("hex"));
      h.update("\n");
    }
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Copy `<src>/node_modules` into `<dst>` as an INDEPENDENT tree.
 *
 * `cp -Rc` asks APFS for a clone: copy-on-write, so 100MB costs milliseconds and no disk, and a later
 * write in the checkout leaves the release's copy untouched (that independence is the whole point).
 * `-c` degrades to a real byte copy on a filesystem without clones, which is slower but equally
 * correct. What we must NEVER do is `-l` (hardlink) or a symlink: both alias the checkout's bytes, so
 * an install there would rewrite the "immutable" release — i.e. exactly tonight's bug with extra steps.
 */
function cloneNodeModules(src: string, dst: string): void {
  const from = join(src, "node_modules");
  if (!existsSync(from)) {
    throw new Error(
      `paw: can't snapshot a release — ${from} doesn't exist. The daemons run node+tsx out of the ` +
        `release, so its dependencies must be installed first (\`pnpm install\`).`,
    );
  }
  const r = spawnSync("cp", ["-Rc", from, join(dst, "node_modules")], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    // Not fatal on its own: a filesystem with no clone support is a plain copy away from correct.
    const plain = spawnSync("cp", ["-R", from, join(dst, "node_modules")], { encoding: "utf8" });
    if (plain.error || plain.status !== 0) {
      throw new Error(`paw: failed to copy node_modules into the release (${plain.stderr?.trim() || plain.error?.message || plain.status})`);
    }
  }
}

export interface Release {
  id: string;
  path: string;
  createdAt: number;
}

/** Every release on disk, newest first. Staging dirs (dot-prefixed) and the `current` symlink are
 *  not releases and never appear. */
export function listReleases(): Release[] {
  const dir = releasesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ id: e.name, path: join(dir, e.name), createdAt: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Snapshot `root` into `$PAW_HOME/releases/<id>/` and return it. Idempotent: an existing release with
 * the same id is REUSED, because the id says the bytes are already there (`force` re-copies anyway,
 * for the one case the id can't see — see {@link releaseId} on node_modules).
 *
 * Built under a staging name and renamed into place, so a reader can never observe a half-copied
 * release: the directory does not exist under its id until it is complete.
 */
export function createRelease(opts: { root?: string; force?: boolean } = {}): Release {
  const root = opts.root ?? REPO_ROOT;
  const id = releaseId(root);
  const dest = releasePath(id);
  if (existsSync(dest) && !opts.force) return { id, path: dest, createdAt: statSync(dest).mtimeMs };

  mkdirSync(releasesDir(), { recursive: true });
  const staging = join(releasesDir(), `.staging-${id}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const item of PAYLOAD) cpSync(join(root, item), join(staging, item), { recursive: true });
    cloneNodeModules(root, staging);
    rmSync(dest, { recursive: true, force: true }); // only reached under --force, or a torn prior run
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { id, path: dest, createdAt: statSync(dest).mtimeMs };
}

/**
 * Point `current` at `id`, ATOMICALLY.
 *
 * The flip is a symlink created under a temp name and rename(2)'d over the pointer: rename is atomic
 * within a directory, so a concurrent `ensure()` reading the pointer sees either the old release or
 * the new one and never a missing or half-written pointer. (Writing the symlink in place would mean
 * unlink-then-create — a window in which paw has NO current release, which under fail-loud is a
 * command that dies for no reason.)
 */
export function activateRelease(id: string): Release {
  const dest = releasePath(id);
  if (!existsSync(dest)) throw new Error(`paw: no release "${id}" in ${releasesDir()} — run \`paw release\` to snapshot the checkout.`);
  const tmp = join(releasesDir(), `.current-${process.pid}-${Date.now()}`);
  rmSync(tmp, { force: true });
  symlinkSync(id, tmp); // RELATIVE target: a releases dir stays valid if $PAW_HOME moves
  renameSync(tmp, currentPointerPath());
  return { id, path: dest, createdAt: statSync(dest).mtimeMs };
}

/** The release `current` points at, or undefined when nothing is pinned yet. A pointer at a release
 *  that no longer exists is undefined too — a dangling pointer is not a release. */
export function currentRelease(): Release | undefined {
  const p = currentPointerPath();
  let target: string;
  try {
    target = readlinkSync(p);
  } catch {
    return undefined; // no pointer yet
  }
  // Read the LINK, don't realpath it: realpath rewrites the whole path through every symlink above
  // it (on macOS a $PAW_HOME under /var comes back as /private/var), so the release path would stop
  // matching the one `paw release` printed and every path comparison would quietly disagree.
  const id = basenameOf(target);
  const path = releasePath(id);
  if (!existsSync(path)) return undefined; // a pointer at a pruned/absent release is not a release
  return { id, path, createdAt: statSync(path).mtimeMs };
}

function basenameOf(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

let devWarned = false;

/**
 * The root every DAEMON spawn resolves its entry file and its tsx out of.
 *
 * Precedence: `PAW_RELEASE=dev` (the checkout, announced loudly — it is the pre-incident behaviour
 * and must never be silent) > `PAW_RELEASE=<id>` (pin one release, e.g. to roll back) > the `current`
 * pointer. With none of those it FAILS LOUD naming the one-line fix, rather than quietly falling back
 * to REPO_ROOT: a silent fallback to the checkout is the exact behaviour this module exists to end.
 */
export function daemonRoot(): string {
  const pin = process.env.PAW_RELEASE?.trim();
  if (pin === "dev") {
    if (!devWarned) {
      devWarned = true;
      console.error(
        `paw: PAW_RELEASE=dev — daemons will run from the live checkout (${REPO_ROOT}). ` +
          `Edits and installs there change what the next daemon starts.`,
      );
    }
    return REPO_ROOT;
  }
  if (pin) {
    const path = releasePath(pin);
    if (!existsSync(path)) throw new Error(`paw: PAW_RELEASE=${pin} but ${path} doesn't exist — \`paw release --list\` shows what's on disk.`);
    return path;
  }
  const cur = currentRelease();
  if (!cur) {
    throw new Error(
      `paw: no release is pinned, so there's nothing to run the daemons from — run \`paw release\` ` +
        `to snapshot this checkout (or PAW_RELEASE=dev to run them straight from it).`,
    );
  }
  return cur.path;
}

/**
 * Drop all but the newest `keep` releases. The CURRENT one is never pruned however old it is — it is
 * what the live daemons are running, and deleting it out from under them would turn a tidy-up into
 * tonight's outage from the other direction. Returns the ids removed.
 */
export function pruneReleases(keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`paw: --prune takes a positive integer (got ${keep})`);
  const cur = currentRelease()?.id;
  const all = listReleases();
  const doomed = all.slice(keep).filter((r) => r.id !== cur);
  for (const r of doomed) rmSync(r.path, { recursive: true, force: true });
  return doomed.map((r) => r.id);
}

/** Best-effort removal of a torn staging dir left by a crashed snapshot. Never throws. */
export function cleanStaging(): void {
  const dir = releasesDir();
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(".staging-")) rmSync(join(dir, e.name), { recursive: true, force: true });
  }
}

/** Remove the `current` pointer (tests + a deliberate un-pin). Leaves the releases themselves. */
export function clearCurrent(): void {
  try {
    unlinkSync(currentPointerPath());
  } catch {
    /* already gone */
  }
}

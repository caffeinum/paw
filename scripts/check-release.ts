/**
 * Hermetic checks for paw's release discipline (src/release.ts + src/commands/release.ts).
 *
 * The properties that make it worth having, each asserted against the failure it prevents:
 *   - determinism    — the same tree is the same release (else every ensure() re-copies 100MB)
 *   - sensitivity    — a changed dependency or source file is a DIFFERENT release (the incident)
 *   - immutability   — editing/installing in the checkout after a snapshot changes NEITHER the
 *                      release's bytes NOR the argv a daemon spawn resolves (the whole point)
 *   - atomicity      — a `current` flip is never observed half-done, from another PROCESS
 *   - prune safety   — the running release is never deleted out from under the daemons
 *   - ownership      — `paw down`/`restart` still FIND daemons launched from a release dir, i.e.
 *                      managerMatchPattern/mailboxMatchPattern still match the new argv shape
 *
 * No mesh, no manager, no daemons: a tiny fake checkout under a temp PAW_HOME. Run: pnpm check:release
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-release-home-"));
process.env.PAW_HOME = home;
process.env.PAW_SPACE = "reltest";
delete process.env.PAW_RELEASE;

const {
  REPO_ROOT,
  activateRelease,
  clearCurrent,
  createRelease,
  currentPointerPath,
  currentRelease,
  daemonRoot,
  listReleases,
  pruneReleases,
  releaseId,
  releasePath,
  releasesDir,
} = await import("../src/release.js");
const { cotaldViaTsx, pawViaTsx, managerMatchPattern, mailboxMatchPattern } = await import("../src/lifecycle.js");
const { parseReleaseArgs } = await import("../src/commands/release.js");

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

/** A minimal fake checkout: the payload paw snapshots, plus a stand-in node_modules carrying the
 *  tsx cli.mjs the daemon argv resolves (so viaTsx takes its real first branch). */
function fixtureCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "paw-release-checkout-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "web", "app"), { recursive: true });
  mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(join(root, "bin", "paw.ts"), "// paw entry\n");
  writeFileSync(join(root, "bin", "cotald.ts"), "// cotald entry\n");
  writeFileSync(join(root, "src", "lifecycle.ts"), "export const v = 1;\n");
  writeFileSync(join(root, "web", "app", "index.html"), "<p>v1</p>\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "paw", dependencies: { "@cotal-ai/core": "^0.15.0" } }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "node_modules", "tsx", "dist", "cli.mjs"), "// tsx\n");
  return root;
}

const checkout = fixtureCheckout();

// ---- id: deterministic, and sensitive to exactly what should change it ------------------------
{
  const a = releaseId(checkout);
  const b = releaseId(checkout);
  assert(a === b, `id: the same tree hashes the same twice (${a})`);
  assert(/^[0-9a-f]{12}$/.test(a), "id: 12 hex chars");

  // A copy of the same bytes at a different PATH is the same release — content-addressed, not
  // location-addressed (so a worktree and the checkout it came from agree).
  const twin = mkdtempSync(join(tmpdir(), "paw-release-twin-"));
  spawnSync("cp", ["-R", `${checkout}/.`, twin]);
  assert(releaseId(twin) === a, "id: an identical tree at another path hashes the same");
  rmSync(twin, { recursive: true, force: true });

  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 2;\n");
  const edited = releaseId(checkout);
  assert(edited !== a, "id: a source edit changes the id");
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 1;\n");
  assert(releaseId(checkout) === a, "id: reverting the edit restores the id");

  // THE incident: a dependency bump. The lockfile is in the payload precisely so this can't be
  // mistaken for the same paw.
  const lock = readFileSync(join(checkout, "pnpm-lock.yaml"), "utf8");
  writeFileSync(join(checkout, "pnpm-lock.yaml"), `${lock}# @cotal-ai/core 0.25.0\n`);
  assert(releaseId(checkout) !== a, "id: a changed pnpm-lock.yaml is a DIFFERENT release");
  writeFileSync(join(checkout, "pnpm-lock.yaml"), lock);

  const missing = mkdtempSync(join(tmpdir(), "paw-release-empty-"));
  assert(throws(() => releaseId(missing)), "id: a tree missing a payload dir fails loud (no partial hash)");
  rmSync(missing, { recursive: true, force: true });
}

// ---- snapshot: complete, reusable, and independent of the checkout ----------------------------
const first = createRelease({ root: checkout });
{
  assert(first.path === releasePath(first.id), "snapshot: lands at releases/<id>");
  for (const f of ["bin/paw.ts", "bin/cotald.ts", "src/lifecycle.ts", "web/app/index.html", "package.json", "pnpm-lock.yaml", "node_modules/tsx/dist/cli.mjs"])
    assert(existsSync(join(first.path, f)), `snapshot: contains ${f}`);
  assert(releaseId(first.path) === first.id, "snapshot: the release re-hashes to its own id (nothing lost in the copy)");
  assert(!lstatSync(join(first.path, "node_modules")).isSymbolicLink(), "snapshot: node_modules is a real directory, NEVER a symlink to the checkout");
  assert(
    statSync(join(first.path, "node_modules", "tsx", "dist", "cli.mjs")).ino !== statSync(join(checkout, "node_modules", "tsx", "dist", "cli.mjs")).ino,
    "snapshot: node_modules files are clones, not hardlinks back into the checkout",
  );
  const again = createRelease({ root: checkout });
  assert(again.id === first.id, "snapshot: re-running is idempotent (same id, no second copy)");
  assert(listReleases().length === 1, "snapshot: still exactly one release on disk");
  assert(listReleases()[0].id === first.id, "snapshot: listReleases sees it");
}

// ---- immutability: the checkout moves on, the release does not --------------------------------
{
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 999; // half-saved edit\n");
  writeFileSync(join(checkout, "node_modules", "tsx", "dist", "cli.mjs"), "// tsx from a half-finished install\n");
  assert(readFileSync(join(first.path, "src", "lifecycle.ts"), "utf8").includes("v = 1"), "immutability: a source edit after the snapshot doesn't reach the release");
  assert(
    readFileSync(join(first.path, "node_modules", "tsx", "dist", "cli.mjs"), "utf8") === "// tsx\n",
    "immutability: reinstalling node_modules in the checkout doesn't reach the release (THE incident)",
  );
  assert(releaseId(first.path) === first.id, "immutability: the release still hashes to its id");
  // Put the checkout back so later id assertions read the tree we started with.
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 1;\n");
  writeFileSync(join(checkout, "node_modules", "tsx", "dist", "cli.mjs"), "// tsx\n");
}

// ---- daemonRoot: pinned, dev-escape-hatched, fail-loud ----------------------------------------
{
  clearCurrent();
  assert(currentRelease() === undefined, "pointer: unset before the first activate");
  assert(throws(() => daemonRoot()), "daemonRoot: FAILS LOUD with no release pinned (never falls back to the checkout)");

  process.env.PAW_RELEASE = "dev";
  assert(daemonRoot() === REPO_ROOT, "daemonRoot: PAW_RELEASE=dev runs from the checkout");
  process.env.PAW_RELEASE = "nosuchrelease";
  assert(throws(() => daemonRoot()), "daemonRoot: PAW_RELEASE naming a missing release fails loud");
  process.env.PAW_RELEASE = first.id;
  assert(daemonRoot() === first.path, "daemonRoot: PAW_RELEASE=<id> pins that release");
  delete process.env.PAW_RELEASE;

  activateRelease(first.id);
  assert(currentRelease()?.id === first.id, "pointer: activate makes it current");
  assert(daemonRoot() === first.path, "daemonRoot: follows the current pointer");
  assert(readlinkSync(currentPointerPath()) === first.id, "pointer: the symlink target is RELATIVE (the id), so the releases dir stays movable");
  assert(throws(() => activateRelease("deadbeef0000")), "pointer: activating a release that isn't on disk fails loud");
}

// ---- the daemon argv resolves through the release, and keeps doing so ------------------------
{
  const [, cotaldArgs] = cotaldViaTsx(["supervise", "--space", "reltest", "--server", "nats://127.0.0.1:4222"]);
  const [, pawArgs] = pawViaTsx(["mailbox", "--space", "reltest"]);
  assert(cotaldArgs.some((a) => a === join(first.path, "bin", "cotald.ts")), "argv: cotald entry comes from the RELEASE dir");
  assert(cotaldArgs[0] === join(first.path, "node_modules", "tsx", "dist", "cli.mjs"), "argv: tsx comes from the release's OWN node_modules (one self-consistent tree)");
  assert(!cotaldArgs.some((a) => a.startsWith(checkout)), "argv: nothing resolves out of the checkout");
  assert(pawArgs.some((a) => a === join(first.path, "bin", "paw.ts")), "argv: the mailbox beacon entry comes from the release dir");

  // The property the incident is about: mutate the checkout, re-resolve, get the same argv.
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 3;\n");
  const [, after] = cotaldViaTsx(["supervise", "--space", "reltest", "--server", "nats://127.0.0.1:4222"]);
  assert(JSON.stringify(after) === JSON.stringify(cotaldArgs), "argv: editing the checkout does NOT change what the next daemon would start");
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 1;\n");

  // ---- ownership: pgrep must still find daemons launched from a release dir ------------------
  // paw finds its own daemons by COMMAND SIGNATURE, not pid (see lifecycle.ts). Release dirs change
  // the PREFIX of the entry path, so the patterns must not be anchored to it — if they were,
  // `paw down` would silently stop finding the manager it started.
  const mgrLine = ["/usr/bin/node", ...cotaldArgs].join(" ");
  const mboxLine = ["/usr/bin/node", ...pawArgs].join(" ");
  assert(new RegExp(managerMatchPattern("reltest")).test(mgrLine), "pgrep: managerMatchPattern matches a manager spawned from a release dir");
  assert(new RegExp(mailboxMatchPattern("reltest")).test(mboxLine), "pgrep: mailboxMatchPattern matches a beacon spawned from a release dir");
  assert(!new RegExp(managerMatchPattern("reltest-1")).test(mgrLine), "pgrep: still space-EXACT from a release dir (reltest-1 ≠ reltest)");
  assert(!new RegExp(mailboxMatchPattern("reltes")).test(mboxLine), "pgrep: mailbox pattern still space-EXACT from a release dir");
  // A release id is hex, so it can never introduce a regex metachar into the matched line — but the
  // PAW_HOME path around it could, and the patterns quote no path at all, which is why they survive.
  assert(!managerMatchPattern("reltest").includes(home), "pgrep: the pattern names no filesystem path (release-location independent)");
}

// ---- pointer atomicity, observed from ANOTHER process ----------------------------------------
{
  // A same-process loop can't see the gap (rename is sync), so the reader is a real child spawned
  // on plain fs: it hammers readlink while the parent flips. Under unlink-then-symlink it would
  // catch an ENOENT; under rename(2) it must never see one.
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 2;\n");
  const second = createRelease({ root: checkout });
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 1;\n");
  assert(second.id !== first.id, "flip: the edited checkout snapshots as a second, different release");

  const reader = `
    const { readlinkSync } = require("node:fs");
    const p = ${JSON.stringify(currentPointerPath())};
    const ok = new Set(${JSON.stringify([first.id, second.id])});
    let missing = 0, bogus = 0, reads = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      try { const v = readlinkSync(p); reads++; if (!ok.has(v)) bogus++; }
      catch { missing++; }
    }
    process.stdout.write(JSON.stringify({ reads, missing, bogus }));
  `;
  // spawn (not spawnSync) — the whole point is that the reader runs WHILE the parent flips.
  const child = spawn(process.execPath, ["-e", reader], { stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (b) => (stdout += String(b)));
  const deadline = Date.now() + 1200;
  let flips = 0;
  while (Date.now() < deadline) {
    activateRelease(flips % 2 === 0 ? second.id : first.id);
    flips++;
  }
  await new Promise<void>((r) => child.on("close", () => r()));
  const out = JSON.parse(stdout || '{"reads":0,"missing":1,"bogus":1}') as { reads: number; missing: number; bogus: number };
  assert(out.reads > 100, `flip: the child actually observed the pointer (${out.reads} reads, ${flips} flips)`);
  assert(out.missing === 0, "flip: another process NEVER saw the pointer missing mid-flip");
  assert(out.bogus === 0, "flip: another process NEVER saw a value that wasn't a real release id");

  activateRelease(second.id);
  assert(currentRelease()?.id === second.id, "flip: the last activate wins");

  // ---- prune: keeps the newest N, and NEVER the running release --------------------------------
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 4;\n");
  const third = createRelease({ root: checkout });
  writeFileSync(join(checkout, "src", "lifecycle.ts"), "export const v = 1;\n");
  assert(listReleases().length === 3, "prune: three releases on disk before pruning");

  activateRelease(first.id); // pin the OLDEST, then keep only the newest 1
  const dropped = pruneReleases(1);
  assert(existsSync(releasePath(first.id)), "prune: the CURRENT release survives even as the oldest (daemons are running it)");
  assert(existsSync(releasePath(third.id)), "prune: the newest release survives");
  assert(!existsSync(releasePath(second.id)), "prune: an old, unpinned release is removed");
  assert(dropped.join() === second.id, "prune: reports exactly what it removed");
  assert(throws(() => pruneReleases(0)), "prune: --prune 0 fails loud (it would mean 'delete everything')");
  assert(daemonRoot() === releasePath(first.id), "prune: the pointer still resolves afterwards");
}

// ---- the command's arg parse -----------------------------------------------------------------
{
  assert(parseReleaseArgs([]).activate === true, "args: bare `paw release` snapshots AND activates");
  assert(parseReleaseArgs(["--no-activate"]).activate === false, "args: --no-activate stages without cutting over");
  assert(parseReleaseArgs(["--list"]).list === true, "args: --list");
  assert(parseReleaseArgs(["--prune"]).prune === 3, "args: --prune defaults to keeping 3");
  assert(parseReleaseArgs(["--prune", "5"]).prune === 5, "args: --prune N");
  assert(parseReleaseArgs(["--prune", "--force"]).force === true, "args: --prune doesn't swallow the next FLAG");
  assert(parseReleaseArgs(["--space", "paw"]).activate === true, "args: the injected --space is ignored (a release is machine-wide)");
  assert(throws(() => parseReleaseArgs(["--prune", "0"])), "args: --prune 0 fails loud");
  assert(throws(() => parseReleaseArgs(["--nope"])), "args: an unknown flag fails loud");
}

rmSync(checkout, { recursive: true, force: true });
rmSync(releasesDir(), { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} release check(s) failed`);
  process.exit(1);
}
console.log("\nall release checks passed 🐾");

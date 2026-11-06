/**
 * Hermetic checks for the smart restart (src/manager-fingerprint.ts + the prune guard in src/release.ts):
 *   - the manager fingerprint covers what the manager loads and is launched with, and NOT the rest —
 *     a CLI/chat/web/mailbox edit keeps it, a connector/hub/launch/dependency edit changes it
 *   - planRestart keeps the manager only when every fact says its code would be identical
 *   - prune never deletes a release a live process still runs (a kept manager is an OLD release)
 *
 * No mesh, no daemons: a copy of this checkout's tree under a temp dir. Run: pnpm check:smart-restart
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "paw-smart-restart-home-"));
process.env.PAW_HOME = home;
process.env.PAW_SPACE = "smarttest";
delete process.env.PAW_RELEASE;

const { computeManagerFingerprint, planRestart, releaseManagerFingerprint, writeManagerFingerprint, MANAGER_FINGERPRINT_FILE } = await import("../src/manager-fingerprint.ts");
const { pruneReleases, releaseIdOfRoot, releasePath, releasesDir, releasesInUse, activateRelease } = await import("../src/release.ts");
const { parseArgs } = await import("../src/commands/runtime.ts");

let failures = 0;
function ok(cond: boolean, msg: string, detail?: unknown): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function throws(fn: () => unknown, re?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re ? re.test((e as Error).message) : true;
  }
}

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** A copy of the checkout's code + manifests, with a stand-in installed lockfile. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "paw-smart-restart-tree-"));
  for (const item of ["bin", "src", "package.json", "pnpm-lock.yaml"]) cpSync(join(REPO, item), join(root, item), { recursive: true });
  mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

// ---- what the fingerprint covers ---------------------------------------------------------------
console.log("fingerprint inputs");
const base = fixture();
const fp0 = computeManagerFingerprint(base);
ok(computeManagerFingerprint(base).fingerprint === fp0.fingerprint, "deterministic: the same tree gives the same fingerprint");
for (const f of [
  "bin/cotald.ts",
  "src/connector.ts",
  "src/kit.ts",
  "src/hermes.ts",
  "src/acp.ts",
  "src/sandbox.ts",
  "bin/paw-sandbox-run.mjs",
  "bin/paw-sandbox-forward.mjs",
  "bin/paw-sandbox-kill.mjs",
  "src/sandbox/Containerfile",
  "src/hub/daemon.mjs",
  "src/hub/headless.mjs",
  "src/hub/cotal-shim.c",
  "src/manager-features.json",
  "src/gui-session.ts",
])
  ok(fp0.files.includes(f), `covers ${f}`);
for (const f of ["src/chat.ts", "src/web.ts", "src/mailbox.ts", "src/status.ts", "src/commands/release.ts", "src/lifecycle.ts", "bin/paw.ts"])
  ok(!fp0.files.includes(f), `does not cover the whole of ${f}`);
for (const d of ["src/lifecycle.ts#startManagerDaemon", "src/lifecycle.ts#daemonEnv", "src/lifecycle.ts#nodeBin", "src/lifecycle.ts#defaultTmuxEnv", "src/release.ts#daemonRoot", "src/cotal-root.ts#pawCotalRoot"])
  ok(fp0.launch.includes(d), `covers the launch declaration ${d}`);
for (const d of ["src/lifecycle.ts#restartMailbox", "src/lifecycle.ts#ensureMailbox", "src/release.ts#pruneReleases", "src/release.ts#createRelease"])
  ok(!fp0.launch.includes(d), `does not cover ${d}`);

/** Apply `edit` to a fresh copy and say whether the fingerprint moved. */
function moves(edit: (root: string) => void): boolean {
  const root = fixture();
  try {
    edit(root);
    return computeManagerFingerprint(root).fingerprint !== fp0.fingerprint;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const append = (rel: string, text = "\n// edit\n") => (root: string) => appendFileSync(join(root, rel), text);
const replaceIn = (rel: string, from: string, to: string) => (root: string) => {
  const p = join(root, rel);
  const s = readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`fixture: "${from}" not in ${rel}`);
  writeFileSync(p, s.replace(from, to));
};

console.log("fingerprint sensitivity");
ok(!moves(append("src/chat.ts")), "a chat (CLI-only) edit keeps it");
ok(!moves(append("src/web.ts")), "a paw web edit keeps it");
ok(!moves(append("src/mailbox.ts")), "a mailbox edit keeps it (the mailbox is restarted anyway)");
ok(!moves(replaceIn("src/lifecycle.ts", "export async function restartMailbox(", "export async function restartMailbox(/* edit */")), "a lifecycle edit outside the manager launch keeps it");
ok(!moves(replaceIn("src/release.ts", "export function pruneReleases(", "export function pruneReleases(/* edit */")), "a release-tooling edit (prune) keeps it");
ok(!moves(replaceIn("package.json", '"scripts": {', '"scripts": {\n    "check:x": "true",')), "a package.json script edit keeps it");
ok(moves(append("src/connector.ts")), "a connector edit changes it");
ok(moves(append("bin/cotald.ts")), "a cotald.ts edit changes it");
ok(moves(append("src/brief.ts")), "an edit to a module the connector imports (brief) changes it");
ok(moves(append("src/hub/daemon.mjs")), "a hub daemon edit changes it");
ok(moves(append("src/hub/cotal-shim.c", "\n/* edit */\n")), "a hub shim edit changes it");
ok(moves(append("src/sandbox/Containerfile", "\n# edit\n")), "a sandbox Containerfile edit changes it");
ok(moves(append("bin/paw-sandbox-forward.mjs")), "a sandbox forwarder edit changes it");
ok(moves(replaceIn("src/manager-features.json", "kit-args", "kit-args2")), "a manager-features edit changes it");
ok(moves(replaceIn("src/lifecycle.ts", "function startManagerDaemon(", "function startManagerDaemon(/* edit */")), "a startManagerDaemon edit changes it");
ok(moves(replaceIn("src/lifecycle.ts", "export function daemonEnv(", "export function daemonEnv(/* edit */")), "an edit to the env the manager is launched with changes it");
ok(moves(replaceIn("src/release.ts", "export function daemonRoot(", "export function daemonRoot(/* edit */")), "an edit to how the manager's tree is resolved changes it");
ok(moves(append("pnpm-lock.yaml", "\n# edit\n")), "a lockfile change changes it");
ok(moves(append("node_modules/.pnpm/lock.yaml", "\n# edit\n")), "a change in what's INSTALLED changes it");
ok(moves(replaceIn("package.json", '"@cotal-ai/core": "', '"@cotal-ai/core": "x')), "a dependency edit in package.json changes it");
ok(
  throws(() => {
    const root = fixture();
    appendFileSync(join(root, "src/connector.ts"), "\nconst m = 'x'; void import(m);\n");
    computeManagerFingerprint(root);
  }, /non-literal import/),
  "a non-literal import() in the manager graph fails loud (its target can't be known)",
);
ok(
  throws(() => {
    const root = fixture();
    rmSync(join(root, "node_modules", ".pnpm", "lock.yaml"));
    computeManagerFingerprint(root);
  }, /lock\.yaml is missing/),
  "no installed lockfile fails loud",
);

console.log("stored fingerprint");
const stamped = fixture();
writeManagerFingerprint(stamped);
const stored = JSON.parse(readFileSync(join(stamped, MANAGER_FINGERPRINT_FILE), "utf8"));
ok(stored.fingerprint === fp0.fingerprint && Array.isArray(stored.files), "written into the release with its inputs");
ok(releaseManagerFingerprint(stamped).stored === true && releaseManagerFingerprint(stamped).fingerprint === fp0.fingerprint, "read back as stored");
ok(releaseManagerFingerprint(base).stored === false && releaseManagerFingerprint(base).fingerprint === fp0.fingerprint, "a release without one is computed from its tree");

// ---- the decision ------------------------------------------------------------------------------
console.log("planRestart");
const rel = (id: string) => join(releasesDir(), id);
const facts = (over: Partial<Parameters<typeof planRestart>[0]> = {}): Parameters<typeof planRestart>[0] => ({
  full: false,
  pendingRevive: false,
  managerPids: [42],
  managerRoot: rel("aaaaaaaaaaaa"),
  runningRuntime: "tmux",
  preferredRuntime: "tmux",
  targetRoot: rel("bbbbbbbbbbbb"),
  releaseOf: (root) => releaseIdOfRoot(root),
  fingerprintOf: () => "same",
  managerAnswers: async () => true,
  ...over,
});
const keep = await planRestart(facts());
ok(keep.kind === "keep-manager" && keep.from === "aaaaaaaaaaaa" && keep.to === "bbbbbbbbbbbb", "same fingerprint, one answering manager → keep it", keep);
const why = async (over: Partial<Parameters<typeof planRestart>[0]>) => {
  const p = await planRestart(facts(over));
  return p.kind === "full" ? p.why : "(kept)";
};
ok((await why({ full: true })) === "--full", "--full → full");
ok(/runtime tmux/.test(await why({ runtime: "tmux" })), "an explicit runtime → full");
ok(/failed restart/.test(await why({ pendingRevive: true })), "a pending revive list → full");
ok(/no manager/.test(await why({ managerPids: [] })), "no manager → full (starts one)");
ok(/2 manager processes/.test(await why({ managerPids: [1, 2] })), "duplicate managers → full (a restart leaves one)");
ok(/manager code changed/.test(await why({ fingerprintOf: (r) => r })), "different fingerprints → full");
ok(/prefers pty/.test(await why({ preferredRuntime: "pty" })), "a runtime preference the manager doesn't run → full");
ok(/not a release/.test(await why({ managerRoot: "/Users/x/Github/paw" })), "a manager on the dev checkout → full (its loaded code can't be known)");
ok(/not a release/.test(await why({ targetRoot: "/Users/x/Github/paw" })), "PAW_RELEASE=dev target → full");
ok(/can't tell/.test(await why({ managerRoot: { error: "ps failed" } })), "an unreadable manager root → full");
ok(/couldn't fingerprint/.test(await why({ fingerprintOf: () => { throw new Error("boom"); } })), "a fingerprint that can't be computed → full");
ok(/isn't answering/.test(await why({ managerAnswers: async () => false })), "a hung manager → full (restart still replaces it)");
let asked = false;
await planRestart(facts({ fingerprintOf: (r) => r, managerAnswers: async () => (asked = true) }));
ok(!asked, "the mesh round-trip is skipped once the code already differs");

console.log("releaseIdOfRoot");
ok(releaseIdOfRoot(rel("abc123def456")) === "abc123def456", "a release dir → its id");
ok(releaseIdOfRoot(join(rel("abc123def456"), "src")) === undefined, "a path inside a release isn't a root");
ok(releaseIdOfRoot("/Users/x/Github/paw") === undefined, "the checkout → undefined");
ok(releaseIdOfRoot(releasesDir()) === undefined, "the releases dir itself → undefined");
ok(releaseIdOfRoot(rel(".staging-x")) === undefined, "a staging dir → undefined");

// ---- prune never deletes a release in use --------------------------------------------------------
console.log("prune");
const listing = [
  `/n/node ${rel("111111111111")}/bin/cotald.ts supervise --space paw --server nats://127.0.0.1:4222 --runtime tmux`,
  `/bin/sh -c ... ${rel("222222222222")}/src/hub/daemon.mjs --space paw --socket /x`,
  `/n/node /Users/x/Github/paw/bin/paw.ts status`,
  `/n/node ${rel("current")}/bin/paw.ts web`,
].join("\n");
const used = releasesInUse(listing);
ok(used.has("111111111111") && used.has("222222222222") && used.size === 2, "in use: every release a live command line names (not `current`, not the checkout)", [...used]);
for (const id of ["111111111111", "222222222222", "333333333333", "444444444444"]) {
  mkdirSync(releasePath(id), { recursive: true });
  await new Promise((r) => setTimeout(r, 15)); // distinct mtimes → a stable newest-first order
}
activateRelease("444444444444");
const pruned = pruneReleases(1, () => new Set(["111111111111"]));
ok(pruned.removed.join() === "333333333333,222222222222" || pruned.removed.sort().join() === "222222222222,333333333333", "prune removes old releases nothing runs", pruned);
ok(pruned.kept.join() === "111111111111", "prune keeps (and names) the old release a live manager runs", pruned);
ok(releasesInUse().size >= 0, "releasesInUse reads the real process table without throwing");

console.log("restart args");
ok(parseArgs(["--full"], "restart").full === true, "restart --full parses");
ok(parseArgs(["--full", "--space", "s"], "restart").space === "s", "restart --full --space s");
ok(throws(() => parseArgs(["--full", "--mailbox"], "restart")), "--full with --mailbox fails loud");
ok(throws(() => parseArgs(["alice", "--full"], "restart")), "--full with an agent fails loud");
ok(parseArgs(["tmux", "--full"], "restart").runtime === "tmux", "a runtime with --full is still a runtime restart");

rmSync(home, { recursive: true, force: true });
rmSync(base, { recursive: true, force: true });
rmSync(stamped, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall smart-restart checks passed");

/**
 * Smoke check for paw's folder→agent addressing (src/addressing.ts): name sanitisation, the
 * persisted folder→name registry, and collision-qualification — the part that must NEVER silently
 * map two different folders to one agent. Runs against an isolated PAW_HOME so real paw state is
 * untouched, and uses real temp directories (folderToName canonicalises via realpath). Run:
 * pnpm check:addressing
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-home-"));

const {
  sanitizeAgentName,
  folderToName,
  setFolderName,
  folderForName,
  canonicalDir,
  resolveModel,
  assertUnambiguousTarget,
  psRowAlive,
  spawnAction,
  STARTING_GRACE_MS,
  registerInstance,
  agentNamesForFolder,
  resolveFolderAgent,
  lookupFolderName,
  removeAgentName,
  readAgentIndex,
  listAgents,
  ensurePersonaFile,
  withChannelGrants,
  personaFilePath: personaPath,
} = await import("../src/addressing.js");

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

const NAME_RE = /^[A-Za-z0-9_-]+$/;

// sanitizeAgentName always yields a valid bare manager token.
assert(sanitizeAgentName("/a/b/web") === "web", "basename used as the name");
assert(sanitizeAgentName("/a/b/my.cool repo!") === "my-cool-repo", "unsafe chars collapse to single dashes");
assert(sanitizeAgentName("/a/b/--edge--") === "edge", "leading/trailing dashes trimmed");
assert(sanitizeAgentName("/") === "root", "filesystem root falls back to 'root'");
assert(NAME_RE.test(sanitizeAgentName("/a/b/π≈3 spaces")), "sanitised name matches the manager name charset");

// folderToName: deterministic, idempotent, and collision-safe across DIFFERENT folders.
const space = "test";
const root = realpathSync(mkdtempSync(join(tmpdir(), "paw-fld-")));
const a = mkdtempSync(join(root, "alpha-"));
const aWeb = canonicalDir(mkdir(a, "web"));
const b = mkdtempSync(join(root, "beta-"));
const bWeb = canonicalDir(mkdir(b, "web"));

const n1 = folderToName(space, aWeb);
assert(n1 === "web", "first 'web' folder gets the clean basename");
assert(folderToName(space, aWeb) === "web", "same folder always resolves to the same name (idempotent)");

const n2 = folderToName(space, bWeb);
assert(n2 !== n1, "a second different folder named 'web' does NOT collide onto the first");
assert(n2.startsWith("web-") && NAME_RE.test(n2), "the collision is qualified with a hash suffix, still a valid name");
assert(folderToName(space, bWeb) === n2, "the qualified name is stable for that folder too");

// setFolderName: force a session-derived name (cleaned), rename in place, qualify cross-folder collisions.
const cSess = canonicalDir(mkdir(mkdtempSync(join(root, "gamma-")), "svc"));
const set1 = setFolderName(space, cSess, "my research!");
assert(set1.name === "my-research" && set1.previous === undefined, "setFolderName seeds a new mapping, cleaned to charset");
const set2 = setFolderName(space, cSess, "renamed");
assert(set2.name === "renamed" && set2.previous === "my-research", "setFolderName renames in place, returning the previous name");
assert(folderForName(space, "renamed") === cSess, "folderForName reverse-resolves name → folder");
// A name already held by a DIFFERENT folder is qualified, not collided onto.
const dSess = canonicalDir(mkdir(mkdtempSync(join(root, "delta-")), "svc2"));
assert(setFolderName(space, dSess, "renamed").name.startsWith("renamed-"), "setFolderName qualifies a name taken by another folder");
// Empty-after-clean falls back to the basename.
const eSess = canonicalDir(mkdir(mkdtempSync(join(root, "eps-")), "svc3"));
assert(setFolderName(space, eSess, "!!!").name === "svc3", "setFolderName falls back to basename when the desired cleans to empty");

// ── EXTRA instances (Model B′ agents.json side-table): >1 agent per folder, opt-in via registerInstance.
const multi = canonicalDir(mkdir(mkdtempSync(join(root, "multi-")), "api"));
assert(folderToName(space, multi) === "api", "folderToName seeds the folder's DEFAULT agent");
assert(registerInstance(space, multi, "api-worker") === "api-worker", "registerInstance mints an EXTRA agent at the same folder");
assert(folderToName(space, multi) === "api", "registerInstance does NOT move the folder's default");
assert(folderForName(space, "api-worker") === multi, "folderForName resolves an EXTRA → its folder");
assert(folderForName(space, "api") === multi, "folderForName still resolves the DEFAULT");
assert(readAgentIndex(space)["api-worker"] === multi, "the extra lives in agents.json (side-table), not folders.json");
// Idempotent + name-cleaning + fail-loud on empty-after-clean.
assert(registerInstance(space, multi, "api-worker") === "api-worker", "registerInstance is idempotent for the same name→folder");
assert(registerInstance(space, multi, "api worker#2") === "api-worker-2", "registerInstance cleans the name to the safe charset");
assert(throws(() => registerInstance(space, multi, "!!!")), "registerInstance fails loud when the name cleans to empty");
// Global uniqueness: an extra can't equal a DEFAULT, another EXTRA, or this folder's OWN default.
assert(throws(() => registerInstance(space, multi, "web")), "registerInstance rejects a name equal to another folder's default");
assert(throws(() => registerInstance(space, multi, "api")), "registerInstance rejects this folder's own default name");
const multi2 = canonicalDir(mkdir(mkdtempSync(join(root, "multi2-")), "api2"));
assert(throws(() => registerInstance(space, multi2, "api-worker")), "registerInstance rejects a name already held by another extra");
// Reverse guard: folderToName / setFolderName won't MINT/SET a default that collides with an existing extra.
const clash = canonicalDir(mkdir(mkdtempSync(join(root, "clash-")), "api-worker"));
const clashName = folderToName(space, clash);
assert(clashName !== "api-worker" && clashName.startsWith("api-worker-"), "folderToName qualifies a default that would collide with an extra");
const clash2 = canonicalDir(mkdir(mkdtempSync(join(root, "clash2-")), "svcX"));
assert(setFolderName(space, clash2, "api-worker").name.startsWith("api-worker-"), "setFolderName qualifies a default that would collide with an extra");
// agentNamesForFolder: the default + every extra for a folder.
const multiNames = agentNamesForFolder(space, multi);
assert(
  multiNames.length === 3 && multiNames.includes("api") && multiNames.includes("api-worker") && multiNames.includes("api-worker-2"),
  "agentNamesForFolder returns the default plus all extras",
);
assert(
  agentNamesForFolder(space, aWeb).length === 1 && agentNamesForFolder(space, aWeb)[0] === "web",
  "agentNamesForFolder returns just the default when a folder has no extras",
);
assert(resolveFolderAgent(space, multi) === "api", "resolveFolderAgent prefers the default when extras also exist");
assert(resolveFolderAgent(space, aWeb) === "web", "resolveFolderAgent is the default on a one-agent folder");
{
  const oc = canonicalDir(mkdir(mkdtempSync(join(root, "oc-")), "paw-opencode"));
  assert(registerInstance(space, oc, "opencode1") === "opencode1", "extra-only folder (no default) — opencode1");
  assert(lookupFolderName(space, oc) === undefined, "extra-only folder has no folders.json default");
  assert(resolveFolderAgent(space, oc) === "opencode1", "chat/attach . uses the sole extra, does not mint a claude default");
  assert(lookupFolderName(space, oc) === undefined, "resolveFolderAgent does not write a default beside the extra");
  assert(registerInstance(space, oc, "opencode2") === "opencode2", "second extra at the extra-only folder");
  assert(throws(() => resolveFolderAgent(space, oc)), "several extras and no default → fail loud (never invent which, never mint claude)");
}
// listAgents: union of defaults and extras.
const listed = listAgents(space);
assert(listed.some((r) => r.name === "api" && r.folder === multi), "listAgents includes the default");
assert(listed.some((r) => r.name === "api-worker" && r.folder === multi), "listAgents includes the extra");
// removeAgentName: drops an extra, leaves the default; undefined for a non-extra (default removed by removeFolder).
assert(removeAgentName(space, "api-worker-2") === multi, "removeAgentName drops an extra and returns its folder");
assert(folderForName(space, "api-worker-2") === undefined, "the removed extra no longer resolves");
assert(folderToName(space, multi) === "api", "removeAgentName leaves the folder's default intact");
assert(removeAgentName(space, "api") === undefined, "removeAgentName returns undefined for a DEFAULT (not an extra)");
assert(folderForName(space, "api") === multi, "the default survives a removeAgentName(default) no-op");

// assertUnambiguousTarget: a BARE token that's BOTH a registered agent name AND a folder basename in
// the cwd must fail loud; everything with a single valid interpretation (or an explicit sigil) resolves.
// `aWeb` is registered as "web"; chdir into `b`, whose child folder `web` (bWeb) is a DIFFERENT path —
// so `web` is genuinely ambiguous there.
const cwd0 = process.cwd();
process.chdir(b);
assert(throws(() => assertUnambiguousTarget(space, "web")), "bare 'web' (a known name AND a folder here) fails loud");
assert(!throws(() => assertUnambiguousTarget(space, "./web")), "'./web' (explicit path sigil) is exempt — no throw");
assert(!throws(() => assertUnambiguousTarget(space, ".")), "'.' (the cwd) is exempt — no throw");
assert(!throws(() => assertUnambiguousTarget(space, "github:o/web")), "a github: handle is exempt — no throw");
assert(!throws(() => assertUnambiguousTarget(space, "web@feature")), "a <repo>@<branch> ref is exempt — no throw");
assert(!throws(() => assertUnambiguousTarget(space, "renamed")), "a known name with no matching folder here resolves (no throw)");
mkdir(b, "solo"); // a folder here that is NOT a registered agent name → unambiguous folder
assert(!throws(() => assertUnambiguousTarget(space, "solo")), "a folder here that isn't a known name resolves (no throw)");
assert(!throws(() => assertUnambiguousTarget(space, undefined)), "no target is exempt — no throw");
process.chdir(cwd0);

// canonicalDir fails loud on a non-directory / missing path.
assert(throws(() => canonicalDir(join(root, "does-not-exist-zzz"))), "canonicalDir throws on a missing path");
// ...and on a blank target (regression: resolve("") returns cwd → would silently address it).
assert(throws(() => canonicalDir("")), "canonicalDir throws on an empty target (no silent cwd default)");
assert(throws(() => canonicalDir("   ")), "canonicalDir throws on a whitespace-only target");

// A registry that is valid JSON but NOT an object must fail loud — including a JSON array, which a
// bare typeof check would miss (regression: array slipped past → data loss + silent collisions).
const arraySpace = "arr";
const arrDir = join(process.env.PAW_HOME!, "spaces", arraySpace);
mkdirSync(arrDir, { recursive: true });
writeFileSync(join(arrDir, "folders.json"), '["a","b"]');
assert(throws(() => folderToName(arraySpace, aWeb)), "folderToName throws on a JSON-array registry (not a plain object)");

// resolveModel: explicit --model wins, else PAW_MODEL env, else undefined; blank counts as unset.
delete process.env.PAW_MODEL;
assert(resolveModel(undefined) === undefined, "resolveModel: no flag + no env => undefined");
assert(resolveModel("opus") === "opus", "resolveModel: explicit flag used when no env");
process.env.PAW_MODEL = "sonnet";
assert(resolveModel(undefined) === "sonnet", "resolveModel: PAW_MODEL env used when no flag");
assert(resolveModel("opus") === "opus", "resolveModel: explicit flag overrides PAW_MODEL env");
process.env.PAW_MODEL = "   ";
assert(resolveModel(undefined) === undefined, "resolveModel: blank PAW_MODEL is treated as unset (no fabricated default)");
delete process.env.PAW_MODEL;

// spawnAction / psRowAlive: the wake gate. A listed-but-dead agent (crash/bounce zombie) must RESTART,
// not be reused — the bug where `paw dm`/`paw chat` couldn't wake an offline-but-listed agent.
assert(spawnAction([], "paw") === "start", "spawnAction: unmanaged name => start");
assert(spawnAction([{ name: "paw", status: "running", mesh: "idle" }], "paw") === "reuse", "spawnAction: running+idle => reuse");
assert(spawnAction([{ name: "paw", status: "running", mesh: "working" }], "paw") === "reuse", "spawnAction: running+working => reuse");
assert(spawnAction([{ name: "paw", status: "running", mesh: "absent" }], "paw") === "reuse", "spawnAction: mid-start (absent) => reuse (don't kill a legit boot)");
assert(spawnAction([{ name: "paw", status: "running", mesh: "offline" }], "paw") === "restart", "spawnAction: listed but mesh offline => restart (the wake bug)");
assert(spawnAction([{ name: "paw", status: "exited", mesh: "offline" }], "paw") === "restart", "spawnAction: exited => restart");
assert(spawnAction([{ name: "other", status: "running", mesh: "idle" }], "paw") === "start", "spawnAction: only a DIFFERENT name is live => start ours");
assert(psRowAlive({ name: "x", status: "running", mesh: "idle" }), "psRowAlive: running+idle is alive");
assert(!psRowAlive({ name: "x", status: "running", mesh: "offline" }), "psRowAlive: mesh offline is dead");
assert(!psRowAlive({ name: "x", status: "exited", mesh: "idle" }), "psRowAlive: exited is dead");
// `absent` = mid-start, which the PURE gate still calls alive so a legitimate boot is never killed.
// The BOUND lives in ensureAgentSpawned: an agent that never leaves `starting…` is a failed boot, not
// a slow one, and reusing it forever is what made `paw chat research` unreachable for 13 hours with no
// way to clear it. Asserted here so the two halves can't drift: the gate stays permissive, the grace
// exists, and it is long enough that a real boot wins the race.
assert(psRowAlive({ name: "x", status: "running", mesh: "absent" }), "psRowAlive: mid-start is still alive to the pure gate");
assert(STARTING_GRACE_MS >= 10_000, "starting grace is generous — killing a live boot costs a resume, the alternative cost 13h");

// --- channel grants ---------------------------------------------------------
// paw agents were locked to reading #general and could post nowhere: cotal defaults an omitted
// allowSubscribe to "read what you subscribe to" and an omitted allowPublish to DENY, and paw
// declared neither. These assert the grant is minted, is real YAML, and never widens a persona that
// already states its own scope.
{
  const { loadAgentFile } = await import("@cotal-ai/core");

  const fresh = ensurePersonaFile("grantspace", "granted");
  const def = loadAgentFile(fresh);
  assert(def.allowSubscribe?.includes(">") === true, "persona: minted with allowSubscribe [>]");
  assert(def.allowPublish?.includes(">") === true, "persona: minted with allowPublish [>]");
  // The quoting is the point: a bare `>` is YAML's folded-block indicator, so an unquoted grant
  // would parse as a string rather than a one-entry list (or fail outright).
  assert(readFileSync(fresh, "utf8").includes('allowSubscribe: [">"]'), "persona: grant is QUOTED (bare > is a YAML block scalar)");
  assert(def.name === "granted" && /resume:/.test(readFileSync(fresh, "utf8")), "persona: still carries name + resume pin");

  // An existing pre-grant persona self-heals on the next spawn, keeping its resume pin and body.
  const legacy = personaPath("grantspace", "legacy");
  writeFileSync(legacy, "---\nname: legacy\nresume: 1234\n---\nI am a legacy persona.\n");
  const healed = readFileSync(ensurePersonaFile("grantspace", "legacy"), "utf8");
  assert(healed.includes('allowPublish: [">"]'), "persona: legacy file gains the grant");
  assert(healed.includes("resume: 1234") && healed.includes("I am a legacy persona."), "persona: upgrade keeps pin + body");
  assert(loadAgentFile(personaPath("grantspace", "legacy")).allowSubscribe?.includes(">") === true, "persona: upgraded file still loads");

  // Write-if-absent per KEY — an operator who narrowed one agent is never widened by a later spawn.
  const narrow = "---\nname: narrow\nallowSubscribe: [general]\n---\nbody\n";
  const widened = withChannelGrants(narrow);
  assert(widened?.includes("allowSubscribe: [general]") === true, "grants: an explicit narrow scope is KEPT verbatim");
  assert(widened?.includes('allowPublish: [">"]') === true, "grants: the missing key is still added");
  assert(withChannelGrants('---\nname: x\nsubscribe: [general]\nallowSubscribe: [">"]\nallowPublish: [">"]\n---\nb\n') === undefined, "grants: fully-granted file is a no-op (no rewrite)");
  // cotal ≥0.33: an omitted `subscribe` means NO channel, not `[general]` — the read set must be stated.
  assert(withChannelGrants('---\nname: x\nallowSubscribe: [">"]\nallowPublish: [">"]\n---\nb\n')?.includes("subscribe: [general]") === true, "grants: a pre-0.33 persona gains an explicit subscribe: [general]");
  assert(withChannelGrants("---\nname: x\nsubscribe: [ops]\n---\nb\n")?.includes("subscribe: [ops]") === true, "grants: an explicit subscribe is kept, never overwritten with general");
  assert(healed.includes("subscribe: [general]"), "persona: legacy file gains the explicit read set");
  assert(loadAgentFile(personaPath("grantspace", "legacy")).subscribe?.includes("general") === true, "persona: the upgraded file reads #general");
  assert(withChannelGrants("no frontmatter here") === undefined, "grants: a file with no frontmatter is left alone, not thrown on");
  assert(withChannelGrants("---\r\nname: x\r\n---\r\nbody\r\n")?.includes('\r\nallowPublish: [">"]\r\n') === true, "grants: CRLF file keeps CRLF");
}

rmSync(process.env.PAW_HOME!, { recursive: true, force: true });

// wake gate busy-guard: an offline row with a recently-written transcript is BUSY, not a zombie.
{
  const { restartDespiteOffline, BUSY_GUARD_MS } = await import("../src/addressing.js");
  const now = 1_000_000_000;
  assert(restartDespiteOffline(undefined, now) === true, "busy-guard: no mtime → no evidence → restart proceeds");
  assert(restartDespiteOffline(now - 30_000, now) === false, "busy-guard: written 30s ago → busy → do NOT restart");
  assert(restartDespiteOffline(now - BUSY_GUARD_MS - 1, now) === true, "busy-guard: older than the window → restart");
  assert(restartDespiteOffline(now + 60_000, now) === true, "busy-guard: an mtime in the FUTURE (clock skew) is not evidence");
}

if (failures > 0) {
  console.error(`\n${failures} paw addressing check(s) failed`);
  process.exit(1);
}
console.log("\nall paw addressing checks passed 🐾");

// helper: make a child dir with an exact name (mkdtemp only takes a prefix) and return its path.
function mkdir(parent: string, name: string): string {
  const p = join(parent, name);
  mkdirSync(p, { recursive: true });
  return p;
}

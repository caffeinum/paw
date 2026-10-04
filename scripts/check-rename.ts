/**
 * Smoke check for `paw rename`'s on-disk effects (renameAgentOnDisk): the registration is
 * renamed, the persona file MOVES with its `resume:` pin and gets its `name:` frontmatter rewritten,
 * and the fail-loud guards fire (no-op, empty/invalid name, collision with another folder, unmapped
 * target). Pure — isolated PAW_HOME, no mesh/daemons. Run: pnpm check:rename
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate paw's state dir so the real ~/.paw is never touched (spaceDir honours PAW_HOME).
process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-home-"));

const { setFolderName, ensurePersonaFile, personaFilePath, lookupFolderName, registerInstance, agentRecord } =
  await import("../src/addressing.ts");
const { readResumeId } = await import("../src/session.ts");
const { renameAgentOnDisk } = await import("../src/rename.ts");

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

const SPACE = "test";
const FOLDER = "/fake/repo/web";

// Seed: map the folder to "web" and create its persona (which mints a resume pin).
setFolderName(SPACE, FOLDER, "web");
const seeded = ensurePersonaFile(SPACE, "web");
const pin = readResumeId(seeded);
assert(typeof pin === "string" && pin.length > 0, "seed persona has a resume pin");

// Happy path: web → api.
const { from, to } = renameAgentOnDisk(SPACE, FOLDER, "api");
assert(from === "web" && to === "api", "renameAgentOnDisk returns { from: web, to: api }");
assert(lookupFolderName(SPACE, FOLDER) === "api", "the folder's default is now 'api'");
assert(!existsSync(personaFilePath(SPACE, "web")), "old persona file (web.md) is gone");
const moved = personaFilePath(SPACE, "api");
assert(existsSync(moved), "new persona file (api.md) exists");
assert(readResumeId(moved) === pin, "resume pin is preserved across the rename (context kept)");
assert(/^name:\s*api$/m.test(readFileSync(moved, "utf8")), "persona name: frontmatter rewritten to 'api'");

// Fail-loud guards.
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "api")), "renaming to the SAME name fails loud (no-op)");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "   ")), "an empty name fails loud");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "@@@")), "a name with no usable chars fails loud");
assert(throws(() => renameAgentOnDisk(SPACE, "/fake/never/mapped", "whatever")), "renaming an UNMAPPED folder fails loud");

// Collision: another folder already holds "queue".
setFolderName(SPACE, "/fake/repo/queue", "queue");
ensurePersonaFile(SPACE, "queue");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "queue")), "renaming to a name held by a DIFFERENT folder fails loud");
assert(lookupFolderName(SPACE, FOLDER) === "api", "the rejected collision left the mapping unchanged");

// --- EXTRA-instance rename (a paw-extra persona) ---
// Seed a 2nd agent at FOLDER via --name; its persona carries its own resume pin.
registerInstance(SPACE, FOLDER, "web-alt");
const extraSeed = ensurePersonaFile(SPACE, "web-alt");
const extraPin = readResumeId(extraSeed);
assert(agentRecord(SPACE, "web-alt")?.folder === FOLDER && agentRecord(SPACE, "web-alt")?.extra === true, "extra 'web-alt' registered (its persona) → FOLDER");

// Rename the EXTRA (currentName = "web-alt"): moves that persona, leaves the DEFAULT alone.
const ext = renameAgentOnDisk(SPACE, FOLDER, "web-beta", "web-alt");
assert(ext.from === "web-alt" && ext.to === "web-beta", "extra rename returns { from: web-alt, to: web-beta }");
assert(lookupFolderName(SPACE, FOLDER) === "api", "extra rename left the folder's DEFAULT ('api') untouched");
assert(agentRecord(SPACE, "web-alt") === undefined, "old extra 'web-alt' no longer registered");
assert(agentRecord(SPACE, "web-beta")?.folder === FOLDER && agentRecord(SPACE, "web-beta")?.extra === true, "new extra 'web-beta' → FOLDER, still an extra");
assert(!existsSync(personaFilePath(SPACE, "web-alt")), "old extra persona (web-alt.md) is gone");
const extMoved = personaFilePath(SPACE, "web-beta");
assert(existsSync(extMoved) && readResumeId(extMoved) === extraPin, "extra persona moved with its resume pin");
assert(/^name:\s*web-beta$/m.test(readFileSync(extMoved, "utf8")), "extra persona name: rewritten to 'web-beta'");

// Extra collisions fail loud without mutating anything.
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "api", "web-beta")), "renaming an extra to the folder's DEFAULT fails loud");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "queue", "web-beta")), "renaming an extra to another folder's default fails loud");
registerInstance(SPACE, FOLDER, "web-gamma");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "web-gamma", "web-beta")), "renaming an extra onto a SAME-folder extra fails loud");
assert(agentRecord(SPACE, "web-beta")?.folder === FOLDER, "rejected extra collisions left 'web-beta' intact");
// `paw rename <default-name> <new>` passes the name as currentName — it relabels that default, not an extra.
const byName = renameAgentOnDisk(SPACE, "/fake/repo/queue", "queue2", "queue");
assert(byName.from === "queue" && lookupFolderName(SPACE, "/fake/repo/queue") === "queue2", "a DEFAULT addressed by name is relabeled");
// A currentName that belongs to ANOTHER folder never redirects the rename to it.
assert(renameAgentOnDisk(SPACE, FOLDER, "api2", "queue2").from === "api", "a foreign currentName falls back to the folder's own default");

// The login fleet job bakes agent names; a rename must follow it there (vibeos-landing → vibeos-ceo,
// 2026-10-03, silently dropped out of the next login's `paw start`).
{
  const { renameInFleetArgs, renameInFleetJob, fleetJob, renderPlist, plistPath, FLEET_LABEL } = await import(
    "../src/commands/launchd.ts"
  );
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const args = ["/n", "/paw.ts", "start", "a", "paw", "b", "--space", "paw"];
  assert(renameInFleetArgs(args, "paw", "a", "z")?.join(" ") === "/n /paw.ts start z paw b --space paw", "fleet args: the name is replaced in place");
  assert(renameInFleetArgs(args, "paw", "paw", "x")?.join(" ") === "/n /paw.ts start a x b --space paw", "fleet args: an agent named like the space is renamed, the --space value is not");
  assert(renameInFleetArgs(args, "paw", "nope", "x") === undefined, "fleet args: a name the job doesn't start → untouched");
  assert(renameInFleetArgs(args, "other", "a", "z") === undefined, "fleet args: another space's job → untouched");

  const realHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "paw-launchd-home-")); // plistPath follows os.homedir()
  try {
    assert(renameInFleetJob("paw", "a", "z") === undefined, "fleet job: no plist installed → nothing to do");
    mkdirSync(join(process.env.HOME, "Library", "LaunchAgents"), { recursive: true });
    const job = fleetJob("paw", ["a", "b"], { cli: ["/n", "/paw.ts"], env: { PAW_HOME: "/h" }, log: "/l", cwd: "/c" });
    writeFileSync(plistPath(FLEET_LABEL), renderPlist(job));
    assert(renameInFleetJob("paw", "a", "z") === plistPath(FLEET_LABEL), "fleet job: a started name is rewritten on disk");
    const back = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath(FLEET_LABEL)], { encoding: "utf8" }));
    assert(back.ProgramArguments.join(" ") === "/n /paw.ts start z b --space paw", "fleet job: the plist now starts the new name");
    assert(back.EnvironmentVariables?.PAW_HOME === "/h" && back.Label === FLEET_LABEL, "fleet job: the rest of the plist survives");
    assert(renameInFleetJob("paw", "a", "y") === undefined, "fleet job: the old name is gone, a second rename of it is a no-op");
  } finally {
    process.env.HOME = realHome;
  }
}

// The renamed agent keeps its queue: open beads move to the new name, closed ones keep their history.
// bd's db follows HOME here (bdEnv pins $HOME/.beads), so a temp HOME isolates it from the real one.
{
  const { execFileSync } = await import("node:child_process");
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "paw-beads-home-"));
  process.env.HOME = home;
  try {
    const env = { ...process.env, HOME: home, BEADS_DIR: join(home, ".beads") };
    execFileSync("bd", ["init", "--quiet"], { cwd: home, env, stdio: "ignore" });
    const mk = (title: string, assignee: string) =>
      execFileSync("bd", ["create", title, "-a", assignee, "--silent"], { cwd: home, env, encoding: "utf8" }).trim();
    const open1 = mk("one", "old-name");
    const open2 = mk("two", "old-name");
    const done = mk("three", "old-name");
    const other = mk("four", "someone-else");
    execFileSync("bd", ["close", done], { cwd: home, env, stdio: "ignore" });
    const { reassignOpenTasks } = await import("../src/tasks.ts");
    const moved = await reassignOpenTasks("old-name", "new-name");
    assert(moved.sort().join(",") === [open1, open2].sort().join(","), "beads: exactly the old name's OPEN beads move");
    const who = (id: string) =>
      (JSON.parse(execFileSync("bd", ["show", id, "--json"], { cwd: home, env, encoding: "utf8" })) as Array<{ assignee?: string }>)[0]?.assignee;
    assert(who(open1) === "new-name" && who(open2) === "new-name", "beads: moved beads now belong to the new name");
    assert(who(done) === "old-name", "beads: a closed bead keeps its historical assignee");
    assert(who(other) === "someone-else", "beads: another agent's bead is untouched");
  } finally {
    process.env.HOME = realHome;
  }
}

if (failures > 0) {
  console.error(`\n${failures} paw rename check(s) failed`);
  process.exit(1);
}
console.log("\nall paw rename checks passed 🐾");

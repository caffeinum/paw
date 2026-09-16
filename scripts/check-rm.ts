/**
 * Smoke check for `paw rm` (src/rm.ts) target resolution against the persona registry:
 * resolve a target by name / folder / extra / orphaned-persona, keep nothing spawning.
 * Isolated HOME + PAW_HOME so real paw state is untouched. Run: pnpm check:rm
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-rm-home-"));
process.env.PAW_SPACE = "rmtest";
const space = "rmtest";

const { folderToName, lookupFolderName, personaFilePath, registerInstance, setFolderName, setPersonaKeys } = await import("../src/addressing.js");
const { resolveRemoval } = await import("../src/rm.js");

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

// A real folder registered as an agent, with a persona on disk.
const folder = realpathSync(mkdtempSync(join(tmpdir(), "paw-rm-proj-")));
const name = folderToName(space, folder); // basename
setPersonaKeys(space, name, { resume: "abc-123" });

// resolveRemoval by NAME and by FOLDER both find the same agent + mapping.
const byName = resolveRemoval(space, name);
assert(byName.name === name && byName.folder === folder, "resolveRemoval by name → name + folder");
const byFolder = resolveRemoval(space, folder);
assert(byFolder.name === name && byFolder.folder === folder, "resolveRemoval by folder → name + folder");

// An EXTRA resolves by its own name to the shared folder; the folder itself still means its default.
assert(registerInstance(space, folder, "helper") === "helper", "an extra is registered beside the default");
assert(resolveRemoval(space, "helper").folder === folder && resolveRemoval(space, folder).name === name, "extra by name, default by folder");
rmSync(personaFilePath(space, "helper"));

// Replacing the folder's default leaves the old persona behind with no folder — an ORPHAN.
assert(setFolderName(space, folder, "replacement").previous === name, "the default is replaced");
assert(lookupFolderName(space, folder) === "replacement", "the folder now means the replacement");

// Orphaned persona: the mapping is gone but the persona file remains → resolvable by name, no folder.
assert(existsSync(personaFilePath(space, name)), "persona still on disk (now orphaned)");
const orphan = resolveRemoval(space, name);
assert(orphan.name === name && orphan.folder === undefined, "resolveRemoval of an orphaned persona → name, no folder");

// Nothing left → fail loud.
rmSync(personaFilePath(space, name), { force: true });
assert(throws(() => resolveRemoval(space, name)), "no mapping + no persona → throws");
assert(throws(() => resolveRemoval(space, "never-existed-xyz")), "unknown target throws");

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });
rmSync(folder, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw rm check(s) failed`);
  process.exit(1);
}
console.log("\nall paw rm checks passed 🐾");

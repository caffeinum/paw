/**
 * Smoke check for `paw rm` (src/rm.ts) + the registry-removal helper (addressing.removeFolder):
 * resolve a target by name / folder / orphaned-persona, drop the mapping, keep nothing spawning.
 * Isolated HOME + PAW_HOME so real paw state is untouched. Run: pnpm check:rm
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-rm-home-"));
process.env.PAW_SPACE = "rmtest";
const space = "rmtest";

const { folderToName, lookupFolderName, removeFolder, personaFilePath } = await import("../src/addressing.js");
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
writeFileSync(personaFilePath(space, name), `---\nname: ${name}\nresume: abc-123\n---\nbody\n`);

// resolveRemoval by NAME and by FOLDER both find the same agent + mapping.
const byName = resolveRemoval(space, name);
assert(byName.name === name && byName.folder === folder, "resolveRemoval by name → name + folder");
const byFolder = resolveRemoval(space, folder);
assert(byFolder.name === name && byFolder.folder === folder, "resolveRemoval by folder → name + folder");

// removeFolder drops the mapping and is idempotent.
assert(removeFolder(space, folder) === name, "removeFolder returns the removed name");
assert(lookupFolderName(space, folder) === undefined, "mapping gone after removeFolder");
assert(removeFolder(space, folder) === undefined, "removeFolder is idempotent (already gone)");

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

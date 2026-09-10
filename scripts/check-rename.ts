/**
 * Smoke check for `paw rename`'s on-disk effects (renameAgentOnDisk): the folder-map entry is
 * renamed, the persona file MOVES with its `resume:` pin and gets its `name:` frontmatter rewritten,
 * and the fail-loud guards fire (no-op, empty/invalid name, collision with another folder, unmapped
 * target). Pure — isolated PAW_HOME, no mesh/daemons. Run: pnpm check:rename
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate paw's state dir so the real ~/.paw is never touched (spaceDir honours PAW_HOME).
process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-home-"));

const { setFolderName, ensurePersonaFile, personaFilePath, lookupFolderName, registerInstance, readAgentIndex } =
  await import("../src/addressing.js");
const { readResumeId } = await import("../src/session.js");
const { renameAgentOnDisk } = await import("../src/rename.js");

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
assert(lookupFolderName(SPACE, FOLDER) === "api", "folders.json now maps the folder to 'api'");
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

// --- EXTRA-instance rename (agents.json side-table) ---
// Seed a 2nd agent at FOLDER via --name; its persona carries its own resume pin.
registerInstance(SPACE, FOLDER, "web-alt");
const extraSeed = ensurePersonaFile(SPACE, "web-alt");
const extraPin = readResumeId(extraSeed);
assert(readAgentIndex(SPACE)["web-alt"] === FOLDER, "extra 'web-alt' registered in agents.json → FOLDER");

// Rename the EXTRA (currentName = "web-alt"): moves the agents.json key, leaves the DEFAULT alone.
const ext = renameAgentOnDisk(SPACE, FOLDER, "web-beta", "web-alt");
assert(ext.from === "web-alt" && ext.to === "web-beta", "extra rename returns { from: web-alt, to: web-beta }");
assert(lookupFolderName(SPACE, FOLDER) === "api", "extra rename left the folder's DEFAULT ('api') untouched");
assert(readAgentIndex(SPACE)["web-alt"] === undefined, "old extra key 'web-alt' dropped from agents.json");
assert(readAgentIndex(SPACE)["web-beta"] === FOLDER, "new extra key 'web-beta' → FOLDER in agents.json");
assert(!existsSync(personaFilePath(SPACE, "web-alt")), "old extra persona (web-alt.md) is gone");
const extMoved = personaFilePath(SPACE, "web-beta");
assert(existsSync(extMoved) && readResumeId(extMoved) === extraPin, "extra persona moved with its resume pin");
assert(/^name:\s*web-beta$/m.test(readFileSync(extMoved, "utf8")), "extra persona name: rewritten to 'web-beta'");

// Extra collisions fail loud without mutating anything.
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "api", "web-beta")), "renaming an extra to the folder's DEFAULT fails loud");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "queue", "web-beta")), "renaming an extra to another folder's default fails loud");
registerInstance(SPACE, FOLDER, "web-gamma");
assert(throws(() => renameAgentOnDisk(SPACE, FOLDER, "web-gamma", "web-beta")), "renaming an extra onto a SAME-folder extra fails loud");
assert(readAgentIndex(SPACE)["web-beta"] === FOLDER, "rejected extra collisions left 'web-beta' intact");

if (failures > 0) {
  console.error(`\n${failures} paw rename check(s) failed`);
  process.exit(1);
}
console.log("\nall paw rename checks passed 🐾");

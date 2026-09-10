/**
 * Concurrency check: the folder→name registry is a cross-process read-modify-write, so N paw
 * processes resolving same-basename folders at once must still get DISTINCT, persisted names (the
 * lock fix). Without the lock this loses entries and maps two folders to one agent. Single-file:
 * re-execs itself as `--child <folder>` workers. Run: pnpm check:concurrency
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Child mode: resolve one folder and print its name. Uses the PAW_HOME/PAW_SPACE inherited from parent.
const childIdx = process.argv.indexOf("--child");
if (childIdx !== -1) {
  const { folderToName, canonicalDir } = await import("../src/addressing.js");
  console.log(folderToName(process.env.PAW_SPACE as string, canonicalDir(process.argv[childIdx + 1])));
  process.exit(0);
}

// Instance-child mode: register one EXTRA agent (--instance <folder> <name>) at a shared folder and
// print the name. Proves the agents.json side-table serializes on the SAME lock as folders.json.
const instIdx = process.argv.indexOf("--instance");
if (instIdx !== -1) {
  const { registerInstance, canonicalDir } = await import("../src/addressing.js");
  const folder = canonicalDir(process.argv[instIdx + 1]);
  console.log(registerInstance(process.env.PAW_SPACE as string, folder, process.argv[instIdx + 2]));
  process.exit(0);
}

// Parent mode.
const N = 8;
const home = mkdtempSync(join(tmpdir(), "paw-conc-home-"));
const space = "conc";
const root = mkdtempSync(join(tmpdir(), "paw-conc-root-"));
// N distinct folders that all share the basename "web" → maximal collision pressure.
const folders = Array.from({ length: N }, (_, i) => {
  const d = join(root, `p${i}`, "web");
  mkdirSync(d, { recursive: true });
  return d;
});

const names = await Promise.all(
  folders.map(
    (f) =>
      new Promise<string>((resolveP, rejectP) => {
        const child = spawn("pnpm", ["exec", "tsx", "scripts/check-concurrency.ts", "--child", f], {
          cwd: process.cwd(),
          env: { ...process.env, PAW_HOME: home, PAW_SPACE: space },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout.on("data", (b) => (out += b.toString()));
        child.on("exit", (code) => (code === 0 ? resolveP(out.trim()) : rejectP(new Error(`child exit ${code}`))));
      }),
  ),
);

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const unique = new Set(names);
assert(unique.size === N, `all ${N} racing resolutions got distinct names (got ${unique.size}: ${[...unique].join(", ")})`);
assert(names.every((n) => /^[A-Za-z0-9_-]+$/.test(n)), "every name is a valid bare token");

const map = JSON.parse(readFileSync(join(home, "spaces", space, "folders.json"), "utf8"));
assert(Object.keys(map).length === N, `registry persisted all ${N} folder→name entries (no lost update; got ${Object.keys(map).length})`);
assert(new Set(Object.values(map)).size === N, "no two folders share a name in the persisted registry");

// EXTRA instances: N processes racing registerInstance at ONE shared folder must yield N distinct
// agents.json entries, all → that folder (the shared folders.json lock serializes agents.json writes too).
const shared = join(root, "shared", "svc");
mkdirSync(shared, { recursive: true });
const instNames = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    new Promise<string>((resolveP, rejectP) => {
      const child = spawn("pnpm", ["exec", "tsx", "scripts/check-concurrency.ts", "--instance", shared, `w${i}`], {
        cwd: process.cwd(),
        env: { ...process.env, PAW_HOME: home, PAW_SPACE: space },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b.toString()));
      child.on("exit", (code) => (code === 0 ? resolveP(out.trim()) : rejectP(new Error(`instance child exit ${code}`))));
    }),
  ),
);
assert(new Set(instNames).size === N, `all ${N} racing registerInstance calls got distinct names (got ${new Set(instNames).size})`);
const agents = JSON.parse(readFileSync(join(home, "spaces", space, "agents.json"), "utf8"));
assert(Object.keys(agents).length === N, `agents.json persisted all ${N} extra instances (no lost update; got ${Object.keys(agents).length})`);
const realShared = realpathSync(shared);
assert(Object.values(agents).every((f) => f === realShared), "every racing extra instance maps to the one shared folder");

rmSync(home, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} paw concurrency check(s) failed`);
  process.exit(1);
}
console.log("\nall paw concurrency checks passed 🐾");

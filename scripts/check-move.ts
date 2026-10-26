/**
 * `paw move` hermetic checks (src/move.ts): argument parsing, the `<agent>#<space>` hoist, the plan text,
 * every refusal, the cutover (target written, source backed up, start only when it ran), the stamped
 * backup on a second move, a hermes profile following it, the rollback (a failed start in the target and
 * an unreleased session), and `--as` bead reassignment against a temp beads db.
 *
 * Isolated: HOME, PAW_HOME and PAW_BEADS_DIR are temp dirs — never the real ~/.paw or ~/.beads. No mesh,
 * no manager: applyMove's stop/start are fakes.
 * Run: pnpm check:move
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-move-home-")));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ALLOW_ANY_CWD = "1";
delete process.env.PAW_SPACE;

const bdDir = realpathSync(mkdtempSync(join(tmpdir(), "paw-move-bd-")));
execFileSync("bd", ["init", "--non-interactive", "-p", "mv", "-q"], { cwd: bdDir, stdio: "ignore", env: { ...process.env, BEADS_DIR: join(bdDir, ".beads") } });
const beadsDb = join(bdDir, ".beads");
process.env.PAW_BEADS_DIR = beadsDb;
const bd = (args: string[]) => execFileSync("bd", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, BEADS_DIR: beadsDb, BEADS_ACTOR: "aleks" } }).trim();

const mv = await import("../src/move.ts");
const { setFolderName, ensurePersonaFile, personaFilePath, setPersonaKeys, registerInstance } = await import("../src/addressing.ts");
const { readResumeId } = await import("../src/session.ts");
const { registerForeground, unregisterForeground } = await import("../src/foreground.ts");
const { writeSleepRecord, clearSleep } = await import("../src/sleep-state.ts");
const { hoistAddressSpace } = await import("../src/dispatch.ts");
const { hermesRoot } = await import("../src/hermes-profile.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
  }
}
async function rejects(p: Promise<unknown>, re: RegExp, msg: string): Promise<string> {
  try {
    await p;
    assert(false, `${msg} (did not reject)`);
    return "";
  } catch (e) {
    const m = (e as Error).message;
    assert(re.test(m), `${msg} — ${m.split("\n")[0]}`);
    return m;
  }
}

const A = "mv-a";
const B = "mv-b";
const spaces = join(process.env.PAW_HOME, "spaces");
mkdirSync(join(spaces, A), { recursive: true });
mkdirSync(join(spaces, B), { recursive: true });
const now = Date.now();
const idle: import("../src/move.ts").MoveLive = { listed: false, running: false, strangers: [] };
const live: import("../src/move.ts").MoveLive = { listed: true, running: true, activeMs: now - 20 * 60_000, strangers: [] };

/** An agent in space A at its own folder, with a kit dir and a restart history. */
function seed(name: string, opts: { kit?: boolean } = {}): string {
  const folder = join(home, "work", name);
  mkdirSync(folder, { recursive: true });
  setFolderName(A, folder, name);
  ensurePersonaFile(A, name);
  if (opts.kit) {
    mkdirSync(join(spaces, A, "kit", name), { recursive: true });
    writeFileSync(join(spaces, A, "kit", name, "schedules.json"), '{"s":[]}\n');
  }
  mkdirSync(join(spaces, A, "restarts"), { recursive: true });
  writeFileSync(join(spaces, A, "restarts", `${name}.json`), '{"restarts":[]}\n');
  return folder;
}

type Call = [op: "stop" | "start", space: string, name: string];
function fakeDeps(o: { failStartIn?: string; unreleased?: boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      stop: async (space: string, name: string) => {
        calls.push(["stop", space, name]);
        return { wasLive: true, released: !o.unreleased };
      },
      start: async (space: string, name: string) => {
        calls.push(["start", space, name]);
        if (space === o.failStartIn) throw new Error("boom: the seat never came up");
      },
      log: () => {},
    },
  };
}

// ── args + addressing ──────────────────────────────────────────────────────────────────────────────
console.log("args");
{
  const a = mv.parseMoveArgs(["worker", "--to-space", B, "--as", "w2", "--dry-run", "--yes", "--space", A]);
  assert(a.name === "worker" && a.to === B && a.as === "w2" && a.dryRun && a.yes && a.space === A && !a.keepBeads, "full flag set parses");
  assert(mv.parseMoveArgs(["w", "--to-space=x", "--as=y", "--keep-beads"]).to === "x", "--to-space= / --as= forms");
  throws(() => mv.parseMoveArgs(["w"]), /which space/, "no --to-space fails loud");
  throws(() => mv.parseMoveArgs(["--to-space", B]), /which agent/, "no agent fails loud");
  throws(() => mv.parseMoveArgs(["./w", "--to-space", B]), /not an agent name/, "a path is refused — move addresses by name");
  throws(() => mv.parseMoveArgs(["w", "x", "--to-space", B]), /one agent/, "two agents refused");
  throws(() => mv.parseMoveArgs(["w", "--to-space", B, "--as", "a b"]), /not an agent name/, "--as with a bad name refused");
  throws(() => mv.parseMoveArgs(["w", "--to-space", B, "--keep-beads"]), /only means something with --as/, "--keep-beads without --as refused");
  throws(() => mv.parseMoveArgs(["w", "--to-space", B, "--force"]), /unknown flag/, "unknown flag refused");
  const h = hoistAddressSpace("move", [`worker#${A}`, "--to-space", B]);
  assert(JSON.stringify(h) === JSON.stringify(["worker", "--to-space", B, "--space", A]), `worker#${A} hoists to --space ${A}; --to-space untouched (${JSON.stringify(h)})`);
  throws(() => hoistAddressSpace("move", ["worker#nosuch", "--to-space", B]), /unknown space "nosuch"/, "worker#<unknown space> fails loud");
}

// ── plan ───────────────────────────────────────────────────────────────────────────────────────────
console.log("plan");
const wFolder = seed("worker", { kit: true });
const wPin = readResumeId(personaFilePath(A, "worker"))!;
{
  const d = mv.moveDisk({ from: A, to: B, name: "worker", newName: "worker2" });
  assert(mv.moveBlockers(d, live, { yes: false, now }).length === 0, "an idle-for-20m running agent with a free name: no blockers");
  assert(d.items.map((i) => i.what).join(",") === "persona,kit,restarts", `moves persona, kit dir, restart history (${d.items.map((i) => i.what)})`);
  const plan = mv.movePlan(d, live, { beads: ["mv-1", "mv-2"], keepBeads: false, now }).join("\n");
  console.log(plan.replace(/^/gm, "      "));
  assert(plan.includes(`move worker (claude, ${wFolder}): space ${A} → ${B}, as "worker2"`), "header: name, harness, folder, spaces, new name");
  assert(plan.includes(`${A}/personas/worker.md → ${B}/personas/worker2.md  (resume: ${wPin})  name: worker2`), "persona line with pin + rewritten name");
  assert(plan.includes(`${A}/kit/worker → ${B}/kit/worker2`), "kit dir line");
  assert(plan.includes(`${A}/restarts/worker.json → ${B}/restarts/worker2.json`), "restart-history line");
  assert(plan.includes(`backup     ${A}/moved-to-${B}/  (the source copies — kept, never deleted)`), "backup line");
  assert(plan.includes(`running in ${A}, transcript written 20m ago — stopped there, started in ${B} as "worker2"`), "live line");
  assert(plan.includes(`session    stays — ${wPin} is keyed by its folder`), "session stays");
  assert(plan.includes(`2 open bead(s) reassigned "worker" → "worker2": mv-1, mv-2`), "bead reassignment line");
  const same = mv.movePlan(mv.moveDisk({ from: A, to: B, name: "worker" }), idle, { keepBeads: false, now }).join("\n");
  assert(same.includes("beads      stay — one machine-wide db") && same.includes(`not running — moved on disk only; \`paw start worker#${B}\``), "no --as: beads stay; not running: disk only");
  const kept = mv.movePlan(d, idle, { keepBeads: true, now, fleetJob: "/x/dev.cotal.paw.plist" }).join("\n");
  assert(kept.includes(`--keep-beads: open beads stay assigned to "worker"`) && kept.includes("login fleet job (/x/dev.cotal.paw.plist)"), "--keep-beads + fleet-job note");
}

// ── refusals ───────────────────────────────────────────────────────────────────────────────────────
console.log("refusals");
const blockersOf = (o: { to?: string; newName?: string; l?: import("../src/move.ts").MoveLive; yes?: boolean; name?: string } = {}) =>
  mv.moveBlockers(mv.moveDisk({ from: A, to: o.to ?? B, name: o.name ?? "worker", ...(o.newName ? { newName: o.newName } : {}) }), o.l ?? idle, { yes: o.yes ?? false, now });
const has = (bs: string[], re: RegExp, msg: string) => assert(bs.some((b) => re.test(b)), `${msg} — ${bs.find((b) => re.test(b)) ?? JSON.stringify(bs)}`);
has(blockersOf({ to: "nosuch" }), /unknown space "nosuch"/, "unknown target space");
has(blockersOf({ to: A }), /already in space/, "same space");
has(blockersOf({ to: A, newName: "x" }), /paw rename/, "same space with --as points at rename");
ensurePersonaFile(B, "worker");
has(blockersOf(), /space "mv-b" already has an agent "worker"/, "target already has the name");
assert(!blockersOf({ newName: "worker2" }).some((b) => /already has an agent/.test(b)), "--as a free name clears it");
rmSync(personaFilePath(B, "worker"));
setPersonaKeys(A, "worker", { teleported: "ssh:box", teleportedAt: "2026-10-01T00:00:00Z" });
has(blockersOf(), /teleported to ssh:box/, "teleported marker");
setPersonaKeys(A, "worker", { teleported: undefined, teleportedAt: undefined });
registerForeground(A, { name: "worker", folder: wFolder, pid: process.pid, startedAt: now, argv: [] });
has(blockersOf(), new RegExp(`foreground \`paw claude\` \\(pid ${process.pid}\\)`), "foreground agent");
unregisterForeground(A, "worker");
writeSleepRecord(A, { name: "worker", folder: wFolder, since: now, cursorSeq: 1, reason: "test" });
has(blockersOf(), /is asleep \(paw sleep\)/, "sleeping agent");
clearSleep(A, "worker");
has(blockersOf({ l: { ...live, strangers: ["pid 4242 (a standalone claude)"] } }), /held by pid 4242.*two writers/, "two-writer conflict");
has(blockersOf({ l: { ...idle, unmanaged: "peer p1" } }), /not under this machine's manager/, "live but unmanaged here");
has(blockersOf({ l: { ...idle, targetPresent: "peer p2" } }), /already present on "mv-b"'s mesh/, "name already present on the target mesh");
has(blockersOf({ l: { ...live, activeMs: now - 2 * 60_000 } }), /busy — its transcript was written 2m ago/, "busy (written < 10m ago) without --yes");
assert(blockersOf({ l: { ...live, activeMs: now - 2 * 60_000 }, yes: true }).length === 0, "busy + --yes: allowed");
assert(blockersOf({ l: { ...idle, activeMs: now - 1000 } }).length === 0, "a fresh transcript on a NOT running agent is not busy");
mkdirSync(join(spaces, B, "kit", "worker"), { recursive: true });
has(blockersOf(), /mv-b\/kit\/worker already exists/, "an existing target kit dir is never clobbered");
rmSync(join(spaces, B, "kit", "worker"), { recursive: true });
ensurePersonaFile(A, "orphan");
has(blockersOf({ name: "orphan" }), /no `cwd:`/, "orphan persona (no folder)");
setFolderName(B, wFolder, "theirs");
ensurePersonaFile(B, "theirs");
has(blockersOf({ newName: "worker2" }), /already has "theirs" as the agent for/, "target's default agent for the same folder");
registerInstance(A, wFolder, "worker-x");
ensurePersonaFile(A, "worker-x");
assert(!blockersOf({ name: "worker-x" }).some((b) => /as the agent for/.test(b)), "an EXTRA can join a folder that has a default there");
rmSync(personaFilePath(B, "theirs"));
rmSync(personaFilePath(A, "worker-x"));
assert(blockersOf().length === 0, "all refusals cleared → no blockers");

// ── the cutover ────────────────────────────────────────────────────────────────────────────────────
console.log("cutover");
{
  const d = mv.moveDisk({ from: A, to: B, name: "worker", newName: "worker2" });
  const { calls, deps } = fakeDeps();
  const r = await mv.applyMove(d, live, deps);
  assert(r.started, "it ran before → started in the target");
  assert(JSON.stringify(calls) === JSON.stringify([["stop", A, "worker"], ["start", B, "worker2"]]), `stop in source, then start in target (${JSON.stringify(calls)})`);
  const target = readFileSync(personaFilePath(B, "worker2"), "utf8");
  assert(/^name: worker2$/m.test(target) && readResumeId(personaFilePath(B, "worker2")) === wPin && target.includes(`cwd: ${wFolder}`), "target persona: name rewritten, same pin, same folder");
  assert(readFileSync(join(spaces, B, "kit", "worker2", "schedules.json"), "utf8").includes('"s"'), "kit dir copied under the new name");
  assert(existsSync(join(spaces, B, "restarts", "worker2.json")), "restart history moved");
  assert(!existsSync(personaFilePath(A, "worker")) && !existsSync(join(spaces, A, "kit", "worker")), "source paths gone from the source space");
  const bk = join(spaces, A, `moved-to-${B}`);
  assert(existsSync(join(bk, "worker.md")) && readResumeId(join(bk, "worker.md")) === wPin, "source persona backed up at moved-to-<to>/worker.md");
  assert(existsSync(join(bk, "kit", "worker", "schedules.json")) && existsSync(join(bk, "restarts", "worker.json")), "source kit dir + restart history backed up");
  // Back again, then forth again: the second backup must not overwrite the first.
  const back = mv.moveDisk({ from: B, to: A, name: "worker2", newName: "worker" });
  await mv.applyMove(back, idle, fakeDeps().deps);
  const again = mv.moveDisk({ from: A, to: B, name: "worker", newName: "worker2", stamp: "STAMP" });
  assert(again.backupRoot === join(bk, "STAMP"), `a second move to the same space backs up under a stamped dir (${again.backupRoot})`);
  const { calls: c2, deps: d2 } = fakeDeps();
  const r2 = await mv.applyMove(again, idle, d2);
  assert(!r2.started && c2.length === 0, "not running → nothing stopped or started");
  assert(existsSync(join(bk, "worker.md")) && existsSync(join(bk, "STAMP", "worker.md")), "both backups kept");
}

// ── hermes profile ─────────────────────────────────────────────────────────────────────────────────
console.log("hermes");
{
  seed("herm");
  setPersonaKeys(A, "herm", { agent: "hermes" });
  const prof = join(hermesRoot(), "profiles", `${A}-herm`);
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, "auth.json"), "{}");
  const d = mv.moveDisk({ from: A, to: B, name: "herm" });
  assert(d.hermes?.dst === join(hermesRoot(), "profiles", `${B}-herm`), "a paw-owned hermes profile follows to the target's profile id");
  assert(mv.movePlan(d, idle, { keepBeads: false, now }).some((l) => l.includes("its profile + login, moved")), "hermes plan line");
  await mv.applyMove(d, idle, fakeDeps().deps);
  assert(existsSync(join(hermesRoot(), "profiles", `${B}-herm`, "auth.json")) && !existsSync(prof), "profile renamed (login kept)");
  setPersonaKeys(B, "herm", { hermesHome: "/adopted/profile" });
  assert(mv.moveDisk({ from: B, to: A, name: "herm" }).hermes === undefined, "an adopted hermesHome: is not paw's to move");
}

// ── rollback ───────────────────────────────────────────────────────────────────────────────────────
console.log("rollback");
{
  seed("roller", { kit: true });
  const before = readFileSync(personaFilePath(A, "roller"), "utf8");
  const d = mv.moveDisk({ from: A, to: B, name: "roller" });
  const { calls, deps } = fakeDeps({ failStartIn: B });
  const msg = await rejects(mv.applyMove(d, live, deps), /move roller → mv-b failed: boom/, "a failed start in the target fails loud");
  assert(/rolled back/.test(msg), "…and says it rolled back");
  assert(JSON.stringify(calls) === JSON.stringify([["stop", A, "roller"], ["start", B, "roller"], ["stop", B, "roller"], ["start", A, "roller"]]), `stopped there, restarted here (${JSON.stringify(calls)})`);
  assert(readFileSync(personaFilePath(A, "roller"), "utf8") === before && existsSync(join(spaces, A, "kit", "roller", "schedules.json")), "source persona + kit dir restored byte for byte");
  assert(!existsSync(personaFilePath(B, "roller")) && !existsSync(join(spaces, B, "kit", "roller")), "target left clean");
  assert(!existsSync(join(spaces, A, `moved-to-${B}`, "roller.md")), "no stray backup");
  const { calls: c2, deps: d2 } = fakeDeps({ unreleased: true });
  await rejects(mv.applyMove(mv.moveDisk({ from: A, to: B, name: "roller" }), live, d2), /still held .* nothing was moved/, "a session still held after the stop refuses");
  assert(JSON.stringify(c2) === JSON.stringify([["stop", A, "roller"], ["start", A, "roller"]]) && existsSync(personaFilePath(A, "roller")), "…restarted in the source, nothing moved");
}

// ── --as: beads follow the name (temp beads db) ────────────────────────────────────────────────────
console.log("beads");
{
  const open1 = bd(["create", "open one", "-a", "worker2", "--silent"]);
  const open2 = bd(["create", "open two", "-a", "worker2", "--silent"]);
  const done = bd(["create", "done one", "-a", "worker2", "--silent"]);
  bd(["close", done, "--reason", "done"]);
  const other = bd(["create", "someone else's", "-a", "other", "--silent"]);
  const { openTaskIds } = await import("../src/tasks.ts");
  const ids = await openTaskIds("worker2");
  assert(ids.sort().join() === [open1, open2].sort().join(), `openTaskIds lists only the open beads (${ids})`);
  const r = await mv.moveBeads("worker2", "worker3");
  assert(r.errors.length === 0 && r.moved.sort().join() === [open1, open2].sort().join(), `moveBeads reassigns both open beads (${r.moved})`);
  const assignee = (id: string) => (JSON.parse(bd(["show", id, "--json"])) as Array<{ assignee?: string }>)[0]?.assignee;
  assert(assignee(open1) === "worker3" && assignee(open2) === "worker3", "open beads now on worker3");
  assert(assignee(done) === "worker2", "a closed bead keeps its historical assignee");
  assert(assignee(other) === "other", "someone else's bead untouched");
}

rmSync(home, { recursive: true, force: true });
rmSync(bdDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} move check(s) failed`);
  process.exit(1);
}
console.log("\nall move checks passed 🐾");

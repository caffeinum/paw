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
    assert(back.ProgramArguments.join(" ") === "/n /paw.ts start --boot z b --space paw", "fleet job: the plist now starts the new name (--boot kept)");
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
    execFileSync("bd", ["close", done, "--actor", "old-name"], { cwd: home, env, stdio: "ignore" });
    const { reassignOpenTasks } = await import("../src/tasks.ts");
    const moved = await reassignOpenTasks("old-name", "new-name");
    assert(moved.sort().join(",") === [open1, open2].sort().join(","), "beads: exactly the old name's OPEN beads move");
    const who = (id: string) =>
      (JSON.parse(execFileSync("bd", ["show", id, "--json"], { cwd: home, env, encoding: "utf8" })) as Array<{ assignee?: string }>)[0]?.assignee;
    assert(who(open1) === "new-name" && who(open2) === "new-name", "beads: moved beads now belong to the new name");
    assert(who(done) === "old-name", "beads: a closed bead keeps its historical assignee");
    assert(who(other) === "someone-else", "beads: another agent's bead is untouched");
    // companies: the roster key and the lead follow the name; other metadata keys survive
    const co = execFileSync("bd", ["create", "Acme", "-t", "epic", "-a", "old-name", "-l", "company:acme", "--metadata", JSON.stringify({ company: "acme", org: { "old-name": {}, x: {} }, note: "keep" }), "--silent"], { cwd: home, env, encoding: "utf8" }).trim();
    execFileSync("bd", ["close", co, "--actor", "old-name"], { cwd: home, env, stdio: "ignore" }); // closed: reassignOpenTasks won't move it
    const { renameInCompanies } = await import("../src/company-service.ts");
    const touched = await renameInCompanies("old-name", "new-name");
    const shown = (JSON.parse(execFileSync("bd", ["show", co, "--json"], { cwd: home, env, encoding: "utf8" })) as Array<{ assignee?: string; metadata?: { org?: Record<string, unknown>; note?: string; company?: string } }>)[0];
    assert(touched.join() === "acme", "companies: the company holding the old name is reported");
    assert(Object.keys(shown.metadata?.org ?? {}).sort().join() === "new-name,x" && shown.metadata?.note === "keep" && shown.metadata?.company === "acme", "companies: metadata.org key renamed, other keys kept");
    assert(shown.assignee === "new-name", "companies: the lead (epic assignee) follows the rename even on a closed epic");
    const { renameInMetadata } = await import("../src/company.ts");
    let clash = false;
    try { renameInMetadata({ company: "a", org: { p: {}, q: {} } }, "p", "q"); } catch { clash = true; }
    assert(clash, "companies: renaming onto a name already on the roster fails loud");
  } finally {
    process.env.HOME = realHome;
  }
}

// A DEFAULTED space gives way to the one local space holding the name (ai-keys, 2026-11-12: rename needed
// --space although the name was unique). A chosen one is kept; two matches fail loud with both commands.
{
  const { defaultedSpace, setFolderName } = await import("../src/addressing.ts");
  const f = mkdtempSync(join(tmpdir(), "paw-rename-def-"));
  setFolderName("rn-other", f, "lonely");
  const retry = (s: string) => `paw rename lonely#${s} solo`;
  const picked = defaultedSpace("lonely", "rn-default", false, retry);
  assert(picked.space === "rn-other" && /using lonely#rn-other, the only space that has it/.test(picked.note ?? ""), `defaulted: the only space holding it is used, with a note (${picked.space})`);
  assert(throws(() => defaultedSpace("lonely", "rn-default", true, retry)), "chosen: a --space / PAW_SPACE that lacks it is kept (fails loud)");
  setFolderName("rn-third", mkdtempSync(join(tmpdir(), "paw-rename-def-")), "lonely");
  let msg = "";
  try { defaultedSpace("lonely", "rn-default", false, retry); } catch (e) { msg = (e as Error).message; }
  assert(/paw rename lonely#rn-other solo\n\s+paw rename lonely#rn-third solo/.test(msg), "two spaces → fail loud with each exact command");
  assert(defaultedSpace("nobody", "rn-default", false, retry).space === "rn-default", "nowhere → the default stays (rename says no agent named …)");
}

// The rename trail: every on-disk rename records old → new, so a chat filtered to the old name follows it
// (`paw hire`: the new agent renames itself while the operator is already chatting with it).
{
  const { readRenameTrail, followTrail, renamedSince, recordRename } = await import("../src/rename-trail.ts");
  const { assertRenamable, renamedWakeText } = await import("../src/rename.ts");
  const trail = readRenameTrail(SPACE);
  assert(trail.web?.to === "api" && typeof trail.web.at === "number", "trail: the first rename (web → api) is recorded");
  assert(trail["web-alt"]?.to === "web-beta", "trail: an extra's rename is recorded too");
  assert(renamedSince(SPACE, "web", 0) === "api2", `trail: web → api → api2 is followed to the end (${renamedSince(SPACE, "web", 0)})`);
  assert(renamedSince(SPACE, "web", Date.now() + 60_000) === undefined, "trail: a rename from before `since` is not followed");
  assert(renamedSince(SPACE, "never-renamed", 0) === undefined, "trail: a name never renamed → undefined");
  assert(followTrail({ a: { to: "b", at: 5 }, b: { to: "a", at: 6 } }, "a", 0) === "b", "trail: a cycle stops instead of looping");
  assert(followTrail({ a: { to: "b", at: 5 }, b: { to: "c", at: 1 } }, "a", 3) === "b", "trail: an older hop out of the new name is not taken");
  recordRename(SPACE, "api2", "web");
  assert(readRenameTrail(SPACE).web === undefined, "trail: a name held again drops its stale trail out");
  assert(throws(() => assertRenamable(SPACE, "web-beta", "web-beta")), "self-rename precheck: the same name fails loud");
  assert(throws(() => assertRenamable(SPACE, "web-beta", "!!!")), "self-rename precheck: no usable characters fails loud");
  assert(throws(() => assertRenamable(SPACE, "web-beta", "queue2")), "self-rename precheck: a name another agent holds fails loud");
  assert(assertRenamable(SPACE, "web-beta", "login redirect") === "login-redirect", "self-rename precheck: a free name passes, cleaned");
  assert(renamedWakeText("hire-ab12", "login-redirect").includes('"login-redirect"'), "self-rename wake DM names the new name");

  // chat's follow decision (followTarget): a registered name follows only hops since the chat began; a name
  // no longer registered (a printed `paw chat @hire-…` run after the hire renamed itself) follows them all.
  const { followTarget } = await import("../src/rename-trail.ts");
  const t = { "hire-ab12": { to: "login-redirect", at: 1000 } };
  assert(followTarget(t, "hire-ab12", true, 2000) === undefined, "follow: still registered, renamed before the chat began → stays");
  assert(followTarget(t, "hire-ab12", false, 2000) === "login-redirect", "follow: no longer registered, renamed before the chat began → follows");
  assert(followTarget(t, "hire-ab12", true, 500) === "login-redirect", "follow: renamed during the chat → follows");
  assert(followTarget(t, "other", false, 0) === undefined, "follow: a name with no trail → stays");
}

// A corrupt renamed.json fails the rename WHOLE — read before anything moves, and the error names the file.
{
  const { writeFileSync } = await import("node:fs");
  const { spaceDir } = await import("../src/addressing.ts");
  const CS = "test-corrupt";
  const CF = "/fake/corrupt/web";
  setFolderName(CS, CF, "web");
  ensurePersonaFile(CS, "web");
  const trailFile = join(spaceDir(CS), "renamed.json");
  writeFileSync(trailFile, "{not json");
  let msg = "";
  try {
    renameAgentOnDisk(CS, CF, "api");
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes(trailFile), `corrupt trail: the error names the file (${msg})`);
  assert(existsSync(personaFilePath(CS, "web")) && !existsSync(personaFilePath(CS, "api")), "corrupt trail: the persona did not move");
  assert(lookupFolderName(CS, CF) === "web", "corrupt trail: the folder still maps to the old name");
  writeFileSync(trailFile, JSON.stringify({ x: { to: 5 } }));
  assert(throws(() => renameAgentOnDisk(CS, CF, "api")) && existsSync(personaFilePath(CS, "web")), "a malformed trail entry also fails before anything moves");
}

// The self-rename halves with their outside reach stubbed: renameSelf (in the agent's turn) and renameChild
// (the detached child: wait for the turn → idle re-check right before the move → rename → always finish).
{
  const { renameSelf, renameChild, renamedWakeText } = await import("../src/rename.ts");
  type Turn = { ended: boolean; why: string };
  const mk = (o: { spawnOk?: boolean; waits?: Array<{ ended: true } | { ended: false; why: string }>; idles?: Turn[]; renameFails?: string; wakeOk?: boolean } = {}) => {
    const calls: string[] = [];
    const logged: string[] = [];
    const waits = [...(o.waits ?? [{ ended: true }])];
    const idles = [...(o.idles ?? [{ ended: true, why: "idle" }])];
    const deps = {
      spawn: (_s: string, sub: string[], key: string) => (calls.push(`spawn ${sub.join(" ")} key=${key}`), o.spawnOk ?? true),
      watch: async (_s: string, n: string) => {
        calls.push(`watch ${n}`);
        return {
          wait: async () => (calls.push("wait"), waits.shift() ?? { ended: true as const }),
          idle: async () => (calls.push("idle"), idles.shift() ?? { ended: true, why: "idle" }),
          close: async () => void calls.push("close"),
        };
      },
      renameNow: async (_s: string, target: string, newName: string, beforeMove: () => Promise<void>) => {
        await beforeMove();
        calls.push(`renameNow ${target} ${newName}`);
        if (o.renameFails) throw new Error(o.renameFails);
      },
      wake: (_s: string, n: string, text: string) => (calls.push(`wake ${n}: ${text}`), { ok: o.wakeOk ?? true, detail: "x" }),
      finish: (_s: string, key: string) => void calls.push(`finish ${key}`),
      markPending: (_s: string, from: string, to: string) => void calls.push(`markPending ${from} ${to}`),
      clearPending: (_s: string, from: string) => void calls.push(`clearPending ${from}`),
      log: (l: string) => void logged.push(l),
    };
    return { calls, logged, deps };
  };
  const err = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  // renameSelf: refusals before the spawn; the child is spawned with the cleaned name and the from-key.
  const s1 = mk();
  assert(renameSelf(SPACE, "web-beta", "login redirect", s1.deps) === "login-redirect", "self: returns the cleaned new name");
  assert(s1.calls[0] === `spawn rename web-beta login-redirect --space ${SPACE} key=web-beta`, `self: spawns the child keyed by the old name (${s1.calls[0]})`);
  assert(s1.calls[1] === "markPending web-beta login-redirect", `self: marks the rename queued once the child is spawned (${s1.calls[1]})`);
  assert(s1.logged.some((l) => /don't check `paw status`/.test(l)), "self: tells the agent not to check paw status mid-turn");
  const s2 = mk();
  assert(throws(() => renameSelf(SPACE, "web-beta", "queue2", s2.deps)) && s2.calls.length === 0, "self: a taken name fails loud, nothing spawned");
  const s3 = mk({ spawnOk: false });
  assert(throws(() => renameSelf(SPACE, "web-beta", "fresh-name", s3.deps)) && !s3.calls.some((c) => c.startsWith("markPending")), "self: a rename already in flight (pidfile held) fails loud, marks nothing");

  // renameChild: the happy path.
  const c1 = mk();
  await renameChild(SPACE, "hire-ab12", "login-redirect", c1.deps);
  assert(c1.calls.join(" | ") === "watch hire-ab12 | wait | idle | renameNow hire-ab12 login-redirect | close | clearPending hire-ab12 | finish hire-ab12", `child: wait → idle → rename → close → finish (${c1.calls.join(" | ")})`);

  // An operator line started a new turn during the wait: it is waited out before anything moves.
  const c2 = mk({ idles: [{ ended: false, why: "mid-turn" }, { ended: true, why: "idle" }], waits: [{ ended: true }, { ended: true }] });
  await renameChild(SPACE, "hire-ab12", "login-redirect", c2.deps);
  assert(c2.calls.join(" | ") === "watch hire-ab12 | wait | idle | wait | idle | renameNow hire-ab12 login-redirect | close | clearPending hire-ab12 | finish hire-ab12", `child: a turn started late is waited out before the move (${c2.calls.join(" | ")})`);

  // The turn never ends: nothing renamed, the agent is told, the pidfile is freed.
  const c3 = mk({ waits: [{ ended: false, why: "did not finish its turn within 30m (last: busy)" }] });
  const m3 = await err(() => renameChild(SPACE, "hire-ab12", "login-redirect", c3.deps));
  assert(/nothing was renamed/.test(m3) && !c3.calls.some((c) => c.startsWith("renameNow")), "child: a turn that never ends → fails loud, nothing renamed");
  assert(c3.calls.some((c) => c.startsWith("wake hire-ab12: ✕ paw rename gave up")) && c3.calls.slice(-2).join(" | ") === "clearPending hire-ab12 | finish hire-ab12", "child: …the agent is woken with why, the marker cleared, the pidfile freed");

  // The rename itself fails: the agent hears it under its OLD name, the error propagates, the pidfile is freed.
  const c4 = mk({ renameFails: "the name is taken" });
  const m4 = await err(() => renameChild(SPACE, "hire-ab12", "login-redirect", c4.deps));
  assert(m4 === "the name is taken", "child: a failed rename propagates its error");
  assert(c4.calls.some((c) => c.startsWith('wake hire-ab12: ✕ paw rename to "login-redirect" failed: the name is taken')), "child: …and wakes the agent under its old name");
  assert(c4.calls.slice(-3).join(" | ") === "close | clearPending hire-ab12 | finish hire-ab12", "child: …the watch is closed, the marker cleared and the pidfile freed");

  // The late turn never ends either: fail before the move.
  const c5 = mk({ idles: [{ ended: false, why: "mid-turn" }], waits: [{ ended: true }, { ended: false, why: "did not finish" }] });
  const m5 = await err(() => renameChild(SPACE, "hire-ab12", "login-redirect", c5.deps));
  assert(/nothing was renamed/.test(m5) && !c5.calls.some((c) => c.startsWith("renameNow")) && c5.calls.at(-1) === "finish hire-ab12", "child: a late turn that never ends → nothing renamed, pidfile freed");
  const wake = renamedWakeText("hire-da9dcc", "coach");
  assert(/while you were switching/.test(wake) && /ask your question now/.test(wake), "wake DM: says held lines follow it and that now is the time to ask");
}

// A queued self-rename (spaces/<s>/renaming.json) and chat's hold while it is in flight (team2027, 2026-11-25:
// "me" typed to hire-da9dcc while it restarted as coach reached nobody; the footer said "○ offline").
{
  const { readRenamePending, markRenamePending, clearRenamePending, pendingRenameOf, renamingTag, renameHeldLine, RenameHold, RENAME_PENDING_MAX_MS } = await import("../src/rename-trail.ts");
  const PS = "test-pending";
  assert(JSON.stringify(readRenamePending(PS)) === "{}", "pending: none by default");
  markRenamePending(PS, "hire-da9dcc", "coach", 1000);
  assert(readRenamePending(PS)["hire-da9dcc"]?.to === "coach", "pending: marked hire-da9dcc → coach");
  assert(pendingRenameOf(readRenamePending(PS), "hire-da9dcc", 2000) === "coach", "pending: fresh → renaming to coach");
  assert(pendingRenameOf(readRenamePending(PS), "hire-da9dcc", 1000 + RENAME_PENDING_MAX_MS + 1) === undefined, "pending: a marker older than any child's wait is ignored");
  assert(pendingRenameOf(readRenamePending(PS), "coach", 2000) === undefined, "pending: only the old name is mid-rename");
  clearRenamePending(PS, "hire-da9dcc");
  clearRenamePending(PS, "hire-da9dcc");
  assert(JSON.stringify(readRenamePending(PS)) === "{}", "pending: cleared (twice is fine)");
  const { writeFileSync } = await import("node:fs");
  const { spaceDir } = await import("../src/addressing.ts");
  writeFileSync(join(spaceDir(PS), "renaming.json"), "[1]");
  assert(throws(() => readRenamePending(PS)), "pending: a malformed marker file fails loud");
  writeFileSync(join(spaceDir(PS), "renaming.json"), "{}");

  // chat's footer during the switch
  assert(renamingTag("hire-da9dcc", "coach") === "hire-da9dcc ◌ renaming to coach…", `chat footer: ${renamingTag("hire-da9dcc", "coach")}`);
  assert(!/offline/.test(renamingTag("hire-da9dcc", "coach")), "chat footer: never a bare offline mid-rename");
  assert(/sends to coach/.test(renameHeldLine("hire-da9dcc", "coach")), "chat: the held line names where it goes");

  // The incident, replayed: queued → "me" typed → trail hop → marker cleared → coach live → "me" goes to coach.
  const h = new RenameHold();
  assert(h.active === undefined, "hold: idle until a rename is queued");
  h.begin("hire-da9dcc", "coach");
  assert(h.active?.from === "hire-da9dcc" && h.active.to === "coach" && h.active.held === 0, "hold: renaming state from the marker");
  assert(h.hold("me") === true && h.hold("and you") === false, "hold: the first held line is announced once");
  const liveSet = new Set<string>();
  const live = (n: string) => liveSet.has(n);
  assert(h.settle({ stillPending: true, renamedTo: undefined, live }) === undefined, "hold: nothing sent while the rename is queued");
  assert(h.settle({ stillPending: true, renamedTo: "coach", live }) === undefined, "hold: nothing sent after the persona moved but before the wake DM went");
  assert(h.settle({ stillPending: false, renamedTo: "coach", live }) === undefined, "hold: nothing sent until coach is live");
  assert(JSON.stringify(h.all()) === JSON.stringify([{ to: "coach", text: "me" }, { to: "coach", text: "and you" }]), "hold: a quit meanwhile lists the held lines");
  liveSet.add("coach");
  const out = h.settle({ stillPending: false, renamedTo: "coach", live });
  assert(out?.to === "coach" && out.landed && JSON.stringify(out.lines) === JSON.stringify(["me", "and you"]), "hold: the lines typed mid-rename reach the NEW name, in order");
  assert(h.active === undefined && h.all().length === 0, "hold: done — back to normal sends");

  // A rename that gave up: the lines go to the old name, which the child woke again.
  const g = new RenameHold();
  g.begin("hire-ab12", "login");
  g.hold("hello");
  const back = g.settle({ stillPending: false, renamedTo: undefined, live: (n) => n === "hire-ab12" });
  assert(back?.to === "hire-ab12" && !back.landed && back.lines[0] === "hello", "hold: a rename that didn't land → the lines go to the old name");
  assert(throws(() => new RenameHold().hold("x")), "hold: holding with no rename in flight fails loud");
}

if (failures > 0) {
  console.error(`\n${failures} paw rename check(s) failed`);
  process.exit(1);
}
console.log("\nall paw rename checks passed 🐾");

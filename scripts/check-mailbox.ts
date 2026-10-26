/**
 * check:mailbox — the "you" beacon is owned by COMMAND SIGNATURE, and a space is one PAW_HOME's.
 *
 * The 2026-10-21 incident: a test run with a fresh PAW_HOME and `PAW_SPACE=` (set, EMPTY) resolved to
 * the live `paw` space, found no mailbox pid in its own home, and started a second beacon there — which
 * minted a new human id, so the live mesh carried two "you" peers for days.
 *
 *   1. resolveSpace: unset → `paw`; empty / whitespace → throws; a value is trimmed.
 *   2. mailboxArgs carries `--home <PAW_HOME>` last, and mailboxMatchPattern still matches it space-exactly.
 *   3. mailboxOwnerHome (pure): the `--home` marker; a legacy beacon's env PAW_HOME; no PAW_HOME → ~/.paw;
 *      unreadable env → throws.
 *   4. ensureMailbox ADOPTS a beacon of our home already running (marker or legacy env) — spawns nothing.
 *   5. ensureMailbox REFUSES (throws) when the space's beacon belongs to another PAW_HOME.
 *
 * Hermetic: temp PAW_HOME, PAW_SPACE=test-mailbox-<pid>, PAW_RELEASE=dev. The "beacons" are sleepers
 * named `<tmp>/bin/paw.ts mailbox --space <test space> …` — no mesh, no live daemon is ever looked at
 * (every scan is space-exact on the test space), and each is killed on teardown.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "paw-mailbox-"));
const HOME_A = join(base, "home-a");
const HOME_B = join(base, "home-b");
for (const d of [HOME_A, HOME_B, join(base, "bin")]) mkdirSync(d, { recursive: true });
const SPACE = `test-mailbox-${process.pid}`;
process.env.PAW_HOME = HOME_A;
process.env.PAW_RELEASE = "dev";
process.env.PAW_SPACE = SPACE;

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
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message}`);
  }
}

const { resolveSpace } = await import("../src/space.ts");
const lc = await import("../src/lifecycle.ts");

console.log("1. resolveSpace");
{
  const saved = process.env.PAW_SPACE;
  delete process.env.PAW_SPACE;
  assert(resolveSpace() === "paw", "unset PAW_SPACE → the default `paw`");
  process.env.PAW_SPACE = "";
  throws(() => resolveSpace(), /PAW_SPACE is set but empty/, "empty PAW_SPACE fails loud");
  process.env.PAW_SPACE = "   ";
  throws(() => resolveSpace(), /PAW_SPACE is set but empty/, "whitespace PAW_SPACE fails loud");
  process.env.PAW_SPACE = "";
  throws(() => lc.ensureSpaceFor("x-local"), /PAW_SPACE is set but empty/, "ensureSpaceFor (the CLI gate's space) fails loud too");
  process.env.PAW_SPACE = ` ${SPACE} `;
  assert(resolveSpace() === SPACE, "a set PAW_SPACE is trimmed");
  process.env.PAW_SPACE = saved;
}

console.log("2. argv + signature");
{
  const args = lc.mailboxArgs(SPACE);
  assert(JSON.stringify(args) === JSON.stringify(["mailbox", "--space", SPACE, "--home", HOME_A]), `mailboxArgs = ${args.join(" ")}`);
  const line = `/n/node /r/bin/paw.ts ${args.join(" ")}`;
  assert(new RegExp(lc.mailboxMatchPattern(SPACE)).test(line), "the signature matches a --home beacon");
  assert(!new RegExp(lc.mailboxMatchPattern(`${SPACE}1`)).test(line), "…space-exactly (a longer space doesn't match)");
  assert(new RegExp(lc.mailboxMatchPattern(SPACE)).test(`/n/node /r/bin/paw.ts mailbox --space ${SPACE}`), "…and a legacy marker-less beacon");
}

console.log("3. mailboxOwnerHome");
{
  const cmd = `/n/node /r/bin/paw.ts mailbox --space s --home /h/with space`;
  assert(lc.mailboxOwnerHome(cmd, undefined) === "/h/with space", "the --home marker wins (spaces kept)");
  const legacy = `/n/node /r/bin/paw.ts mailbox --space s`;
  assert(lc.mailboxOwnerHome(legacy, `${legacy} TMPDIR=/t PAW_HOME=/x/home PATH=/bin:/usr/bin`) === "/x/home", "legacy: PAW_HOME from the env");
  assert(lc.mailboxOwnerHome(legacy, `${legacy} TMPDIR=/t PATH=/bin PAW_HOME=/x/home`) === "/x/home", "legacy: PAW_HOME last in the env");
  assert(lc.mailboxOwnerHome(legacy, `${legacy} TMPDIR=/t PATH=/bin`) === join(homedir(), ".paw"), "legacy: no PAW_HOME → ~/.paw");
  throws(() => lc.mailboxOwnerHome(legacy, legacy), /can't tell which PAW_HOME/, "legacy with no readable env fails loud");
  throws(() => lc.mailboxOwnerHome(legacy, undefined), /can't tell which PAW_HOME/, "legacy with no env at all fails loud");
}

// ---- fake beacons: sleepers whose argv carries the mailbox signature ----
const fakeEntry = join(base, "bin", "paw.ts");
writeFileSync(fakeEntry, "setInterval(() => {}, 1 << 30);\n");
const kids: ChildProcess[] = [];
async function fakeBeacon(extra: string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fakeEntry, "mailbox", "--space", SPACE, ...extra], { env, stdio: "ignore" });
  kids.push(child);
  for (let i = 0; i < 50 && !lc.mailboxProcs(SPACE).includes(child.pid!); i++) await new Promise((r) => setTimeout(r, 50));
  return child;
}
function kill(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once("exit", () => r());
    child.kill("SIGKILL");
  });
}
const mailboxLog = join(HOME_A, "spaces", SPACE, "mailbox.log");
const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() };

try {
  console.log("4. adopt by signature");
  {
    const ours = await fakeBeacon(["--home", HOME_A], baseEnv);
    assert(lc.mailboxProcs(SPACE).includes(ours.pid!), "the fake beacon is found by signature");
    assert(lc.adoptRunningMailbox(SPACE) === true, "a --home beacon of our PAW_HOME is adopted");
    lc.ensureMailbox(SPACE);
    assert(!existsSync(mailboxLog), "ensureMailbox spawned nothing (no mailbox.log, no pid file consulted)");
    assert(lc.mailboxProcs(SPACE).length === 1, "still exactly one beacon");
    await kill(ours);

    const legacy = await fakeBeacon([], { ...baseEnv, PAW_HOME: HOME_A });
    assert(lc.adoptRunningMailbox(SPACE) === true, "a legacy (marker-less) beacon whose env PAW_HOME is ours is adopted");
    await kill(legacy);
    assert(lc.adoptRunningMailbox(SPACE) === false, "nothing running → not adopted (ensureMailbox would spawn)");
  }

  console.log("5. refuse a foreign PAW_HOME");
  {
    const foreign = await fakeBeacon(["--home", HOME_B], baseEnv);
    throws(() => lc.ensureMailbox(SPACE), /from another PAW_HOME/, "ensureMailbox throws on a --home beacon of another home");
    assert(!existsSync(mailboxLog), "…and spawned no second beacon");
    await kill(foreign);

    const legacyForeign = await fakeBeacon([], { ...baseEnv, PAW_HOME: HOME_B });
    throws(() => lc.ensureMailbox(SPACE), /from another PAW_HOME/, "…and on a legacy beacon whose env PAW_HOME is another home");
    await kill(legacyForeign);

    const legacyDefault = await fakeBeacon([], baseEnv);
    throws(() => lc.ensureMailbox(SPACE), /from another PAW_HOME/, "…and on a legacy beacon of the default ~/.paw (no PAW_HOME in its env)");
    await kill(legacyDefault);
  }
} finally {
  await Promise.all(kids.map(kill));
  rmSync(base, { recursive: true, force: true });
}

if (failures) {
  console.error(`\ncheck:mailbox — ${failures} FAILED`);
  process.exit(1);
}
console.log("\ncheck:mailbox — all ok");

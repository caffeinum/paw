/**
 * END-TO-END (not in CI): `paw status --problems` against a real, ISOLATED mesh + manager. No claude agent
 * is ever spawned and no settings-writing command runs — the agents are personas with no seat.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/e2e-problems.ts
 *
 *   1 `paw status` brings up mesh + manager (+ mailbox)
 *   2 ghost1 (folder there) + ghost2 (folder removed) registered and named in live.json; sleeper asleep
 *     with no waiting DM; corrupt with an unreadable sleep record
 *   3 `--problems --json`: live-record ghost1 · folder-gone ghost2 · sleep-corrupt corrupt · nothing for sleeper
 *   4 `paw down`, then `--problems`: one manager-down row whose s lists exactly ghost1 ghost2, and no daemon started
 *   5 teardown: `paw down` + purgeTestSpace
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.PAW_HOME ?? "";
const space = process.env.PAW_SPACE ?? "";
if (!home || !space.startsWith("test-") || process.env.PAW_RELEASE !== "dev") throw new Error("isolated run only: PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const paw = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "bin", "paw.mjs"), ...args], { encoding: "utf8", env: process.env, timeout: 180_000 });
const pgrepSpace = () => {
  try {
    return execFileSync("pgrep", ["-f", `space ${space}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fails++;
};

try {
  ok(paw("status").status === 0, "paw status brought the isolated space up");
  const personas = join(home, "spaces", space, "personas");
  mkdirSync(personas, { recursive: true });
  for (const n of ["ghost1", "ghost2", "sleeper", "corrupt"]) {
    mkdirSync(join(home, "w", n), { recursive: true });
    writeFileSync(join(personas, `${n}.md`), `---\nname: ${n}\ncwd: ${join(home, "w", n)}\n---\n`);
  }
  rmSync(join(home, "w", "ghost2"), { recursive: true });
  writeFileSync(join(home, "spaces", space, "live.json"), JSON.stringify({ space, bootAt: 0, at: new Date().toISOString(), names: ["ghost1", "ghost2"] }));
  const sleep = join(home, "spaces", space, "sleep");
  mkdirSync(sleep, { recursive: true });
  writeFileSync(join(sleep, "sleeper.json"), JSON.stringify({ name: "sleeper", folder: join(home, "w", "sleeper"), since: Date.now() - 3_600_000, cursorSeq: 0, reason: "e2e" }));
  writeFileSync(join(sleep, "corrupt.json"), "{bad");

  const r = paw("status", "--problems", "--json");
  const j = JSON.parse(r.stdout) as { spaces: Array<{ read: string }>; problems: Array<{ reason: string; name: string }>; errors: string[] };
  const by = (n: string) => j.problems.find((p) => p.name === n)?.reason;
  ok(r.status === 0 && j.spaces[0]?.read === "ok" && j.errors.length === 0, `--problems --json read the space (${r.stderr.trim()})`);
  ok(by("ghost1") === "live-record" && by("ghost2") === "folder-gone" && by("corrupt") === "sleep-corrupt" && by("sleeper") === undefined, `rows: ${j.problems.map((p) => `${p.reason}:${p.name}`).join(" ")}`);

  paw("down");
  const before = pgrepSpace();
  const d = paw("status", "--problems", "--json");
  const dj = JSON.parse(d.stdout) as { spaces: Array<{ read: string }>; problems: Array<{ reason: string; actions: Array<{ key?: string; argv?: string[] }> }> };
  const md = dj.problems[0];
  ok(d.status === 0 && dj.spaces[0]?.read === "manager-down" && dj.problems.length === 1 && md?.reason === "manager-down", "manager stopped → one manager-down row");
  ok(JSON.stringify(md?.actions.find((a) => a.key === "s")?.argv) === JSON.stringify(["start", "ghost1", "ghost2", "--space", space]), "its s lists exactly the recorded names");
  ok(pgrepSpace() === before, "--problems started nothing (no mesh, manager or mailbox)");
} finally {
  paw("down");
  const { purgeTestSpace } = await import("../src/prune.ts");
  const { pawServer } = await import("../src/server.ts");
  await purgeTestSpace(space, pawServer(space)).catch((e: Error) => console.error(`teardown: ${e.message}`));
}
if (fails) process.exit(1);
console.log("e2e-problems ok");
process.exit(0);

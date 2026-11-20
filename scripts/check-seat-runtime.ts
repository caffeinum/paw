/**
 * Persona `runtime:` — one agent's seat on a runtime other than its space's manager (cotal >=0.107 picks
 * a runtime per seat). docs/notes/lifecycle.md#per-seat-runtime
 *
 * Hermetic (always): the persona key's grammar, the seat-over-manager overlay every pane reader uses, the
 * manager-feature gate, and that cotal's spawn contract still takes `runtime`.
 *
 * Live (PAW_SEAT_RUNTIME_LIVE=1, an isolated PAW_HOME + test-* space enforced): a pty manager launches a
 * `runtime: tmux` agent into a tmux window on the default socket, status says tmux, a full manager restart
 * brings it back there, and `paw down` leaves no `cotal-<space>` session behind. Needs claude + tmux;
 * the agent runs haiku.
 *   PAW_HOME=$(mktemp -d /tmp/pw.XXXX) PAW_SPACE=test-sr-$$ PAW_RELEASE=dev PAW_SEAT_RUNTIME_LIVE=1 pnpm check:seat-runtime
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const live = process.env.PAW_SEAT_RUNTIME_LIVE === "1";
if (!live) process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-seatrt-home-"));
const space = live ? process.env.PAW_SPACE?.trim() : "seatrt";
if (live) {
  const home = process.env.PAW_HOME?.trim();
  if (!home || home === join(homedir(), ".paw")) throw new Error("check:seat-runtime live: set an isolated PAW_HOME (never ~/.paw)");
  if (!space?.startsWith("test-")) throw new Error(`check:seat-runtime live: PAW_SPACE must be a test-* space, got ${JSON.stringify(space)}`);
  if (process.env.PAW_RELEASE !== "dev") throw new Error("check:seat-runtime live: PAW_RELEASE=dev (the manager must run this checkout)");
}

const { readSeatRuntime } = await import("../src/session.ts");
const { seatRuntimeOf } = await import("../src/seat-runtime.ts");
const { personaFilePath } = await import("../src/addressing.ts");
const { notTmuxMessage } = await import("../src/commands/unstick.ts");
const { SEAT_RUNTIME_FEATURE } = await import("../src/manager-features.ts");
const { SPAWN_INPUT_KEYS } = await import("@cotal-ai/manager");

let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`seat-runtime: ${m}`);
  n++;
  console.log(`  ok  ${m}`);
};
const throwsWith = (f: () => unknown, re: RegExp) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};

const dir = mkdtempSync(join(tmpdir(), "paw-seatrt-"));
const persona = (body: string) => {
  const p = join(dir, `p${n}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(p, `---\nname: x\n${body}---\nbrief\n`);
  return p;
};
ok(readSeatRuntime(persona("")) === undefined, "no runtime: key = the manager's own");
ok(readSeatRuntime(persona("runtime: tmux\n")) === "tmux", "runtime: tmux");
ok(readSeatRuntime(persona("runtime: pty\n")) === "pty", "runtime: pty");
ok(readSeatRuntime(persona('runtime: "tmux"\n')) === "tmux", "a quoted value reads the same");
ok(readSeatRuntime(undefined) === undefined, "no persona = no key");
ok(throwsWith(() => readSeatRuntime(persona("runtime: cmux\n")), /paw runtime cmux/), "cmux per seat refused, naming `paw runtime cmux`");
ok(throwsWith(() => readSeatRuntime(persona("runtime: tmx\n")), /expected pty or tmux/), "a typo fails loud");

if (!live) {
  const p = personaFilePath(space!, "a");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "---\nname: a\nruntime: tmux\n---\n");
  writeFileSync(personaFilePath(space!, "b"), "---\nname: b\n---\n");
  ok(seatRuntimeOf(space!, "a", "pty") === "tmux", "the seat's runtime wins over a pty manager");
  ok(seatRuntimeOf(space!, "b", "pty") === "pty" && seatRuntimeOf(space!, "b", "cmux") === "cmux", "no key: the manager's runtime");
  ok(seatRuntimeOf(space!, "nobody", "tmux") === "tmux", "no persona: the manager's runtime");
  ok(seatRuntimeOf(space!, "b", undefined) === undefined, "no manager runtime and no key = unknown, never a guess");
}
ok(/runtime: tmux. in its persona/.test(notTmuxMessage("x", "pty", "paw type", "type into")), "the not-tmux refusal names the per-agent fix");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const features = JSON.parse(readFileSync(join(root, "src", "manager-features.json"), "utf8")).features as string[];
ok(features.includes(SEAT_RUNTIME_FEATURE), `manager-features.json lists ${SEAT_RUNTIME_FEATURE} (an older release's manager refuses a spawn's runtime)`);
ok(SPAWN_INPUT_KEYS.includes("runtime"), "cotal's spawn contract takes a per-seat runtime");

if (live) await liveCheck(space!);
console.log(`✓ check:seat-runtime — ${n} assertions${live ? " (live)" : ""}`);

async function liveCheck(space: string): Promise<void> {
  const paw = (args: string[], timeout = 240_000) => {
    const r = spawnSync(process.execPath, [join(root, "bin", "paw.mjs"), ...args], { encoding: "utf8", timeout, env: { ...process.env, PAW_MODEL: "haiku", PAW_ALLOW_ANY_CWD: "1" } });
    return { code: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const session = `cotal-${space}`;
  const windows = () => {
    const r = spawnSync("tmux", ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}"], { encoding: "utf8" });
    return (r.stdout ?? "").split("\n").filter((l) => l.startsWith(`${session}\t`)).map((l) => l.split("\t")[1]);
  };
  const statusRuntime = () => {
    const r = paw(["status", "--json"], 60_000);
    if (r.code !== 0) throw new Error(`paw status --json failed: ${r.out}`);
    const { rows } = JSON.parse(r.stdout) as { rows: { name: string; runtime?: string }[] };
    return rows.find((row) => row.name === "seatrt")?.runtime;
  };
  const managerCmd = () => execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" }).split("\n").find((l) => l.includes("supervise") && l.includes(`--space ${space} `)) ?? "";
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "pf.")));
  try {
    const opened = paw(["open", folder, "--name", "seatrt", "--no-attach"]);
    ok(opened.code === 0, `the agent boots under the pty manager (${opened.out.trim().split("\n").at(-1)})`);
    const p = personaFilePath(space, "seatrt");
    writeFileSync(p, readFileSync(p, "utf8").replace(/\n---\n/, "\nruntime: tmux\n---\n"));
    ok(paw(["stop", "seatrt"], 60_000).code === 0, "stopped to pick up runtime: tmux");
    const started = paw(["start", "seatrt"]);
    ok(started.code === 0, `started again (${started.out.trim().split("\n").at(-1)})`);
    ok(!/--runtime/.test(managerCmd()), "the manager itself still runs pty");
    ok(windows().includes("seatrt"), `the seat is a tmux window in ${session} on the default socket`);
    ok(statusRuntime() === "tmux", "paw status says tmux for it");
    const restarted = paw(["restart", "--full"], 300_000);
    ok(restarted.code === 0 && /brought back 1\/1/.test(restarted.out), "a full manager restart brings it back");
    ok(windows().includes("seatrt") && statusRuntime() === "tmux", "…in tmux again");
  } finally {
    const down = paw(["down"], 120_000);
    console.log(down.out.trim().replace(/^/gm, "  · "));
    const { purgeTestSpace } = await import("../src/prune.ts");
    const { pawServer } = await import("../src/server.ts");
    await purgeTestSpace(space, pawServer()).catch((e) => console.error(`  ! purge ${space}: ${(e as Error).message}`));
  }
  const left = windows();
  if (left.length) spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
  ok(!left.length, `paw down left no ${session} session (found: ${left.join(", ") || "none"})`);
}

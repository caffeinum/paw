/**
 * Hermetic check for `!cmd` against a SANDBOXED agent (src/sandbox-exec.ts): the command goes through
 * `container exec -w <folder> <live id> … bash -lc <command>` — never a host shell — with the command as one
 * argv element; an agent without `sandbox:` still runs on the host, unchanged; a VM that isn't running fails
 * loud; output streams while the command runs. Against a FAKE `container` (no VM). Run: pnpm check:sandbox-bang
 *
 * `PAW_SANDBOX_BANG_SMOKE=1` adds a real smoke when `container system status` is up: a THROWAWAY container
 * labelled like a paw agent of an isolated space (never a live agent's), the bang path run against it, deleted after.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-sbxbang-")));
const realPath = process.env.PATH;
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ROOT = home;
process.env.PAW_SERVER = "nats://127.0.0.1:1";
for (const k of ["PAW_SPACE", "PAW_COTAL_HUB", "PAW_CONTAINER", "COTAL_NAME", "COTAL_SPACE"]) delete process.env[k];
const SPACE = `test-sbxbang-${process.pid}`;

let failures = 0;
const assert = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const throwsLike = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};

// The fake `container`: every call's argv, NUL-separated, one record per call; `ls` prints $FAKE_LS;
// `exec` streams two lines a second apart (the "prints a URL, then waits" shape), or exits $FAKE_EXEC_CODE.
const fakeLog = join(home, "container.log");
const lsJson = join(home, "ls.json");
const fake = join(home, "fakebin", "container");
mkdirSync(dirname(fake));
writeFileSync(
  fake,
  `#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a"; done >> "${fakeLog}"; printf '\\n' >> "${fakeLog}"
case "$1" in
  ls) cat "${lsJson}" ;;
  exec) [ -n "$FAKE_EXEC_CODE" ] && exit "$FAKE_EXEC_CODE"; echo "open https://example.test/login"; sleep 1; echo "logged in" >&2 ;;
esac
`,
);
chmodSync(fake, 0o755);
process.env.PAW_CONTAINER = fake;
const calls = (): string[][] => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => l.split("\0").slice(0, -1)) : []);
const row = (id: string, agent: string, state: string, space = SPACE) => ({ configuration: { id, labels: { "paw.space": space, "paw.agent": agent } }, status: { state } });
const setLs = (rows: unknown[]) => writeFileSync(lsJson, JSON.stringify(rows));

const { personaFilePath } = await import("../src/addressing.ts");
const { bashMessage } = await import("../src/bash.ts");
const sx = await import("../src/sandbox-exec.ts");

const folder = join(home, "work");
mkdirSync(folder);
const persona = (name: string, sandboxed: boolean) => {
  const p = personaFilePath(SPACE, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\nname: ${name}\ncwd: ${folder}\n${sandboxed ? "sandbox: container\n" : ""}---\n`);
};
persona("plain", false);
persona("boxed", true);

console.log("an agent without sandbox: runs on the host, unchanged");
{
  setLs([]);
  writeFileSync(fakeLog, "");
  const place = sx.bangPlace(SPACE, "plain");
  assert(place.kind === "host", "bangPlace → host");
  const r = await sx.runBang("pwd; echo $0", folder, place);
  assert(r.output.split("\n")[0] === folder && r.code === 0 && r.vm === undefined, `runs in the folder through the host shell (${JSON.stringify(r.output)})`);
  assert(calls().length === 0, "…and never calls `container`");
  assert(sx.bangWhere("plain", folder, place) === `in ${folder}`, "the echoed label is the old `in <folder>`");
  assert(bashMessage(r).startsWith(`I ran this in ${folder}:`), "the agent's transcript reads as before");
}

console.log("a sandboxed agent whose VM is not running fails loud — nothing runs anywhere");
{
  setLs([row("paw-x-other-aaaaaa", "other", "running"), row("paw-y-boxed-cccccc", "boxed", "running", "another-space")]);
  assert(throwsLike(() => sx.bangPlace(SPACE, "boxed"), /"boxed" is sandboxed.*VM is not running.*NOT run on this machine.*paw start boxed#/), "no container for it (another agent's, the same name on another space don't count)");
  setLs([row(`paw-${SPACE}-boxed-dddddd`, "boxed", "stopped")]);
  assert(throwsLike(() => sx.bangPlace(SPACE, "boxed"), /VM is not running \(paw-.*-boxed-dddddd: stopped\)/), "a stopped one is named with its state");
  setLs([row("a1", "boxed", "running"), row("a2", "boxed", "running")]);
  assert(throwsLike(() => sx.bangPlace(SPACE, "boxed"), /2 running containers \(a1, a2\)/), "two running → refuses to guess");
}

console.log("a sandboxed agent's !cmd runs in its VM via container exec");
{
  const id = `paw-${SPACE}-boxed-eeeeee`;
  setLs([row(`paw-${SPACE}-boxed-old000`, "boxed", "stopped"), row(id, "boxed", "running")]);
  const place = sx.bangPlace(SPACE, "boxed");
  assert(place.kind === "vm" && place.container === id, "bangPlace → the one RUNNING container");
  writeFileSync(fakeLog, "");
  const marker = join(folder, "HOST-RAN");
  const command = `neon auth login; touch ${marker} && echo "$(whoami)" '; rm -rf /' "x"`;
  const chunks: Array<{ t: number; s: string }> = [];
  const t0 = Date.now();
  const r = await sx.runBang(command, folder, place, { onOutput: (s) => chunks.push({ t: Date.now() - t0, s }) });
  const total = Date.now() - t0;
  const exec = calls().find((c) => c[0] === "exec");
  assert(JSON.stringify(exec) === JSON.stringify(sx.sandboxBashArgv(id, folder, command)), `argv = sandboxBashArgv (${JSON.stringify(exec)})`);
  assert(exec?.[1] === "-w" && exec[2] === folder && exec[3] === id, "…the folder via -w, then the container id");
  assert(exec?.slice(-3)[0] === "bash" && exec.slice(-3)[1] === "-lc" && exec.at(-1) === command, "…a login bash with the command as ONE argv element, byte-for-byte");
  assert(exec?.includes("timeout") && exec.includes("KILL"), "…wrapped in the VM's own `timeout -s KILL` (killing the exec CLI doesn't stop the VM process)");
  assert(!existsSync(marker), "no host shell ran it (its `touch` never happened on this machine)");
  assert(r.vm === id && r.code === 0 && r.output.includes("https://example.test/login") && r.output.includes("logged in"), "the result carries the output and the VM it ran in");
  const first = chunks.find((c) => c.s.includes("https://example.test/login"));
  assert(first !== undefined && first.t < total - 500, `output streams: the URL arrived at ${first?.t}ms, the command ended at ${total}ms`);
  assert(sx.bangWhere("boxed", folder, place) === `in boxed's VM: ${folder}`, "the echoed label says where it ran");
  assert(bashMessage(r).startsWith(`I ran this in your sandbox VM, in ${folder}:`), "the agent is told it ran in its VM");

  process.env.FAKE_EXEC_CODE = "137";
  const killed = await sx.runBang("sleep 999", folder, place);
  assert(killed.timedOut && killed.code === null, "the in-VM timeout firing (exit 137) reads as `timed out`, not `exit 137`");
  assert(exec?.includes("300"), "an in-VM bang gets 5 min (a login waits for the browser), not the host's 60s");
  assert(killed.output.includes(`use \`paw sandbox shell boxed#${SPACE}\``) && bashMessage(killed).includes("timed out after 300s"), "a VM timeout points at `paw sandbox shell <n>#<s>` and states the real limit");
  process.env.FAKE_EXEC_CODE = "3";
  const failed = await sx.runBang("false", folder, place);
  assert(!failed.timedOut && failed.code === 3, "an ordinary failing exit is reported as is");
  delete process.env.FAKE_EXEC_CODE;
  assert(JSON.stringify(sx.sandboxShellArgv(id, folder)) === JSON.stringify(["exec", "-i", "-t", "-w", folder, id, "bash", "-l"]), "`paw sandbox shell` = container exec -it -w <folder> <id> bash -l");
}

console.log("every `!cmd` surface goes through the sandbox-aware runner");
{
  for (const f of ["src/chat.ts", "src/web.ts"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert(!/\brunBash\(/.test(src) && /bangPlace\(space,/.test(src) && /runBang\(/.test(src), `${f} picks the place (bangPlace) and runs via runBang, never runBash directly`);
  }
}

if (process.env.PAW_SANDBOX_BANG_SMOKE === "1") {
  console.log("real smoke: a throwaway container labelled as an isolated test agent");
  const real = (realPath ?? "").split(":").map((d) => join(d, "container")).find((c) => existsSync(c));
  const up = real ? spawnSync(real, ["system", "status"], { encoding: "utf8" }).status === 0 : false;
  if (!real || !up) console.log("  skip  `container` missing or its services are down");
  else {
    process.env.PAW_CONTAINER = real;
    const image = process.env.PAW_SANDBOX_BANG_IMAGE ?? "paw-sandbox:df0569e40d03";
    const name = `paw-bang-smoke-${Math.random().toString(16).slice(2, 8)}`;
    const run = spawnSync(real, ["run", "-d", "--rm", "--name", name, "-l", `paw.space=${SPACE}`, "-l", "paw.agent=boxed", "-v", `${folder}:${folder}`, "-e", "SMOKE_ENV=from-container-env", image, "sleep", "300"], { encoding: "utf8" });
    try {
      assert(run.status === 0, `started ${name} (${(run.stderr || "").trim().split("\n").at(-1)})`);
      const place = sx.bangPlace(SPACE, "boxed");
      assert(place.kind === "vm" && place.container === name, "bangPlace finds it by its labels");
      const chunks: Array<{ t: number; s: string }> = [];
      const t0 = Date.now();
      const r = await sx.runBang(`pwd; echo "env=$SMOKE_ENV home=$HOME"; uname -s; sleep 2; echo 'done "quoted" $NOT_EXPANDED_BY_HOST'`, folder, place, { onOutput: (s) => chunks.push({ t: Date.now() - t0, s }) });
      const total = Date.now() - t0;
      const lines = r.output.trim().split("\n");
      assert(lines[0] === folder, `ran in the folder inside the VM (${lines[0]})`);
      assert(lines[1] === "env=from-container-env home=/root" && lines[2] === "Linux", `with the container's env, in Linux (${lines.slice(1, 3).join(" | ")})`);
      assert(lines.at(-1) === 'done "quoted" $NOT_EXPANDED_BY_HOST', `quoting survives intact (${lines.at(-1)})`);
      const first = chunks.find((c) => c.s.includes(folder));
      assert(first !== undefined && first.t < total - 1500, `streamed: first output at ${first?.t}ms, done at ${total}ms`);
      const timed = await sx.runBang("sleep 30; echo never", folder, place, { timeoutMs: 1500 });
      assert(timed.timedOut && !timed.output.includes("never"), "the in-VM timeout kills a long command");
      const ps = spawnSync(real, ["exec", name, "ps", "-eo", "args"], { encoding: "utf8" }).stdout;
      assert(!/^(timeout|bash|sleep) .*sleep 30/m.test(ps), `…and nothing of it is left running in the VM (${ps.trim().split("\n").join(" | ")})`);
    } finally {
      spawnSync(real, ["delete", "--force", name], { encoding: "utf8" });
      const left = spawnSync(real, ["ls", "--all", "--format", "json"], { encoding: "utf8" }).stdout;
      assert(!left.includes(name), `deleted ${name}`);
    }
  }
}

console.log(failures ? `\n${failures} FAILED` : "\ncheck:sandbox-bang passed");
process.exit(failures ? 1 : 0);

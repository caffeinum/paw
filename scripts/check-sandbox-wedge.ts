/**
 * Hermetic check for a WEDGED sandbox VM (docs/notes/sandbox.md#a-wedged-vm) — team2027 vercel, 2026-11-06:
 * its 1G guest ran out of memory (kernel `page allocation failure`, no OOM kill), the mesh heartbeat flapped
 * for five minutes and then stopped for good while the launcher and `container run` looked alive; `container
 * stop`/`delete --force`/`exec` all hung (they go through the guest), the VM outlived its launcher, and every
 * relaunch blocked on deleting the leftover past the manager's startup window.
 *
 * A fake `container` reproduces that guest: once `wedged` exists, exec/stop/delete hang; only a SIGKILL of the
 * VM's host process (`container-runtime-linux … --uuid <id>`) takes it down. Asserted:
 *   1. the VM-process lookup matches the exact `--uuid` token;
 *   2. forceRemoveContainers removes a wedged VM by SIGKILL, bounded, and throws when it can't (never "gone");
 *   3. the launcher's watchdog notices a guest that stopped answering, kills the VM and exits 75 (→ supervise);
 *   4. a leftover that can't be removed fails the launch loud and fast, not via a missing startup prompt;
 *   5. SIGTERM's detached reaper removes a wedged VM;
 *   6. a sandboxed spawn carries the supervise policy, a host spawn none.
 * Run: pnpm check:sandbox-wedge
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kill = await import("../bin/paw-sandbox-kill.mjs");
const { sandboxSpawnFields, SANDBOX_SUPERVISE, SANDBOX_RUNNER } = await import("../src/sandbox.ts");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (pred: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !pred(); ) await new Promise((r) => setTimeout(r, 100));
  return pred();
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const S = mkdtempSync(join(tmpdir(), "paw-wedge-"));
mkdirSync(join(S, "bin"));
const runtime = join(S, "bin", "container-runtime-linux");
writeFileSync(runtime, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");
chmodSync(runtime, 0o755);
const fake = join(S, "bin", "container");
writeFileSync(
  fake,
  `#!/bin/sh
S="${S}"
echo "argv: $*" >> "$S/log"
case "$1" in
  ls)
    printf '['; sep=''
    for f in "$S"/*.pid; do
      [ -e "$f" ] || continue
      id=$(basename "$f" .pid)
      if kill -0 "$(cat "$f")" 2>/dev/null; then
        printf '%s{"configuration":{"id":"%s","labels":{"paw.space":"wsp","paw.agent":"wag"}},"status":{"state":"running"}}' "$sep" "$id"; sep=','
      else rm -f "$f"; fi
    done
    printf ']\\n' ;;
  run)
    id=""; prev=""; for a in "$@"; do [ "$prev" = "--name" ] && id="$a"; prev="$a"; done
    "$S/bin/container-runtime-linux" start --root "$S/c/$id" --uuid "$id" &
    rp=$!
    echo $rp > "$S/$id.pid"
    trap 'exit 0' TERM
    while kill -0 $rp 2>/dev/null; do sleep 0.1; done
    exit 0 ;;
  exec) [ -f "$S/wedged" ] && sleep 60; exit 0 ;;
  stop|delete|kill)
    [ -f "$S/wedged" ] && sleep 60
    for id in "$@"; do [ -f "$S/$id.pid" ] && kill "$(cat "$S/$id.pid")" 2>/dev/null; done
    exit 0 ;;
esac
`,
);
chmodSync(fake, 0o755);
const wedge = () => writeFileSync(join(S, "wedged"), "");
const unwedge = () => rmSync(join(S, "wedged"), { force: true });
const startVm = (id: string) => {
  // Not our child (like the real one, whose parent is the container service): a zombie would stay "alive".
  const out = spawnSync("/bin/sh", ["-c", '"$0" start --root "$1" --uuid "$2" >/dev/null 2>&1 & echo $!', runtime, join(S, "c", id), id], { encoding: "utf8" });
  const pid = Number(out.stdout.trim());
  writeFileSync(join(S, `${id}.pid`), String(pid));
  return pid;
};
const listed = (id: string) => kill.stillListed(fake, [id]).length > 0;
const tokenFile = join(S, "token");
writeFileSync(tokenFile, "sk-test\n", { mode: 0o600 });
const launcher = (id: string, log: string, env: Record<string, string> = {}): ChildProcess =>
  spawn(process.execPath, [SANDBOX_RUNNER, "--container", fake, "--token-file", tokenFile, "--name", id, "--space", "wsp", "--agent", "wag", "--log", log, "--forward", "off", "--", "run", "--name", id, "img"], {
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null ? r(c.exitCode) : c.on("exit", (code) => r(code))));

console.log("1. the VM process lookup");
{
  const ps = ["  101 /x/container-runtime-linux start --root /a/c/paw-s-a-1 --uuid paw-s-a-1", "  102 /x/container-runtime-linux start --root /a/c/paw-s-a-10 --uuid paw-s-a-10", "  103 node something --uuid paw-s-a-1"].join("\n");
  ok("matches the exact --uuid token of a container-runtime-linux process only", JSON.stringify(kill.runtimePids(ps, "paw-s-a-1")) === "[101]");
}

console.log("2. forceRemoveContainers on a wedged guest");
{
  const pid = startVm("w1");
  wedge();
  const notes: string[] = [];
  const t0 = Date.now();
  const r = kill.forceRemoveContainers(fake, ["w1"], { deleteTimeoutMs: 500, note: (m: string) => notes.push(m) });
  ok("the VM process is SIGKILLed when delete --force doesn't answer", r.killed.includes(pid) && (await until(() => !alive(pid), 3000)), JSON.stringify(r));
  ok("…and the container is gone, bounded", !listed("w1") && Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
  ok("…said out loud", notes.some((n) => /survived `container delete --force`.*SIGKILL to its VM process/.test(n)));
  // A listed container with no VM process to kill: never reported gone.
  const stuck = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  writeFileSync(join(S, "w2.pid"), String(stuck.pid));
  let threw = "";
  try {
    kill.forceRemoveContainers(fake, ["w2"], { deleteTimeoutMs: 300, settleMs: 300 });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("one that stays listed throws, naming it", /w2 still listed/.test(threw), threw);
  stuck.kill("SIGKILL");
  unwedge();
}

console.log("3. the launcher's watchdog kills a wedged VM and exits 75");
{
  const log = join(S, "l3.log");
  const c = launcher("w3", log, { PAW_SANDBOX_PROBE_MS: "200", PAW_SANDBOX_PROBE_TIMEOUT_MS: "400", PAW_SANDBOX_PROBE_FAILS: "2" });
  ok("the VM came up", await until(() => listed("w3"), 5000));
  ok("…and answered a probe", await until(() => readFileSync(join(S, "log"), "utf8").includes("argv: exec w3 true"), 5000));
  await new Promise((r) => setTimeout(r, 500));
  const pid = Number(readFileSync(join(S, "w3.pid"), "utf8"));
  wedge();
  const code = await Promise.race([exited(c), new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  ok("the launcher exits 75 (a seat exit the manager's supervise restarts)", code === 75, `code ${code}`);
  ok("it logged the wedge with the memory hint", /WEDGED — 2 probes in a row failed.*out of memory\? raise its sandboxMemory/.test(text));
  ok("the wedged VM is gone (its process SIGKILLed)", !alive(pid) && !listed("w3"));
  unwedge();
  c.kill("SIGKILL");
}

console.log("3b. a probe that never got an answer while booting is not a wedge");
{
  const log = join(S, "l3b.log");
  wedge();
  const c = launcher("w3b", log, { PAW_SANDBOX_PROBE_MS: "200", PAW_SANDBOX_PROBE_TIMEOUT_MS: "300", PAW_SANDBOX_PROBE_FAILS: "2" });
  ok("its VM started", await until(() => existsSync(join(S, "w3b.pid")), 8000));
  await new Promise((r) => setTimeout(r, 2000));
  ok("the launcher keeps running", c.exitCode === null && !readFileSync(log, "utf8").includes("WEDGED"));
  unwedge();
  c.kill("SIGKILL");
  await exited(c);
  const pid = Number(readFileSync(join(S, "w3b.pid"), "utf8"));
  process.kill(pid, "SIGKILL");
}

console.log("4. a leftover that can't be removed fails the launch loud, fast");
{
  const stuck = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  writeFileSync(join(S, "w4old.pid"), String(stuck.pid));
  wedge();
  const log = join(S, "l4.log");
  const t0 = Date.now();
  const c = launcher("w4", log);
  const code = await exited(c);
  ok("exit 2, well inside the manager's 15s startup window", code === 2 && Date.now() - t0 < 12_000, `code ${code} after ${Date.now() - t0}ms`);
  ok("the log names the leftover", /FAILED: can't remove the leftover container\(s\) of wag#wsp: .*w4old still listed/.test(readFileSync(log, "utf8")));
  stuck.kill("SIGKILL");
  unwedge();
  rmSync(join(S, "w4old.pid"), { force: true });
}

console.log("4b. a wedged leftover with a VM process is killed and the launch goes on");
{
  const old = startVm("w4b-old");
  wedge();
  const log = join(S, "l4b.log");
  const c = launcher("w4b", log);
  ok("the leftover's VM process is killed", await until(() => !alive(old), 12_000));
  unwedge();
  ok("…and the new VM starts", await until(() => listed("w4b"), 8000));
  c.kill("SIGTERM");
  await exited(c);
}

console.log("5. SIGTERM's detached reaper removes a wedged VM");
{
  const log = join(S, "l5.log");
  const c = launcher("w5", log);
  ok("the VM came up", await until(() => listed("w5"), 5000));
  const pid = Number(readFileSync(join(S, "w5.pid"), "utf8"));
  wedge();
  c.kill("SIGTERM");
  ok("the reaper SIGKILLs the VM process once stop/delete hang", await until(() => !alive(pid), 40_000));
  ok("…logged", await until(() => /SIGKILL to its VM process/.test(readFileSync(log, "utf8")), 5000));
  ok("…and the launcher exits", (await Promise.race([exited(c), new Promise<null>((r) => setTimeout(() => r(null), 10_000))])) !== null);
  unwedge();
}

console.log("6. the spawn policy");
{
  const personas = join(S, "personas");
  mkdirSync(personas);
  writeFileSync(join(personas, "box.md"), "---\nname: box\nsandbox: container\n---\n");
  writeFileSync(join(personas, "host.md"), "---\nname: host\n---\n");
  ok("a sandboxed spawn carries supervise", JSON.stringify(sandboxSpawnFields(join(personas, "box.md"))) === JSON.stringify({ supervise: { ...SANDBOX_SUPERVISE } }));
  ok("a host spawn carries none", JSON.stringify(sandboxSpawnFields(join(personas, "host.md"))) === "{}");
  const addressing = readFileSync(join(import.meta.dirname, "..", "src", "addressing.ts"), "utf8");
  ok("ensureAgentSpawned puts it on the spawn op", /Object\.assign\(args, sandboxSpawnFields\(config\)\)/.test(addressing));
}

rmSync(S, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\ncheck:sandbox-wedge passed");
process.exit(failures ? 1 : 0);

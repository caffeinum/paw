#!/usr/bin/env node
/**
 * paw's sandbox launcher — the process the manager runs for a `sandbox: container` seat (src/sandbox.ts).
 *
 *   node paw-sandbox-run.mjs --container <bin> --token-file <f> --name <id> --space <s> --agent <n> --log <f> -- run …
 *
 * 1. Reads the Claude OAuth token from its 0600 file into CLAUDE_CODE_OAUTH_TOKEN for `container run -e
 *    CLAUDE_CODE_OAUTH_TOKEN` — so the token is never on any argv, in the LaunchSpec or in a log line.
 * 2. Removes this agent's leftover containers (a predecessor that was SIGKILLed before it could clean up) —
 *    bounded, escalating to a SIGKILL of the VM process (./paw-sandbox-kill.mjs); one that won't go fails loud.
 * 3. Runs `container run` on the seat's pty (stdin/stdout — the VM's tty) and exits with its code. The run
 *    CLI's own STDERR (its progress and its errors, e.g. a missing image) goes to `--log`, beside this
 *    launcher's own lines: the pty is claude's screen, and the manager keeps no copy of it.
 * 4. Owns the container's lifetime: killing the `container run` CLI does NOT stop the VM, so on SIGTERM /
 *    SIGHUP / SIGINT a DETACHED reaper (./paw-sandbox-kill.mjs: `container stop`, `delete --force`, then SIGKILL
 *    of the VM process — a wedged guest answers neither) is started (it outlives the manager's SIGKILL 3s
 *    later) and this process exits once the run CLI does.
 * 6. Watches the guest: a VM that stops answering `container exec` (memory exhaustion) is killed and this
 *    launcher exits 75, so the manager's supervise policy restarts the seat (see the watchdog below).
 * 5. Forwards every TCP port listening in the VM to the same port on the host's loopback (./paw-sandbox-forward.mjs;
 *    `--forward off` = persona `sandboxForward: false`), listing them in `forwards.json` beside `--log`.
 * Plain node ESM, no dependencies: it starts in the manager's node without tsx.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containerTransport, startForwarder } from "./paw-sandbox-forward.mjs";
import { forceRemoveContainers, stillListed } from "./paw-sandbox-kill.mjs";

const KILLER = fileURLToPath(new URL("./paw-sandbox-kill.mjs", import.meta.url));
const argv = process.argv.slice(2);
const opt = {};
let i = 0;
for (; i < argv.length; i++) {
  if (argv[i] === "--") {
    i++;
    break;
  }
  if (!argv[i].startsWith("--") || argv[i + 1] === undefined) die(`bad argument ${argv[i]}`);
  opt[argv[i].slice(2)] = argv[++i];
}
const run = argv.slice(i);
const { container, "token-file": tokenFile, name, space, agent, log, forward = "on" } = opt;
if (forward !== "on" && forward !== "off") die(`--forward is on|off, not "${forward}"`);
if (!container || !tokenFile || !name || !space || !agent || !log || run[0] !== "run")
  die("usage: --container <bin> --token-file <f> --name <id> --space <s> --agent <n> --log <f> -- run …");
mkdirSync(dirname(log), { recursive: true });

function note(msg) {
  if (log) appendFileSync(log, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`paw sandbox: ${msg}\n`);
  try {
    note(`FAILED: ${msg}`);
  } catch {
    /* the log itself is what failed */
  }
  process.exit(2);
}

let token;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch (e) {
  die(`can't read the Claude OAuth token file ${tokenFile} (${e.code ?? e.message})`);
}
if (!token) die(`the Claude OAuth token file ${tokenFile} is empty`);

// Leftovers of this agent: same labels, any state. One container per launch id, so this never races
// a live sibling of the same agent — there is none (one seat per name per manager).
const ls = spawnSync(container, ["ls", "--all", "--format", "json"], { encoding: "utf8", timeout: 30_000 });
if (ls.status !== 0) die(`\`container ls\` failed — is it running? \`container system start\` (${(ls.stderr || ls.error?.message || "").trim()})`);
let listed;
try {
  listed = JSON.parse(ls.stdout || "[]");
} catch {
  die(`\`container ls --format json\` printed something that is not JSON: ${ls.stdout.slice(0, 200)}`);
}
const stale = listed
  .filter((c) => c.configuration?.labels?.["paw.space"] === space && c.configuration?.labels?.["paw.agent"] === agent)
  .map((c) => c.configuration.id);
if (stale.length) {
  note(`removing leftover container(s) of ${agent}#${space}: ${stale.join(" ")}`);
  // Bounded and escalating (a wedged leftover never answers `delete`): this runs inside the manager's startup
  // window, and a leftover that can't be removed fails the launch HERE, named — not as a missing prompt.
  try {
    forceRemoveContainers(container, stale, { note, deleteTimeoutMs: 3_000, settleMs: 3_000 });
  } catch (e) {
    die(`can't remove the leftover container(s) of ${agent}#${space}: ${e.message}`);
  }
}

// The seat's creds mirror (src/sandbox.ts): the manager renews the agent's creds by an atomic rename on the
// host, which the VM's read-only mirror dir only sees once it is copied in again — tmp + rename inside the
// mirror, so the seat never reads half a file.
const mirrorSrc = opt["mirror-src"];
const mirrorDst = opt["mirror-dst"];
if (!!mirrorSrc !== !!mirrorDst) die("--mirror-src and --mirror-dst come together");
if (mirrorSrc) {
  let seen = statSync(mirrorSrc).mtimeMs;
  setInterval(() => {
    try {
      const at = statSync(mirrorSrc).mtimeMs;
      if (at === seen) return;
      copyFileSync(mirrorSrc, `${mirrorDst}.tmp`);
      renameSync(`${mirrorDst}.tmp`, mirrorDst);
      seen = at;
      note(`creds renewed on the host — mirrored into the sandbox`);
    } catch (e) {
      note(`creds mirror: ${e.message}`);
    }
  }, 5_000).unref();
}

note(`starting ${name} (${agent}#${space})`);
const child = spawn(container, run, { stdio: ["inherit", "inherit", openSync(log, "a")], env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } });
token = undefined;

const forwarder =
  forward === "on"
    ? startForwarder({ transport: containerTransport(container, name), note, stateFile: join(dirname(log), "forwards.json"), container: name })
    : undefined;

// The guest watchdog (docs/notes/sandbox.md#a-wedged-vm). A guest out of memory with no swap can thrash
// without the OOM killer ever firing: claude and its cotal MCP server get a few ms of CPU now and then, the
// mesh heartbeat flaps, then stops for good — while `container run` and this launcher look perfectly alive to
// the manager, so the seat sat "offline … process running" with DMs queued forever. Every probe is a
// trivial `container exec <id> true`; after FAILS consecutive failures (once the VM answered at least once)
// the VM is killed for certain and this launcher exits WEDGED_EXIT — a seat exit the manager's supervise
// policy (src/sandbox.ts SANDBOX_SUPERVISE) restarts in place, same identity, queued DMs kept.
const WEDGED_EXIT = 75;
const envInt = (k, dflt) => {
  const v = process.env[k];
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) <= 0) die(`${k}=${v} is not a positive integer (ms / count)`);
  return Number(v);
};
const PROBE_EVERY_MS = envInt("PAW_SANDBOX_PROBE_MS", 30_000);
const PROBE_TIMEOUT_MS = envInt("PAW_SANDBOX_PROBE_TIMEOUT_MS", 20_000);
const PROBE_FAILS = envInt("PAW_SANDBOX_PROBE_FAILS", 4);
let wedged = false;
const watchdog = (() => {
  let answered = false;
  let failures = 0;
  let last = "";
  let inFlight = false;
  let done = false;
  const probe = () => {
    if (inFlight || done) return;
    inFlight = true;
    const p = spawn(container, ["exec", name, "true"], { stdio: ["ignore", "ignore", "pipe"], timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => (err = e.message));
    // "exit", not "close": a hung exec's own children may hold its stderr open long after it was killed.
    p.on("exit", (code, signal) => {
      inFlight = false;
      if (done) return;
      if (code === 0) {
        if (failures) note(`watchdog: ${name} answers again after ${failures} failed probe(s)`);
        answered = true;
        failures = 0;
        return;
      }
      if (!answered) return; // still booting
      failures++;
      last = signal ? `no answer within ${PROBE_TIMEOUT_MS / 1000}s` : `exit ${code}: ${err.trim().slice(0, 200)}`;
      note(`watchdog: ${name} did not answer \`container exec … true\` (${last}) — ${failures}/${PROBE_FAILS}`);
      if (failures < PROBE_FAILS) return;
      done = true;
      clearInterval(timer);
      wedged = true;
      forwarder?.stop();
      note(`watchdog: ${name} is WEDGED — ${failures} probes in a row failed (last: ${last}); its guest is not running anything (out of memory? raise its sandboxMemory). Killing the VM so the seat restarts`);
      try {
        forceRemoveContainers(container, [name], { note, deleteTimeoutMs: 5_000 });
      } catch (e) {
        note(`watchdog: FAILED to kill wedged ${name}: ${e.message}`);
      }
      child.kill("SIGKILL");
    });
  };
  const timer = setInterval(probe, PROBE_EVERY_MS);
  timer.unref();
  return {
    stop() {
      done = true;
      clearInterval(timer);
    },
  };
})();

let stopping = false;
const stop = (sig) => {
  if (stopping) return;
  stopping = true;
  forwarder?.stop();
  note(`${sig}: stopping ${name}`);
  watchdog.stop();
  // Detached: it outlives the manager's SIGKILL of this launcher 3s later. stop → delete --force → SIGKILL of
  // the VM process when the guest doesn't answer (./paw-sandbox-kill.mjs), every step bounded.
  const reaper = spawn(process.execPath, [KILLER, "--container", container, "--log", log, "--stop", name], {
    detached: true,
    stdio: "ignore",
  });
  reaper.unref();
};
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => stop(sig));

child.on("error", (e) => die(`couldn't start ${container}: ${e.message}`));
child.on("exit", (code, signal) => {
  forwarder?.stop();
  watchdog.stop();
  note(`${name} exited (${signal ?? `code ${code}`})`);
  // The run CLI dying (a crash, a SIGKILL) leaves the VM running — an unmanaged agent still on the mesh.
  // `--rm` already removed a container that stopped on its own; this catches the rest.
  try {
    if (stillListed(container, [name]).length) {
      forceRemoveContainers(container, [name], { note });
      note(`removed ${name}, which outlived its run CLI`);
    }
  } catch (e) {
    note(`FAILED to remove ${name} after its run CLI exited: ${e.message}`);
  }
  if (wedged) process.exit(WEDGED_EXIT);
  process.exit(code ?? (signal ? 1 : 0));
});

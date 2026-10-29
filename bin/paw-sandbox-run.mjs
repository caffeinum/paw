#!/usr/bin/env node
/**
 * paw's sandbox launcher — the process the manager runs for a `sandbox: container` seat (src/sandbox.ts).
 *
 *   node paw-sandbox-run.mjs --container <bin> --token-file <f> --name <id> --space <s> --agent <n> --log <f> -- run …
 *
 * 1. Reads the Claude OAuth token from its 0600 file into CLAUDE_CODE_OAUTH_TOKEN for `container run -e
 *    CLAUDE_CODE_OAUTH_TOKEN` — so the token is never on any argv, in the LaunchSpec or in a log line.
 * 2. Removes this agent's leftover containers (a predecessor that was SIGKILLed before it could clean up).
 * 3. Runs `container run` on the seat's pty (stdin/stdout — the VM's tty) and exits with its code. The run
 *    CLI's own STDERR (its progress and its errors, e.g. a missing image) goes to `--log`, beside this
 *    launcher's own lines: the pty is claude's screen, and the manager keeps no copy of it.
 * 4. Owns the container's lifetime: killing the `container run` CLI does NOT stop the VM, so on SIGTERM /
 *    SIGHUP / SIGINT a DETACHED `container stop` + `delete --force` is started (it outlives the manager's
 *    SIGKILL 3s later) and this process exits once the run CLI does.
 * 5. Forwards every TCP port listening in the VM to the same port on the host's loopback (./paw-sandbox-forward.mjs;
 *    `--forward off` = persona `sandboxForward: false`), listing them in `forwards.json` beside `--log`.
 * Plain node ESM, no dependencies: it starts in the manager's node without tsx.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { containerTransport, startForwarder } from "./paw-sandbox-forward.mjs";

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
  spawnSync(container, ["delete", "--force", ...stale], { stdio: "ignore", timeout: 60_000 });
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

let stopping = false;
const stop = (sig) => {
  if (stopping) return;
  stopping = true;
  forwarder?.stop();
  note(`${sig}: stopping ${name}`);
  const reaper = spawn("/bin/sh", ["-c", '"$0" stop --time 2 "$1" >/dev/null 2>&1; "$0" delete --force "$1" >/dev/null 2>&1', container, name], {
    detached: true,
    stdio: "ignore",
  });
  reaper.unref();
};
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => stop(sig));

child.on("error", (e) => die(`couldn't start ${container}: ${e.message}`));
child.on("exit", (code, signal) => {
  forwarder?.stop();
  note(`${name} exited (${signal ?? `code ${code}`})`);
  // The run CLI dying (a crash, a SIGKILL) leaves the VM running — an unmanaged agent still on the mesh.
  // `--rm` already removed a container that stopped on its own; this catches the rest.
  const del = spawnSync(container, ["delete", "--force", name], { encoding: "utf8", timeout: 30_000 });
  if (del.status === 0) note(`removed ${name}, which outlived its run CLI`);
  process.exit(code ?? (signal ? 1 : 0));
});

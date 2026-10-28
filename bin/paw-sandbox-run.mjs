#!/usr/bin/env node
/**
 * paw's sandbox launcher — the process the manager runs for a `sandbox: container` seat (src/sandbox.ts).
 *
 *   node paw-sandbox-run.mjs --container <bin> --token-file <f> --name <id> --space <s> --agent <n> -- run …
 *
 * 1. Reads the Claude OAuth token from its 0600 file into CLAUDE_CODE_OAUTH_TOKEN for `container run -e
 *    CLAUDE_CODE_OAUTH_TOKEN` — so the token is never on any argv, in the LaunchSpec or in a log line.
 * 2. Removes this agent's leftover containers (a predecessor that was SIGKILLed before it could clean up).
 * 3. Runs `container run` on the seat's pty and exits with its code.
 * 4. Owns the container's lifetime: killing the `container run` CLI does NOT stop the VM, so on SIGTERM /
 *    SIGHUP / SIGINT a DETACHED `container stop` + `delete --force` is started (it outlives the manager's
 *    SIGKILL 3s later) and this process exits once the run CLI does.
 * Plain node ESM, no dependencies: it starts in the manager's node without tsx.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const { container, "token-file": tokenFile, name, space, agent } = opt;
if (!container || !tokenFile || !name || !space || !agent || run[0] !== "run") die("usage: --container <bin> --token-file <f> --name <id> --space <s> --agent <n> -- run …");

function die(msg) {
  process.stderr.write(`paw sandbox: ${msg}\n`);
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
const stale = JSON.parse(ls.stdout || "[]")
  .filter((c) => c.configuration?.labels?.["paw.space"] === space && c.configuration?.labels?.["paw.agent"] === agent)
  .map((c) => c.configuration.id);
if (stale.length) {
  process.stderr.write(`paw sandbox: removing leftover container(s) of ${agent}: ${stale.join(" ")}\n`);
  spawnSync(container, ["delete", "--force", ...stale], { stdio: "ignore", timeout: 60_000 });
}

const child = spawn(container, run, { stdio: "inherit", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } });
token = undefined;

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const reaper = spawn("/bin/sh", ["-c", '"$0" stop --time 2 "$1" >/dev/null 2>&1; "$0" delete --force "$1" >/dev/null 2>&1', container, name], {
    detached: true,
    stdio: "ignore",
  });
  reaper.unref();
};
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, stop);

child.on("error", (e) => die(`couldn't start ${container}: ${e.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

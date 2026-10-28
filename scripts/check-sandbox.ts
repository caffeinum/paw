/**
 * Hermetic check for `sandbox: container` (src/sandbox.ts, bin/paw-sandbox-run.mjs): the launch wrapping
 * (mounts, env by name only, cotal-only MCP, control socket, transcript store), every refusal, the token
 * never reaching an argv / the LaunchSpec / stdout, and the launcher's container lifecycle — against a FAKE
 * `container` binary, so it runs anywhere (no VM, no mesh, no network). Run: pnpm check:sandbox
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-sbx-")));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ROOT = home;
for (const k of ["PAW_SPACE", "PAW_COTAL_HUB", "PAW_CONTAINER", "PAW_CLAUDE_TOKEN_FILE", "COTAL_NAME", "COTAL_SPACE"]) delete process.env[k];
writeFileSync(join(home, ".claude.json"), "{}");

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

// A fake `container`: logs argv (one line per call) + whether the token reached its env, prints a canned `ls`.
const fakeDir = join(home, "fakebin");
mkdirSync(fakeDir);
const fakeLog = join(home, "container.log");
const lsJson = join(home, "ls.json");
const fake = join(fakeDir, "container");
writeFileSync(
  fake,
  `#!/bin/sh
echo "argv: $*" >> "${fakeLog}"
case "$1" in
  ls) cat "${lsJson}" ;;
  run) echo $$ > "${fakeLog}.pid"; echo "token-in-env: \${CLAUDE_CODE_OAUTH_TOKEN:-<unset>}" >> "${fakeLog}"; trap 'exit 0' TERM; sleep 30 & wait ;;
  stop) kill "$(cat "${fakeLog}.pid")" ;;
  *) : ;;
esac
`,
);
chmodSync(fake, 0o755);
writeFileSync(lsJson, "[]");
process.env.PATH = `${fakeDir}:${process.env.PATH}`;

const TOKEN = "sk-ant-oat01-SENTINEL-never-print-me";
mkdirSync(join(home, ".paw", "secrets"), { recursive: true });
const tokenFile = join(home, ".paw", "secrets", "claude-oauth-token");
writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

const { peelArgs } = await import("../src/claude.ts");
const { readSandbox, personaTranscriptRoots, sandboxClaudeDir } = await import("../src/session.ts");
const sbx = await import("../src/sandbox.ts");
const { pawConnector } = await import("../src/connector.ts");
const { writeRemoteMesh } = await import("../src/remote-mesh.ts");

console.log("paw claude --sandbox");
{
  const p = peelArgs(["--sandbox", "--space", "r", "--name", "n", "--model", "haiku"]);
  assert(p.sandbox && p.space === "r" && p.name === "n" && p.claudeArgs.join(" ") === "--model haiku", "--sandbox is paw's leading flag, the rest passes through");
  assert(!peelArgs(["--model", "x", "--sandbox"]).sandbox, "--sandbox after the passthrough began is claude's, not paw's");
}

// A remote space record (the only kind v1 sandboxes) whose root holds a signer the VM must never see.
const SPACE = "sbxremote";
const root = join(home, "remote-root");
mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
writeFileSync(join(root, ".cotal", "auth", "auth.json"), '{"signer":"SIGNER-SECRET"}', { mode: 0o600 });
writeRemoteMesh({ space: SPACE, server: "tls://192.168.64.1:4222", root, ts: new Date().toISOString() });
const personas = join(home, ".paw", "spaces", SPACE, "personas");
mkdirSync(personas, { recursive: true });
const folder = join(home, "work", "agent-folder");
mkdirSync(folder, { recursive: true });
// The manager's per-space creds dir: this agent's file AND a sibling's, which the VM must never see.
const credsDir = join(root, ".cotal", "auth", "creds", "space.abc123");
mkdirSync(credsDir, { recursive: true });
const agentCreds = join(credsDir, "smoke.uid1.creds");
writeFileSync(agentCreds, "-----BEGIN NATS USER JWT----- smoke-v1", { mode: 0o600 });
writeFileSync(join(credsDir, "sibling.uid2.creds"), "SIBLING-CREDS", { mode: 0o600 });
const persona = (name: string, extra = "") => {
  const f = join(personas, `${name}.md`);
  writeFileSync(f, `---\nname: ${name}\ncwd: ${folder}\nresume: 11111111-2222-3333-4444-555555555555\nsandbox: container\n${extra}---\n`);
  return f;
};

console.log("persona keys");
{
  const f = persona("keys");
  assert(readSandbox(f) === "container", "sandbox: container is read");
  writeFileSync(join(personas, "bad.md"), "---\nname: bad\nsandbox: docker\n---\n");
  assert(throwsLike(() => readSandbox(join(personas, "bad.md")), /only sandbox is `container`/), "an unknown sandbox: value throws (never boots unsandboxed)");
  assert(readSandbox(join(personas, "nope.md")) === undefined, "no persona ⇒ no sandbox");
  assert(personaTranscriptRoots(f)[0] === join(home, ".paw", "spaces", SPACE, "sandbox", "keys", "claude", "projects"), "a sandboxed agent's transcripts live in its own mounted config dir");
  assert(throwsLike(() => sbx.readSandboxMemory(persona("mem", "sandboxMemory: lots\n")), /sandboxMemory/), "a bad sandboxMemory: throws");
  assert(sbx.readSandboxMemory(persona("mem2", "sandboxMemory: 3G\n")) === "3G" && sbx.readSandboxMemory(f) === "2G", "sandboxMemory: is read, default 2G");
  assert(sbx.readSandboxImage(persona("img", "sandboxImage: my/img:1\n")) === "my/img:1" && /^paw-sandbox:[0-9a-f]{12}$/.test(sbx.readSandboxImage(f)), "sandboxImage: is read, default keyed by the Containerfile");
}

console.log("the launch, through pawConnector");
const configPath = persona("smoke");
const material = join(home, "launch-mat");
mkdirSync(material);
let out = "";
const origLog = console.log;
const origWarn = console.warn;
const spec = (() => {
  console.warn = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  try {
    return pawConnector.buildLaunch({ space: SPACE, name: "smoke", configPath, workspaceRoot: root, servers: "tls://192.168.64.1:4222", creds: agentCreds });
  } finally {
    console.warn = origWarn;
  }
})();
const all = JSON.stringify(spec);
const runAt = spec.args.indexOf("--");
const run = spec.args.slice(runAt + 1);
const vols = run.flatMap((a, i) => (a === "-v" ? [run[i + 1]] : []));
const envs = run.flatMap((a, i) => (a === "-e" ? [run[i + 1]] : []));
{
  assert(spec.command === process.execPath && spec.args[0] === sbx.SANDBOX_RUNNER, "runs paw's launcher under the manager's node");
  assert(!all.includes(TOKEN) && !out.includes(TOKEN), "the token is NOWHERE in the LaunchSpec (args, env) or the printed warnings");
  assert(spec.args.includes("--token-file") && spec.args[spec.args.indexOf("--token-file") + 1] === tokenFile, "the launcher gets the token FILE path");
  assert(run[0] === "run" && run.includes("--rm") && run.includes("-t") && run.includes("--init"), "container run --rm -i -t --init");
  assert(envs.includes("CLAUDE_CODE_OAUTH_TOKEN") && envs.every((e) => !e.includes("=")), "-e passes NAMES only (values inherit from the launcher's env)");
  assert(vols.includes(`${folder}:${folder}`), "the agent's folder is mounted read-write at its own path");
  assert(vols.includes(`${sandboxClaudeDir(configPath)}:/paw/claude`), "its own claude config dir is mounted at /paw/claude");
  const nm = sbx.nodeModulesRoot(spec.args.find((a) => a.includes("connector-claude-code")) ?? run[run.indexOf("--plugin-dir") + 1]);
  assert(nm && vols.includes(`${nm}:${nm}:ro`), "paw's node_modules (cotal MCP + plugin hooks) is mounted READ-ONLY");
  assert(vols.includes(`${join(root, ".cotal", "events")}:${join(root, ".cotal", "events")}`), "the event WAL dir is mounted, read-write");
  const sources = vols.map((v) => v.split(":")[0]);
  assert(!sources.some((s) => s === root || s === join(root, ".cotal") || s.startsWith(join(root, ".cotal", "auth"))), "no mount SOURCE is the cotal root, its .cotal or its auth dir (signer, every agent's creds)");
  const mirror = join(home, ".paw", "spaces", SPACE, "sandbox", "smoke", "creds");
  assert(vols.includes(`${mirror}:${credsDir}:ro`), "the creds dir path is served from this agent's own mirror, read-only");
  assert(readdirSync(mirror).join() === "smoke.uid1.creds" && readFileSync(join(mirror, "smoke.uid1.creds"), "utf8").includes("smoke-v1"), "…which holds only ITS creds file (not the sibling's)");
  assert(!vols.some((v) => v.startsWith(`${home}:`) || v.includes(".ssh") || v.startsWith(`${join(home, ".paw")}:`) || v.startsWith(`${join(home, ".claude")}:`)), "nothing else of $HOME (~/.ssh, ~/.paw, ~/.claude) is mounted");
  const vmEnv = spec.env ?? {};
  assert(vmEnv.COTAL_CONTROL_SOCKET === sbx.SANDBOX_CONTROL_SOCKET, "the control socket moves into the VM's /tmp");
  assert(vmEnv.CLAUDE_CONFIG_DIR === "/paw/claude" && vmEnv.IS_SANDBOX === "1", "CLAUDE_CONFIG_DIR + IS_SANDBOX for the VM");
  assert(vmEnv.COTAL_TLS === "1" && envs.includes("COTAL_TLS"), "the remote space's COTAL_TLS reaches the seat");
  assert(!envs.includes("COTAL_HOME") && !envs.includes("HOME") && !envs.includes("PATH"), "host-only env (HOME, PATH, COTAL_HOME) is not forwarded");
  const mcp = JSON.parse(run[run.indexOf("--mcp-config") + 1]) as { mcpServers: Record<string, unknown> };
  assert(Object.keys(mcp.mcpServers).join() === "cotal", "--mcp-config carries the cotal server only");
  assert(run.includes("--session-id") && !run.includes("--resume"), "first boot: --session-id (no transcript in the sandbox store yet)");
  assert(/^paw-sbxremote-smoke-[0-9a-f]{6}$/.test(run[run.indexOf("--name") + 1]) && run.includes("paw.space=sbxremote") && run.includes("paw.agent=smoke"), "a fresh, labelled container id per launch");
  assert(run[run.indexOf("-w") + 1] === folder && run[run.indexOf("-m") + 1] === "2G", "workdir = its folder, memory = 2G");
  const seeded = JSON.parse(readFileSync(join(sandboxClaudeDir(configPath), ".claude.json"), "utf8"));
  assert(seeded.hasCompletedOnboarding === true && seeded.projects?.[folder]?.hasTrustDialogAccepted === true, "its .claude.json is seeded: onboarded, folder trusted");
  assert(JSON.parse(readFileSync(join(sandboxClaudeDir(configPath), "settings.json"), "utf8")).skipDangerousModePermissionPrompt === true, "its settings.json pre-accepts the bypass-mode dialog");
  // A transcript in the SANDBOX store → --resume; one only in the host's ~/.claude never counts.
  const proj = join(sandboxClaudeDir(configPath), "projects", folder.replace(/[^A-Za-z0-9_]/g, "-"));
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");
  const again = pawConnector.buildLaunch({ space: SPACE, name: "smoke", configPath, workspaceRoot: root, servers: "tls://192.168.64.1:4222", creds: agentCreds });
  assert(again.args.includes("--resume"), "restart: --resume once the sandbox store holds the session");
}

console.log("cotal-only MCP config");
{
  const r = sbx.cotalOnlyMcpConfig(JSON.stringify({ mcpServers: { cotal: { command: "node", args: ["/x/node_modules/a/mcp.cjs"] }, slack: { command: "slack-mcp", env: { SLACK_TOKEN: "xoxb-secret" } } } }));
  assert(!r.json.includes("xoxb-secret") && !r.json.includes("slack") && r.cotalPaths[0] === "/x/node_modules/a/mcp.cjs", "a shared server (and its secret env) is dropped");
  assert(throwsLike(() => sbx.cotalOnlyMcpConfig('{"mcpServers":{}}'), /no cotal MCP server/), "no cotal server ⇒ refused");
  assert(sbx.nodeModulesRoot("/r/node_modules/.pnpm/x/node_modules/y/dist/a.cjs") === "/r/node_modules", "the TOPMOST node_modules is the mount");
}

console.log("refusals");
{
  const launch = (name: string, space = SPACE, extra = "") =>
    pawConnector.buildLaunch({ space, name, configPath: persona(name, extra), workspaceRoot: root, servers: "tls://x:1", creds: agentCreds });
  assert(throwsLike(() => sbx.assertSandboxSpace("paw", "x"), /LOCAL space.*127\.0\.0\.1/), "a local space is refused (its broker is 127.0.0.1-only)");
  mkdirSync(join(home, ".paw", "spaces", "localsp", "personas"), { recursive: true });
  writeFileSync(join(home, ".paw", "spaces", "localsp", "personas", "l.md"), `---\nname: l\ncwd: ${folder}\nsandbox: container\n---\n`);
  assert(
    throwsLike(() => pawConnector.buildLaunch({ space: "localsp", name: "l", configPath: join(home, ".paw", "spaces", "localsp", "personas", "l.md"), workspaceRoot: root }), /LOCAL space/),
    "…and the manager-side buildLaunch refuses it too",
  );
  assert(throwsLike(() => launch("kitty", SPACE, "agent: kit\n"), /only claude agents/), "a non-claude harness is refused");
  assert(throwsLike(() => launch("hl", SPACE, "headless: true\n"), /headless/), "headless is refused (the hub's host socket)");
  writeFileSync(join(personas, "nocwd.md"), "---\nname: nocwd\nsandbox: container\n---\n");
  assert(
    throwsLike(() => pawConnector.buildLaunch({ space: SPACE, name: "nocwd", configPath: join(personas, "nocwd.md"), workspaceRoot: root }), /no cwd:/),
    "no cwd: in the persona is refused",
  );
  chmodSync(tokenFile, 0o644);
  assert(throwsLike(() => launch("tok1"), /readable by others/), "a token file readable by others is refused");
  chmodSync(tokenFile, 0o600);
  process.env.PAW_CLAUDE_TOKEN_FILE = join(home, "missing-token");
  assert(throwsLike(() => launch("tok2"), /does not exist.*setup-token/), "a missing token file is refused, with how to make one");
  writeFileSync(join(home, "empty-token"), "", { mode: 0o600 });
  process.env.PAW_CLAUDE_TOKEN_FILE = join(home, "empty-token");
  assert(throwsLike(() => launch("tok3"), /is empty/), "an empty token file is refused");
  delete process.env.PAW_CLAUDE_TOKEN_FILE;
  process.env.PAW_CONTAINER = join(home, "no-such-container");
  assert(throwsLike(() => launch("bin1"), /PAW_CONTAINER=.*not an executable/), "a PAW_CONTAINER that isn't executable is refused");
  delete process.env.PAW_CONTAINER;
  const savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  assert(throwsLike(() => sbx.containerBin(), /not on PATH.*signed release/), "no `container` on PATH is refused, with the install");
  process.env.PATH = savedPath;
}

console.log("container ls parsing");
{
  const rows = sbx.parseContainerList(
    JSON.stringify([
      { configuration: { id: "paw-s-a-1", labels: { "paw.space": "s", "paw.agent": "a" }, resources: { memoryInBytes: 2147483648 } }, status: { state: "running", networks: [{ ipv4Address: "192.168.64.9/24" }] } },
      { configuration: { id: "other", labels: {} }, status: { state: "running" } },
    ]),
  );
  assert(rows.length === 1 && rows[0].agent === "a" && rows[0].space === "s" && rows[0].memoryBytes === 2147483648 && rows[0].ip === "192.168.64.9/24", "only paw-labelled containers, with agent/space/memory/ip");
}

console.log("the launcher (bin/paw-sandbox-run.mjs) against a fake container");
{
  writeFileSync(lsJson, JSON.stringify([{ configuration: { id: "paw-sbxremote-smoke-old000", labels: { "paw.space": SPACE, "paw.agent": "smoke" } } }]));
  writeFileSync(fakeLog, "");
  const cname = run[run.indexOf("--name") + 1];
  const child = spawn(process.execPath, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"] });
  let printed = "";
  child.stdout.on("data", (d) => (printed += d));
  child.stderr.on("data", (d) => (printed += d));
  const until = async (pred: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && !pred(); ) await new Promise((r) => setTimeout(r, 100));
    return pred();
  };
  const log = () => readFileSync(fakeLog, "utf8");
  assert(await until(() => log().includes("token-in-env:"), 10_000), "the launcher started `container run`");
  assert(log().includes("argv: delete --force paw-sbxremote-smoke-old000"), "a leftover container of the same agent is removed first");
  assert(log().includes(`token-in-env: ${TOKEN}`), "the token reached `container run` through its ENV");
  assert(!log().split("\n").filter((l) => l.startsWith("argv:")).some((l) => l.includes(TOKEN)), "…and never through any argv");
  const ps = spawnSync("/bin/ps", ["-A", "-o", "command="], { encoding: "utf8" }).stdout;
  assert(!ps.includes(TOKEN), "no process on this machine shows the token in its command line");
  // The manager renews creds by an atomic rename; the launcher must carry the new file into the mirror.
  const mirrored = join(home, ".paw", "spaces", SPACE, "sandbox", "smoke", "creds", "smoke.uid1.creds");
  writeFileSync(`${agentCreds}.new`, "-----BEGIN NATS USER JWT----- smoke-v2", { mode: 0o600 });
  renameSync(`${agentCreds}.new`, agentCreds);
  assert(await until(() => readFileSync(mirrored, "utf8").includes("smoke-v2"), 12_000), "a renewed creds file (atomic rename on the host) reaches the mirror within seconds");
  child.kill("SIGTERM");
  assert(await until(() => log().includes(`argv: stop --time 2 ${cname}`) && log().includes(`argv: delete --force ${cname}`), 10_000), "SIGTERM → a detached `container stop` + `delete --force` of THIS launch's container");
  assert(await until(() => child.exitCode !== null, 10_000), "…and the launcher exits with the run CLI");
  assert(!printed.includes(TOKEN), "the launcher printed nothing carrying the token");
  const bad = spawnSync(process.execPath, [sbx.SANDBOX_RUNNER, "--container", fake, "--token-file", join(home, "nope"), "--name", "n", "--space", "s", "--agent", "a", "--log", join(home, "l.log"), "--", "run"], { encoding: "utf8" });
  assert(bad.status === 2 && /can't read the Claude OAuth token file/.test(bad.stderr), "an unreadable token file fails the launch loud");
}

console.log("sandbox image recipe");
{
  const cf = readFileSync(sbx.CONTAINERFILE, "utf8");
  assert(/FROM docker\.io\/library\/node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}/.test(cf), "the base image is pinned by version AND digest");
  assert(/CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/.test(cf), "claude code is pinned to an exact version");
  assert(existsSync(sbx.SANDBOX_RUNNER), "the launcher ships in bin/ (part of every release)");
}

console.log = origLog;
console.log(failures ? `\n${failures} FAILED` : "\ncheck:sandbox passed");
process.exit(failures ? 1 : 0);

/**
 * Hermetic check for kit inside the sandbox (src/sandbox-kit.ts, bin/paw-sandbox-kitauth.mjs, the swap guard in
 * src/swap.ts): the provider pick, the login mirror (one provider, access token only, never a refresh token,
 * never on an argv / the LaunchSpec / a log), the launch wrapping (mounts, env by name, the linux kit), the
 * launcher's mirror + host refresh, the VM process reader for sleep, the transcript roots, and — the bug this
 * started from — `paw restart <sandboxed> --agent kit` refusing BEFORE it writes the persona. Fake `container`,
 * stub kit binaries, fake tokens; no VM, no mesh, no network. Run: pnpm check:sandbox-kit
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-sbk-")));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ROOT = home;
process.env.PAW_RELEASE = "dev"; // the manager-feature check reads this checkout's manager-features.json
process.env.KIT_HOME = join(home, ".kit");
for (const k of ["PAW_SPACE", "PAW_COTAL_HUB", "PAW_CONTAINER", "PAW_CLAUDE_TOKEN_FILE", "COTAL_NAME", "COTAL_SPACE", "KIT_BIN", "KIT_LINUX_BIN", "KIT_SRC", "SSL_CERT_FILE"]) delete process.env[k];
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
const errOf = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

// Fake `container` (as check:sandbox): logs argv, `run` waits for a stop.
const fakeDir = join(home, "fakebin");
mkdirSync(fakeDir);
const fakeLog = join(home, "container.log");
const lsJson = join(home, "ls.json");
writeFileSync(
  join(fakeDir, "container"),
  `#!/bin/sh
echo "argv: $*" >> "${fakeLog}"
case "$1" in
  ls) cat "${lsJson}" ;;
  run) echo $$ > "${fakeLog}.pid"; trap 'exit 0' TERM; sleep 30 & wait ;;
  stop) kill "$(cat "${fakeLog}.pid")" 2>/dev/null ;;
  delete) echo "[]" > "${lsJson}" ;;
  *) : ;;
esac
`,
  { mode: 0o755 },
);
writeFileSync(lsJson, "[]");
process.env.PATH = `${fakeDir}:${process.env.PATH}`;

// A stub HOST kit: `run … -h` parses (exit 0); `models <p> --refresh` = kit refreshing its own login (it swaps in
// $KIT_HOME/auth.next.json, the "refreshed" store) and logs the call.
const hostKit = join(home, "hostkit", "kit");
mkdirSync(join(home, "hostkit"));
const refreshLog = join(home, "refresh.log");
writeFileSync(
  hostKit,
  `#!/bin/sh
case "$1" in
  run) exit 0 ;;
  models) echo "$*" >> "${refreshLog}"; [ -f "$KIT_HOME/auth.next.json" ] && mv "$KIT_HOME/auth.next.json" "$KIT_HOME/auth.json"; exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 },
);
process.env.KIT_BIN = hostKit;

const ACCESS = "FAKE-XAI-ACCESS-sentinel-never-print";
const REFRESH = "FAKE-XAI-REFRESH-sentinel-never-copy";
const kitStore = join(home, ".kit", "auth.json");
const writeStore = (file: string, expires: number, access = ACCESS) => {
  mkdirSync(join(home, ".kit"), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ xai: { access, refresh: REFRESH, expires } }), { mode: 0o600 });
};

const kitauth = await import("../bin/paw-sandbox-kitauth.mjs");
const sk = await import("../src/sandbox-kit.ts");
const sbx = await import("../src/sandbox.ts");
const { kitConnector } = await import("../src/kit.ts");
const { personaTranscriptRoots, sandboxClaudeDir, sandboxStateDir } = await import("../src/session.ts");
const { writeRemoteMesh } = await import("../src/remote-mesh.ts");
const { applySwap } = await import("../src/swap.ts");
const { vmKitSessionProcs, kitWakeBlocker } = await import("../src/sleep.ts");

const SPACE = "sbkremote";
const root = join(home, "remote-root");
mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
writeFileSync(join(root, ".cotal", "auth", "auth.json"), '{"signer":"SIGNER-SECRET"}', { mode: 0o600 });
writeRemoteMesh({ space: SPACE, server: "tls://192.168.64.1:4222", root, ts: new Date().toISOString() });
const personas = join(home, ".paw", "spaces", SPACE, "personas");
mkdirSync(personas, { recursive: true });
const folder = join(home, "work", "neon");
mkdirSync(folder, { recursive: true });
const credsDir = join(root, ".cotal", "auth", "creds", "space.abc123");
mkdirSync(credsDir, { recursive: true });
const creds = join(credsDir, "neon.uid1.creds");
writeFileSync(creds, "-----BEGIN NATS USER JWT----- neon-v1", { mode: 0o600 });
writeFileSync(join(credsDir, "sibling.uid2.creds"), "SIBLING-CREDS", { mode: 0o600 });
const PIN = "11111111-2222-3333-4444-555555555555";
const persona = (name: string, extra = "") => {
  const f = join(personas, `${name}.md`);
  writeFileSync(f, `---\nname: ${name}\ncwd: ${folder}\nresume: ${PIN}\nsandbox: container\n${extra}---\nYou deploy to neon.\n`);
  return f;
};
const linuxKit = join(home, ".paw", "bin", "linux-arm64", "kit");
const putLinuxKit = () => {
  mkdirSync(join(home, ".paw", "bin", "linux-arm64"), { recursive: true });
  writeFileSync(linuxKit, "#!/bin/sh\n", { mode: 0o755 });
};

console.log("which provider a sandboxed kit agent talks to");
{
  const p = (o: { provider?: string; model?: string; kitArgs?: string[] }) => sk.sandboxKitProvider({ kitArgs: [], ...o }, "neon");
  assert(p({ kitArgs: ["-m", "grok-4.7"] }) === "xai", "-m grok-4.7 → grok (xai)");
  assert(p({ kitArgs: ["--model=codex/gpt-6.1-sol"] }) === "openai" && p({ kitArgs: ["-P", "codex"] }) === "openai", "-m codex/<m>, -P codex → codex (openai)");
  assert(p({ provider: "grok" }) === "xai" && p({ model: "gpt-6.1-sol" }) === "openai", "the persona's provider:/model: count too");
  assert(p({ provider: "codex", kitArgs: ["-P", "grok"] }) === "xai", "kitArgs come last (Go keeps the last flag)");
  assert(p({ kitArgs: ["-P", "fake:codex"] }) === "fake", "kit's offline fake provider needs no login");
  assert(throwsLike(() => p({}), /no provider named.*exactly ONE provider/), "nothing named (kit's own defaults) is refused — paw mirrors one provider");
  assert(throwsLike(() => p({ kitArgs: ["-m", "mystery-1"] }), /can't place \(mystery-1\)/), "a model paw can't place is refused, never guessed");
  assert(throwsLike(() => p({ kitArgs: ["-P", "codex", "-m", "grok-4.7"] }), /say one/), "-P codex -m grok-4.7 is refused (kit refuses it too)");
}

console.log("the host login, mirrored: one provider, access only");
{
  assert(kitauth.hostKitLogin("xai") === undefined, "no login anywhere → none");
  writeStore(kitStore, Date.now() + 3_600_000);
  const l = kitauth.hostKitLogin("xai");
  assert(l?.access === ACCESS && l.refreshable && /kit's own login/.test(l.origin), "kit's own host store is read (refreshable)");
  chmodSync(kitStore, 0o644);
  assert(throwsLike(() => kitauth.hostKitLogin("xai"), /readable by others/), "a group-readable store is refused (kit refuses it too)");
  chmodSync(kitStore, 0o600);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt, account_id: "acct-fake", refresh_token: "CODEX-REFRESH-sentinel" } }));
  const c = kitauth.hostKitLogin("openai");
  assert(c?.access === jwt && !c.refreshable && c.accountId === "acct-fake" && Math.abs(c.expires - (Date.now() + 3_600_000)) < 5_000, "codex's login is borrowed (expiry from its JWT, never refreshable)");
  const mirror = join(home, "mirror-test", "auth.json");
  kitauth.writeKitAuthMirror(mirror, "xai", l!);
  const m = readFileSync(mirror, "utf8");
  assert(Object.keys(JSON.parse(m)).join() === "xai" && !m.includes(REFRESH) && m.includes(ACCESS), "the mirror holds ONE provider's access token — no refresh token");
  assert((statSync(mirror).mode & 0o777) === 0o600, "…0600");
  const h = join(home, "vm-home");
  mkdirSync(h);
  assert(kitauth.vmKitLogin(h) === "absent" && kitauth.linkKitAuthMirror(h) === "mirror", "an agent with no kit login gets the mirror link");
  assert(readlinkSync(join(h, ".kit", "auth.json")) === "/paw/kit-auth/auth.json" && kitauth.vmKitLogin(h) === "mirror", "~/.kit/auth.json → /paw/kit-auth/auth.json (the read-only mount)");
  rmSync(join(h, ".kit", "auth.json"));
  writeFileSync(join(h, ".kit", "auth.json"), JSON.stringify({ openai: { access: "x" } }), { mode: 0o600 });
  assert(kitauth.linkKitAuthMirror(h) === "own" && !lstatSync(join(h, ".kit", "auth.json")).isSymbolicLink(), "an agent's OWN login (kit auth in the VM) is never replaced");
}

console.log("refusals before a launch (spawn site / swap)");
{
  persona("neon-pre", "agent: kit\n");
  const ready = (o: { provider?: string; model?: string; kitArgs?: string[] }, name = "neon-pre") => errOf(() => sk.assertSandboxKitReady(name, { kitArgs: [], ...o }));
  assert(/linux\/arm64 kit, and there is none.*GOOS=linux GOARCH=arm64 go build/.test(ready({ kitArgs: ["-m", "grok-4.7"] })), "no linux kit → refused with the cross-build command");
  putLinuxKit();
  rmSync(kitStore);
  assert(/no grok login to mirror.*kit auth grok/.test(ready({ kitArgs: ["-m", "grok-4.7"] })), "no host grok login → refused with `kit auth grok`");
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a.b.c" } }));
  assert(/has expired.*never refreshes another tool's login/.test(ready({ kitArgs: ["-P", "codex"] })), "an expired BORROWED login is refused (paw never refreshes codex's)");
  writeStore(kitStore, Date.now() - 60_000);
  assert(ready({ kitArgs: ["-m", "grok-4.7"] }) === "", "an expired but refreshable kit login passes (the launcher refreshes it on the host)");
  assert(ready({ kitArgs: ["-P", "fake:codex"] }) === "", "the fake provider needs no login");
  const own = sbx.claimSandboxHome(SPACE, "neon-own");
  mkdirSync(join(own, ".kit"), { recursive: true });
  writeFileSync(join(own, ".kit", "auth.json"), JSON.stringify({ openai: { access: "x" } }), { mode: 0o600 });
  persona("neon-own", "agent: kit\n");
  assert(/its own kit login.*without grok/.test(ready({ kitArgs: ["-m", "grok-4.7"] }, "neon-own")), "its own login without that provider is refused (never mixed with the host's)");
}

console.log("the launch, through the kit connector");
writeStore(kitStore, Date.now() + 3_600_000);
const configPath = persona("neon", 'agent: kit\nkitArgs: ["-m","grok-4.7"]\nstorage: claude\n');
const build = () =>
  kitConnector.buildLaunch({ space: SPACE, name: "neon", configPath, workspaceRoot: root, servers: "tls://192.168.64.1:4222", creds, id: "actor-neon", lifecycleUid: "lc-1", subscribe: ["general"] } as never);
const spec = build();
const all = JSON.stringify(spec);
const runAt = spec.args.indexOf("--");
const pre = spec.args.slice(0, runAt);
const run = spec.args.slice(runAt + 1);
const vols = run.flatMap((a, i) => (a === "-v" ? [run[i + 1]] : []));
const envs = run.flatMap((a, i) => (a === "-e" ? [run[i + 1]] : []));
const stateDir = sandboxStateDir(configPath);
const kitDir = join(home, ".paw", "spaces", SPACE, "kit", "neon");
const homeDir = sbx.sandboxHomeDir("neon");
{
  assert(spec.command === process.execPath && spec.args[0] === sbx.SANDBOX_RUNNER, "runs paw's sandbox launcher under the manager's node");
  assert(!all.includes(ACCESS) && !all.includes(REFRESH), "no token in the LaunchSpec (argv or env)");
  assert(!pre.includes("--token-file"), "no Claude token for a kit seat");
  assert(pre[pre.indexOf("--kit-provider") + 1] === "xai" && pre[pre.indexOf("--kit-auth-mirror") + 1] === join(stateDir, "kit-auth", "auth.json") && pre[pre.indexOf("--kit-host-bin") + 1] === hostKit, "the launcher mirrors grok's login (provider, mirror file, the host kit that refreshes it)");
  const img = run.indexOf(sbx.readSandboxImage(configPath));
  assert(run[img + 1] === sk.SANDBOX_KIT_BIN && run[img + 2] === "run", "the VM runs the mounted linux kit: /paw/kit/kit run …");
  const kargs = run.slice(img + 2);
  const f = (x: string) => kargs[kargs.indexOf(x) + 1];
  assert(f("--server") === "tls://192.168.64.1:4222" && f("--creds") === creds && f("--actor") === "actor-neon" && f("--lifecycle-uid") === "lc-1", "kit joins the mesh itself: the space's server, the manager-minted creds and identity");
  assert(kargs.includes("--overwrite") && f("--session-id") === PIN && kargs.slice(-2).join(" ") === "-m grok-4.7", "storage: claude → --overwrite; first boot --session-id <pin>; kitArgs verbatim, last");
  assert(f("--append-system-prompt-file") === join(kitDir, "system.md"), "its brief is in its kit dir");
  assert(vols.includes(`${folder}:${folder}`) && vols.includes(`${sandboxClaudeDir(configPath)}:/paw/claude`) && vols.includes(`${homeDir}:/root`), "folder rw, its claude store at /paw/claude (storage: claude lands there), its private home at /root");
  assert(vols.includes(`${kitDir}:${kitDir}`), "kit's brief/state dir rw at its own path (schedules.json, read by paw sleep)");
  assert(vols.includes(`${join(home, ".paw", "bin", "linux-arm64")}:/paw/kit:ro`), "the linux kit's dir is mounted READ-ONLY at /paw/kit");
  assert(vols.includes(`${join(stateDir, "kit-auth")}:/paw/kit-auth:ro`), "the login mirror is mounted READ-ONLY at /paw/kit-auth");
  assert(vols.includes(`${join(stateDir, "creds")}:${credsDir}:ro`) && readFileSync(join(stateDir, "creds", "neon.uid1.creds"), "utf8").includes("neon-v1") && !existsSync(join(stateDir, "creds", "sibling.uid2.creds")), "the creds dir is served from ITS OWN mirror (not the sibling's)");
  const sources = vols.map((v) => v.split(":")[0]);
  assert(!sources.some((s) => s === home || s === join(home, ".kit") || s === join(home, ".codex") || s === join(home, ".paw") || s === root || s.startsWith(join(root, ".cotal"))), "never the host's home, ~/.kit, ~/.codex, ~/.paw or the cotal root");
  assert(envs.every((e) => !e.includes("=")) && !envs.some((e) => ["HOME", "PATH", "KIT_HOME", "USER"].includes(e)), "-e passes NAMES only, no host HOME/PATH/KIT_HOME");
  const vmEnv = readFileSync(run[run.indexOf("--env-file") + 1], "utf8");
  assert(/^KIT_HOME=\/root\/\.kit$/m.test(vmEnv) && /^CLAUDE_CONFIG_DIR=\/paw\/claude$/m.test(vmEnv) && /^HOME=\/root$/m.test(vmEnv) && /^BASH_ENV=\/paw\/seat\/bashenv\.sh$/m.test(vmEnv), "VM env file: KIT_HOME=/root/.kit, CLAUDE_CONFIG_DIR=/paw/claude, HOME, BASH_ENV (kit's shell gets ~/.env)");
  assert(readlinkSync(join(homeDir, ".kit", "auth.json")) === "/paw/kit-auth/auth.json", "its ~/.kit/auth.json links to the mirror");
  assert(/^paw-sbkremote-neon-[0-9a-f]{6}$/.test(run[run.indexOf("--name") + 1]) && run.includes("paw.agent=neon"), "a fresh, labelled container id");
  const brief = readFileSync(join(kitDir, "system.md"), "utf8");
  assert(brief.includes("YOU RUN IN A SANDBOX") && brief.includes("~/.env") && !brief.includes("claude mcp add"), "the kit brief says it runs in a sandbox (kit's variant, no claude MCP lines)");
  const proj = join(sandboxClaudeDir(configPath), "projects", folder.replace(/[^A-Za-z0-9_]/g, "-"));
  mkdirSync(join(home, ".claude", "projects", "x"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "x", `${PIN}.jsonl`), "{}\n");
  assert(build().args.includes("--session-id"), "a transcript only in the HOST's ~/.claude never counts");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${PIN}.jsonl`), "{}\n");
  assert(build().args.includes("--resume"), "the sandbox's own claude store holds it → --resume");
  assert(personaTranscriptRoots(configPath).join() === join(sandboxClaudeDir(configPath), "projects"), "paw log/status/sleep read its sandbox claude store (storage: claude)");
  const kp = persona("neon-kitstore", 'agent: kit\nkitArgs: ["-m","grok-4.7"]\n');
  assert(personaTranscriptRoots(kp).join() === [join(home, ".paw", "containers", "neon-kitstore", ".kit", "sessions"), join(sandboxClaudeDir(kp), "projects")].join(), "…and on kit's own store: its home's .kit/sessions, then its claude store");
  const fake = persona("neon-fake", 'agent: kit\nkitArgs: ["-P","fake:codex"]\n');
  const fs_ = kitConnector.buildLaunch({ space: SPACE, name: "neon-fake", configPath: fake, workspaceRoot: root, servers: "tls://x:1", creds, id: "a", lifecycleUid: "l" } as never);
  assert(!fs_.args.includes("--kit-provider") && !fs_.args.some((a) => a.includes("/paw/kit-auth")), "the fake provider: no mirror, no login mount");
  const ca = join(home, "private-ca.pem");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n");
  process.env.NODE_EXTRA_CA_CERTS = ca;
  const withCa = build();
  delete process.env.NODE_EXTRA_CA_CERTS;
  const caEnv = readFileSync(withCa.args[withCa.args.indexOf("--env-file") + 1], "utf8");
  assert(/^SSL_CERT_DIR=\/etc\/ssl\/certs:\/paw\/seat\/ca$/m.test(caEnv) && !/^SSL_CERT_FILE=/m.test(caEnv) && readFileSync(join(stateDir, "seat", "ca", "extra-ca.pem"), "utf8").includes("FAKE"), "a private broker CA (NODE_EXTRA_CA_CERTS) reaches Go via SSL_CERT_DIR beside the public roots");
  const stray = join(home, ".paw", "bin", "linux-arm64", "other-secret");
  writeFileSync(stray, "x");
  assert(throwsLike(build, /must hold only kit/), "a linux kit dir holding anything else is refused (it is mounted whole)");
  rmSync(stray);
}

console.log("the launcher: mirror, host refresh, renewal");
{
  // The store lapses within the launcher's look-ahead: it refreshes on the HOST before the first mirror.
  writeStore(kitStore, Date.now() + 60_000);
  writeStore(join(home, ".kit", "auth.next.json"), Date.now() + 7_200_000, `${ACCESS}-2`);
  const mirror = join(stateDir, "kit-auth", "auth.json");
  const p = spawn(process.execPath, spec.args, { env: { ...spec.env, PATH: process.env.PATH!, PAW_KIT_AUTH_POLL_MS: "200", PAW_SANDBOX_PROBE_MS: "600000" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d));
  const until = async (f: () => boolean, ms = 8_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (f()) return true;
    return false;
  };
  assert(await until(() => existsSync(fakeLog) && readFileSync(fakeLog, "utf8").includes("argv: run")), "the launcher starts `container run`");
  assert(existsSync(refreshLog) && readFileSync(refreshLog, "utf8").trim() === "models grok --refresh", "a lapsing kit login is refreshed on the host first (`kit models grok --refresh`)");
  const m1 = JSON.parse(readFileSync(mirror, "utf8"));
  assert(m1.xai?.access === `${ACCESS}-2` && !("refresh" in m1.xai) && Object.keys(m1).join() === "xai", "…and the refreshed access token is mirrored (one provider, no refresh token)");
  writeStore(kitStore, Date.now() + 9_000_000, `${ACCESS}-3`);
  assert(await until(() => JSON.parse(readFileSync(mirror, "utf8")).xai?.access === `${ACCESS}-3`), "a host renewal is mirrored into the running seat");
  p.kill("SIGTERM");
  await new Promise((r) => p.on("exit", r));
  const log = readFileSync(join(stateDir, "launcher.log"), "utf8");
  assert(/kit auth: grok from kit's own login/.test(log) && /renewed on the host/.test(log), "launcher.log says where the login came from and each renewal");
  assert(!log.includes(ACCESS) && !log.includes(REFRESH) && !stderr.includes(ACCESS) && !readFileSync(fakeLog, "utf8").includes(ACCESS), "no token in launcher.log, stderr or the container's argv");
  rmSync(kitStore);
  const q = spawn(process.execPath, spec.args, { env: { ...spec.env, PATH: process.env.PATH! }, stdio: ["ignore", "ignore", "pipe"] });
  let qerr = "";
  q.stderr.on("data", (d) => (qerr += d));
  const code = await new Promise((r) => q.on("exit", r));
  assert(code === 2 && /no grok login to mirror/.test(qerr), "no host login at launch → the launcher fails loud before any VM");
}

console.log("paw sleep in the VM");
{
  const ps = [
    "    1     0  100 /sbin/init",
    "    7     1   90 /paw/kit/kit run --cwd . --name neon --space sbkremote --server tls://x:1",
    "   20     7   88 /bin/bash --noprofile --norc",
    "   31    20   10 npm run build",
    "   40     1    5 node server.js",
    "   50     0    1 ps -eo pid=,ppid=,etimes=,args=",
  ].join("\n");
  const r = vmKitSessionProcs(ps, 1_000_000);
  assert(r.ok && r.where === "vm" && r.startedAt === 1_000_000 - 90_000, "the seat is the mounted linux kit's `run`");
  assert(r.ok && r.shells.length === 1 && r.shells[0].includes("npm run build"), "work under kit's shell counts, the persistent shell itself does not");
  assert(r.ok && r.detached.length === 1 && r.detached[0].includes("node server.js"), "work it detached to the VM's init is reported; container exec sessions (ppid 0) are not");
  assert(!vmKitSessionProcs(ps.replace("/paw/kit/kit run", "/usr/bin/other run")).ok, "no kit seat in the VM → unknown, never idle");
  rmSync(linuxKit);
  const blocker = kitWakeBlocker(configPath, PIN, personaTranscriptRoots(configPath), { bin: hostKit, preflight: () => {} });
  assert(/no linux kit .* in its sandbox/.test(blocker ?? ""), "a sandboxed kit whose linux kit is gone never sleeps (its wake couldn't relaunch it)");
  putLinuxKit();
  assert(kitWakeBlocker(configPath, PIN, personaTranscriptRoots(configPath), { bin: hostKit, preflight: () => {} }) === undefined, "…with it, the wake resumes from the sandbox store");
}

console.log("swap guard: a swap that can't launch never writes (paw restart <sandboxed> --agent kit)");
{
  const claudeP = persona("vercel"); // a sandboxed CLAUDE agent, as neon/vercel are
  const before = readFileSync(claudeP, "utf8");
  const lines: string[] = [];
  rmSync(linuxKit);
  const e1 = errOf(() => applySwap(SPACE, "vercel", { agent: "kit", kitArgs: ["-m", "grok-4.7"] }, (l) => lines.push(l)));
  assert(/can't swap sandboxed "vercel" to kit.*linux\/arm64.*nothing was changed; vercel keeps running on claude/.test(e1), "no linux kit → refused with the build command, nothing changed");
  assert(readFileSync(claudeP, "utf8") === before && !lines.length, "…the persona is byte-identical (main wrote agent: kit here, then the restart failed)");
  putLinuxKit();
  const e2 = errOf(() => applySwap(SPACE, "vercel", { agent: "kit" }, () => {}));
  assert(/can't swap sandboxed.*no provider named/.test(e2) && readFileSync(claudeP, "utf8") === before, "no provider named → refused before writing");
  const e3 = errOf(() => applySwap(SPACE, "vercel", { agent: "kit", kitArgs: ["-m", "grok-4.7"] }, () => {}));
  assert(/no grok login to mirror/.test(e3) && readFileSync(claudeP, "utf8") === before, "no host grok login → refused before writing");
  writeStore(kitStore, Date.now() + 3_600_000);
  assert(applySwap(SPACE, "vercel", { agent: "kit", kitArgs: ["-m", "grok-4.7"] }, (l) => lines.push(l)), "host ready → the swap writes");
  const after = readFileSync(claudeP, "utf8");
  assert(/^agent: kit$/m.test(after) && /^kitArgs: \["-m","grok-4\.7"\]$/m.test(after) && /^storage: claude$/m.test(after) && /^sandbox: container$/m.test(after) && after.includes(`resume: ${PIN}`), "…agent: kit, kitArgs verbatim, storage: claude, still sandboxed, same pin");
  assert(!lines.join("\n").includes(ACCESS), "nothing printed carries a token");
  const back = errOf(() => applySwap(SPACE, "vercel", { agent: "claude" }, () => {}));
  assert(/can't swap sandboxed "vercel" to claude.*Claude OAuth token.*nothing was changed/.test(back) && readFileSync(claudeP, "utf8") === after, "the way back is guarded too: no Claude token → refused, persona untouched");
  mkdirSync(join(home, ".paw", "secrets"), { recursive: true });
  writeFileSync(join(home, ".paw", "secrets", "claude-oauth-token"), "sk-ant-oat01-FAKE\n", { mode: 0o600 });
  assert(applySwap(SPACE, "vercel", { agent: "claude" }, () => {}) && !/^agent:/m.test(readFileSync(claudeP, "utf8")), "with the token, kit → claude swaps back");
  // a sandboxed agent on a LOCAL space: the swap is refused before writing (the VM can't reach a local broker)
  mkdirSync(join(home, ".paw", "spaces", "localsp", "personas"), { recursive: true });
  const lp = join(home, ".paw", "spaces", "localsp", "personas", "loc.md");
  writeFileSync(lp, `---\nname: loc\ncwd: ${folder}\nresume: ${PIN}\nsandbox: container\n---\n`);
  const lb = readFileSync(lp, "utf8");
  assert(/LOCAL space/.test(errOf(() => applySwap("localsp", "loc", { agent: "kit", kitArgs: ["-m", "grok-4.7"] }, () => {}))) && readFileSync(lp, "utf8") === lb, "a sandboxed agent on a local space: refused, untouched");
}

rmSync(home, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\ncheck:sandbox-kit passed");

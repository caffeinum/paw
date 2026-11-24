/**
 * e2e:sandbox-kit — a SANDBOXED agent swapped from claude to kit runs kit INSIDE its Apple `container` VM and is
 * still the same peer on the mesh. Real VM, real paw manager (PAW_RELEASE=dev), real kit (cross-built for
 * linux/arm64 by paw itself), kit's offline fake provider (`-P fake:codex`) — no model account, no real token.
 * Fully isolated: own PAW_HOME, a throwaway JWT + TLS broker (`cotal up --no-manager`) on the vmnet gateway
 * (the only host address a VM reaches without NAT tricks), a decoy PAW_SPACE, test container names only.
 *
 *   1. a sandboxed (claude) persona → `paw restart <n> --agent kit -- -P fake:codex` writes the swap and starts it;
 *   2. the seat is a VM: one labelled container, `/paw/kit/kit run` in its ps, no `kit run` on the host;
 *   3. a DM is answered FROM the VM (kit's shell tool ran uname/env/ls there) and reaches `paw inbox`;
 *   4. the transcript is in the agent's sandbox claude store (storage: claude), not the host's ~/.claude;
 *   5. `paw restart` resumes the same session (the next reply carries more history);
 *   6. `paw stop` leaves no container;
 *   7. a second agent on `-m grok-4.7` with a FAKE grok login in the host's (test) kit home: kit in the VM sees the
 *      mirrored login (access token only, read-only), the log never carries it; no model call is made;
 *   8. teardown leaves no process or container naming the space.
 *
 *   COTAL_BIN=<cotal-ai@0.110.0>/dist/cotal.js KIT_SRC=<kit checkout> node scripts/e2e-sandbox-kit.ts
 *
 * Needs `container` running and the default sandbox image built (`paw sandbox build`). E2E_SANDBOX_HOST overrides
 * the broker address (default 192.168.64.1 — up while any container runs).
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const COTAL = process.env.COTAL_BIN ?? "";
const KIT_SRC = process.env.KIT_SRC ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:sandbox-kit needs COTAL_BIN=<cotal-ai package>/dist/cotal.js");
if (!KIT_SRC || !existsSync(join(KIT_SRC, "go.mod"))) throw new Error("e2e:sandbox-kit needs KIT_SRC=<kit checkout>");

// Helper mode: register a folder agent as a sandboxed CLAUDE agent (never started), as neon/vercel are.
if (process.argv[2] === "--register") {
  const [, , , space, dir, name] = process.argv;
  const { setFolderName, ensurePersonaFile, setPersonaKeys } = await import("../src/addressing.ts");
  setFolderName(space!, dir!, name!);
  ensurePersonaFile(space!, name!, { kind: "folder" });
  setPersonaKeys(space!, name!, { cwd: dir, sandbox: "container", sandboxMemory: "1G" });
  process.exit(0);
}

const GW = process.env.E2E_SANDBOX_HOST ?? "192.168.64.1";
const tag = `${process.pid}`;
const R = `sbkit-${tag}`;
const DECOY = `sbkdecoy-${tag}`;
const NAME = "skit";
const home = mkdtempSync("/tmp/psk-");
const work = realpathSync(mkdtempSync("/tmp/psk-work-"));
const remoteRoot = join(work, "remote");
const localRoot = join(work, "local");
const agentDir = join(work, "agent");
for (const d of [remoteRoot, join(localRoot, ".cotal", "auth"), agentDir, join(work, "cotalhome"), join(work, "xdg"), join(work, "hostkit")]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: agentDir });
const port = await new Promise<number>((r, j) => {
  const s = createServer().once("error", j).listen(0, GW, () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const server = `tls://${GW}:${port}`;
const cert = join(work, "cert.pem");
const key = join(work, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", `subjectAltName=DNS:localhost,IP:${GW}`], { stdio: "ignore" });
const hostKit = join(work, "hostkit", "kit");
execFileSync("go", ["build", "-o", hostKit, "./cmd/kit"], { cwd: KIT_SRC, stdio: "inherit" });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAW_HOME: home,
  PAW_SPACE: DECOY,
  PAW_SERVER: "nats://127.0.0.1:9",
  PAW_RELEASE: "dev",
  PAW_RUNTIME: "pty",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NODE_EXTRA_CA_CERTS: cert,
  KIT_BIN: hostKit,
  KIT_SRC, // paw cross-builds the linux kit itself on the first sandboxed spawn
  KIT_HOME: join(work, "kithome"), // the host kit's own home (unused by the fake provider) — never ~/.kit
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "PAW_COTAL_HUB", "KIT_LINUX_BIN", "SSL_CERT_FILE"]) delete env[k];

let fails = 0;
let checks = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  checks++;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const run = (cmd: string, args: string[], cwd = REPO, timeout = 300_000): SpawnSyncReturns<string> => spawnSync(cmd, args, { env, cwd, encoding: "utf8", timeout });
const paw = (args: string[]) => run(process.execPath, [join(REPO, "bin/paw.ts"), ...args]);
const cotal = (args: string[]) => run(process.execPath, [COTAL, ...args], remoteRoot);
const out = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "");
const must = (what: string, r: SpawnSyncReturns<string>) => {
  if (r.status !== 0) throw new Error(`e2e:sandbox-kit setup failed — ${what}: ${out(r).trim()}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs = (needle: string) => execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(needle) && !l.includes("e2e-sandbox-kit"));
const containers = () =>
  (JSON.parse(execFileSync("container", ["ls", "--all", "--format", "json"], { encoding: "utf8" })) as Array<{ configuration: { id: string; labels?: Record<string, string> }; status?: { state?: string } }>)
    .filter((c) => c.configuration.labels?.["paw.space"] === R)
    .map((c) => ({ id: c.configuration.id, agent: c.configuration.labels?.["paw.agent"], state: c.status?.state }));
async function inboxHas(re: RegExp, ms: number): Promise<string | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(3000)) {
    const r = paw(["inbox", "--space", R, "--json"]);
    const hit = out(r).split("\n").find((l) => re.test(l));
    if (hit) return hit;
  }
  return undefined;
}
const shell = (cmd: string) => `FAKE: ${JSON.stringify([{ name: "shell_command", args: JSON.stringify({ command: cmd }) }])}`;

try {
  must("cotal up", cotal(["up", "--detach", "--no-manager", "--space", R, "--server", server, "--host", GW, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")]));
  const exported = join(work, "signer.json");
  must("cotal auth signer", cotal(["auth", "signer", "--out", exported]));
  copyFileSync(exported, join(localRoot, ".cotal", "auth", "auth.json"));
  must("paw mesh add", paw(["mesh", "add", R, "--server", server, "--root", localRoot]));
  must("register", run(process.execPath, [join(REPO, "scripts/e2e-sandbox-kit.ts"), "--register", R, agentDir, NAME]));
  const persona = join(home, "spaces", R, "personas", `${NAME}.md`);
  const pin = /^resume: (\S+)$/m.exec(readFileSync(persona, "utf8"))?.[1];

  // ── 1. swap + start ─────────────────────────────────────────────────────────────────────────────────
  const swap = paw(["restart", NAME, "--space", R, "--agent", "kit", "--", "-P", "fake:codex"]);
  const p = readFileSync(persona, "utf8");
  ok(
    "paw restart <sandboxed> --agent kit writes the swap (agent: kit, kitArgs, storage: claude, still sandboxed) and starts it",
    swap.status === 0 && /^agent: kit$/m.test(p) && /^storage: claude$/m.test(p) && /^sandbox: container$/m.test(p),
    out(swap).trim().split("\n").slice(-4).join(" | "),
  );
  ok("paw cross-built the linux/arm64 kit into $PAW_HOME/bin/linux-arm64", existsSync(join(home, "bin", "linux-arm64", "kit")) && /ELF 64-bit.*aarch64/.test(execFileSync("file", [join(home, "bin", "linux-arm64", "kit")], { encoding: "utf8" })));

  // ── 2. the seat is a VM ─────────────────────────────────────────────────────────────────────────────
  const cs = containers().filter((c) => c.state === "running");
  ok("one running container, labelled with the test space + agent", cs.length === 1 && cs[0].agent === NAME, JSON.stringify(containers()));
  const vmPs = cs[0] ? execFileSync("container", ["exec", cs[0].id, "ps", "-eo", "args="], { encoding: "utf8" }) : "";
  ok("kit runs INSIDE the VM (/paw/kit/kit run … --creds …)", /^\/paw\/kit\/kit run .*--name skit .*--creds /m.test(vmPs), vmPs.split("\n").find((l) => l.includes("kit")) ?? vmPs.slice(0, 200));
  ok("no `kit run` for it on the host", procs(`--space ${R}`).filter((l) => / run .*--name skit/.test(l) && !l.includes("container")).length === 0, procs(`--space ${R}`).join(" | "));
  const st = out(paw(["status", "--space", R, "--json"]));
  ok("paw status: live", /"name":\s*"skit"[\s\S]*"live":\s*true/.test(st), st.slice(0, 300));

  // ── 3. a DM answered from the VM ────────────────────────────────────────────────────────────────────
  must("dm", paw(["dm", "--space", R, NAME, `${shell("uname -sm; echo KH=$KIT_HOME HOME=$HOME CC=$CLAUDE_CONFIG_DIR; test -e /root/.paw && echo HOSTPAW || echo NOHOSTPAW; ls ~/.kit")}\nprobe-one`]));
  const r1 = await inboxHas(/FAKE-REPLY.*probe-one/, 120_000);
  ok("the DM is answered over the mesh, from the VM", !!r1, r1?.slice(0, 200));
  ok("…its shell ran in linux/arm64 with KIT_HOME=/root/.kit, CLAUDE_CONFIG_DIR=/paw/claude, no host ~/.paw", !!r1 && /Linux aarch64/.test(r1) && /KH=\/root\/\.kit/.test(r1) && /CC=\/paw\/claude/.test(r1) && /NOHOSTPAW/.test(r1), r1?.slice(0, 400));
  const h1 = Number(/history_items=(\d+)/.exec(r1 ?? "")?.[1] ?? 0);

  // ── 4. the transcript is in its sandbox store ───────────────────────────────────────────────────────
  const store = join(home, "spaces", R, "sandbox", NAME, "claude", "projects");
  const files = existsSync(store) ? readdirSync(store).flatMap((d) => readdirSync(join(store, d)).map((f) => join(store, d, f))) : [];
  ok("the transcript is <sandbox>/claude/projects/<slug>/<pin>.jsonl (storage: claude)", files.some((f) => f.endsWith(`/${pin}.jsonl`)), files.join(" "));
  const hostClaude = join(homedir(), ".claude", "projects");
  ok("…and not in the host's ~/.claude", !readdirSync(hostClaude).some((d) => existsSync(join(hostClaude, d, `${pin}.jsonl`))));
  const log = out(paw(["log", NAME, "--space", R]));
  ok("paw log reads it", /probe-one/.test(log), log.slice(-300));

  // ── 5. restart resumes ──────────────────────────────────────────────────────────────────────────────
  must("restart", paw(["restart", NAME, "--space", R]));
  must("dm 2", paw(["dm", "--space", R, NAME, `${shell("echo again")}\nprobe-two`]));
  const r2 = await inboxHas(/FAKE-REPLY.*probe-two/, 120_000);
  const h2 = Number(/history_items=(\d+)/.exec(r2 ?? "")?.[1] ?? 0);
  ok("after paw restart the same session resumes (more history in the next reply)", !!r2 && h2 > h1, `history ${h1} → ${h2}`);
  ok("…in a fresh container (one per launch)", containers().filter((c) => c.state === "running").length === 1);

  // ── 6. stop ─────────────────────────────────────────────────────────────────────────────────────────
  must("stop", paw(["stop", NAME, "--space", R]));
  ok("paw stop leaves no container", containers().length === 0, JSON.stringify(containers()));

  // ── 7. a real provider's login, mirrored (a FAKE grok token — never a real one; no model call is made) ──
  const kitHome = env.KIT_HOME!;
  mkdirSync(kitHome, { recursive: true, mode: 0o700 });
  const FAKE_ACCESS = `fake-grok-access-${tag}`;
  writeFileSync(join(kitHome, "auth.json"), JSON.stringify({ xai: { access: FAKE_ACCESS, refresh: `fake-grok-refresh-${tag}`, expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  const G = "sgrok";
  const gDir = join(work, "grok-agent");
  mkdirSync(gDir);
  must("register grok", run(process.execPath, [join(REPO, "scripts/e2e-sandbox-kit.ts"), "--register", R, gDir, G]));
  // --compact-at: kit skips its model listing at boot, so the fake token never leaves this machine.
  const gs = paw(["restart", G, "--space", R, "--agent", "kit", "--", "-m", "grok-4.7", "--compact-at", "100000"]);
  ok("a sandboxed agent swaps to kit on grok (host login present) and starts", gs.status === 0, out(gs).trim().split("\n").slice(-3).join(" | "));
  const gc = containers().find((c) => c.agent === G && c.state === "running");
  const status = gc ? spawnSync("container", ["exec", gc.id, "/paw/kit/kit", "auth", "status"], { encoding: "utf8" }) : undefined;
  ok("in the VM kit finds the mirrored grok login (kit auth, not refreshable)", /grok \(xai\): kit auth \(\/root\/\.kit\/auth\.json\).*refreshable=false/.test(status?.stdout ?? ""), (status?.stdout ?? "").trim());
  const link = gc ? spawnSync("container", ["exec", gc.id, "readlink", "/root/.kit/auth.json"], { encoding: "utf8" }).stdout.trim() : "";
  ok("…through ~/.kit/auth.json → /paw/kit-auth/auth.json", link === "/paw/kit-auth/auth.json", link);
  const vmCat = gc ? spawnSync("container", ["exec", gc.id, "cat", "/paw/kit-auth/auth.json"], { encoding: "utf8" }).stdout : "";
  ok("…which carries the access token only (no refresh token in the VM)", vmCat.includes(FAKE_ACCESS) && !vmCat.includes("refresh"), "");
  const wr = gc ? spawnSync("container", ["exec", gc.id, "sh", "-c", "echo x > /paw/kit-auth/auth.json"], { encoding: "utf8" }) : undefined;
  ok("…read-only from inside the VM", !!wr && wr.status !== 0, (wr?.stderr ?? "").trim());
  const glog = readFileSync(join(home, "spaces", R, "sandbox", G, "launcher.log"), "utf8");
  ok("launcher.log names the login's origin and never the token", /kit auth: grok from kit's own login/.test(glog) && !glog.includes(FAKE_ACCESS), "");
  ok("no token on any host process argv", !procs(FAKE_ACCESS).length);
  must("stop grok", paw(["stop", G, "--space", R]));
} finally {
  console.log(out(paw(["down", "--space", R])).trim());
  console.log(out(cotal(["down", "--yes"])).trim());
  await sleep(2000);
  for (const c of containers()) spawnSync("container", ["delete", "--force", c.id]);
  const left = [...procs(R), ...procs(DECOY)];
  ok("teardown leaves no process or container naming the test space", left.length === 0 && containers().length === 0, left.join(" | "));
  for (const l of left) {
    try {
      process.kill(Number(l.trim().split(/\s+/)[0]), "SIGTERM");
    } catch {
      /* gone */
    }
  }
  if (process.env.E2E_KEEP) console.log(`E2E_KEEP: kept ${home} ${work}`);
  else for (const d of [home, work]) rmSync(d, { recursive: true, force: true });
}
console.log(`\ne2e:sandbox-kit — ${checks} checks, ${fails} failure(s)`);
if (fails) process.exit(1);

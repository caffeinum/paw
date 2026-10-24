/**
 * e2e:teleport — `paw teleport` end to end between this machine and a box paw does not share a process
 * table with: a Docker container running sshd and THIS checkout's paw, reached over the real `ssh:`
 * transport. Both machines join one remote space on a private cotal 0.84 JWT + TLS broker (the
 * e2e-remote recipe), each with its own PAW_HOME, record root and manager.
 *
 * The agent is an `agent: acp` seat driving a scripted ACP agent (no login anywhere, so nothing of the
 * operator's is used), its folder a git repo with one unpushed commit, mirrored at the same absolute
 * path inside the container (the repo's remote is a bare repo bind-mounted at the same path there).
 * HOME is a temp dir on both sides: memory, a skill and a CLAUDE.md come from fixtures.
 *
 *   1. the agent runs here; `paw teleport tele --to ssh:<container> --repo --memory --skills --claude-md
 *      --dry-run` passes preflight and copies nothing;
 *   2. the real teleport: files, the repo at the same HEAD (unpushed commit via bundle), the persona; the
 *      agent is present on the mesh from the container, not run here; this persona is marked; a DM here
 *      and `paw start` here refuse it;
 *   3. `--back`: it runs here again, the container's copy is marked `teleported: origin` and its own
 *      `paw start` refuses it;
 *   4. a target whose `paw start` fails: the teleport fails loud, the agent is restarted HERE, this
 *      persona stays unmarked and the container's copy is marked origin;
 *   5. teardown: the container, both managers, the broker, the temp dirs.
 *
 *   COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-teleport.ts
 *
 * Needs docker (OrbStack's host.docker.internal reaches the host's loopback broker) and openssl.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
// Helper mode (run with this machine's env): a claude agent's session + memory moved over the real ssh
// transport the way the cutover's copy step does it — remapped into the target folder's project dir, then
// `paw __teleport rewrite-cwd` THERE. (A claude seat can't start in the container: no login.)
if (process.argv[2] === "--relocate") {
  const [, , , host, space, name] = process.argv;
  const plan = await import("../src/teleport-plan.ts");
  const shell = await import("../src/teleport-shell.ts");
  const { personaFilePath } = await import("../src/addressing.ts");
  const what: Array<"session" | "memory"> = ["session", "memory"];
  const m = plan.buildManifest({ space: space!, name: name!, personaFile: personaFilePath(space!, name!), what });
  const side = shell.remoteSide({ kind: "ssh", host: host! });
  const folder = plan.destFolder(m, what, await shell.probeEnv(side));
  const files = plan.manifestFiles(m);
  const memSlug = (await shell.probe(side, m, what, folder)).memory?.slug;
  await shell.copyFiles(shell.localSide(), side, files.map((f) => ({ src: f.rel, dst: plan.remapRel(f.rel, m, folder.cwd, memSlug) })));
  const rels = plan.transcriptRels(files, m).map((r) => plan.remapRel(r, m, folder.cwd, memSlug));
  const r = await shell.run(side, shell.pawScript(["__teleport", "rewrite-cwd", "--from", m.cwd, "--to", folder.cwd, "--space", space!]), rels.join("\n") + "\n");
  console.log(JSON.stringify({ folder: folder.cwd, chain: m.chain, rels, code: r.code, out: r.stdout.toString("utf8").trim(), err: shell.said(r) }));
  process.exit(0);
}

const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("e2e:teleport needs COTAL_BIN=<cotal-ai package>/dist/cotal.js (see the header)");

const tag = `${process.pid}`;
const R = `teletest-${tag}`;
const DECOY = `teledecoy-${tag}`;
const work = realpathSync(mkdtempSync("/tmp/pt-"));
const pawHome = join(work, "p");
const home = join(work, "home");
const root = join(work, "root");
// Its remote is a GitHub URL (teleport places a repo by owner/repo: <PAW_HOME>/repos/e2e/repo there),
// served on both machines by the bind-mounted bare repo through url.insteadOf.
const repo = join(home, "Github", "repo");
const repoUrl = "https://github.com/e2e/repo.git";
const repoThere = "/root/.paw/repos/e2e/repo";
const slugOf = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
const agentBin = join(work, "agentbin"); // the scripted ACP agent, bind-mounted at the same path there
const bare = join(work, "remote.git");
const ctr = `paw-e2e-teleport-${tag}`;
const host = `paw-e2e-${tag}`;
const image = "paw-e2e-teleport:dev";
for (const d of [pawHome, agentBin, join(root, ".cotal", "auth"), join(work, "cotalhome"), join(work, "xdg"), join(work, "bin"), join(work, "certs"), join(work, "store")]) mkdirSync(d, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; input?: string; timeout?: number } = {}): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { env, cwd: opts.cwd ?? REPO, input: opts.input, encoding: "utf8", timeout: opts.timeout ?? 300_000 });
const out = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "");
const tail = (s: string, n = 8) => s.trim().split("\n").slice(-n).join("\n    ");

// ── the broker (private, JWT + TLS), as e2e-remote stands it up ──────────────────────────────────────
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const cert = join(work, "certs", "cert.pem");
const key = join(work, "certs", "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1"], { stdio: "ignore" });
chmodSync(key, 0o600);

// ── this machine's environment: isolated PAW_HOME, HOME, cotal home; a decoy current space ───────────
const base: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  PAW_HOME: pawHome,
  PAW_SPACE: DECOY,
  PAW_SERVER: "nats://127.0.0.1:9",
  PAW_RELEASE: "dev",
  PAW_RUNTIME: "pty",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NODE_EXTRA_CA_CERTS: cert,
  PATH: `${join(work, "bin")}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: "e2e",
  GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "e2e",
  GIT_COMMITTER_EMAIL: "e2e@example.invalid",
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "PAW_COTAL_HUB", "PAW_ROOT", "KIT_HOME"]) delete base[k];
const paw = (args: string[], opts: { input?: string; timeout?: number } = {}) => run(process.execPath, [join(REPO, "bin/paw.ts"), ...args], base, opts);
const cotal = (args: string[]) => run(process.execPath, [COTAL, ...args], base, { cwd: join(work, "store") });
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: base, encoding: "utf8" }).trim();
const docker = (args: string[], input?: string) => run("docker", args, process.env, { input, timeout: 900_000 });
/** A shell inside the container, with its login environment (the same profile the transport sources). */
const there = (script: string) => docker(["exec", "-i", ctr, "sh", "-c", `. /root/.profile; ${script}`]);

/** The scripted ACP agent (after cotal-connector-acp's test/fake-acp-agent.mjs): enough protocol for a seat. */
const FAKE_ACP = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) return;
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: false } }, authMethods: [] } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
  if (msg.method === "session/prompt") return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no " + msg.method } });
}).on("close", () => process.exit(0));
`;

const DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-server ca-certificates procps \\
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \\
 && git config --system --add safe.directory '*'
# (the bind-mounted bare repo is owned by the host user; root's git would call it dubious)
RUN npm install -g --ignore-scripts pnpm@11.1.2
WORKDIR /opt/paw
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile --ignore-scripts
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;

/** `/root/.profile` there: what paw runs with on that box. `paw start` fails while /root/fail-start exists. */
const PROFILE = `export PATH=/usr/local/bin:/usr/bin:/bin
export PAW_HOME=/root/.paw PAW_SPACE=${DECOY} PAW_SERVER=nats://127.0.0.1:9 PAW_RELEASE=dev PAW_RUNTIME=pty
export NODE_EXTRA_CA_CERTS=/certs/cert.pem COTAL_SKIP_CONNECTOR_SEED=1 COTAL_HOME=/root/.cotalhome
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid
`;
/** `claude` there: a login check that says yes, and nothing else — enough for a claude agent's preflight. */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then echo '{"loggedIn": true, "authMethod": "e2e-fake"}'; exit 0; fi
echo "e2e fake claude: there is no model here" >&2; exit 1
`;
const LAUNCHER = `#!/bin/sh
if [ "$1" = start ] && [ -f /root/fail-start ]; then echo "e2e fixture: paw start refused on this box" >&2; exit 1; fi
exec /usr/local/bin/node /opt/paw/bin/paw.mjs "$@"
`;

const personaPath = join(pawHome, "spaces", R, "personas", "tele.md");
const persona = () => (existsSync(personaPath) ? readFileSync(personaPath, "utf8") : "");
const thereText = (file: string) => there(`cat ${file} 2>/dev/null`).stdout ?? "";
const remotePersona = () => thereText(`/root/.paw/spaces/${R}/personas/tele.md`);

async function present(want: boolean, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = out(paw(["who", "--space", R]));
    if (/\btele\b/.test(last) === want) return last;
    await sleep(2000);
  }
  return last;
}
type Row = { name?: string; live?: boolean; unmanaged?: boolean };
/** `paw status`'s row for tele here: "here" = live AND run by this machine's manager; "elsewhere" = live on
 *  the mesh but not this manager's (status calls that unmanaged). */
const whereHere = (): string => {
  try {
    const row = (JSON.parse(paw(["status", "--space", R, "--json"]).stdout) as { rows: Row[] }).rows.find((r) => r.name === "tele");
    return !row ? "no row" : !row.live ? "offline" : row.unmanaged ? "elsewhere" : "here";
  } catch (e) {
    return `unreadable (${(e as Error).message})`;
  }
};

try {
  // ── the broker + this machine's record ───────────────────────────────────────────────────────────
  const up = cotal(["up", "--detach", "--no-manager", "--space", R, "--server", `tls://127.0.0.1:${port}`, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store", "data")]);
  ok("broker up (JWT + TLS)", up.status === 0, tail(out(up), 2));
  const signer = join(root, ".cotal", "auth", "auth.json");
  // cotal 0.100: `auth signer` (was `mint --signer`), and it refuses an --out inside any `.cotal/` — export beside, copy in.
  const exported = join(work, "signer.json");
  ok("cotal auth signer", cotal(["auth", "signer", "--out", exported]).status === 0 && existsSync(exported));
  mkdirSync(dirname(signer), { recursive: true });
  cpSync(exported, signer);
  chmodSync(signer, 0o600);
  ok("this machine joins the space", paw(["mesh", "add", R, "--server", `tls://127.0.0.1:${port}`, "--root", root, "--as", "e2e-here"]).status === 0);

  // ── fixtures: HOME, the repo (one unpushed commit), the agent ────────────────────────────────────
  const slug = slugOf(repo);
  mkdirSync(join(home, ".claude", "projects", slug, "memory"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", slug, "memory", "MEMORY.md"), "- e2e memory\n");
  mkdirSync(join(home, ".claude", "skills", "e2e-skill"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "e2e-skill", "SKILL.md"), "---\nname: e2e-skill\n---\nhello\n");
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# e2e global instructions\n");
  const gitconfig = `[url "${bare}"]\n\tinsteadOf = ${repoUrl}\n`;
  writeFileSync(join(home, ".gitconfig"), gitconfig);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["remote", "add", "origin", repoUrl], repo);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(agentBin, "fake-acp-agent.mjs"), FAKE_ACP);
  chmodSync(join(agentBin, "fake-acp-agent.mjs"), 0o755);
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "fixture"], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);
  writeFileSync(join(repo, "NOTES.md"), "unpushed\n");
  git(["add", "NOTES.md"], repo);
  git(["commit", "-q", "-m", "unpushed work"], repo);
  const head = git(["rev-parse", "HEAD"], repo);
  mkdirSync(dirname(personaPath), { recursive: true });
  writeFileSync(
    personaPath,
    [
      "---",
      "name: tele",
      `cwd: ${repo}`,
      "agent: acp",
      `acpCommand: '["/usr/bin/env","node","${agentBin}/fake-acp-agent.mjs"]'`,
      "acpHost: ts",
      "shareTools: none",
      "subscribe: [general]",
      'allowSubscribe: [">"]',
      'allowPublish: [">"]',
      "---",
      "You are tele, a paw teleport e2e fixture.",
      "",
    ].join("\n"),
  );

  // ── the other box: sshd + this checkout's paw, on the same space ─────────────────────────────────
  const ctx = join(work, "image");
  mkdirSync(ctx);
  for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) cpSync(join(REPO, f), join(ctx, f));
  for (const d of ["patches", "vendor"]) cpSync(join(REPO, d), join(ctx, d), { recursive: true });
  writeFileSync(join(ctx, "Dockerfile"), DOCKERFILE);
  const build = docker(["build", "-q", "-t", image, ctx]);
  ok("target image builds (node + git + sshd + paw's deps)", build.status === 0, build.status === 0 ? "" : tail(out(build), 12));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(work, "id")]);
  const runC = docker(["run", "-d", "--name", ctr, "-p", "127.0.0.1::22", "-v", `${bare}:${bare}`, "-v", `${agentBin}:${agentBin}:ro`, "-v", `${join(work, "certs")}:/certs:ro`, image]);
  ok("target container up", runC.status === 0, tail(out(runC), 2));
  const sshPort = /:(\d+)\s*$/.exec(docker(["port", ctr, "22/tcp"]).stdout.trim().split("\n")[0])?.[1];
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO, encoding: "utf8" }).split("\n").filter((f) => f && existsSync(join(REPO, f)) && !f.startsWith("node_modules"));
  const tarball = execFileSync("tar", ["-c", "-f", "-", "--no-mac-metadata", "--no-xattrs", "-T", "-"], { cwd: REPO, input: files.join("\n"), maxBuffer: 512 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  ok("this checkout copied into the target", spawnSync("docker", ["exec", "-i", ctr, "tar", "-x", "-f", "-", "-C", "/opt/paw"], { input: tarball }).status === 0);
  docker(["exec", "-i", ctr, "sh", "-c", "cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"], readFileSync(join(work, "id.pub"), "utf8"));
  docker(["exec", "-i", ctr, "sh", "-c", "cat > /root/.profile"], PROFILE);
  docker(["exec", "-i", ctr, "sh", "-c", "cat > /usr/local/bin/paw && chmod 755 /usr/local/bin/paw"], LAUNCHER);
  docker(["exec", "-i", ctr, "sh", "-c", "cat > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude"], FAKE_CLAUDE);
  docker(["exec", "-i", ctr, "sh", "-c", "cat > /root/.gitconfig"], gitconfig);
  docker(["exec", "-i", ctr, "sh", "-c", "mkdir -p /root/cotal-root/.cotal/auth && cat > /root/cotal-root/.cotal/auth/auth.json && chmod 600 /root/cotal-root/.cotal/auth/auth.json"], readFileSync(signer, "utf8"));
  const addThere = there(`paw mesh add ${R} --server tls://host.docker.internal:${port} --root /root/cotal-root --as e2e-there`);
  ok("the target joins the same space (its own root + signer copy)", addThere.status === 0, tail(out(addThere), 2));
  // The literal `ssh:<host>` transport, pointed at the container by an ssh config the shim adds.
  writeFileSync(
    join(work, "ssh_config"),
    `Host ${host}\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User root\n  IdentityFile ${join(work, "id")}\n  IdentitiesOnly yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n`,
  );
  writeFileSync(join(work, "bin", "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F ${join(work, "ssh_config")} "$@"\n`);
  chmodSync(join(work, "bin", "ssh"), 0o755);
  const hello = run("ssh", ["-o", "BatchMode=yes", host, "paw __teleport probe"], base);
  ok("ssh reaches the target's paw", /paw-teleport 2/.test(hello.stdout), tail(out(hello), 3));

  // ── 1. the agent runs here; a dry run ────────────────────────────────────────────────────────────
  const start = paw(["start", "tele", "--space", R]);
  ok("the agent starts here", start.status === 0 && /started:.*tele/.test(out(start)), tail(out(start), 3));
  ok("…and is present on the mesh", /\btele\b/.test(await present(true, 60_000)));
  const what = ["--repo", "--memory", "--skills", "--claude-md"];
  const dry = paw(["teleport", "tele", "--to", `ssh:${host}`, ...what, "--dry-run", "--space", R]);
  console.log(`    ${out(dry).trim().split("\n").join("\n    ")}`);
  ok("dry run passes preflight and copies nothing", dry.status === 0 && /preflight passed; nothing was copied/.test(out(dry)) && there(`test -e ${repoThere}`).status !== 0);
  ok("the plan names the unpushed commit's bundle", /1 unpushed commit\(s\) as a git bundle/.test(out(dry)));

  // ── 2. the teleport ──────────────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const tele = paw(["teleport", "tele", "--to", `ssh:${host}`, ...what, "--yes", "--space", R]);
  console.log(`    ${out(tele).trim().split("\n").join("\n    ")}`);
  ok(`teleport succeeds (${Math.round((Date.now() - t0) / 1000)}s)`, tele.status === 0 && /✓ teleported tele: this machine → ssh:/.test(out(tele)));
  ok("the repo lands in the target's paw clone (repos/e2e/repo, not the source path), same branch + HEAD (the unpushed commit came as a bundle)", there(`git -C ${repoThere} rev-parse HEAD`).stdout.trim() === head && there(`git -C ${repoThere} symbolic-ref --short HEAD`).stdout.trim() === "main");
  ok("…clean, tracking origin/main", there(`git -C ${repoThere} status --porcelain`).stdout.trim() === "" && there(`git -C ${repoThere} rev-parse --abbrev-ref main@{upstream}`).stdout.trim() === "origin/main");
  ok("the persona there points at the paw clone", new RegExp(`^cwd: ${repoThere}$`, "m").test(remotePersona()));
  ok("memory (in the clone's project dir), skill and CLAUDE.md landed under the target's HOME", /e2e memory/.test(thereText(`/root/.claude/projects/${slugOf(repoThere)}/memory/MEMORY.md`)) && /hello/.test(thereText("/root/.claude/skills/e2e-skill/SKILL.md")) && /e2e global/.test(thereText("/root/.claude/CLAUDE.md")));
  ok("the persona there carries no teleport marker", /^agent: acp$/m.test(remotePersona()) && !/teleported/.test(remotePersona()));
  ok("this persona is marked teleported (where, when, what)", new RegExp(`^teleported: ssh:${host}$`, "m").test(persona()) && /^teleportedAt: \d{4}-/m.test(persona()) && /^teleportedWhat: repo,skills,memory,claude-md$/m.test(persona()));
  ok("it is present on the mesh", /\btele\b/.test(await present(true, 30_000)));
  ok("…and not run by this machine's manager", whereHere() === "elsewhere", whereHere());
  const statusThere = there(`paw status --space ${R} --json`);
  ok("the target's paw runs it", (() => {
    try {
      return (JSON.parse(statusThere.stdout) as { rows: Row[] }).rows.find((r) => r.name === "tele")?.live === true;
    } catch {
      return false;
    }
  })(), tail(out(statusThere), 3));
  const dm = paw(["dm", "tele", "hi", "--space", R]);
  ok("a DM here reaches the copy on the target and spawns nothing here", dm.status === 0 && whereHere() === "elsewhere", `${tail(out(dm), 2)} / ${whereHere()}`);
  there(`paw stop tele --space ${R}`);
  ok("(its copy there stopped for a moment)", !/\btele\b/.test(await present(false, 60_000)));
  const dmDown = paw(["dm", "tele", "hi", "--space", R]);
  ok("with nobody present, a DM here refuses to wake it here and points at --back", dmDown.status !== 0 && /teleported to ssh:.*paw teleport tele --back/.test(out(dmDown)), tail(out(dmDown), 2));
  const startHere = paw(["start", "tele", "--space", R]);
  ok("paw start here skips it", /skipped:.*tele \(paw: "tele" was teleported to ssh:/.test(out(startHere)), tail(out(startHere), 2));
  const restartThere = there(`paw start tele --space ${R}`);
  ok("(and started again there)", /started:.*tele/.test(out(restartThere)) && /\btele\b/.test(await present(true, 60_000)), tail(out(restartThere), 2));
  const again = paw(["teleport", "tele", "--to", `ssh:${host}`, "--all", "--yes", "--space", R]);
  ok("teleporting it again refuses (already left)", again.status !== 0 && /already left/.test(out(again)));

  // ── 3. --back ────────────────────────────────────────────────────────────────────────────────────
  writeFileSync(join(home, ".claude", "projects", slug, "memory", "MEMORY.md"), "- e2e memory\n"); // unchanged: the same rule applies both ways
  const back = paw(["teleport", "tele", "--back", "--yes", "--space", R]);
  console.log(`    ${out(back).trim().split("\n").join("\n    ")}`);
  ok("--back succeeds", back.status === 0 && /✓ teleported tele: ssh:.* → this machine/.test(out(back)));
  ok("it runs here again", whereHere() === "here", whereHere());
  ok("this persona lost the marker and is back in its own folder", !/teleported/.test(persona()) && /^agent: acp$/m.test(persona()) && new RegExp(`^cwd: ${repo}$`, "m").test(persona()));
  ok("the target's copy is marked teleported: origin", /^teleported: origin$/m.test(remotePersona()));
  const startThere = there(`paw start tele --space ${R}`);
  ok("the target's own paw start refuses its copy", /skipped:.*tele \(paw: "tele" was teleported back to the machine it came from/.test(out(startThere)), tail(out(startThere), 2));

  // ── 4. a failed start there rolls back here ──────────────────────────────────────────────────────
  there("touch /root/fail-start");
  const bad = paw(["teleport", "tele", "--to", `ssh:${host}`, ...what, "--yes", "--space", R]);
  console.log(`    ${out(bad).trim().split("\n").join("\n    ")}`);
  ok("the teleport fails loud", bad.status !== 0 && /failed at the start on ssh:/.test(out(bad)) && /e2e fixture: paw start refused/.test(out(bad)));
  ok("…and says it restarted the agent here", /restarted tele on this machine — it runs on this machine again/.test(out(bad)));
  ok("it runs here", whereHere() === "here" && /\btele\b/.test(await present(true, 30_000)), whereHere());
  ok("this persona is not marked", !/teleported/.test(persona()));
  ok("the target's copy stood down (marked origin)", /^teleported: origin$/m.test(remotePersona()));

  // ── 5. without --repo: the agent gets <PAW_HOME>/agents/<name> there ──────────────────────────────
  there("rm -f /root/fail-start");
  const big = join(home, "Github", "big");
  mkdirSync(big, { recursive: true });
  writeFileSync(join(big, "data.bin"), "stays here\n");
  mkdirSync(join(home, ".claude", "projects", slugOf(big), "memory"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", slugOf(big), "memory", "MEMORY.md"), "- tele2 memory\n");
  const p2 = join(pawHome, "spaces", R, "personas", "tele2.md");
  writeFileSync(p2, readFileSync(personaPath, "utf8").replace(/^name: tele$/m, "name: tele2").replace(/^cwd: .*$/m, `cwd: ${big}`).replace("You are tele,", "You are tele2,"));
  const persona2 = () => readFileSync(p2, "utf8");
  const remote2 = () => thereText(`/root/.paw/spaces/${R}/personas/tele2.md`);
  const agentsThere = "/root/.paw/agents/tele2";
  ok("tele2 starts here", /started:.*tele2/.test(out(paw(["start", "tele2", "--space", R]))));
  const what2 = ["--memory", "--skills", "--claude-md"];
  const dry2 = paw(["teleport", "tele2", "--to", `ssh:${host}`, ...what2, "--dry-run", "--space", R]);
  console.log(`    ${out(dry2).trim().split("\n").join("\n    ")}`);
  ok("no-repo dry run: passes, names the agents folder there", dry2.status === 0 && out(dry2).includes(`folder     ${big} → ${agentsThere}  (no --repo: a fresh folder paw owns there`));
  ok("…and memory going to that folder's project dir", out(dry2).includes(`→ /root/.claude/projects/${slugOf(agentsThere)}/memory/`));
  const tele2 = paw(["teleport", "tele2", "--to", `ssh:${host}`, ...what2, "--yes", "--space", R]);
  console.log(`    ${out(tele2).trim().split("\n").join("\n    ")}`);
  ok("no-repo teleport succeeds", tele2.status === 0 && /✓ teleported tele2/.test(out(tele2)));
  ok("the agents folder exists there, and nothing of the source folder came along", there(`test -d ${agentsThere} && ! test -e ${agentsThere}/data.bin`).status === 0);
  ok("the persona there points at it", new RegExp(`^cwd: ${agentsThere}$`, "m").test(remote2()));
  ok("memory is in its project dir there (not the source slug)", /tele2 memory/.test(thereText(`/root/.claude/projects/${slugOf(agentsThere)}/memory/MEMORY.md`)) && there(`test -e /root/.claude/projects/${slugOf(big)}`).status !== 0);
  ok("this persona keeps its own folder, marked", new RegExp(`^cwd: ${big}$`, "m").test(persona2()) && /^teleported: ssh:/m.test(persona2()));
  const st2 = there(`paw status --space ${R} --json`);
  ok("the target runs it (paw-managed folder, under any PAW_ROOT)", (() => {
    try {
      return (JSON.parse(st2.stdout) as { rows: Row[] }).rows.find((r) => r.name === "tele2")?.live === true;
    } catch {
      return false;
    }
  })());
  const back2 = paw(["teleport", "tele2", "--back", "--yes", "--space", R]);
  console.log(`    ${out(back2).trim().split("\n").join("\n    ")}`);
  ok("no-repo --back succeeds, back in the folder it left from", back2.status === 0 && new RegExp(`^cwd: ${big}$`, "m").test(persona2()) && !/teleported/.test(persona2()));
  ok("…its memory back in the original project dir", /tele2 memory/.test(readFileSync(join(home, ".claude", "projects", slugOf(big), "memory", "MEMORY.md"), "utf8")) && !existsSync(join(home, ".claude", "projects", slugOf(agentsThere))));
  ok("the folder it left is untouched", readFileSync(join(big, "data.bin"), "utf8") === "stays here\n");
  paw(["stop", "tele2", "--space", R]);

  // ── 6. a claude agent on a big dirty repo (the 2027-intern case): dry runs + its session over ssh ──
  const t27 = join(home, "Github", "team2027");
  mkdirSync(t27, { recursive: true });
  git(["init", "-q", "-b", "main"], t27);
  for (let i = 0; i < 30; i++) writeFileSync(join(t27, `untracked-${String(i).padStart(2, "0")}.txt`), "x");
  const pd = join(home, ".claude", "projects", slugOf(t27));
  const P = "aaaaaaaa-1111-4111-8111-000000000001";
  const Q = "bbbbbbbb-2222-4222-8222-000000000002";
  mkdirSync(join(pd, Q, "subagents"), { recursive: true });
  mkdirSync(join(pd, "memory"), { recursive: true });
  const jl = (o: object) => JSON.stringify(o) + "\n";
  writeFileSync(join(pd, `${P}.jsonl`), jl({ type: "user", sessionId: P, cwd: t27, message: { role: "user", content: "start" } }) + jl({ type: "continued-in", sessionId: P, continuedInSessionId: Q }));
  writeFileSync(join(pd, `${Q}.jsonl`), jl({ type: "user", sessionId: Q, cwd: t27, message: { role: "user", content: "go on" } }) + jl({ type: "assistant", sessionId: Q, cwd: `${t27}/evals`, message: { role: "assistant", content: "ok" } }));
  writeFileSync(join(pd, Q, "subagents", "agent-1.jsonl"), jl({ type: "user", sessionId: Q, cwd: t27 }));
  writeFileSync(join(pd, "memory", "MEMORY.md"), "- intern memory\n");
  writeFileSync(join(pawHome, "spaces", R, "personas", "intern.md"), ["---", "name: intern", `cwd: ${t27}`, `resume: ${Q}`, "subscribe: [general]", 'allowSubscribe: [">"]', 'allowPublish: [">"]', "---", "You are intern.", ""].join("\n"));
  const dirty = paw(["teleport", "intern", "--to", `ssh:${host}`, "--all", "--dry-run", "--space", R]);
  console.log(`    ${out(dirty).trim().split("\n").join("\n    ")}`);
  const listed = out(dirty).split("\n").filter((l) => /^  \?\? /.test(l)).length;
  ok("--all on a dirty repo: refused with 10 paths, '… and 20 more', and --no-repo", dirty.status !== 0 && listed === 10 && /… and 20 more/.test(out(dirty)) && /--no-repo/.test(out(dirty)), `listed ${listed}`);
  const dry3 = paw(["teleport", "intern", "--to", `ssh:${host}`, "--session", "--skills", "--memory", "--claude-md", "--dry-run", "--space", R]);
  console.log(`    ${out(dry3).trim().split("\n").join("\n    ")}`);
  ok("no-repo dry run of a claude agent passes (its login checked there)", dry3.status === 0 && /preflight passed/.test(out(dry3)));
  ok("…the chain, into the agents folder's project dir, cwd fields rewritten", out(dry3).includes(`session    ${P} → ${Q}`) && out(dry3).includes(`→ /root/.claude/projects/${slugOf("/root/.paw/agents/intern")}/, cwd fields rewritten`));
  const rel = run(process.execPath, [join(REPO, "scripts/e2e-teleport.ts"), "--relocate", host, R, "intern"], base);
  let moved: { folder?: string; chain?: string[]; code?: number; out?: string; err?: string } = {};
  try {
    moved = JSON.parse(rel.stdout.trim().split("\n").pop()!);
  } catch {
    moved = { err: tail(out(rel), 6) };
  }
  ok("the session moves over ssh and `paw __teleport rewrite-cwd` runs there", moved.code === 0 && moved.folder === "/root/.paw/agents/intern", JSON.stringify(moved));
  const newPd = `/root/.claude/projects/${slugOf("/root/.paw/agents/intern")}`;
  const cwdsThere = there(`cat ${newPd}/${P}.jsonl ${newPd}/${Q}.jsonl ${newPd}/${Q}/subagents/agent-1.jsonl | grep -o '"cwd":"[^"]*"' | sort | uniq -c`).stdout.trim();
  ok("every transcript there names the new folder (or a folder under it)", /3 "cwd":"\/root\/\.paw\/agents\/intern"/.test(cwdsThere) && /1 "cwd":"\/root\/\.paw\/agents\/intern\/evals"/.test(cwdsThere) && !cwdsThere.includes(t27), cwdsThere.replace(/\n/g, " | "));
  ok("…and memory went with it", /intern memory/.test(thereText(`${newPd}/memory/MEMORY.md`)));
} finally {
  // ── 5. teardown ──────────────────────────────────────────────────────────────────────────────────
  console.log(tail(out(paw(["down", "--space", R])), 3));
  docker(["rm", "-f", ctr]);
  console.log(tail(out(cotal(["down"])), 2));
  const left = execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" }).split("\n").filter((l) => (l.includes(R) || l.includes(DECOY)) && !l.includes("e2e-teleport"));
  ok("nothing left naming the test spaces", left.length === 0, left.join(" | "));
  if (process.env.E2E_KEEP) console.log(`E2E_KEEP: kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
if (fails) {
  console.error(`\ne2e:teleport — ${fails} failure(s)`);
  process.exit(1);
}
console.log("\ne2e:teleport — all ok");

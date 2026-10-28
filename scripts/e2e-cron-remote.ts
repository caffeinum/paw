/**
 * END-TO-END `paw cron` on a REMOTE space: our own JWT + TLS broker (cotal `up --no-manager`, as the Fly
 * box runs it), recorded with `paw mesh add`, fully isolated (own PAW_HOME, COTAL_HOME, decoy PAW_SPACE,
 * dead local broker):
 *  1. "target" — a REAL claude agent (haiku) registered on THIS machine and started by this machine's
 *     manager on the remote broker — gets a fire from `paw cron tick`, sent by the peer "cron" under the
 *     signer's operator creds (its own nkey), and acts on it (writes a file);
 *  2. "elsewhere" — no persona here (another machine's agent): `add` is refused, a hand-written job is
 *     NOT delivered, the tick logs why, and nothing is spawned for it.
 *
 *   COTAL_BIN=<cotal-ai@0.100.0>/dist/cotal.js node scripts/e2e-cron-remote.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const COTAL = process.env.COTAL_BIN ?? "";
if (!COTAL || !existsSync(COTAL)) throw new Error("needs COTAL_BIN=<cotal-ai package>/dist/cotal.js");

const tag = `${process.pid}`;
const R = `remotetest-cron-${tag}`;
const DECOY = `remotedecoy-cron-${tag}`;
const home = mkdtempSync("/tmp/pc-"); // short: the hub socket path must fit sun_path
const work = realpathSync(mkdtempSync(join("/tmp", "pc-work-")));
const remoteRoot = join(work, "remote");
const localRoot = join(work, "local");
const targetDir = join(work, "target");
for (const d of [remoteRoot, join(localRoot, ".cotal", "auth"), targetDir, join(work, "cotalhome"), join(work, "xdg")]) mkdirSync(d, { recursive: true });
const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const server = `tls://127.0.0.1:${port}`;
const cert = join(work, "cert.pem");
const key = join(work, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });

const base: NodeJS.ProcessEnv = {
  ...process.env,
  PAW_HOME: home,
  PAW_SPACE: DECOY,
  PAW_SERVER: "nats://127.0.0.1:9",
  PAW_RELEASE: "dev",
  PAW_RUNTIME: "pty",
  PAW_MODEL: process.env.PAW_MODEL ?? "haiku",
  COTAL_HOME: join(work, "cotalhome"),
  XDG_CONFIG_HOME: join(work, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NODE_EXTRA_CA_CERTS: cert,
};
for (const k of ["PAW_COTAL_ROOT", "PAW_AUTH", "PAW_COTAL_HUB", "COTAL_NAME", "COTAL_SPACE"]) delete base[k];

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (r: { stdout?: string | null; stderr?: string | null }) => `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^paw: PAW_RELEASE=dev.*\n/gm, "").trim();
const paw = (args: string[]) => {
  const r = spawnSync(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env: base, cwd: REPO, encoding: "utf8", timeout: 240_000 });
  console.log(`  $ paw ${args.join(" ")} → ${r.status}\n${out(r).replace(/^/gm, "    ")}`);
  return { status: r.status, out: out(r) };
};
const cotal = (args: string[]) => spawnSync(process.execPath, [COTAL, ...args], { env: base, cwd: remoteRoot, encoding: "utf8", timeout: 180_000 });
const procs = (needle: string) => execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(needle) && !l.includes("e2e-cron-remote"));

const waitFor = async (pred: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !pred(); ) await sleep(2000);
  return pred();
};
const fileSays = (f: string, w: string) => existsSync(f) && readFileSync(f, "utf8").includes(w);


try {
  const up = cotal(["up", "--detach", "--no-manager", "--space", R, "--server", server, "--tls-cert", cert, "--tls-key", key, "--store-dir", join(work, "store")]);
  ok("remote broker up (JWT + TLS)", up.status === 0, out(up).split("\n").pop());
  const exported = join(work, "signer.json");
  ok("cotal auth signer", cotal(["auth", "signer", "--out", exported]).status === 0 && existsSync(exported));
  const signer = join(localRoot, ".cotal", "auth", "auth.json");
  copyFileSync(exported, signer);
  chmodSync(signer, 0o600);
  ok("paw mesh add (remote space record)", paw(["mesh", "add", R, "--server", server, "--root", localRoot]).status === 0);

  // "target": registered HERE (persona in this PAW_HOME), a real claude seat under this machine's manager.
  process.env.PAW_HOME = home;
  const { setFolderName } = await import("../src/addressing.ts");
  ok("target registered on this machine", setFolderName(R, targetDir, "target").name === "target");
  ok("paw start target --space R (real claude on the remote broker)", paw(["start", "target", "--space", R]).status === 0);
  ok("target is live on the remote mesh", await waitFor(() => /target/.test(paw(["who", "--space", R]).out), 180_000));
  await sleep(20_000); // let its first turn settle

  // 1. hosted here → delivered from "cron", and the agent acts on it
  const f = join(targetDir, "pong-remote.txt");
  ok("cron add target#R --in 2s", paw(["cron", "add", `target#${R}`, "--in", "2s", `use your Bash tool to run: echo PONGR > ${f}`]).status === 0);
  await sleep(2500);
  const t1 = paw(["cron", "tick"]);
  ok("tick fires it from this (hosting) machine (exit 0)", t1.status === 0 && /fired \S+ → target#/.test(t1.out));
  ok("the agent acted on the remote fire: file written", await waitFor(() => fileSays(f, "PONGR"), 240_000), f);
  ok("the cron sender's own nkey is persisted 0600", existsSync(join(home, "spaces", R, "cron.nkey.json")) && (statSync(join(home, "spaces", R, "cron.nkey.json")).mode & 0o777) === 0o600);
  const hist = paw(["history", "--space", R, "--limit", "50"]);
  ok('the DM on the broker is from "cron"', /cron/.test(hist.out) && /PONGR/.test(hist.out));

  // 2. not hosted here → refused at add, skipped + logged at fire, nothing spawned
  const refused = paw(["cron", "add", `elsewhere#${R}`, "--in", "2s", "x"]);
  ok("add for an agent hosted elsewhere fails loud", refused.status === 1 && /not hosted on this machine/.test(refused.out));
  const { updateStore } = await import("../src/cron.ts");
  updateStore(R, (st) => void st.jobs.push({ id: "elsew001", agent: "elsewhere", prompt: "token-E", at: Date.now() - 1000, createdAt: Date.now() - 60_000, createdBy: "operator" }));
  const t2 = paw(["cron", "tick"]);
  ok("tick skips it and logs why (exit 1)", t2.status === 1 && /elsew001 → elsewhere#\S+ NOT delivered .*not hosted on this machine/.test(t2.out));
  ok("…and nothing was spawned for it", !procs("COTAL_NAME=elsewhere").length && !/elsewhere/.test(paw(["cotal", "ps", "--space", R]).out));
} finally {
  console.log(out(spawnSync(process.execPath, [join(REPO, "bin/paw.ts"), "down", "--space", R], { env: base, cwd: REPO, encoding: "utf8", timeout: 120_000 })));
  console.log(out(cotal(["down"])));
  await sleep(1000);
  ok("nothing left naming the remote space", procs(R).length === 0, procs(R).join(" | "));
  ok("nothing ran for the decoy space", procs(DECOY).length === 0);
  if (!process.env.E2E_KEEP) {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(fails ? `${fails} FAILED` : "e2e passed");
process.exit(fails ? 1 : 0);

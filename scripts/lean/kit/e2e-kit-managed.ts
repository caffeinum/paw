/**
 * END-TO-END: a paw-MANAGED kit agent (persona `agent: kit`, src/kit.ts) on a REAL, ISOLATED mesh,
 * then kit's own claude-style CLI (`kit`, `kit --continue --follow`, `kit --resume`) on the same mesh.
 *
 *   managed  1 `paw start` → the manager spawns `kit run` (paw builds the binary into $PAW_HOME/bin);
 *              `paw status --json` lists it live, MANAGED (not unmanaged), idle
 *            2 first boot creates the pinned session (`--session-id <pin>`), a DM gets a reply, the
 *              transcript appears at ~/.claude/projects/<slug>/<pin>.jsonl
 *            3 `paw restart` resumes the SAME session (`--resume <pin>`) and remembers a word
 *              (a real provider) / sees its history (fake)
 *            4 `paw log` renders the transcript (incl. the message itself); `paw open` says kit
 *            5 `paw stop` takes it offline; RAM of the kit process along the way
 *   cli      6 bare `kit` in a folder: silent, on the mesh under the folder's name, a NEW session filed
 *              for that folder, answers a DM, SIGTERM → offline + exit 0
 *            7 `kit --continue --follow`: the same session, its activity printed paw-log style
 *            8 `kit --resume` with no id lists the folder's sessions and exits 1
 *
 *   KIT_E2E_PROVIDER=codex KIT_E2E_MODEL=gpt-6-luna   (default fake:codex — offline)
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=kit-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) \
 *     node scripts/lean/kit/e2e-kit-managed.ts
 *
 * Without KIT_BIN, paw builds the kit repo ($KIT_SRC, default ~/Github/caffeinum/kit) itself.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("kit-test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=kit-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
const PROVIDER = process.env.KIT_E2E_PROVIDER ?? "fake:codex";
const MODEL = process.env.KIT_E2E_MODEL ?? "";
const FAKE = PROVIDER.startsWith("fake");
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
process.env.PAW_RUNTIME = "pty"; // no tmux server touched
delete process.env.PAW_COTAL_HUB;
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "kitjs-"))], { stdio: "ignore" });

const { ensure, stop, managerProcs, mailboxProcs } = await import("../../../src/lifecycle.ts");
const { ensurePersonaFile, personaFilePath, setFolderName, setPersonaKeys } = await import("../../../src/addressing.ts");
const { readResumeId, transcriptPath } = await import("../../../src/session.ts");
const { kitBinPath } = await import("../../../src/kit.ts");
const { pawServer } = await import("../../../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, every = 500): Promise<T | undefined> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await fn();
    if (v) return v;
  }
  return undefined;
};
const paw = (...args: string[]) => {
  const r = spawnSync(process.execPath, [join(REPO, "bin/paw.mjs"), ...args, "--space", space], { env: process.env, encoding: "utf8", timeout: 300_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const tail = (s: string, n = 3) => s.trim().split("\n").slice(-n).join(" | ");
const ps = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssMb: Number(m[3]) / 1024, cmd: m[4]! }));
const footprintMb = (pid: number) => {
  const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(spawnSync("footprint", [String(pid)], { encoding: "utf8" }).stdout ?? "");
  return m ? Number(m[1]) * (m[2] === "KB" ? 1 / 1024 : m[2] === "GB" ? 1024 : 1) : NaN;
};
const kitProc = (name: string) => ps().find((p) => p.cmd.includes(" run ") && p.cmd.includes(`--name ${name} `) && p.cmd.includes(`--space ${space} `));
const ram = (label: string, name: string) => {
  const p = kitProc(name);
  if (!p) return console.log(`  RAM ${label}: no kit process`);
  console.log(`  RAM ${label}: kit pid ${p.pid} footprint ${footprintMb(p.pid).toFixed(1)} MB, rss ${p.rssMb.toFixed(1)} MB`);
};
type Row = { name: string; live?: boolean; unmanaged?: boolean; mesh?: string; runtime?: string };
const statusRow = (name: string): Row | undefined => {
  const r = paw("status", "--json");
  try {
    const j = JSON.parse(r.out) as { rows?: Row[] } | Row[];
    return (Array.isArray(j) ? j : (j.rows ?? [])).find((x) => x.name === name);
  } catch {
    return undefined;
  }
};

const inbox: Array<{ from: string; text: string }> = [];
let prober: CotalEndpoint | undefined;
const children: ChildProcess[] = [];
const cleanup: string[] = [];
try {
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0 || undefined, 10_000, 100);
  await ensure({ needMesh: true, needManager: true, space });
  prober = new CotalEndpoint({ space, servers: pawServer(), channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();
  const peer = (n: string) => prober!.getRoster().find((p) => p.card.name === n && p.status !== "offline");
  const reply = (from: string, needle: string, ms = 300_000) => until(() => inbox.find((m) => m.from === from && m.text.includes(needle)), ms);
  const dm = async (to: string, text: string) => prober!.unicast(peer(to)!.card.id, text);

  // ── managed ────────────────────────────────────────────────────────────────────────────────
  const NAME = "kitty";
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "kit-managed-")));
  setFolderName(space, folder, NAME);
  ensurePersonaFile(space, NAME, { brief: "You are kitty, a test agent. Keep replies to one line." });
  setPersonaKeys(space, NAME, { agent: "kit", provider: PROVIDER, model: MODEL || undefined, variant: FAKE ? undefined : "low" });
  const pin = readResumeId(personaFilePath(space, NAME))!;
  ok("persona minted with a resume pin and no transcript yet", !!pin && !transcriptPath(pin));

  const t0 = Date.now();
  const st = paw("start", NAME);
  ok("paw start kitty", st.code === 0, tail(st.out + st.err));
  ok("paw built the kit binary into $PAW_HOME/bin", existsSync(kitBinPath()) || !!process.env.KIT_BIN);
  const live = await until(() => peer(NAME), 60_000, 200);
  ok("kitty on the mesh", !!live, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const proc = kitProc(NAME);
  ok("one `kit run` process for it", !!proc, proc?.cmd.slice(0, 220));
  ok("first boot creates the pinned session (--session-id)", !!proc?.cmd.includes(`--session-id ${pin}`));
  ok("launched under the manager's identity (--actor/--lifecycle-uid)", !!proc?.cmd.includes("--actor ") && !!proc?.cmd.includes("--lifecycle-uid "));
  ok("presence card.id is the manager-assigned principal", !!live && live.card.id === `local.${/--actor (\S+)/.exec(proc?.cmd ?? "")?.[1]}`, live?.card.id);
  ram("at boot", NAME);
  const row = await until(() => {
    const r = statusRow(NAME);
    return r?.live && r.mesh === "idle" ? r : undefined;
  }, 30_000, 1000);
  ok("paw status: live, MANAGED (not unmanaged), idle", !!row && row.unmanaged !== true && row.runtime === "pty", JSON.stringify(statusRow(NAME)));
  console.log(paw("status", NAME).out.trim().split("\n").map((l) => `    ${l}`).join("\n"));

  await dm(NAME, "Reply to prober with cotal_dm saying exactly READY-KIT, nothing else.");
  const r1 = await reply(NAME, "READY-KIT");
  ok("a DM gets a reply", !!r1, r1?.text.slice(0, 160));
  const file = await until(() => transcriptPath(pin), 10_000);
  ok("the transcript is the pin, filed under the folder's claude project", !!file && file.endsWith(`/${folder.replace(/[^a-zA-Z0-9]/g, "-")}/${pin}.jsonl`), file);
  if (file) cleanup.push(file);
  await dm(NAME, "Remember the code word PELICAN-42. Reply to prober with cotal_dm saying exactly NOTED, nothing else.");
  ok("noted the word", !!(await reply(NAME, "NOTED")));
  await until(() => (peer(NAME)?.status === "idle" ? true : undefined), 30_000);
  ram("after 2 turns", NAME);

  const rs = paw("restart", NAME);
  ok("paw restart kitty", rs.code === 0, tail(rs.out + rs.err));
  await until(() => (kitProc(NAME)?.cmd.includes("--resume") ? true : undefined), 60_000);
  const proc2 = kitProc(NAME);
  ok("restart resumes the SAME session (--resume <pin>)", !!proc2?.cmd.includes(`--resume ${pin}`) && proc2.pid !== proc?.pid, proc2?.cmd.slice(0, 220));
  // the NEW incarnation's presence, not the old one's last row (a DM to the old principal reaches nobody)
  const actor2 = /--actor (\S+)/.exec(proc2?.cmd ?? "")?.[1];
  ok("the new incarnation is on the mesh", !!(await until(() => (peer(NAME)?.card.id === `local.${actor2}` ? true : undefined), 60_000, 200)), peer(NAME)?.card.id);
  inbox.length = 0;
  if (FAKE) {
    await dm(NAME, "Reply to prober with cotal_dm saying exactly AFTER-RESTART.");
    const r2 = await reply(NAME, "AFTER-RESTART");
    const items = Number(/history_items=(\d+)/.exec(r2?.text ?? "")?.[1] ?? 0);
    ok("after restart it carries its history (fake: history_items > 4)", items > 4, r2?.text.slice(0, 120));
  } else {
    await dm(NAME, "What code word did I ask you to remember? Reply to prober with cotal_dm saying only the word.");
    const r2 = await reply(NAME, "PELICAN-42");
    ok("remembers the word across the restart", !!r2, r2?.text);
  }
  const row2 = await until(() => (statusRow(NAME)?.live ? statusRow(NAME) : undefined), 20_000, 1000);
  ok("still managed after the restart", !!row2 && row2.unmanaged !== true, JSON.stringify(row2));

  const lg = paw("log", NAME, "--tail", "12");
  ok("paw log renders the kit transcript", lg.code === 0 && /PELICAN-42/.test(lg.out) && /↩ prober/.test(lg.out), tail(lg.out + lg.err, 6));
  console.log(lg.out.trim().split("\n").map((l) => `    ${l}`).join("\n"));
  const op = paw("open", NAME);
  ok("paw open says it runs on kit (headless)", /runs on kit/.test(op.out), tail(op.out + op.err));

  const sp = paw("stop", NAME);
  ok("paw stop kitty", sp.code === 0, tail(sp.out + sp.err));
  ok("offline after stop", !!(await until(() => (!peer(NAME) ? true : undefined), 20_000)));
  ok("no kit process left", !!(await until(() => (!kitProc(NAME) ? true : undefined), 10_000)));
  const row3 = statusRow(NAME);
  ok("paw status: not live", !!row3 && !row3.live, JSON.stringify(row3));

  // ── kit's own CLI ──────────────────────────────────────────────────────────────────────────
  const bin = process.env.KIT_BIN ?? kitBinPath();
  const cliDir = realpathSync(mkdtempSync(join(tmpdir(), "kit cli.")));
  const cliName = "kit-cli"; // basename "kit cli.XXXX" cleaned the way paw cleans names, minus the random tail
  const expected = cliDir.split("/").pop()!.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const env = { ...process.env, KIT_PROVIDER: PROVIDER, ...(MODEL ? { KIT_MODEL: MODEL } : {}) };
  const project = join(homedir(), ".claude", "projects", cliDir.replace(/[^a-zA-Z0-9]/g, "-"));
  cleanup.push(project);
  const run = (args: string[]) => {
    const c = spawn(bin, args, { cwd: cliDir, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(c);
    let out = "";
    let err = "";
    c.stdout!.on("data", (d) => (out += d));
    c.stderr!.on("data", (d) => (err += d));
    const exited = new Promise<number | null>((r) => c.on("exit", (code) => r(code)));
    return { c, out: () => out, err: () => err, exited };
  };
  const bare = run([]);
  const bp = await until(() => peer(expected), 30_000, 200);
  ok(`bare \`kit\`: on the mesh as the folder's name (${expected})`, !!bp, cliName);
  inbox.length = 0;
  await dm(expected, "Reply to prober with cotal_dm saying exactly CLI-READY, nothing else.");
  ok("bare `kit`: answers a DM", !!(await reply(expected, "CLI-READY")));
  const sessions = existsSync(project) ? readdirSync(project).filter((f) => f.endsWith(".jsonl")) : [];
  ok("bare `kit`: a NEW session filed for the folder like claude does", sessions.length === 1, `${project}: ${sessions.join(",")}`);
  await until(() => (peer(expected)?.status === "idle" ? true : undefined), 30_000);
  bare.c.kill("SIGTERM");
  const code = await bare.exited;
  ok("bare `kit`: SIGTERM → clean exit 0", code === 0, String(code));
  ok("bare `kit`: offline after SIGTERM", !!(await until(() => (!peer(expected) ? true : undefined), 10_000)));
  ok("bare `kit`: silent (no stdout/stderr)", bare.out() === "" && bare.err() === "", JSON.stringify(bare.out() + bare.err()).slice(0, 200));

  const cont = run(["--continue", "--follow"]);
  ok("`kit --continue --follow`: back on the mesh", !!(await until(() => peer(expected), 30_000, 200)));
  await until(() => (cont.out().includes("CLI-READY") ? true : undefined), 10_000);
  ok("--follow prints the earlier activity paw-log style", /📨 dm from prober/.test(cont.out()) && /↩ prober/.test(cont.out()), cont.out().slice(0, 300));
  inbox.length = 0;
  await dm(expected, "Reply to prober with cotal_dm saying exactly CONTINUED.");
  const rc = await reply(expected, "CONTINUED");
  ok("--continue resumed the same session (one file, history carried)", !!rc && readdirSync(project).filter((f) => f.endsWith(".jsonl")).length === 1 && (!FAKE || Number(/history_items=(\d+)/.exec(rc.text)?.[1] ?? 0) > 1), rc?.text.slice(0, 120));
  ok("--follow prints new activity live", !!(await until(() => (cont.out().includes("CONTINUED") && /│ Reply to prober/.test(cont.out()) ? true : undefined), 10_000)), cont.out().slice(-300));
  cont.c.kill("SIGINT");
  ok("`kit --continue`: SIGINT → exit 0", (await cont.exited) === 0);
  ok("--continue: nothing on stderr", cont.err() === "", cont.err().slice(0, 200));

  const list = spawnSync(bin, ["--resume"], { cwd: cliDir, env, encoding: "utf8" });
  ok("`kit --resume` with no id lists the sessions, exit 1", list.status === 1 && /newest first/.test(list.stderr) && list.stderr.includes(sessions[0]!.replace(".jsonl", "")), tail(list.stderr));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(1000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  removeMesh(space);
  nats.kill("SIGTERM");
  for (const p of cleanup) {
    rmSync(p, { recursive: true, force: true });
    rmSync(`${p}.kit.lock`, { force: true });
  }
  // the managed agent's project dir, now empty
  for (const p of cleanup.filter((x) => x.endsWith(".jsonl"))) {
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);

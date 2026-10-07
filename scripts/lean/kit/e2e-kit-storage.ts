/**
 * END-TO-END: kit session storage modes, kit as the FIRST agent of a brand-new space, kit busy/idle in
 * `paw status`, and `paw chat <folder> --agent kit` — on a REAL, ISOLATED mesh with HOME isolated too
 * (so ~/.claude and ~/.kit are throwaway dirs, never the operator's).
 *
 *   first    1 ensure() on a fresh nats-server creates the space's streams (no TS agent ever joined);
 *              `paw start` of a kit agent then comes up — before anything else touched the space
 *   kitstore 2 default storage: `--session-id <pin>` (no --overwrite), the transcript lands in KIT's
 *              store (<HOME>/.kit/sessions/<slug>/<pin>.jsonl), claude's store stays empty
 *            3 after a DM turn, presence idle ⇒ `paw status` says idle, NOT busy
 *            4 `paw restart` ⇒ `--resume <pin>` (paw found the kit-only transcript)
 *   claude   5 `storage: claude` ⇒ `--session-id --overwrite`, transcript in CLAUDE's store; restart ⇒
 *              `--resume --overwrite`, nothing in kit's store
 *   fork     6 the same agent switched to kit's store (storage line removed) ⇒ `--resume` (no
 *              --overwrite), kit forks the claude transcript into its store; a new turn lands ONLY in
 *              the fork; `paw log` shows the fork's turn
 *   chat     7 `paw chat <folder> --agent kit --provider fake:codex` births agent: kit (shareTools:
 *              none, fresh pin) and talks to it; a second `--agent codex` on it fails loud
 *
 *   KIT_BIN=<kit built from feat/session-storage-modes> \
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=kit-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) \
 *     node scripts/lean/kit/e2e-kit-storage.ts
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("kit-test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=kit-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
if (!process.env.KIT_BIN) throw new Error("KIT_BIN: a kit built from feat/session-storage-modes (has --overwrite)");
// HOME isolated BEFORE anything reads it: claude's and kit's stores, the mesh registry, claude's trust file.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "kit-storage-home-")));
process.env.HOME = HOME;
delete process.env.KIT_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
process.env.PAW_RUNTIME = "pty";
delete process.env.PAW_COTAL_HUB;
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "kitjs-"))], { stdio: "ignore" });

const { CotalEndpoint, chatStream, dmStream } = await import("@cotal-ai/core");
const { removeMesh } = await import("@cotal-ai/workspace");
const { jetstreamManager } = await import("@nats-io/jetstream");
const { connect } = await import("@nats-io/transport-node");
const { ensure, ensureSpaceStreams, stop, managerProcs, mailboxProcs } = await import("../../../src/lifecycle.ts");
const { ensurePersonaFile, personaFilePath, setFolderName, setPersonaKeys } = await import("../../../src/addressing.ts");
const { claudeProjectsRoot, kitSessionsRoot, readAgentType, readResumeId, readShareTools, personaValue } = await import("../../../src/session.ts");

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
const kitProc = (name: string) =>
  execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }))
    .find((p) => p.cmd.includes(" run ") && p.cmd.includes(`--name ${name} `) && p.cmd.includes(`--space ${space} `));
type Row = { name: string; live?: boolean; mesh?: string; busy?: boolean; durable?: boolean; unmanaged?: boolean };
const statusRow = (name: string): Row | undefined => {
  try {
    return (JSON.parse(paw("status", "--json").out) as { rows: Row[] }).rows.find((x) => x.name === name);
  } catch {
    return undefined;
  }
};
const streamNames = async () => {
  const nc = await connect({ servers: process.env.PAW_SERVER! });
  try {
    const jsm = await jetstreamManager(nc);
    const out: string[] = [];
    for await (const n of jsm.streams.names()) out.push(n);
    return out;
  } finally {
    await nc.close();
  }
};
const slug = (dir: string) => dir.replace(/[^A-Za-z0-9_]/g, "-");
const kitFile = (dir: string, pin: string) => join(kitSessionsRoot(), slug(dir), `${pin}.jsonl`);
const claudeFile = (dir: string, pin: string) => join(claudeProjectsRoot(), slug(dir), `${pin}.jsonl`);
const birth = (name: string, extra: Record<string, string | undefined> = {}) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `kit-${name}-`)));
  setFolderName(space, folder, name);
  ensurePersonaFile(space, name, { brief: `You are ${name}, a test agent.` });
  setPersonaKeys(space, name, { agent: "kit", provider: "fake:codex", ...extra });
  return { folder, pin: readResumeId(personaFilePath(space, name))! };
};

const inbox: Array<{ from: string; text: string }> = [];
let prober: InstanceType<typeof CotalEndpoint> | undefined;
try {
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0 || undefined, 10_000, 100);

  // ── 1 kit first in a fresh space ───────────────────────────────────────────────────────────
  ok("fresh broker: no streams for the space yet", !(await streamNames()).some((n) => n.endsWith(space)));
  await ensure({ needMesh: true, needManager: true, space });
  const names = await streamNames();
  ok("ensure() created the space's streams (CHAT_/DM_ …)", names.includes(chatStream(space)) && names.includes(dmStream(space)), names.join(","));
  ok("ensureSpaceStreams is a no-op once they exist", (await ensureSpaceStreams(space, process.env.PAW_SERVER!)) === "present");

  const A = "kitstore";
  const a = birth(A);
  const st = paw("start", A);
  ok("kit as the FIRST agent of the space: paw start", st.code === 0, tail(st.out + st.err));
  const rowUp = await until(() => (statusRow(A)?.live && statusRow(A)?.mesh === "idle" ? statusRow(A) : undefined), 60_000, 1000);
  ok("…and it is live + idle (no TS endpoint ever joined first)", !!rowUp, JSON.stringify(statusRow(A)));

  // ── 2-4 kit's own store ────────────────────────────────────────────────────────────────────
  const p1 = kitProc(A);
  ok("default storage: --session-id <pin>, no --overwrite", !!p1?.cmd.includes(`--session-id ${a.pin}`) && !p1.cmd.includes("--overwrite"), p1?.cmd.slice(0, 200));
  prober = new CotalEndpoint({ space, servers: process.env.PAW_SERVER!, channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();
  const peer = (n: string) => prober!.getRoster().find((p) => p.card.name === n && p.status !== "offline");
  // The CURRENT incarnation's presence (the one whose --actor the live `kit run` carries) — right after a
  // restart the old one's last row is still on the roster, and a DM to it reaches nobody.
  const dmAndWait = async (to: string, word: string) => {
    const pr = await until(() => {
      const actor = /--actor (\S+)/.exec(kitProc(to)?.cmd ?? "")?.[1];
      const p = peer(to);
      return actor && p?.card.id === `local.${actor}` ? p : undefined;
    }, 60_000, 200);
    if (!pr) return undefined;
    await prober!.unicast(pr.card.id, word);
    return until(() => inbox.find((m) => m.from === to && m.text.includes(word)), 60_000, 200);
  };
  ok("a DM gets a reply", !!(await dmAndWait(A, "MARK-ONE")));
  ok("the transcript is in KIT's store", existsSync(kitFile(a.folder, a.pin)), kitFile(a.folder, a.pin));
  ok("…and not in claude's", !existsSync(claudeFile(a.folder, a.pin)));
  await until(() => (peer(A)?.status === "idle" ? true : undefined), 30_000, 200);
  await sleep(11_000); // past the 10s mtime window, so only the turn reading could say busy
  const rowIdle = statusRow(A);
  ok("idle kit agent: paw status idle, NOT busy", !!rowIdle && rowIdle.mesh === "idle" && rowIdle.busy === false && rowIdle.durable === true, JSON.stringify(rowIdle));
  const lgA = paw("log", A, "--tail", "6");
  ok("paw log reads the kit-store transcript", lgA.code === 0 && lgA.out.includes("MARK-ONE"), tail(lgA.out + lgA.err, 4));
  const rsA = paw("restart", A);
  ok("paw restart", rsA.code === 0, tail(rsA.out + rsA.err));
  const p2 = await until(() => (kitProc(A)?.cmd.includes("--resume") ? kitProc(A) : undefined), 60_000);
  ok("restart: --resume <pin> (paw found the kit-only transcript)", !!p2?.cmd.includes(`--resume ${a.pin}`), p2?.cmd.slice(0, 200));

  // ── 5 storage: claude ──────────────────────────────────────────────────────────────────────
  const B = "onclaude";
  const b = birth(B, { storage: "claude" });
  ok("paw start (storage: claude)", paw("start", B).code === 0);
  await until(() => statusRow(B)?.live, 60_000, 1000);
  const pb1 = kitProc(B);
  ok("storage: claude ⇒ --overwrite --session-id", !!pb1?.cmd.includes("--overwrite") && !!pb1.cmd.includes(`--session-id ${b.pin}`), pb1?.cmd.slice(0, 220));
  ok("a DM gets a reply", !!(await dmAndWait(B, "MARK-TWO")));
  ok("the transcript is in CLAUDE's store", existsSync(claudeFile(b.folder, b.pin)) && readFileSync(claudeFile(b.folder, b.pin), "utf8").includes("MARK-TWO"));
  ok("…and not in kit's", !existsSync(kitFile(b.folder, b.pin)));
  ok("paw restart (storage: claude)", paw("restart", B).code === 0);
  const pb2 = await until(() => (kitProc(B)?.cmd.includes("--resume") ? kitProc(B) : undefined), 60_000);
  ok("restart: --resume --overwrite", !!pb2?.cmd.includes(`--resume ${b.pin}`) && pb2.cmd.includes("--overwrite"), pb2?.cmd.slice(0, 220));
  ok("a DM after the restart lands in claude's transcript", !!(await dmAndWait(B, "MARK-THREE")) && readFileSync(claudeFile(b.folder, b.pin), "utf8").includes("MARK-THREE") && !existsSync(kitFile(b.folder, b.pin)));

  // ── 6 the same session, switched to kit's store: fork ──────────────────────────────────────
  const pFile = personaFilePath(space, B);
  writeFileSync(pFile, readFileSync(pFile, "utf8").replace(/^storage: claude\n/m, ""));
  ok("persona switched to kit's store", personaValue(pFile, "storage") === undefined);
  ok("paw restart (now kit's store)", paw("restart", B).code === 0);
  const pb3 = await until(() => (kitProc(B) && !kitProc(B)!.cmd.includes("--overwrite") ? kitProc(B) : undefined), 60_000);
  ok("restart: --resume <pin> WITHOUT --overwrite (paw found the claude original)", !!pb3?.cmd.includes(`--resume ${b.pin}`), pb3?.cmd.slice(0, 220));
  ok("a DM after the switch gets a reply", !!(await dmAndWait(B, "MARK-FOUR")));
  const fork = kitFile(b.folder, b.pin);
  ok("kit forked the session into its store, the new turn only there", existsSync(fork) && readFileSync(fork, "utf8").includes("MARK-FOUR") && readFileSync(fork, "utf8").includes("MARK-TWO"));
  ok("the claude original is untouched by the new turn", !readFileSync(claudeFile(b.folder, b.pin), "utf8").includes("MARK-FOUR"));
  const lgB = paw("log", B, "--tail", "6");
  ok("paw log shows the kit continuation (not the cwd-local claude original)", lgB.code === 0 && lgB.out.includes("MARK-FOUR") && lgB.out.includes(fork), tail(lgB.out + lgB.err, 4));

  // ── 7 paw chat --agent kit ─────────────────────────────────────────────────────────────────
  const chatDir = realpathSync(mkdtempSync(join(tmpdir(), "kit-chat-")));
  const chat = spawn(process.execPath, [join(REPO, "bin/paw.mjs"), "chat", chatDir, "--agent", "kit", "--provider", "fake:codex", "--name", "chatty", "--space", space], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let cout = "";
  chat.stdout!.on("data", (d) => (cout += d));
  chat.stderr!.on("data", (d) => (cout += d));
  const live = await until(() => (statusRow("chatty")?.live ? true : undefined), 90_000, 1000);
  ok("paw chat --agent kit: the agent comes up", !!live, tail(cout, 4));
  const cp = personaFilePath(space, "chatty");
  ok(
    "…born as agent: kit, provider fake:codex, shareTools none, its own pin + folder",
    readAgentType(cp) === "kit" && personaValue(cp, "provider") === "fake:codex" && readShareTools(cp) === "none" && !!readResumeId(cp) && personaValue(cp, "cwd") === chatDir,
    existsSync(cp) ? readFileSync(cp, "utf8").split("---")[1] : "no persona",
  );
  ok("…and runs on kit", !!kitProc("chatty"));
  await sleep(1500);
  chat.stdin!.write("CHAT-HELLO\n");
  ok("a line typed in the chat gets a reply on screen", !!(await until(() => (cout.includes("FAKE-REPLY") && cout.includes("CHAT-HELLO") ? true : undefined), 60_000, 300)), tail(cout, 4));
  chat.stdin!.end();
  chat.kill("SIGINT");
  const clash = paw("chat", chatDir, "--name", "chatty", "--agent", "codex");
  ok("--agent codex on the existing kit agent fails loud", clash.code !== 0 && /runs on kit, not codex/.test(clash.err), tail(clash.err));
  const bad = paw("chat", chatDir, "--agent", "gpt");
  ok("an unknown --agent fails loud", bad.code !== 0 && /unknown harness/.test(bad.err), tail(bad.err));
} finally {
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(1000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);

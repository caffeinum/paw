/**
 * END-TO-END `paw sleep` for a KIT agent (persona `agent: kit`) on a REAL, ISOLATED mesh with HOME isolated
 * too (~/.kit and ~/.claude are throwaway dirs), kit's offline `fake:codex` provider:
 *
 *   1 a kit agent opted in (`hibernate: 3h`) answers a DM; `paw sleep --sweep --dry-run` judges it by its
 *     own transcript ("idle Nm < 180m"), not "harness kit not supported"
 *   2 a command it backgrounded in its shell (`sleep 600 &`, a child of kit's persistent bash) keeps it
 *     awake: `paw sleep <n> --now` refuses, naming the process; killed → the sleep goes through
 *   3 asleep: the `kit run` seat is gone, the sleep record is written, the stand-in holds the name
 *   4 a DM to the stand-in wakes it: `kit run … --resume <pin>` (same session, kitArgs kept), it answers,
 *     and the new turn lands in the SAME transcript as the turn before the sleep
 *
 * kit's store is a throwaway KIT_HOME (~/.claude is only ever read, by the resume lookup).
 *
 *   KIT_BIN=~/.paw/bin/kit PAW_HOME=$(mktemp -d) PAW_SPACE=kit-test-$$ PAW_RELEASE=dev PAW_BEADS_DIR=$(mktemp -d) \
 *     node scripts/lean/kit/e2e-kit-sleep.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const space = process.env.PAW_SPACE ?? "";
const home = process.env.PAW_HOME?.trim();
if (!home || home === join(homedir(), ".paw") || !space.startsWith("kit-test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME=$(mktemp -d), PAW_SPACE=kit-test-*, PAW_RELEASE=dev, PAW_BEADS_DIR=$(mktemp -d)");
if (!process.env.KIT_BIN || !existsSync(process.env.KIT_BIN)) throw new Error("KIT_BIN: an existing kit binary");
process.env.KIT_HOME = realpathSync(mkdtempSync(join(tmpdir(), "kit-sleep-kithome-")));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
process.env.PAW_RUNTIME = "pty";
delete process.env.PAW_COTAL_HUB;

const { CotalEndpoint } = await import("@cotal-ai/core");
const { purgeTestSpace } = await import("../../../src/prune.ts");
const { pawServer } = await import("../../../src/server.ts");
const { ensure, stop, managerProcs, mailboxProcs } = await import("../../../src/lifecycle.ts");
const { ensurePersonaFile, personaFilePath, setFolderName, setPersonaKeys } = await import("../../../src/addressing.ts");
const { kitSessionsRoot, readResumeId } = await import("../../../src/session.ts");
const { isAsleep, standInHolder } = await import("../../../src/sleep-state.ts");

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
const procs = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }));
const kitProc = (name: string) => procs().find((p) => p.cmd.includes(" run ") && p.cmd.includes(`--name ${name} `) && p.cmd.includes(`--space ${space} `));
type Row = { name: string; live?: boolean; mesh?: string };
const statusRow = (name: string): Row | undefined => {
  try {
    return (JSON.parse(paw("status", "--json").out) as { rows: Row[] }).rows.find((x) => x.name === name);
  } catch {
    return undefined;
  }
};
const slug = (dir: string) => dir.replace(/[^A-Za-z0-9_]/g, "-");

const inbox: Array<{ from: string; text: string }> = [];
let prober: InstanceType<typeof CotalEndpoint> | undefined;
let bgPid: number | undefined;
try {
  await ensure({ needMesh: true, needManager: true, space });

  const A = "dozer";
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `kit-${A}-`)));
  setFolderName(space, folder, A);
  ensurePersonaFile(space, A, { brief: `You are ${A}, a test agent.` });
  // kitArgs: kit's own flags, verbatim — the wake must relaunch with them too.
  setPersonaKeys(space, A, { agent: "kit", provider: "fake:codex", hibernate: "3h", kitArgs: '["-e","high"]' });
  const pin = readResumeId(personaFilePath(space, A))!;
  const transcript = join(kitSessionsRoot(), slug(folder), `${pin}.jsonl`);
  const st = paw("start", A);
  ok("paw start (kit, fake:codex, hibernate: 3h)", st.code === 0, tail(st.out + st.err));
  ok("…live + idle", !!(await until(() => (statusRow(A)?.live && statusRow(A)?.mesh === "idle" ? true : undefined), 60_000, 1000)), JSON.stringify(statusRow(A)));

  prober = new CotalEndpoint({ space, servers: pawServer(space), channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();
  const peer = (n: string) => prober!.getRoster().find((p) => p.card.name === n && p.status !== "offline");
  const dmAndWait = async (text: string, word: string, current = true) => {
    const pr = await until(() => {
      const p = peer(A);
      if (!current) return p;
      const actor = /--actor (\S+)/.exec(kitProc(A)?.cmd ?? "")?.[1];
      return actor && p?.card.id === `local.${actor}` ? p : undefined;
    }, 60_000, 200);
    if (!pr) return undefined;
    await prober!.unicast(pr.card.id, text);
    return until(() => inbox.find((m) => m.from === A && m.text.includes(word)), 120_000, 200);
  };

  // ── 1 judged by its own transcript ───────────────────────────────────────────────────────────
  ok("a DM gets a reply", !!(await dmAndWait("MARK-ONE", "MARK-ONE")));
  ok("its transcript is in kit's store", existsSync(transcript), transcript);
  await until(() => (peer(A)?.status === "idle" ? true : undefined), 30_000, 200);
  const dry = paw("sleep", "--sweep", "--dry-run");
  ok("dry run judges the kit agent by its transcript (idle < 3h), not 'harness not supported'", dry.code === 0 && new RegExp(`${A}: awake — idle \\d+m < 180m`).test(dry.out), dry.out.trim() + dry.err.trim());

  // ── 2 a backgrounded command keeps it awake ──────────────────────────────────────────────────
  const bg = JSON.stringify([{ name: "shell_command", args: JSON.stringify({ command: "sleep 611 >/dev/null 2>&1 &" }) }]);
  ok("it backgrounds a command in its shell", !!(await dmAndWait(`FAKE: ${bg}`, "FAKE-REPLY")));
  await until(() => (peer(A)?.status === "idle" ? true : undefined), 30_000, 200);
  bgPid = (await until(() => procs().find((p) => p.cmd === "sleep 611"), 10_000, 200))?.pid;
  ok("…`sleep 611` runs under kit's shell", !!bgPid);
  const refused = paw("sleep", A, "--now");
  ok("paw sleep --now refuses, naming the process under kit", refused.code !== 0 && /process\(es\) running under kit: \d+ sleep 611/.test(refused.err), tail(refused.err));
  if (bgPid) process.kill(bgPid, "SIGTERM");
  bgPid = undefined;
  await sleep(500);

  // ── 3 asleep ─────────────────────────────────────────────────────────────────────────────────
  const slept = paw("sleep", A, "--now");
  ok("with nothing running, paw sleep --now puts it to sleep", slept.code === 0 && /asleep/.test(slept.out), tail(slept.out + slept.err));
  ok("the `kit run` seat is gone", !!(await until(() => (kitProc(A) ? undefined : true), 20_000, 300)));
  ok("the sleep record is written", isAsleep(space, A));
  ok("the stand-in holds the name", !!(await until(() => standInHolder(space, A) ?? undefined, 30_000, 500)), String(standInHolder(space, A)));
  const before = readFileSync(transcript, "utf8");

  // ── 4 a DM wakes it into the same session ────────────────────────────────────────────────────
  inbox.length = 0;
  const woke = await dmAndWait("MARK-TWO", "MARK-TWO", false);
  ok("a DM to the stand-in wakes it and it answers", !!woke, JSON.stringify(inbox.slice(-2)));
  const p2 = kitProc(A);
  ok("woken with --resume <pin> and its kitArgs", !!p2?.cmd.includes(`--resume ${pin}`) && p2.cmd.includes("-e high"), p2?.cmd.slice(0, 260));
  const after = readFileSync(transcript, "utf8");
  ok("the new turn lands in the SAME transcript, after the pre-sleep one", after.startsWith(before) && after.includes("MARK-TWO") && before.includes("MARK-ONE"));
  ok("no longer recorded asleep", !!(await until(() => (isAsleep(space, A) ? undefined : true), 30_000, 500)));
} finally {
  if (bgPid) spawnSync("kill", [String(bgPid)]);
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(1000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  await purgeTestSpace(space, pawServer(space)).catch((e) => {
    console.error("teardown purge:", (e as Error).message);
    fails++;
  });
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);

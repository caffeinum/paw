/**
 * END-TO-END: `paw relocate` — a relocated agent resumes the SAME session in its new folder.
 *
 * The incident (2026-10-28): `skills` ran in ~/Github/team2027/2027-skills; the operator ran
 * `mv 2027-skills skills`; the agent's cwd was gone and it couldn't come back. On a FULLY ISOLATED stack
 * (own nats-server, PAW_HOME, space, cotal root, beads):
 *   1  spawn one REAL haiku agent in <tmp>/2027-skills; it learns a secret word and acks over the mesh
 *   2  the operator moves the folder by hand while it runs (`mv 2027-skills skills`)
 *   3  `paw relocate skills <tmp>/skills --dry-run` prints the re-point plan and changes nothing
 *   4  `paw relocate skills <tmp>/skills --yes`: stopped, re-pointed, started — "resumed its session <pin>"
 *   5  its claude runs in the new folder on the same session id, and it still knows the secret word
 *   6  `paw relocate skills <tmp>/skills-v2 --yes`: paw moves the folder itself; same session, same word
 *   7  the new project dir's transcript grows; the original (the backup) does not
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=relocate-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) \
 *   PAW_BEADS_DIR=$(mktemp -d) node scripts/e2e-relocate.ts
 *
 * Uses the real ~/.claude (claude's login); the three temp project dirs it creates there are removed at the end.
 */
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMesh } from "@cotal-ai/workspace";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("relocate-test") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=relocate-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const natsPort = await freePort();
process.env.PAW_SERVER = `nats://127.0.0.1:${natsPort}`;
process.env.PAW_MODEL ??= "haiku";
process.env.PAW_RUNTIME ??= "tmux";
const nats = spawn("nats-server", ["-js", "-p", String(natsPort), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawrljs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.ts");
const { ensureAgentSpawned, setFolderName, personaFilePath } = await import("../src/addressing.ts");
const { ensure, stop } = await import("../src/lifecycle.ts");
const { meshAgentSession } = await import("../src/named.ts");
const { pawServer } = await import("../src/server.ts");
const { readResumeId, readCwd } = await import("../src/session.ts");
const { sanitizePath } = await import("../src/teleport-memory.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return undefined;
};
const paw = (...args: string[]) =>
  new Promise<{ out: string; err: string; code: number | null }>((r) => {
    const p = spawn(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => r({ out, err, code }));
  });
const inboxHas = async (token: string) => (await paw("inbox", "--json")).out.includes(token);
const ask = async (label: string, prompt: string, token: string) => {
  const dm = await paw("dm", name, prompt);
  ok(`${label}: paw dm sent`, dm.code === 0, (dm.out + dm.err).slice(-400));
  ok(`${label}: the agent answered ${token}`, !!(await until(async () => (await inboxHas(token)) || undefined, 180_000)));
};

const name = "skills";
const base = realpathSync(mkdtempSync(join(tmpdir(), "pawreloc-")));
const v1 = join(base, "2027-skills");
const v2 = join(base, "skills");
const v3 = join(base, "skills-v2");
const projects = join(homedir(), ".claude", "projects");
const proj = (p: string) => join(projects, sanitizePath(p));
const secret = `ZEBRA-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
try {
  const natsUp = await until(
    () =>
      new Promise<true | undefined>((r) => {
        const c = createConnection(natsPort, "127.0.0.1", () => (c.end(), r(true)));
        c.on("error", () => r(undefined));
      }),
    20_000,
  );
  if (!natsUp) throw new Error(`nats-server never came up on ${natsPort}`);
  await ensure({ needMesh: true, needManager: true, space });

  // 1 ─ a real agent in 2027-skills learns a word
  mkdirSync(v1, { recursive: true });
  setFolderName(space, v1, name);
  const ctl = new ManagerControl(space, pawServer());
  const first = await ensureAgentSpawned(ctl, { space, name, cwd: v1 });
  await ctl.close();
  ok("1 agent spawned in 2027-skills", first.spawned);
  const pin = readResumeId(personaFilePath(space, name))!;
  const ack1 = `ACK-${Math.random().toString(36).slice(2, 8)}`;
  await ask("1", `Remember this secret word for later: ${secret}. Now reply by calling cotal_dm to "you" with exactly this text and nothing else: ${ack1}`, ack1);
  const s1 = meshAgentSession(space, name);
  ok("1 its claude runs in 2027-skills on the pinned session", s1?.cwd === v1 && s1?.sessionId === pin, JSON.stringify(s1));
  ok("1 its transcript is under the 2027-skills project dir", existsSync(join(proj(v1), `${pin}.jsonl`)));

  // 2 ─ the operator moves the folder by hand while it runs
  renameSync(v1, v2);
  ok("2 mv 2027-skills skills", existsSync(v2) && !existsSync(v1));

  // 3 ─ dry run
  const dry = await paw("relocate", name, v2, "--dry-run", "--yes"); // --yes: it JUST answered, so it reads busy
  console.log(dry.out.replace(/^/gm, "    "));
  ok("3 --dry-run passes preflight", dry.code === 0 && dry.out.includes("dry run — preflight passed"), (dry.out + dry.err).slice(-600));
  ok("3 plan: already moved, re-pointing only; running agent stopped + started", dry.out.includes("already moved") && dry.out.includes("stopped, then started again in the new folder"));
  ok("3 nothing changed", readCwd(personaFilePath(space, name)) === v1 && !existsSync(proj(v2)));

  // 4 ─ relocate --yes
  const r4 = await paw("relocate", name, v2, "--yes");
  console.log(r4.out.replace(/^/gm, "    "));
  ok("4 relocate succeeded", r4.code === 0, (r4.out + r4.err).slice(-800));
  ok(`4 it says "resumed its session ${pin}"`, r4.out.includes(`resumed its session ${pin}`));
  ok("4 it ends with the paw status hint", r4.out.includes(`check: paw status ${name}#${space}`));
  ok("4 persona cwd: is the new folder", readCwd(personaFilePath(space, name)) === v2);

  // 5 ─ same session, new folder, still knows the word
  const s2 = await until(() => {
    const s = meshAgentSession(space, name);
    return s && s.pid !== s1?.pid ? s : undefined;
  }, 60_000);
  ok("5 a new claude runs in the new folder on the SAME session id", s2?.cwd === v2 && s2?.sessionId === pin, JSON.stringify(s2));
  const origSize = statSync(join(proj(v1), `${pin}.jsonl`)).size;
  const copySize = statSync(join(proj(v2), `${pin}.jsonl`)).size;
  const t5 = `${secret}-OK5`;
  await ask("5", `What was the secret word I asked you to remember? Reply by calling cotal_dm to "you" with exactly that word followed by -OK5 and nothing else.`, t5);

  // 7 ─ the copy grows, the original stays the backup
  ok("7 the new project dir's transcript grew", statSync(join(proj(v2), `${pin}.jsonl`)).size > copySize, `${copySize} → ${statSync(join(proj(v2), `${pin}.jsonl`)).size}`);
  ok("7 the original (backup) did not", statSync(join(proj(v1), `${pin}.jsonl`)).size === origSize);
  const lastCwd = readFileSync(join(proj(v2), `${pin}.jsonl`), "utf8").trim().split("\n").reverse().map((l) => JSON.parse(l) as { cwd?: string }).find((l) => l.cwd)?.cwd;
  ok("7 new lines are stamped with the new folder", lastCwd === v2, lastCwd);

  // 6 ─ paw moves the folder itself
  const r6 = await paw("relocate", name, v3, "--yes");
  console.log(r6.out.replace(/^/gm, "    "));
  ok("6 relocate (paw moves the folder) succeeded", r6.code === 0 && r6.out.includes(`mv ${v2} → ${v3}`), (r6.out + r6.err).slice(-800));
  ok("6 folder moved", existsSync(v3) && !existsSync(v2));
  const s3 = await until(() => {
    const s = meshAgentSession(space, name);
    return s && s.pid !== s2?.pid ? s : undefined;
  }, 60_000);
  ok("6 running in skills-v2 on the same session", s3?.cwd === v3 && s3?.sessionId === pin, JSON.stringify(s3));
  const t6 = `${secret}-OK6`;
  await ask("6", `One more time: the secret word? Reply by calling cotal_dm to "you" with exactly that word followed by -OK6 and nothing else.`, t6);
  const st = await paw("status", name);
  console.log(st.out.replace(/^/gm, "    "));
  ok("6 paw status shows it in the new folder", st.out.includes(name));
} catch (e) {
  fails++;
  console.error("✗ e2e aborted:", (e as Error).stack ?? e);
} finally {
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  const s = meshAgentSession(space, name);
  if (s) process.kill(s.pid, "SIGTERM");
  removeMesh(space);
  nats.kill("SIGTERM");
  for (const p of [v1, v2, v3]) rmSync(proj(p), { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failure(s)` : "\nall relocate e2e checks passed");
process.exit(fails ? 1 : 0);

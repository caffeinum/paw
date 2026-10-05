/**
 * END-TO-END: kit agents (github.com/caffeinum/kit) on a REAL, ISOLATED cotal mesh (own nats-server, PAW_HOME, space,
 * cotal root), each continuing a COPY of a real Claude Code session.
 *
 *   1 paw's ensure() brings up mesh + manager + mailbox ("you"); each agent is registered as a
 *     paw persona (so `paw status` lists it) and started as `kit run` — one process per agent
 *   2 presence: visible on the roster, `working` during a turn, `idle` after, `offline` on stop
 *   3 a DM from a peer → a turn with tool calls (read a file, edit it, run bash) → a cotal_dm back
 *   4 a DM sent mid-turn is queued and answered by the next turn
 *   5 `paw dm <name>` reaches it (as "you"); the reply lands in `paw inbox`
 *   6 `paw status --json`: live, unmanaged (not the manager's)
 *   7 RAM (phys_footprint + RSS) of the kit process and its shell, idle at boot and after the turns
 *
 *   [KIT_BIN=<built kit>] KIT_AGENTS="codexy=codex:gpt-6-luna,grokky=grok:grok-build-0.1" \
 *   KIT_SESSION=<source transcript.jsonl (copied, never modified)> \
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=kit-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) \
 *   PAW_BEADS_DIR=$(mktemp -d) node scripts/lean/kit/e2e-kit.ts
 *
 * Without KIT_BIN the kit repo ($KIT_SRC, default ~/Github/caffeinum/kit) is built. Tokens come
 * from kit's own store (KIT_HOME, default ~/.kit) or borrowed codex/opencode logins.
 * A provider spec `fake:codex` / `fake:grok` runs the same mapping offline (scripted calls).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";
import { kitBin } from "./bin.ts";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("kit-test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=kit-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
const SOURCE = process.env.KIT_SESSION ?? "";
const AGENTS = (process.env.KIT_AGENTS ?? "").split(",").filter(Boolean).map((s) => {
  const [name, prov] = s.split("=");
  const [provider, model] = prov!.split(/:(?=[^:]*$)/).length === 2 && !prov!.startsWith("fake") ? prov!.split(/:(?=[^:]*$)/) : [prov!, ""];
  return { name: name!, provider: provider!, model: model! };
});
if (!SOURCE || !AGENTS.length) throw new Error("KIT_SESSION and KIT_AGENTS are required");
const BIN = kitBin();
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

const { ensure, stop } = await import("../../../src/lifecycle.ts");
const { ensurePersonaFile, setFolderName } = await import("../../../src/addressing.ts");
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
  const r = spawnSync(process.execPath, [join(REPO, "bin/paw.ts"), ...args], { env: process.env, encoding: "utf8", timeout: 180_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const ps = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssMb: Number(m[3]) / 1024, cmd: m[4]! }));
const footprintMb = (pid: number) => {
  const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(spawnSync("footprint", [String(pid)], { encoding: "utf8" }).stdout ?? "");
  return m ? Number(m[1]) * (m[2] === "KB" ? 1 / 1024 : m[2] === "GB" ? 1024 : 1) : NaN;
};
const ram = (label: string, pid: number) => {
  const all = ps();
  const self = all.find((p) => p.pid === pid);
  const kids = all.filter((p) => p.ppid === pid);
  const fp = footprintMb(pid);
  const kfp = kids.reduce((a, k) => a + footprintMb(k.pid), 0);
  const krss = kids.reduce((a, k) => a + k.rssMb, 0);
  console.log(`  RAM ${label}: kit footprint ${fp.toFixed(1)} MB rss ${self?.rssMb.toFixed(1)} MB · shell (${kids.map((k) => k.cmd.split(" ")[0]).join(",")}) footprint ${kfp.toFixed(1)} MB rss ${krss.toFixed(1)} MB`);
  return { fp, rss: self?.rssMb ?? NaN, kfp, krss };
};

const inbox: Array<{ from: string; text: string }> = [];
let prober: CotalEndpoint | undefined;
const procs: ChildProcess[] = [];
const ramRows: string[] = [];
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

  for (const a of AGENTS) {
    console.log(`\n── ${a.name}: ${a.provider}${a.model ? ` ${a.model}` : ""} ──`);
    const root = realpathSync(mkdtempSync(join(tmpdir(), `kit-${a.name}-`)));
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, "notes.txt"), "fruit: apple\ncount: 1\n");
    const copy = join(root, "session.jsonl");
    copyFileSync(SOURCE, copy);
    setFolderName(space, work, a.name);
    ensurePersonaFile(space, a.name);
    const log = openSync(join(root, "kit.log"), "a");
    const args = ["run", "--session", copy, "--cwd", work, "--name", a.name, "--space", space, "--server", pawServer(), "--provider", a.provider, "--state", join(root, "state"), "--effort", "low"];
    if (a.model) args.push("--model", a.model);
    const t0 = Date.now();
    const p = spawn(BIN, args, { stdio: ["ignore", log, log], env: process.env });
    procs.push(p);
    const live = await until(() => peer(a.name), 30_000, 100);
    ok(`${a.name} on the mesh`, !!live, `after ${Date.now() - t0} ms, id ${live?.card.id}, meta ${JSON.stringify(live?.card.meta)}`);
    if (!live) continue;
    await sleep(2000);
    const boot = ram(`${a.name} idle at boot`, p.pid!);

    const fake = a.provider.startsWith("fake");
    const family = a.provider.split(":")[1];
    const task = fake
      ? `FAKE: ${JSON.stringify((family === "codex" || family === "openai")
        ? [{ name: "shell_command", args: JSON.stringify({ command: "cat notes.txt && sleep 4" }) }, { name: "apply_patch", args: "*** Begin Patch\n*** Update File: notes.txt\n@@\n-fruit: apple\n+fruit: banana\n*** End Patch" }]
        : [{ name: "view_file", args: JSON.stringify({ path: "notes.txt" }) }, { name: "str_replace_editor", args: JSON.stringify({ path: "notes.txt", old_str: "fruit: apple", new_str: "fruit: banana" }) }, { name: "bash", args: JSON.stringify({ command: "wc -l notes.txt && sleep 4" }) }])}`
      : "New task, unrelated to the earlier conversation. In your working directory there is notes.txt. 1) Read it. 2) Edit it with your file-editing tool so that `apple` becomes `banana`. 3) Run `wc -l notes.txt && sleep 4` in the shell. Then cotal_dm prober with exactly: DONE <the wc output>.";
    const want = fake ? "FAKE-REPLY" : "DONE";
    const seen = new Set<string>();
    const tTurn = Date.now();
    await prober.unicast(live.card.id, task);
    const watch = (async () => {
      for (let i = 0; i < 600 && !inbox.some((m) => m.from === a.name && m.text.includes(want)); i++) {
        seen.add(peer(a.name)?.status ?? "?");
        await sleep(200);
      }
    })();
    await until(() => seen.has("working") || undefined, 60_000, 200);
    await prober.unicast(live.card.id, fake ? "FAKE: []\nqueued" : "Second message, sent while you were busy: cotal_dm prober with exactly QUEUED-OK, nothing else.");
    const done = await reply(a.name, want);
    await watch;
    ok(`${a.name}: DM → tool turn → cotal_dm back`, !!done, `${((Date.now() - tTurn) / 1000).toFixed(1)}s: ${done?.text.slice(0, 160).replace(/\n/g, "⏎")}`);
    ok(`${a.name}: presence went working during the turn`, seen.has("working"), [...seen].join(","));
    const file = readFileSync(join(work, "notes.txt"), "utf8");
    ok(`${a.name}: edited the file (apple → banana)`, file.includes("banana") && !file.includes("apple"), JSON.stringify(file));
    const queued = await until(() => (fake ? inbox.filter((m) => m.from === a.name).length >= 2 : !!inbox.find((m) => m.from === a.name && m.text.includes("QUEUED-OK"))) || undefined, 240_000);
    ok(`${a.name}: the DM sent mid-turn was queued and answered`, !!queued);
    await until(() => peer(a.name)?.status === "idle" || undefined, 30_000);
    ok(`${a.name}: idle after the turns`, peer(a.name)?.status === "idle", peer(a.name)?.status);

    const token = `PONG-${Math.random().toString(36).slice(2, 8)}`;
    const dm = paw("dm", a.name, fake ? `FAKE: []\n${token}` : `Reply to "you" with cotal_dm, text exactly: ${token}`);
    ok(`${a.name}: \`paw dm\` reaches it`, dm.code === 0, (dm.out + dm.err).trim().split("\n").slice(-2).join(" | "));
    const got = await until(() => paw("inbox", "--json").out.includes(token) || undefined, 240_000, 2000);
    ok(`${a.name}: its reply is in \`paw inbox\``, !!got, token);

    const st = JSON.parse(paw("status", "--json").out) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const row = (Array.isArray(st) ? st : st.rows ?? []).find((r) => r.name === a.name);
    ok(`${a.name}: paw status --json says live + unmanaged`, row?.live === true && row?.unmanaged === true, JSON.stringify(row)?.slice(0, 300));
    console.log(paw("status", a.name).out.trim().split("\n").map((l) => `    ${l}`).join("\n"));

    await sleep(3000);
    const after = ram(`${a.name} after the turns`, p.pid!);
    ramRows.push(`${a.name} (${a.provider}${a.model ? ` ${a.model}` : ""}): boot ${boot.fp.toFixed(1)} MB fp / ${boot.rss.toFixed(1)} MB rss → after ${after.fp.toFixed(1)} MB fp / ${after.rss.toFixed(1)} MB rss; shell ${after.kfp.toFixed(1)} MB fp`);

    p.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => p.once("exit", r));
    ok(`${a.name}: clean exit on SIGTERM`, code === 0, `code ${code}`);
    const off = await until(async () => {
      const r = prober!.getRoster().find((x) => x.card.name === a.name);
      return !r || r.status === "offline" ? true : undefined;
    }, 10_000);
    ok(`${a.name}: offline on the roster after stop`, !!off);
    console.log(`  transcript copy: ${copy}\n  log: ${join(root, "kit.log")}`);
  }
  console.log(`\nRAM\n${ramRows.map((r) => `  ${r}`).join("\n")}`);
} catch (e) {
  fails++;
  console.error("✗ e2e aborted:", (e as Error).stack ?? e);
} finally {
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `\n${fails} FAILED` : "\nkit e2e passed");
process.exit(fails ? 1 : 0);

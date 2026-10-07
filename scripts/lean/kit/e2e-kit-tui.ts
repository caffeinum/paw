/**
 * END-TO-END: `paw attach <kit agent>` opens kit's live view (`kit <name>`, kit's tui package) in a
 * real pty, on a REAL, ISOLATED mesh, and what is typed into it reaches the agent as the operator.
 *
 *   1 `paw start` a kit agent (fake:codex), `paw attach` it inside node-pty → the screen (rendered by
 *     @xterm/headless) shows the header, the message + tool sections, the status line and `> `
 *   2 type a `FAKE:` script that runs a slow bash → the screen shows the tool running, its LIVE
 *     output and "running Bash… Ns" (kit's status file), then the agent's reply `↩ you` + idle
 *   3 Alt+Enter makes a two-line prompt; Esc leaves the view and the agent stays on the mesh
 *
 *   XTERM_DIR=<dir with node_modules/@xterm/headless> KIT_BIN=<kit built from the checkout> \
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=kit-tui-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) \
 *     node scripts/lean/kit/e2e-kit-tui.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";
import * as pty from "@lydell/node-pty";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("kit-tui-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=kit-tui-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
if (!process.env.XTERM_DIR || !process.env.KIT_BIN) throw new Error("XTERM_DIR and KIT_BIN are required");
const req = createRequire(join(process.env.XTERM_DIR, "package.json"));
// not a paw dependency: loaded from $XTERM_DIR, typed just enough for what this script uses
type XTerm = {
  loadAddon(a: never): void;
  unicode: { activeVersion: string };
  write(d: string): void;
  buffer: { active: { viewportY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
};
const { Terminal } = req("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => XTerm };
const { Unicode11Addon } = req("@xterm/addon-unicode11") as { Unicode11Addon: new () => unknown };
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

const { ensure, stop, managerProcs, mailboxProcs } = await import("../../../src/lifecycle.ts");
const { ensurePersonaFile, personaFilePath, setFolderName, setPersonaKeys } = await import("../../../src/addressing.ts");
const { readResumeId, transcriptPath } = await import("../../../src/session.ts");
const { pawServer } = await import("../../../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, every = 100): Promise<T | undefined> => {
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

const COLS = 100;
const ROWS = 28;
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
term.loadAddon(new Unicode11Addon() as never);
term.unicode.activeVersion = "11";
const screen = () => {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < ROWS; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
  return out.join("\n");
};
const show = (label: string) => console.log(`\n── screen: ${label} ──\n${screen().split("\n").map((l) => `│ ${l}`).join("\n")}\n`);

let prober: CotalEndpoint | undefined;
let p: pty.IPty | undefined;
const cleanup: string[] = [];
try {
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0 || undefined, 10_000);
  await ensure({ needMesh: true, needManager: true, space });
  prober = new CotalEndpoint({ space, servers: pawServer(), channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (_m: unknown, d: { ack(): void }) => d.ack());
  await prober.start();
  const peer = (n: string) => prober!.getRoster().find((x) => x.card.name === n && x.status !== "offline");

  const NAME = "kitty";
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "kit-tui-")));
  setFolderName(space, folder, NAME);
  ensurePersonaFile(space, NAME, { brief: "You are kitty, a test agent." });
  setPersonaKeys(space, NAME, { agent: "kit", provider: "fake:codex" });
  const pin = readResumeId(personaFilePath(space, NAME))!;
  const st = paw("start", NAME);
  ok("paw start kitty", st.code === 0, (st.out + st.err).trim().split("\n").slice(-2).join(" | "));
  const up = await until(() => peer(NAME), 60_000, 200);
  ok("kitty on the mesh", !!up);
  if (!up) {
    console.log(paw("status", NAME).out);
    console.log(spawnSync("ps", ["-axo", "pid,command"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes(space)).join("\n"));
    throw new Error("agent never came up");
  }

  // ── 1: paw attach → kit's view ────────────────────────────────────────────────────────────
  const t0 = Date.now();
  p = pty.spawn(process.execPath, [join(REPO, "bin/paw.mjs"), "attach", NAME, "--space", space], { cols: COLS, rows: ROWS, cwd: folder, env: { ...process.env, TERM: "xterm-256color" } as Record<string, string> });
  let exited: number | undefined;
  p.onData((d) => term.write(d));
  p.onExit((e) => (exited = e.exitCode));
  const first = await until(() => (screen().includes(`${NAME} · kit`) && /^> /m.test(screen()) ? true : undefined), 30_000, 20);
  ok("paw attach opens kit's view (header + prompt)", !!first, `${Date.now() - t0} ms incl. paw's own startup`);
  const s1 = screen();
  ok("header: harness · provider, folder, session, process", s1.includes("kit · fake") && s1.includes(`session ${pin}`) && /pid \d+/.test(s1), s1.split("\n").slice(0, 2).join(" / "));
  ok("message + tool sections and a status line", s1.includes("── last message") && s1.includes("── tool") && /(idle|connecting)/.test(s1));
  show("attached, before any turn");

  // ── 2: type a turn that runs a slow bash ──────────────────────────────────────────────────
  const script = `FAKE: [{"name":"shell_command","args":"{\\"command\\":\\"for i in 1 2 3 4 5 6; do echo tick $i; sleep 1; done\\"}"}]`;
  p.write(script);
  await until(() => (screen().includes("FAKE: [") ? true : undefined), 5_000, 20);
  p.write("\r");
  const running = await until(() => (/running Bash… \d+s/.test(screen()) && /tick [2-5]/.test(screen()) ? true : undefined), 60_000, 50);
  ok("while the bash runs: tool call, its LIVE output, 'running Bash… Ns'", !!running);
  show("tool running");
  const replied = await until(() => (screen().includes("↩ you") && screen().includes("FAKE-REPLY") && /● idle/.test(screen()) ? true : undefined), 60_000, 100);
  ok("the typed text reached the agent as the operator: it replied to `you`, now idle", !!replied);
  ok("the tool's result replaced the live output", /⎿ {2}tick 1/.test(screen()) || /tick 6/.test(screen()));
  show("after the reply");
  const file = transcriptPath(pin);
  if (file) cleanup.push(file);

  // ── 3: multi-line prompt, then leave ──────────────────────────────────────────────────────
  p.write("line one");
  p.write("\x1b\r");
  p.write("line two");
  const multi = await until(() => (/^> line one\s*$/m.test(screen()) && /^ {2}line two\s*$/m.test(screen()) ? true : undefined), 5_000, 20);
  ok("Alt+Enter: a two-line prompt", !!multi);
  show("two-line prompt");
  p.write("\x1b");
  await until(() => (exited !== undefined ? true : undefined), 10_000, 50);
  ok("Esc leaves the view (exit 0)", exited === 0, String(exited));
  await sleep(500);
  ok("…and the agent keeps running", !!peer(NAME));
} finally {
  try {
    p?.kill();
  } catch {}
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(1000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  removeMesh(space);
  nats.kill("SIGTERM");
  for (const f of cleanup) {
    for (const s of ["", ".kit.lock", ".kit.status", ".kit.out"]) rmSync(f + s, { force: true });
    const dir = f.slice(0, f.lastIndexOf("/"));
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);

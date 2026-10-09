/**
 * END-TO-END: `paw chat @kit`'s tasks view in a real pty, on a REAL, ISOLATED mesh and beads db.
 *
 *   1 a presence-only fake agent `kit` (replies to every DM), four beads assigned to it + one not
 *   2 `paw chat @kit` in node-pty, the screen rendered by @xterm/headless; → on the empty line
 *     opens the tasks view: beads in order, the last message each way
 *   3 send a line from the tasks view → the reply replaces "its last message"; an idle stretch
 *     writes NOTHING (no flicker); a bead closed behind its back shows up on the next refresh
 *   4 a short terminal: the panel still fits; ← goes back to chat, ← again to logs
 *
 *   XTERM_DIR=<dir with node_modules/@xterm/headless + addon-unicode11> \
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=chat-tasks-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) \
 *     node scripts/lean/e2e-chat-tasks.ts
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";
import * as pty from "@lydell/node-pty";

const space = process.env.PAW_SPACE ?? "";
const beads = process.env.PAW_BEADS_DIR ?? "";
if (!process.env.PAW_HOME || !space.startsWith("chat-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !beads)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=chat-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
if (!process.env.XTERM_DIR) throw new Error("XTERM_DIR is required");
const req = createRequire(join(process.env.XTERM_DIR, "package.json"));
type XTerm = {
  loadAddon(a: never): void;
  unicode: { activeVersion: string };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  buffer: { active: { viewportY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
};
const { Terminal } = req("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => XTerm };
const { Unicode11Addon } = req("@xterm/addon-unicode11") as { Unicode11Addon: new () => unknown };
const REPO = fileURLToPath(new URL("../..", import.meta.url));

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
process.env.PAW_RUNTIME = "pty";
delete process.env.PAW_COTAL_HUB;
const jsDir = mkdtempSync(join(tmpdir(), "chatjs-"));
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", jsDir], { stdio: "ignore" });

const { ensure, stop, managerProcs, mailboxProcs } = await import("../../src/lifecycle.ts");
const { pawServer } = await import("../../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => T | undefined, ms: number, every = 100): Promise<T | undefined> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = fn();
    if (v) return v;
  }
  return undefined;
};

let COLS = 90;
let ROWS = 30;
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
term.loadAddon(new Unicode11Addon() as never);
term.unicode.activeVersion = "11";
const screen = () => {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < ROWS; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
  return out.join("\n");
};
const show = (label: string) => console.log(`\n── screen: ${label} (${COLS}×${ROWS}) ──\n${screen().split("\n").map((l) => `│ ${l}`).join("\n")}\n`);

// ── the beads: kit's four (in_progress, blocked, open, closed) + someone else's ────────────────────
const bdEnv = { ...process.env, BEADS_DIR: beads };
const bd = (...args: string[]) => execFileSync("bd", args, { cwd: beads, env: bdEnv, encoding: "utf8" }).trim();
bd("init", "--quiet");
const mk = (title: string, assignee: string) => bd("create", title, "-a", assignee, "--silent");
const ipId = mk("Fix the flaky reconnect test in check:loop", "kit");
const blkId = mk("Ship the tasks view once review lands", "kit");
const openId = mk("Write the chat.md section for the tasks view", "kit");
const doneId = mk("Remove the logs + chat view", "kit");
mk("Someone else's bead — must not show", "evals");
bd("update", ipId, "--status", "in_progress");
bd("update", blkId, "--status", "blocked");
bd("close", doneId);

let kit: CotalEndpoint | undefined;
let p: pty.IPty | undefined;
try {
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0 || undefined, 10_000);
  await ensure({ needMesh: true, needManager: true, space });

  // A fake agent: present on the mesh as `kit`, answers every DM.
  kit = new CotalEndpoint({ space, servers: pawServer(), consume: true, registerPresence: true, watchPresence: true, card: { name: "kit", kind: "endpoint", id: "kitfake" } });
  kit.on("error", () => {});
  let replies = 0;
  kit.on("message", (m: CotalMessage, d: { ack(): void }) => {
    d.ack();
    if (m.from?.name !== "you") return;
    replies++;
    setTimeout(() => void kit!.unicast(m.from.id, `**fixed** — reply #${replies}: the reconnect test was racing the drain\n\n- moved the wait after the subscribe\n- 50 runs green`), 400);
  });
  await kit.start();

  p = pty.spawn(process.execPath, [join(REPO, "bin/paw.mjs"), "chat", "@kit", "--space", space], { cols: COLS, rows: ROWS, cwd: tmpdir(), env: { ...process.env, TERM: "xterm-256color" } as Record<string, string> });
  let raw = "";
  p.onData((d) => {
    raw += d;
    term.write(d);
  });
  const up = await until(() => (screen().includes("you → kit") && screen().includes("chat  │") ? true : undefined), 40_000, 50);
  ok("paw chat @kit is up (prompt + hint)", !!up);
  ok("banner names the three views, no `logs + chat`", screen().includes("← → switch logs · chat · tasks") && !screen().includes("logs + chat"));
  ok("hint: chat │ ← logs ↓ mention tasks →", screen().includes("chat  │  ← logs   ↓ mention   tasks →"));

  // ── → opens the tasks view ──────────────────────────────────────────────────────────────────
  p.write("\x1b[C");
  const tasks = await until(() => (screen().includes("tasks · kit") && screen().includes(ipId) ? true : undefined), 30_000, 50);
  ok("→ on an empty line opens the tasks view with kit's beads", !!tasks);
  const s = screen();
  const at = (id: string) => s.indexOf(id);
  ok("order: in_progress, blocked, open, then closed", at(ipId) < at(blkId) && at(blkId) < at(openId) && at(openId) < at(doneId) && at(doneId) > 0);
  ok("glyphs: ◐ in progress, ⊘ blocked, ○ open, ✓ closed", /◐ \S+ +Fix the flaky/.test(s) && /⊘ \S+ +Ship the tasks/.test(s) && /○ \S+ +Write the chat/.test(s) && /✓ \S+ +Remove the logs/.test(s));
  ok("someone else's bead is not listed", !s.includes("Someone else"));
  ok("hint: tasks │ ← chat ↓ mention, no →", s.includes("tasks  │  ← chat   ↓ mention") && !s.includes("tasks →"));
  ok("no messages yet says so", s.includes("no messages between you and kit yet"));
  show("tasks view, before any message");

  // ── send from the tasks view; the reply lands in place ─────────────────────────────────────────
  p.write("please look at the flaky reconnect test\r");
  const got = await until(() => (screen().includes("reply #1") && screen().includes("please look at the flaky") ? true : undefined), 20_000, 50);
  ok("a line sent from the tasks view: your message + kit's reply both shown", !!got);
  ok("the reply clears the ⏳ notice", !screen().includes("⏳ waiting"));
  ok("the reply is markdown-rendered (no ** left, bullets)", !screen().includes("**fixed**") && screen().includes("50 runs green"));
  const s2 = screen();
  ok("messages oldest first: you, then kit (by the prompt)", s2.indexOf("you → kit ·") < s2.indexOf("kit · ") || s2.lastIndexOf("kit ·") > s2.indexOf("you → kit ·"));
  show("tasks view after a round-trip");

  // ── idle: an unchanged repaint writes nothing ─────────────────────────────────────────────────
  await sleep(1500);
  const before = raw.length;
  await sleep(13_000); // spans a 12s bead refresh
  const idle = raw.slice(before);
  const frames = idle.split("\x1b[H").length - 1;
  // Ages are minute-resolution, so at most ONE repaint (a minute rolling over) — and never a clear.
  ok("13s idle (incl. a bead refresh): at most one in-place repaint, never a screen clear — no flicker", frames <= 1 && !idle.includes("\x1b[2J"), `${idle.length} bytes, ${frames} repaint(s)`);

  // ── a bead closed behind the view's back shows up on the next refresh ───────────────────────────
  bd("close", openId);
  const closed = await until(() => (/✓ \S+ +Write the chat/.test(screen()) ? true : undefined), 20_000, 200);
  ok("a bead closed elsewhere turns ✓ within one refresh", !!closed);

  // ── a short terminal: the panel fits, the newest lines kept ──────────────────────────────────
  ROWS = 14;
  term.resize(COLS, ROWS);
  p.resize(COLS, ROWS);
  await sleep(800);
  const small = screen();
  ok("14 rows: title, the reply's last line and the prompt + hint all on screen", small.includes("tasks · kit") && small.includes("50 runs green") && small.includes("you → kit") && small.includes("tasks  │"));
  show("tasks view, short terminal");
  p.write("\x1b[<0;5;3M\x1b[<0;5;3m\x1b[<65;5;3M"); // a click + a wheel: handled, never typed
  await sleep(400);
  ok("mouse reports never reach the input line", !/\d+;\d+;\d+[Mm]/.test(screen()), screen().split("\n").filter((l) => /;\d+[Mm]/.test(l)).join(" | "));
  p.write("\x1b[<64;5;3M\x1b[<64;5;3M\x1b[<64;5;3M");
  await sleep(300);
  p.write("\x1b[6~"); // PgDn scrolls the bead list
  const down = await until(() => (screen().includes("↑") && screen().includes("above · PgUp") ? true : undefined), 5_000, 50);
  ok("PgDn scrolls the beads: an ↑ N above row appears", !!down);
  show("tasks view, scrolled");
  p.write("\x1b[5~");
  const top = await until(() => (!screen().includes("above · PgUp") ? true : undefined), 5_000, 50);
  ok("PgUp scrolls back to the top", !!top);
  ROWS = 30;
  term.resize(COLS, ROWS);
  p.resize(COLS, ROWS);
  await sleep(500);

  // ── ← back to chat, ← again to logs ──────────────────────────────────────────────────────────
  p.write("\x1b[D");
  const chat = await until(() => (screen().includes("chat  │  ← logs") && !screen().includes("tasks · kit") ? true : undefined), 5_000, 50);
  ok("← returns to the chat view (conversation reprinted)", !!chat && screen().includes("reply #1"));
  p.write("\x1b[D");
  const logs = await until(() => (screen().includes("logs  │") ? true : undefined), 5_000, 50);
  ok("← again: the logs view", !!logs);
  p.write("\x1b[D");
  await sleep(300);
  ok("← at the left end stays on logs (3 views, clamped)", screen().includes("logs  │"));
} finally {
  try {
    p?.kill();
  } catch {}
  await kit?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(1000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  removeMesh(space);
  nats.kill("SIGTERM");
  rmSync(jsDir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);

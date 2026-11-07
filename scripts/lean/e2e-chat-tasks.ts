/**
 * END-TO-END: `paw chat @kit`'s beads view in a real pty, on a REAL, ISOLATED mesh and beads db.
 * (Rewritten for the 2026-11-06 view order + fullscreen beads + mouse-on-by-default; NOT re-run since —
 *  it needs nats-server and @xterm/headless. check:chat-tty 17–20 covers the same ground hermetically.)
 *
 *   1 a presence-only fake agent `kit` (replies to every DM), four beads assigned to it + one not
 *   2 `paw chat @kit` in node-pty, the screen rendered by @xterm/headless; → → on the empty line
 *     (chat → messages → beads) opens the beads view FULLSCREEN: beads in order, no conversation pane
 *   3 send a line from the beads view → the receipt line, then the reply clears it; an idle stretch
 *     writes NOTHING (no flicker); a bead closed behind its back shows up on the next refresh
 *   4 a short terminal: the panel still fits; ← walks back messages → chat → logs
 *   5 mouse: SGR reporting is ON while beads is up (a click on a parent's icon folds it), ctrl+o hands
 *     it back (?1000l, select mode) and takes it again; leaving beads or quitting chat in it emits ?1000l
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
bd("close", doneId, "--actor", "kit");
const epicId = mk("Epic: polish the tasks view", "kit");
for (const t of ["child one", "child two", "child three"]) bd("create", t, "-a", "kit", "--parent", epicId, "--silent");

let kit: CotalEndpoint | undefined;
let p: pty.IPty | undefined;
let exited = false;
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
  p.onExit(() => (exited = true));
  p.onData((d) => {
    raw += d;
    term.write(d);
  });
  const up = await until(() => (screen().includes("you → kit") && screen().includes("chat  │") ? true : undefined), 40_000, 50);
  ok("paw chat @kit is up (prompt + hint)", !!up);
  ok("banner names the four views, no `logs + chat`", screen().includes("← → switch logs · chat · messages · beads") && !screen().includes("logs + chat"));
  ok("hint: chat │ ← logs ↓ mention messages →", screen().includes("chat  │  ← logs   ↓ mention   messages →"));

  // ── a multi-line draft is editable across lines ──────────────────────────────────────────────
  const repliesBefore = replies;
  for (const ch of "first line") p.write(ch);
  p.write("\x1b\r"); // alt+enter holds it
  await sleep(300);
  for (const ch of "second") p.write(ch);
  p.write("\x1b\r");
  await sleep(300);
  p.write("\x7f"); // backspace on the empty line takes "second" back
  const back = await until(() => (/kit \(only\)> second\s*$/m.test(screen()) && !/│ second/.test(screen()) ? true : undefined), 5_000, 50);
  ok("backspace on an empty line takes the last held line back into the input", !!back, screen().split("\n").filter((l) => l.trim()).slice(-4).join(" | "));
  p.write("\x15"); // ctrl+u: clears the typed line
  await sleep(200);
  p.write("\x15"); // ctrl+u on the empty line: drops the whole draft
  const cleared = await until(() => (screen().includes("cleared the draft (1 line)") && !/│ first line/.test(screen()) ? true : undefined), 5_000, 50);
  ok("ctrl+u on an empty line clears the whole multi-line draft", !!cleared);
  await sleep(1500);
  ok("nothing was sent while editing the draft", replies === repliesBefore);

  // ── → → opens the beads view (chat → messages → beads) ─────────────────────────────────────────
  p.write("\x1b[C");
  await until(() => (screen().includes("messages  │") ? true : undefined), 5_000, 50);
  p.write("\x1b[C");
  const tasks = await until(() => (screen().includes("beads · kit") && screen().includes(ipId) ? true : undefined), 30_000, 50);
  ok("→ → on an empty line opens the beads view with kit's beads", !!tasks);
  const s = screen();
  const at = (id: string) => s.indexOf(id);
  ok("order: in_progress, blocked, open, then closed", at(ipId) < at(blkId) && at(blkId) < at(openId) && at(openId) < at(doneId) && at(doneId) > 0);
  ok("glyphs: ◐ in progress, ⊘ blocked, ○ open, ✓ closed", /◐ \S+ +Fix the flaky/.test(s) && /⊘ \S+ +Ship the tasks/.test(s) && /○ \S+ +Write the chat/.test(s) && /✓ \S+ +Remove the logs/.test(s));
  ok("someone else's bead is not listed", !s.includes("Someone else"));
  ok("hint: beads │ ← messages ↓ mention, no →", s.includes("beads  │  ← messages   ↓ mention") && !s.includes("beads →"));
  ok("fullscreen: no conversation pane", !s.includes("no messages between") && !s.includes("you → kit"));
  show("beads view, before any message");

  // ── send from the beads view; the receipt, then the reply clears it ─────────────────────────────────────────
  p.write("please look at the flaky reconnect test\r");
  const got = await until(() => (replies > repliesBefore && !screen().includes("⏳ waiting") ? true : undefined), 20_000, 50);
  ok("a line sent from the beads view reaches kit, and its reply clears the ⏳ notice", !!got);
  ok("…the reply itself stays out of the fullscreen beads view", !screen().includes("reply #1"));
  show("beads view after a round-trip");

  // ── idle: an unchanged repaint writes nothing ─────────────────────────────────────────────────
  await sleep(1500);
  const before = raw.length;
  await sleep(13_000); // spans a 12s bead refresh
  const idle = raw.slice(before);
  const frames = idle.split("\x1b[H").length - 1;
  // Ages are minute-resolution, so at most ONE repaint (a minute rolling over) — and never a clear.
  ok("13s idle (incl. a bead refresh): at most one in-place repaint, never a screen clear — no flicker", frames <= 1 && !idle.includes("\x1b[2J"), `${idle.length} bytes, ${frames} repaint(s)`);

  // ── a bead closed behind the view's back shows up on the next refresh ───────────────────────────
  bd("close", openId, "--actor", "kit");
  const closed = await until(() => (/✓ \S+ +Write the chat/.test(screen()) ? true : undefined), 20_000, 200);
  ok("a bead closed elsewhere turns ✓ within one refresh", !!closed);

  // ── a short terminal: the panel fits, the newest lines kept ──────────────────────────────────
  ROWS = 14;
  term.resize(COLS, ROWS);
  p.resize(COLS, ROWS);
  await sleep(800);
  const small = screen();
  ok("14 rows: title and the prompt + hint on screen", small.includes("beads · kit") && small.includes("beads  │"));
  show("beads view, short terminal");
  p.write("\x1b[6~"); // PgDn scrolls the bead list
  const down = await until(() => (screen().includes("↑") && screen().includes("above · wheel/PgUp") ? true : undefined), 5_000, 50);
  ok("PgDn scrolls the beads: an ↑ N above row appears", !!down);
  show("beads view, scrolled");
  p.write("\x1b[5~");
  const top = await until(() => (!screen().includes("above · wheel/PgUp") ? true : undefined), 5_000, 50);
  ok("PgUp scrolls back to the top", !!top);
  ROWS = 30;
  term.resize(COLS, ROWS);
  p.resize(COLS, ROWS);
  await sleep(500);

  // ── the mouse: on while beads is up, ctrl+o = select mode ──────────────────────────────────────
  const ON = "\x1b[?1000h";
  const OFF = "\x1b[?1000l";
  ok("beads view: SGR mouse reporting is on (the wheel scrolls)", raw.lastIndexOf(ON) > raw.lastIndexOf(OFF) && raw.includes("\x1b[?1006h"));
  ok("an open parent leads with ▾ and lists its children", screen().split("\n").some((l) => l.includes(`▾ ○ ${epicId}`)) && screen().includes("child three"));
  ok("hint: wheel scrolls · ctrl+o select text", screen().includes("wheel scrolls · ctrl+o select text"));
  const lines = screen().split("\n");
  const row = lines.findIndex((l) => l.includes(`▾ ○ ${epicId}`));
  const col = row >= 0 ? lines[row].indexOf("▾") : -1;
  ok("the epic's icon is on screen", row >= 0 && col >= 0, `row ${row + 1}, col ${col + 1}`);
  const click = (x: number, y: number) => p!.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
  click(col + 10, row + 1); // the title: nothing
  await sleep(400);
  ok("a click on the title does nothing", screen().includes("child three") && !screen().includes("(+3)"));
  click(col + 1, row + 1);
  const foldedNow = await until(() => (screen().includes(`▸ ○ ${epicId} (+3)`) && !screen().includes("child three") ? true : undefined), 5_000, 50);
  ok("a click on a parent's icon folds it: ▸ <id> (+3), the children gone", !!foldedNow);
  const leak = screen().match(/\d+;\d+;\d+[Mm]?|\[<\d/);
  ok("no mouse report leaked into the input line (or anywhere on screen)", !leak, leak?.[0] ?? "");
  let mark = raw.length;
  p.write("\x0f");
  const cOff = await until(() => (raw.slice(mark).includes(OFF) && screen().includes("select mode ·") ? true : undefined), 5_000, 50);
  ok("ctrl+o: ?1000l written, the select-mode row shows", !!cOff);
  mark = raw.length;
  p.write("\x0f");
  const cOn = await until(() => (raw.slice(mark).includes(ON) && !screen().includes("select mode ·") ? true : undefined), 5_000, 50);
  ok("ctrl+o again: ?1000h written, the row gone", !!cOn);
  ok("the fold outlives select mode", screen().includes(`▸ ○ ${epicId} (+3)`));

  // ── ← back through messages to chat, ← again to logs ───────────────────────────────────────────
  mark = raw.length;
  p.write("\x1b[D");
  const msgs = await until(() => (screen().includes("messages  │") && raw.slice(mark).includes(OFF) ? true : undefined), 5_000, 50);
  ok("← out of beads: the messages view, and ?1000l written", !!msgs);
  p.write("\x1b[D");
  const chat = await until(() => (screen().includes("chat  │  ← logs") && !screen().includes("beads · kit") ? true : undefined), 5_000, 50);
  ok("← returns to the chat view (conversation reprinted)", !!chat && screen().includes("reply #1"));
  p.write("\x1b[D");
  const logs = await until(() => (screen().includes("logs  │") ? true : undefined), 5_000, 50);
  ok("← again: the logs view", !!logs);
  p.write("\x1b[D");
  await sleep(300);
  ok("← at the left end stays on logs (4 views, clamped)", screen().includes("logs  │"));

  // ── quitting chat from the beads view turns reporting off ────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    p.write("\x1b[C");
    await sleep(300);
  }
  await until(() => (screen().includes("beads · kit") ? true : undefined), 5_000, 50);
  mark = raw.length;
  p.write("\x03"); // ctrl+c quits chat
  const quit = await until(() => (exited ? true : undefined), 10_000, 50);
  ok("ctrl+c in the beads view: chat exits and writes ?1000l on the way out", !!quit && raw.slice(mark).includes(OFF), `exited=${exited}`);
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

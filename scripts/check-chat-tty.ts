/**
 * e2e: paw chat's instant UI under a real pty, in an ISOLATED space (refuses anything else).
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/check-chat-tty.ts
 *
 * A raw CotalEndpoint peer `echoer` records every DM and #general post it gets. Then `paw chat`:
 *   1. a line typed BEFORE the prompt and one typed once it shows are both queued, then delivered to
 *      echoer exactly once each, in order — and nothing reaches #general;
 *   2. `@ghost hi` typed before ready says "no peer named ghost", posts nothing, and is back in the input;
 *   3. `paw chat nosuch` + an early line: the line is refused and kept (✕ not sent … text kept), the
 *      process stays up, /quit leaves, #general stays silent;
 *   4. echoer DMs "you" the moment its presence appears: the DM renders (listeners attach before connect);
 *   5. Ctrl-C at +20/50/80/120/400ms: exits within the startup-settle bound, bracketed paste turned off
 *      if it was ever turned on, a line queued before the quit is printed in full;
 *  5b. SIGTERM in the pre-shell window: bracketed paste (if on) is turned off on the way out;
 *   6. pipe mode (`… | paw chat echoer`) delivers once — today's order, unchanged;
 *   7. a multi-line bracketed paste landing at ~60ms (before chat.ts has loaded) is ONE message;
 *   8. a multi-line queued line refused at replay is kept and printed in full on quit (never lost);
 *   9. an argv error after the skeleton was painted erases it before the error prints;
 *  10. a 14-row terminal gets a one-line skeleton (a full one would strand its top in the scrollback).
 *  11. `@echoerr` (a typo, registered nowhere): the first frame says "looking for", then the chooser
 *      offers @echoer; a line typed meanwhile is NOT sent — it is back in the input, and goes to echoer
 *      only once the operator picks it and presses Enter;
 *  12. a name registered only in ANOTHER local space: the chooser offers to open it there; Esc quits.
 *  13. composing (connected): trailing-`\` continuations + a paste → the draft on the rail, the paste inline, ONE DM
 *      whose wire text is unchanged.
 *  14. the earlier block on open: `── earlier with echoer ──` … `── now ──` with both directions, and a DM
 *      that ALSO arrives live (it sat in the inbox) is on screen exactly once;
 *  15. the earlier block on an `@name` switch: echo2's DM (hidden + acked by a filtered chat, so never
 *      delivered live again) shows after `@echo2`; history never marks it read (cursor unchanged), never
 *      retargets (no `↪ replying`), and plain lines still go to the switched-to target;
 *  16. `--history 1` + `/more 3` grows the block in place; `--history 0` shows none.
 *  17. the MESSAGES view (→ from chat): echoer's earlier DM to a second peer `bob` (in the stream from
 *      before chat opened) and a live DM bob → echoer show INDENTED RIGHT with an `a → b` label, while
 *      echoer's DM to you stays left-aligned;
 *  18. ←/→ walk logs → chat → messages → beads (the hint names each view on the way) and clamp;
 *  19. the BEADS view is fullscreen (no conversation pane), turns SGR mouse reporting on, and the wheel
 *      scrolls the bead list (40 beads in an isolated PAW_BEADS_DIR); ctrl+o hands the mouse back
 *      (reporting off) and takes it again; leaving the view turns reporting off;
 *  20. /quit typed in the beads view turns mouse reporting off on the way out.
 *  22. an image to an agent on another machine (teleported persona): refused, `/noimg` drops it and puts
 *      the typed words back in the input; Enter sends them alone, exactly once.
 *  (1. also covers a peer registered nowhere here that IS on the roster: found → the normal prompt.)
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { controlCreds } from "../src/addressing.ts";
import { readCursor } from "../src/cursor.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { pawServer } from "../src/server.ts";

const home = process.env.PAW_HOME?.trim();
const space = process.env.PAW_SPACE?.trim();
if (!home || home === join(homedir(), ".paw") || !space || space === "paw" || space === "team2027" || process.env.PAW_RELEASE !== "dev")
  throw new Error("check:chat-tty starts a mesh manager and sends messages — run it ONLY as PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/check-chat-tty.ts");

const REPO = fileURLToPath(new URL("..", import.meta.url));
const bun = join(homedir(), ".bun/bin/bun");
const [exe, pre] = existsSync(bun) ? [bun, [join(REPO, "bin/paw.ts")]] : [process.execPath, [join(REPO, "bin/paw.mjs")]];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const text = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

const failures: string[] = [];
const ok = (label: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "  ok " : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(label);
};

// The beads view reads bd: point it (and every child chat) at a throwaway db, never the operator's ~/.beads.
const beadsDb = join(home, "beads");
mkdirSync(beadsDb, { recursive: true });
process.env.PAW_BEADS_DIR = beadsDb;
const bd = (...args: string[]): string => execFileSync("bd", args, { cwd: beadsDb, env: { ...process.env, BEADS_DIR: beadsDb }, encoding: "utf8" }).trim();
bd("init", "--quiet");
for (let i = 0; i < 40; i++) bd("create", `bead number ${String(i).padStart(2, "0")}`, "-a", "echoer", "--silent");

await ensure({ needMesh: true, needManager: true, space });
const server = pawServer(space);

// ── echoer: a bare mesh peer (no claude), records DMs + #general ──────────────────────────────────
const dms: string[] = [];
const general: string[] = [];
let pingOnJoin = false;
const echoer = new CotalEndpoint({ space, servers: server, creds: await controlCreds(space), card: { name: "echoer", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
echoer.on("error", (e: Error) => console.error("echoer:", e.message));
echoer.on("warning", () => {});
echoer.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
  d.ack();
  if (meta.kind === "dm") dms.push(text(m));
  else if (meta.kind === "channel") general.push(text(m));
});
let youId: string | undefined;
echoer.on("presence", (ev: { type: string; presence: { card: { id: string; name: string } } }) => {
  if (ev.presence.card.name === "you") youId = ev.presence.card.id;
  if (pingOnJoin && ev.type === "join" && ev.presence.card.name === "you") {
    pingOnJoin = false;
    void echoer.unicast(ev.presence.card.id, "ping-the-moment-you-joined");
  }
});
await echoer.start();

/** A mode switched on is switched off after it — never "off" required of a terminal paw never touched. */
const pasteRestored = (raw: string): boolean => raw.lastIndexOf("\x1b[?2004h") < raw.lastIndexOf("\x1b[?2004l") || !raw.includes("\x1b[?2004h");
const pasteDetail = (raw: string): string => (raw.includes("\x1b[?2004h") ? (raw.includes("\x1b[?2004l") ? "on → off" : "left ON") : "never switched on");

/** One `paw chat` under a pty. `script` runs against it; returns the plain output and exit code. */
async function chat(args: string[], script: (io: { pid: number; write(s: string): void; kill(sig: string): void; out(): string; raw(): string; t(): number; waitFor(re: RegExp, ms: number): Promise<boolean> }) => Promise<void>, budgetMs = 30_000, rows = 40) {
  const t0 = Date.now();
  const p = ptySpawn(exe, [...pre, "chat", ...args], { name: "xterm-256color", cols: 120, rows, cwd: REPO, env: { ...(process.env as Record<string, string>), FORCE_COLOR: "1" } });
  let raw = "";
  p.onData((d) => (raw += d));
  let signal = 0;
  const exited = new Promise<number>((r) => p.onExit(({ exitCode, signal: sig }) => ((signal = sig ?? 0), r(exitCode))));
  let done = false;
  void exited.then(() => (done = true));
  const io = {
    pid: p.pid,
    write: (s: string) => !done && p.write(s),
    kill: (sig: string) => !done && p.kill(sig),
    out: () => strip(raw),
    raw: () => raw,
    t: () => Date.now() - t0,
    waitFor: async (re: RegExp, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(strip(raw))) return true;
        if (done) return re.test(strip(raw));
        await sleep(25);
      }
      return false;
    },
  };
  await script(io);
  const code = await Promise.race([exited, sleep(budgetMs).then(() => undefined)]);
  if (code === undefined) p.kill();
  return { raw, plain: strip(raw), code, signal, ms: Date.now() - t0 };
}

/** `pid` and every descendant of it. */
function tree(pid: number): number[] {
  let kids: number[] = [];
  try {
    kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {} // pgrep exits 1 when there are no children
  return [pid, ...kids.flatMap(tree)];
}

try {
  // 1. type-ahead: one line before the prompt, one once it shows — queued, then sent once each, in order.
  {
    dms.length = 0;
    general.length = 0;
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("one-early\r"), 30);
      await io.waitFor(/you → /, 5000);
      io.write("two-at-prompt\r");
      const end = Date.now() + 20_000;
      while (Date.now() < end && dms.filter((d) => /one-early|two-at-prompt/.test(d)).length < 2) await sleep(50);
      await sleep(500); // a duplicate would land now
      io.write("/quit\r");
    });
    const got = dms.filter((d) => /one-early|two-at-prompt/.test(d));
    ok("1. both early lines reach echoer exactly once, in typed order", JSON.stringify(got) === JSON.stringify(["one-early", "two-at-prompt"]), JSON.stringify(got));
    ok("1. …they were queued while connecting (◌ queued)", (r.plain.match(/◌ queued — sends when connected/g) ?? []).length >= 1, `${(r.plain.match(/◌ queued/g) ?? []).length}×`);
    ok("1. …and #general heard nothing", general.length === 0, JSON.stringify(general));
    ok("1. /quit exits 0", r.code === 0, `exit ${r.code}`);
  }

  // 2. `@ghost hi` before ready → refused by name, nothing posted.
  {
    dms.length = 0;
    general.length = 0;
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("@ghost hi-ghost\r"), 30);
      await io.waitFor(/no peer named "ghost"/, 20_000);
      await sleep(300);
      io.write("\x15/quit\r"); // the refused line is back in the input: clear it first
    });
    ok("2. @ghost before ready → no peer named ghost", /no peer named "ghost"/.test(r.plain), r.plain.split("\n").slice(-6).join(" | "));
    ok("2. …and the refused line is back in the input, never lost", /(that line|your text) is back in the input/.test(r.plain) && /> ?@ghost hi-ghost/.test(r.plain), r.plain.split("\n").slice(-6).join(" | "));
    ok("2. …and nothing was sent anywhere", dms.every((d) => !/hi-ghost/.test(d)) && general.length === 0);
  }

  // 3. an unreachable target: the queued line is refused and kept, the chat stays up, /quit leaves.
  {
    general.length = 0;
    const r = await chat(["nosuch"], async (io) => {
      setTimeout(() => io.write("hi-nobody\r"), 30);
      const refused = await io.waitFor(/✕ not sent to nosuch: [\s\S]*that line is back in the input/, 20_000);
      ok("3. a line to an unreachable target is refused and put back in the input", refused, io.out().split("\n").slice(-6).join(" | "));
      await sleep(300);
      ok("3. …the chat is still up", !/\$ $/.test(io.out()) && /you → .*nosuch/.test(io.out()));
      io.write("\x15/quit\r");
    });
    ok("3. …#general stayed silent (never a fallback post)", general.length === 0, JSON.stringify(general));
    ok("3. /quit leaves", r.code !== undefined, `exit ${r.code}`);
  }

  // 4. a DM that lands the moment "you" joins is shown (listeners attached before connect).
  {
    pingOnJoin = true;
    const r = await chat(["echoer"], async (io) => {
      await io.waitFor(/ping-the-moment-you-joined/, 8_000);
      await sleep(300);
      io.write("/quit\r");
    });
    ok("4. a DM sent the moment you join renders", /ping-the-moment-you-joined/.test(r.plain), r.plain.split("\n").slice(-6).join(" | "));
    pingOnJoin = false;
  }

  // 5. Ctrl-C during startup: leaves promptly, terminal restored, queued lines printed in full.
  // Early ones may land before the pre-shell's raw switch: the kernel's SIGINT, the terminal never touched.
  for (const at of [20, 50, 80, 120, 400]) {
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("keep-this-line\r"), Math.min(30, at / 2)); // always typed before the Ctrl-C
      setTimeout(() => io.write("\x03"), at);
    }, 15_000);
    ok(`5. Ctrl-C at +${at}ms exits within the settle bound`, r.code !== undefined && r.ms < 12_000, `exit ${r.code}${r.signal ? ` (signal ${r.signal})` : ""} after ${r.ms}ms`);
    ok(`5. …bracketed paste, if switched on, is switched off on the way out`, pasteRestored(r.raw), pasteDetail(r.raw));
    const sent = dms.includes("keep-this-line");
    ok(`5. …the queued line is printed in full (or it was sent before the quit)`, /keep-this-line/.test(r.plain.slice(r.plain.lastIndexOf("quitting") >= 0 ? r.plain.lastIndexOf("quitting") : 0)) || sent, sent ? "sent" : "printed");
    dms.length = 0;
  }

  // 5b. a signal in the pre-shell window (before chat.ts listens for it): the terminal still goes back.
  for (const at of [70, 110]) {
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.kill("SIGTERM"), at);
    }, 15_000);
    ok(`5b. SIGTERM at +${at}ms exits`, r.code !== undefined, `exit ${r.code}${r.signal ? ` (signal ${r.signal})` : ""} after ${r.ms}ms`);
    ok(`5b. …bracketed paste, if switched on, is switched off on the way out`, pasteRestored(r.raw), pasteDetail(r.raw));
  }

  // 6. pipe mode: today's order — connect, then read lines — one delivery.
  {
    dms.length = 0;
    const child = spawn(exe, [...pre, "chat", "echoer"], { cwd: REPO, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const end = Date.now() + 20_000;
    while (Date.now() < end && !/you → /.test(strip(out))) await sleep(50);
    child.stdin.write("piped-line\n");
    while (Date.now() < end && !dms.includes("piped-line")) await sleep(50);
    await sleep(500);
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    ok("6. pipe mode delivers once", dms.filter((d) => d === "piped-line").length === 1, JSON.stringify(dms));
    ok("6. …banner after the connect (today's order)", strip(out).indexOf("connecting to echoer") < strip(out).indexOf("paw chat") && /echoer[^\n]*· mesh /.test(strip(out)) && !/status:|reusing/.test(strip(out)), strip(out).slice(0, 300));
  }

  // 7. a multi-line paste in the first ~60ms arrives bracketed (the pre-shell turned 2004 on) → ONE DM.
  {
    dms.length = 0;
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("\x1b[200~p-one\rp-two\rp-three\x1b[201~"), 60);
      setTimeout(() => io.write(" tail-word\r"), 120);
      const end = Date.now() + 20_000;
      while (Date.now() < end && !dms.some((d) => /tail-word/.test(d))) await sleep(50);
      await sleep(500);
      io.write("/quit\r");
    });
    const hits = dms.filter((d) => /p-one|p-two|p-three|tail-word/.test(d));
    ok("7. an early multi-line paste is ONE message with all its lines", hits.length === 1 && /p-one[\s\S]*p-two[\s\S]*p-three/.test(hits[0]!) && /tail-word/.test(hits[0]!), JSON.stringify(hits));
    ok("7. …the pre-shell enabled bracketed paste before the first prompt", r.raw.indexOf("\x1b[?2004h") >= 0 && r.raw.indexOf("\x1b[?2004h") < r.raw.indexOf("you → "));
  }

  // 8. a continued (multi-line) line to an unreachable target: refused at replay, kept, printed on quit.
  {
    general.length = 0;
    const r = await chat(["nosuch"], async (io) => {
      setTimeout(() => io.write("line-one\\\r"), 30);
      setTimeout(() => io.write("line-two\r"), 60);
      await io.waitFor(/that line is kept, not sent/, 20_000);
      await sleep(200);
      io.write("\x04");
    });
    const tail = r.plain.slice(Math.max(0, r.plain.lastIndexOf("quitting with")));
    ok("8. a refused multi-line queued line is kept, not lost", /that line is kept, not sent/.test(r.plain), r.plain.split("\n").slice(-8).join(" | "));
    ok("8. …and printed in full on quit", /quitting with 1 message/.test(tail) && /line-one[\s\S]*line-two/.test(tail), tail.slice(0, 200));
    ok("8. …#general stayed silent", general.length === 0);
  }

  // 9. an argv error after the skeleton was painted: the frame is erased (cleared down) before the error.
  {
    const r = await chat(["echoer", "--personality", "calm"], async () => {}, 15_000);
    const errAt = r.raw.indexOf("--personality is for a new agent");
    const before = r.raw.slice(0, errAt);
    ok("9. an argv error exits 1 with its message", r.code === 1 && errAt > 0, `exit ${r.code}`);
    // echoer is registered nowhere here, so its skeleton prompt is the "looking for" one.
    const promptAt = Math.max(before.lastIndexOf("you → "), before.lastIndexOf("looking for @echoer"));
    ok("9. …after the skeleton was cleared (never glued onto the loader prompt)", before.lastIndexOf("\x1b[0J") > promptAt && promptAt > 0);
  }

  // 10. a short terminal: the first frame is one line, so erasing it can reach every row.
  {
    const r = await chat(["echoer"], async (io) => {
      await io.waitFor(/you → echoer> /, 20_000);
      await sleep(200);
      io.write("/quit\r");
    }, 30_000, 7);
    const first = strip(r.raw.slice(0, r.raw.indexOf("\x1b[0J")));
    ok("10. a 7-row terminal gets a one-line skeleton", /◌ loading/.test(first) && !/keys/.test(first), JSON.stringify(first.slice(0, 160)));
  }
  // 11. a typo'd name: an honest pending frame, then the chooser; nothing sent until the operator picks.
  {
    dms.length = 0;
    general.length = 0;
    const r = await chat(["@echoerr"], async (io) => {
      setTimeout(() => io.write("for-echoer\r"), 30);
      const shown = await io.waitFor(/✕ no agent echoerr in [\s\S]*did you mean[\s\S]*1 echoer/, 20_000);
      ok("11. the chooser says there's no echoerr and offers echoer", shown, io.out().split("\n").slice(-10).join(" | "));
      ok("11. …once: no status row, no second copy, the footer says not found, the prompt ✕", (strip(io.out()).match(/✕ no agent echoerr/g) ?? []).length === 1 && /echoerr ✕ not found/.test(strip(io.out())) && /you → echoerr ✕> /.test(strip(io.out())) && !/status:|offline|not running|any other key/.test(strip(io.out())), io.out().split("\n").slice(-10).join(" | "));
      await sleep(300);
      ok("11. …and the line typed meanwhile was not sent", !dms.some((d) => /for-echoer/.test(d)) && general.length === 0, JSON.stringify(dms));
      io.write("1");
      await io.waitFor(/now messaging echoer/, 10_000);
      await sleep(200);
      io.write("\r"); // the kept line, back in the input, now goes to the chosen agent
      const end = Date.now() + 10_000;
      while (Date.now() < end && !dms.some((d) => /for-echoer/.test(d))) await sleep(50);
      await sleep(300);
      io.write("/quit\r");
    });
    const first = strip(r.raw.slice(0, r.raw.indexOf("\x1b[0J")));
    ok("11. the first frame shows the name with a loader, nothing guessed", /echoerr · mesh /.test(first) && /you → echoerr ◌> /.test(first) && !/offline|status:/.test(first), JSON.stringify(first.slice(-160)));
    ok("11. after picking @echoer + Enter the kept line reached echoer exactly once", dms.filter((d) => /for-echoer/.test(d)).length === 1, JSON.stringify(dms));
    ok("11. …#general heard nothing", general.length === 0);
  }

  // 12. a name that exists only in another (isolated) local space.
  {
    const otherSpace = `${space}-b`;
    mkdirSync(join(home, "spaces", otherSpace, "personas"), { recursive: true });
    writeFileSync(join(home, "spaces", otherSpace, "personas", "only-there.md"), `---\nname: only-there\n---\n`);
    const r = await chat(["@only-there"], async (io) => {
      const shown = await io.waitFor(new RegExp(`no agent only-there in ${space}[\\s\\S]*open only-there in ${otherSpace}`), 20_000);
      ok("12. the chooser offers to open it in the other space", shown, io.out().split("\n").slice(-8).join(" | "));
      io.write("\x1b");
    }, 15_000);
    ok("12. Esc quits", r.code !== undefined, `exit ${r.code}`);
    rmSync(join(home, "spaces", otherSpace), { recursive: true, force: true });
  }

  // 13. composing a multi-line message with a paste, once connected: the draft is drawn on the rail and
  //     the continuation prompt IS the rail; the paste shows inline under its line; the wire text is
  //     exactly what it always was (held lines joined by \n, the payload in its fence after the body).
  {
    dms.length = 0;
    let railPrompt = false;
    const r = await chat(["echoer"], async (io) => {
      await io.waitFor(/you → echoer> /, 20_000);
      await sleep(1500); // connected, not queued: this is the live composing path
      io.write("m-first\\\r");
      railPrompt = await io.waitFor(/  │ /, 5000); // the continuation prompt is the rail (no held row is on it yet)
      io.write("m-second\\\r");
      await sleep(200);
      io.write("\x1b[200~q-one\rq-two\rq-three\x1b[201~");
      await sleep(300);
      io.write("\\\r");
      await sleep(200);
      io.write("m-last\r");
      const end = Date.now() + 20_000;
      while (Date.now() < end && !dms.some((d) => /m-last/.test(d))) await sleep(50);
      await sleep(300);
      io.write("/quit\r");
    });
    const hits = dms.filter((d) => /m-first|m-last/.test(d));
    const want = "m-first\nm-second\n[Pasted text #1] \nm-last\n\n--- [Pasted text #1] (3 lines) ---\nq-one\nq-two\nq-three\n--- end [Pasted text #1] ---";
    ok("13. a composed multi-line message with a paste arrives as ONE DM, wire text unchanged", hits.length === 1 && hits[0] === want, JSON.stringify(hits));
    ok("13. …the draft's first line reads like an echo, later ones sit on the rail", /you → echoer> m-first/.test(r.plain) && /  │ m-second/.test(r.plain), r.plain.split("\n").slice(-14).join(" | "));
    ok("13. …the paste is shown inline under its line (📋 header + its rows)", /│ 📋 \[Pasted text #1\] 3 lines[\s\S]*│ {3}q-one[\s\S]*│ {3}q-three/.test(r.plain));
    ok("13. …mid-draft the prompt is the rail, and after the send it is the normal prompt again", railPrompt && /m-last[\s\S]*you → echoer> /.test(r.plain));
  }

  // What is on screen at the end: everything after the last full redraw (a redraw reprints the whole
  // history; erased-in-place rows only ever held a `◌` loader, never a message).
  const lastScreen = (raw: string): string => strip(raw.slice(raw.lastIndexOf("\x1b[H\x1b[2J\x1b[3J") + 1));
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

  // 14. history on open, deduped against a live copy.
  {
    const nonce = Date.now().toString(36);
    if (!youId) throw new Error("check:chat-tty: echoer never saw \"you\" on the roster — can't DM it");
    await echoer.unicast(youId, `hist-in-${nonce}`); // no chat is running: it waits in the inbox AND sits in the stream
    await sleep(300);
    const r = await chat(["echoer"], async (io) => {
      await io.waitFor(/── now ──/, 20_000);
      await io.waitFor(new RegExp(`hist-in-${nonce}`), 5000);
      await sleep(1200); // a duplicate (live after history, or history after live) would land now
      io.write("/quit\r");
    });
    const screen = lastScreen(r.raw);
    ok("14. the earlier block shows on open (── earlier with echoer … ── now ──)", /── earlier with echoer · \d+ messages? in the last 24h[^\n]*──[\s\S]*── now ──/.test(screen), screen.split("\n").slice(-30).join(" | "));
    ok("14. …both directions: your earlier lines to echoer are in it", /you → echoer[^\n]*: (one-early|two-at-prompt|m-first)/.test(screen));
    ok("14. …a DM that also arrived live is on screen exactly once", count(screen, `hist-in-${nonce}`) === 1, `${count(screen, `hist-in-${nonce}`)}×`);
    // Replaced in place (the loader's rows cleared down, `\x1b[0J`, after it) or by a full redraw.
    const loaderAt = r.raw.indexOf("◌ loading earlier messages with echoer");
    ok("14. …the loader was replaced, not left behind", !/◌ loading earlier messages with echoer/.test(screen) || (loaderAt >= 0 && r.raw.indexOf("\x1b[0J", loaderAt) > loaderAt), screen.split("\n").slice(-14).join(" | "));
  }

  // 15. history on an @switch; never read, never a retarget.
  {
    const nonce = Date.now().toString(36);
    const echo2 = new CotalEndpoint({ space, servers: server, creds: await controlCreds(space), card: { name: "echo2", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
    echo2.on("error", (e: Error) => console.error("echo2:", e.message));
    echo2.on("warning", () => {});
    const e2dms: string[] = [];
    echo2.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
      d.ack();
      if (meta.kind === "dm") e2dms.push(text(m));
    });
    await echo2.start();
    try {
      // A FILTERED chat on echoer acks echo2's DM without showing it — it is not read.
      await chat(["@echoer"], async (io) => {
        await io.waitFor(/● connected/, 20_000);
        await sleep(500);
        await echo2.unicast(youId!, `e2-hidden-${nonce}`);
        await io.waitFor(/1 elsewhere/, 10_000);
        io.write("/quit\r");
      });
      const cursorBefore = readCursor(space);
      dms.length = 0;
      const r = await chat(["echoer"], async (io) => {
        await io.waitFor(/── now ──/, 20_000);
        io.write("@echo2\r");
        await io.waitFor(/── earlier with echo2/, 15_000);
        await io.waitFor(new RegExp(`e2-hidden-${nonce}`), 5000);
        await sleep(800);
        io.write(`to-echo2-${nonce}\r`);
        const end = Date.now() + 15_000;
        while (Date.now() < end && !e2dms.some((d) => d.includes(`to-echo2-${nonce}`))) await sleep(50);
        await sleep(300);
        io.write("/quit\r");
      });
      const screen = lastScreen(r.raw);
      ok("15. @echo2 loads echo2's earlier conversation (its DM a filtered chat had hidden)", /── earlier with echo2[\s\S]*e2-hidden-[\s\S]*── now ──/.test(screen) && count(screen, `e2-hidden-${nonce}`) === 1, screen.split("\n").slice(-20).join(" | "));
      ok("15. …history never marks it read (the unread cursor did not move)", readCursor(space) === cursorBefore, `${cursorBefore} → ${readCursor(space)}`);
      ok("15. …history never retargets (no ↪ replying)", !/↪ replying/.test(r.plain));
      ok("15. …and a plain line after the switch goes to echo2, not echoer", e2dms.some((d) => d.includes(`to-echo2-${nonce}`)) && !dms.some((d) => d.includes(`to-echo2-${nonce}`)), JSON.stringify(e2dms));
    } finally {
      await echo2.stop().catch(() => {});
    }
  }

  // 16. --history N and /more; --history 0.
  {
    const r = await chat(["echoer", "--history", "1"], async (io) => {
      await io.waitFor(/── earlier with echoer · 1 message · \d+ older · \/more ──/, 20_000);
      await sleep(300);
      io.write("/more 3\r");
      await io.waitFor(/── earlier with echoer · 4 messages/, 10_000);
      await sleep(300);
      io.write("/quit\r");
    });
    const screen = lastScreen(r.raw);
    ok("16. --history 1 shows one message and says how many are older", /── earlier with echoer · 1 message · \d+ older · \/more ──/.test(r.plain), r.plain.split("\n").filter((l) => /earlier/.test(l)).join(" | "));
    ok("16. …/more 3 grows the same block to 4 (redrawn, one divider)", count(screen, "── earlier with echoer") === 1 && /── earlier with echoer · 4 messages/.test(screen), screen.split("\n").filter((l) => /earlier|now/.test(l)).join(" | "));
    const off = await chat(["echoer", "--history", "0"], async (io) => {
      await io.waitFor(/● connected/, 20_000);
      await sleep(1500);
      io.write("/quit\r");
    });
    ok("16. --history 0 shows no earlier block", !/earlier messages|── earlier/.test(off.plain));
  }

  // 17–20. the messages view, the view order, the fullscreen beads view and its mouse wheel.
  {
    const nonce = Date.now().toString(36);
    const MOUSE_ON = "\x1b[?1000h";
    const MOUSE_OFF = "\x1b[?1000l";
    const bob = new CotalEndpoint({ space, servers: server, creds: await controlCreds(space), card: { name: "bob", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
    bob.on("error", (e: Error) => console.error("bob:", e.message));
    bob.on("warning", () => {});
    bob.on("message", (_m: CotalMessage, d: Delivery) => d.ack());
    await bob.start();
    try {
      if (!youId) throw new Error("check:chat-tty: echoer never saw \"you\" on the roster");
      await echoer.unicast(bob.card.id, `peer-hist-${nonce}`); // before the chat: only the DM stream has it
      await sleep(300);
      let messagesScreen = "";
      let hints = "";
      let beadsRaw = "";
      let afterLeave = "";
      const r = await chat(["echoer"], async (io) => {
        await io.waitFor(/── now ──/, 20_000);
        await io.waitFor(/● connected/, 10_000);
        await echoer.unicast(youId!, `mine-${nonce}`);
        await io.waitFor(new RegExp(`mine-${nonce}`), 10_000);
        await sleep(300);
        io.write("\x1b[C"); // chat → messages
        await io.waitFor(/messages {2}│/, 5000);
        await io.waitFor(/between echoer and other peers/, 15_000);
        await sleep(500);
        messagesScreen = lastScreen(io.raw());
        await bob.unicast(echoer.card.id, `peer-live-${nonce}`);
        await io.waitFor(new RegExp(`peer-live-${nonce}`), 10_000);
        await sleep(300);
        const mark = io.raw().length;
        io.write("\x1b[C"); // messages → beads
        await io.waitFor(/beads · /, 5000);
        await io.waitFor(/… \+\d+ more · wheel\/PgDn/, 20_000);
        await sleep(300);
        io.write("\x1b[<65;20;10M"); // wheel down
        await io.waitFor(/↑ 3 above · wheel\/PgUp/, 5000);
        await sleep(200);
        io.write("\x0f"); // ctrl+o: select mode
        await io.waitFor(/select mode · /, 5000);
        await sleep(200);
        io.write("\x0f"); // ctrl+o: the wheel back
        await sleep(400);
        io.write("\x1b[C"); // clamps at beads
        await sleep(300);
        beadsRaw = io.raw().slice(mark);
        const leave = io.raw().length;
        io.write("\x1b[D"); // beads → messages
        await sleep(400);
        afterLeave = io.raw().slice(leave);
        io.write("\x1b[D"); // → chat
        await sleep(400);
        io.write("\x1b[D"); // → logs
        await io.waitFor(/logs {2}│/, 5000);
        await sleep(300);
        io.write("\x1b[D"); // clamps at logs
        await sleep(300);
        hints = io.out();
        for (let i = 0; i < 3; i++) {
          io.write("\x1b[C"); // back to beads
          await sleep(400);
        }
        await io.waitFor(/beads · /, 5000);
        await sleep(300);
        io.write("/quit\r");
      });
      const lines = messagesScreen.split(/\r?\n/);
      const peerHist = lines.find((l) => l.includes(`peer-hist-${nonce}`)) ?? "";
      const mine = lines.find((l) => l.includes(`mine-${nonce}`)) ?? "";
      ok("17. messages view: echoer's earlier DM to bob shows, indented right with an `echoer → bob` label", /^ {4}echoer → bob[^\n]*: peer-hist-/.test(peerHist), JSON.stringify(peerHist));
      ok("17. …your own conversation with echoer stays left-aligned", mine !== "" && !/^ {4}/.test(mine), JSON.stringify(mine));
      ok("17. …the loader was replaced by a summary of the other-peer rows", /── \d+ messages? between echoer and other peers in the last 24h, indented right/.test(messagesScreen) && !/◌ loading echoer's messages with other peers/.test(messagesScreen));
      ok("17. …a LIVE DM bob → echoer shows indented right", new RegExp(`[\\r\\n] {4}bob → echoer: peer-live-${nonce}`).test(r.plain), r.plain.split("\n").filter((l) => l.includes("peer-live")).join(" | "));
      const order = ["chat  │", "messages  │", "beads  │", "logs  │"].map((h) => hints.indexOf(h));
      ok("18. → walks chat → messages → beads, ← walks back to logs (the hint names each view)", order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && hints.indexOf("logs  │", order[2]) > order[2], JSON.stringify(order));
      const beadsPlain = strip(beadsRaw.slice(beadsRaw.lastIndexOf("\x1b[H\x1b[2J\x1b[3J")));
      ok("19. beads view is FULLSCREEN: title, beads to the bottom, no conversation pane", /beads · [^\n]*echoer/.test(beadsPlain) && (beadsPlain.match(/○ \S+ +bead number/g) ?? []).length >= 20 && !/no messages between|you → echoer ·|peer-live|mine-/.test(beadsPlain), `${(beadsPlain.match(/bead number/g) ?? []).length} bead rows`);
      ok("19. …entering it turns SGR mouse reporting on", beadsRaw.indexOf(MOUSE_ON) >= 0 && beadsRaw.includes("\x1b[?1006h"));
      ok("19. …the wheel scrolls the bead list (↑ 3 above)", /↑ 3 above · wheel\/PgUp/.test(strip(beadsRaw)));
      const sel = beadsRaw.indexOf("select mode");
      ok("19. …ctrl+o turns reporting off for select mode, and ctrl+o again back on", sel > 0 && beadsRaw.lastIndexOf(MOUSE_OFF, sel) > beadsRaw.indexOf(MOUSE_ON) && beadsRaw.indexOf(MOUSE_ON, sel) > sel);
      ok("19. …leaving the view turns reporting off", afterLeave.includes(MOUSE_OFF) && !afterLeave.includes(MOUSE_ON), JSON.stringify(afterLeave.slice(0, 40)));
      ok("19. …no other view turned it on (the first ?1000h comes after the chat and messages views were used)", r.raw.indexOf(MOUSE_ON) > r.raw.indexOf(`peer-live-${nonce}`) && r.raw.indexOf(`peer-live-${nonce}`) > 0);
      ok("20. /quit in the beads view turns mouse reporting off on the way out", r.raw.lastIndexOf(MOUSE_OFF) > r.raw.lastIndexOf(MOUSE_ON) && r.code === 0, `exit ${r.code}`);

      // 21. ctrl+z in the beads view: reporting off BEFORE the process stops (a parent shell left in
      // mouse mode types `\e[<64;…M` on every wheel), and back on with `fg`.
      let suspendRaw = "";
      let stopped: number[] = [];
      let resumedRaw = "";
      const z = await chat(["echoer"], async (io) => {
        await io.waitFor(/● connected/, 20_000);
        await sleep(300);
        io.write("\x1b[C");
        await sleep(300);
        io.write("\x1b[C"); // → beads
        await io.waitFor(/beads · /, 5000);
        await sleep(500);
        const mark = io.raw().length;
        io.write("\x1a"); // ctrl+z
        await sleep(800);
        suspendRaw = io.raw().slice(mark);
        stopped = tree(io.pid).filter((pid) => /T/.test(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })));
        const back = io.raw().length;
        for (const pid of stopped) process.kill(pid, "SIGCONT");
        await sleep(800);
        resumedRaw = io.raw().slice(back);
        io.write("/quit\r");
      });
      ok("21. ctrl+z in beads stops the chat process", stopped.length > 0, JSON.stringify(stopped));
      ok("21. …after turning mouse reporting and bracketed paste off", suspendRaw.includes(MOUSE_OFF) && suspendRaw.includes("\x1b[?2004l") && !suspendRaw.slice(suspendRaw.indexOf(MOUSE_OFF)).includes(MOUSE_ON), JSON.stringify(suspendRaw.slice(0, 60)));
      ok("21. …and `fg` (SIGCONT) takes reporting back and repaints the beads view", resumedRaw.includes(MOUSE_ON) && /beads · /.test(strip(resumedRaw)) && z.code === 0, `exit ${z.code}`);
    } finally {
      await bob.stop().catch(() => {});
    }
  }

  // 22. an image to an agent that runs on another machine: the send is refused, and /noimg drops the
  // image and puts the typed words back in the input — Enter sends them alone (operator, 2026-11-10).
  {
    const persona = join(home, "spaces", space, "personas", "farcat.md");
    mkdirSync(join(home, "spaces", space, "personas"), { recursive: true });
    writeFileSync(persona, "---\nname: farcat\nteleported: ssh:mini\n---\n");
    const png = join(home, "shot.png");
    writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    const farDms: string[] = [];
    const far = new CotalEndpoint({ space, servers: server, creds: await controlCreds(space), card: { name: "farcat", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
    far.on("error", (e: Error) => console.error("farcat:", e.message));
    far.on("warning", () => {});
    far.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
      d.ack();
      if (meta.kind === "dm") farDms.push(text(m));
    });
    await far.start();
    try {
      let refusedSeen = false;
      let restoredSeen = false;
      const r = await chat(["farcat"], async (io) => {
        await io.waitFor(/● connected/, 20_000);
        await sleep(300);
        io.write(`i added cc to betterstack account ${png}\r`);
        refusedSeen = await io.waitFor(/not sent — farcat runs on ssh:mini and can't open \[Image #1\][\s\S]*\/noimg drops it and keeps your text/, 10_000);
        await sleep(300);
        io.write("/noimg\r");
        restoredSeen = await io.waitFor(/your text is back in the input without the image/, 5000);
        await sleep(300);
        io.write("\r"); // the restored words, as they are
        const end = Date.now() + 10_000;
        while (Date.now() < end && !farDms.length) await sleep(50);
        await sleep(300);
        io.write("/quit\r");
      });
      const afterNoimg = r.plain.slice(Math.max(0, r.plain.indexOf("your text is back in the input without")));
      ok("22. an image to an agent on another machine is refused, and the hint says the text is kept", refusedSeen, r.plain.split("\n").filter((l) => /not sent|⚠/.test(l)).join(" | "));
      ok("22. …nothing reached farcat while the image was staged", !farDms.some((d) => /\[Image|shot\.png/.test(d)), JSON.stringify(farDms));
      ok("22. …/noimg puts the typed words back into the input", restoredSeen && /i added cc to betterstack account[\s\S]*◌ waiting for farcat/.test(afterNoimg), JSON.stringify(afterNoimg.slice(0, 600)));
      ok("22. …and Enter sends exactly those words, without the image", JSON.stringify(farDms) === JSON.stringify(["i added cc to betterstack account"]), JSON.stringify(farDms));
    } finally {
      await far.stop().catch(() => {});
      rmSync(persona, { force: true });
    }
  }
} finally {
  await echoer.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("teardown stop:", (e as Error).message));
  await purgeTestSpace(space, server).catch((e) => {
    console.error("teardown purge:", (e as Error).message);
    process.exitCode = 1;
  });
  rmSync(join(home, "spaces", space), { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} chat tty check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\npaw chat takes keys from the first frame 🐾");

/**
 * e2e: a multi-line draft in `paw chat` while messages arrive — on a REAL terminal (tmux), in an
 * ISOLATED space (refuses anything else).
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/check-chat-draft.ts
 *
 * The draft is INPUT, not history (docs/notes/chat.md#multiline, 2026-11-17): a message that arrives
 * while you compose prints ABOVE the whole draft, the draft rows stay together and show once, and Enter
 * leaves ONE block in the scrollback — one time stamp above it, the receipt right under it — which a
 * redraw paints the same. Only a terminal can show that: a raw pty stream still holds every row that
 * was erased, so each screen here is tmux's own (`capture-pane -S -200`, scrollback included).
 *
 * A raw CotalEndpoint `echoer` (no claude) DMs mid-draft and records what reaches it; `paw chat echoer`
 * runs in tmux on a PRIVATE socket (-L), 120 columns. Scenarios:
 *   A. trailing-`\` lines, a DM, Enter, ←/→ redraw;  B. a multi-line paste + words, DM, Enter;
 *   C. the operator's screenshot: `\` lines, a paste inside line 3, DM, the agent mid-turn, Enter;
 *   D. control: one line, DM, Enter;  E. a 25-line draft (one row wraps), DM, Enter, ←/→;
 *   E2. the same draft in a 20-row pane: capped live (`… +N more rows above`), whole once sent;
 *   F. ⌫ on the empty rail after a DM;  G. alt+enter / shift+enter instead of `\`;
 *   H. a paste on an empty prompt: the `[1 pasted]` badge is drawn and the caret sits after the text;
 *   I. a burst of 3 DMs mid-draft;  J. Ctrl+U after a DM;  K. ←/→ view switches mid-draft;
 *   L. the terminal resized mid-draft (120 → 90 columns), then a DM;  M. the ↓ picker open mid-draft.
 * Round 2 (a real-terminal tester + a reviewer found these on the first fix, each one reproduced here):
 *   N. lines EXACTLY the terminal width (60 columns): readline gives them an extra caret row;
 *   O. a head row of wide (CJK) glyphs wrapping at the right edge;  P. `/quit` typed on the rail;
 *   Q. the picker in a short pane (the draft stays whole), and over a draft taller than what is left;
 *   R. Ctrl-C with the picker open;  S. Ctrl+L, then a DM (tmux copies a home-row clear to the scrollback);
 *   T. a draft begun before chat connected (its `◌` head prompt settles);  U. TERM=dumb starts;
 *   V. a long line typed under a capped draft: the draft is capped again, no scrollback-wiping redraw;
 *   W. a long line landing in ONE chunk under a capped draft (the screen scrolls), killed, then a DM.
 * Every wire DM is asserted byte for byte (check:chat-tty 13 pins the same format).
 * Teardown always runs: tmux kill-server, echoer stop, `paw down`, purgeTestSpace, the space dir.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { controlCreds } from "../src/addressing.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { pawServer } from "../src/server.ts";

const home = process.env.PAW_HOME?.trim();
const space = process.env.PAW_SPACE?.trim();
if (!home || home === join(homedir(), ".paw") || !space || space === "paw" || space === "team2027" || process.env.PAW_RELEASE !== "dev")
  throw new Error("check:chat-draft starts a mesh manager and sends messages — run it ONLY as PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/check-chat-draft.ts");
try {
  execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
  throw new Error("check:chat-draft needs tmux on PATH — the screens are a real terminal's, a pty byte stream can't show erased rows");
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SOCK = `paw-chat-draft-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const SOCK_PATH = `/private/tmp/tmux-${process.getuid!()}/${SOCK}`;
const COLS = 120;
const beadsDir = join(home, "beads");
mkdirSync(beadsDir, { recursive: true });
process.env.PAW_BEADS_DIR = beadsDir;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
const failures: string[] = [];
const ok = (label: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "  ok " : "  FAIL"}  ${label}${!pass && detail ? `\n${detail}` : ""}`);
  if (!pass) failures.push(label);
};

// ── tmux ─────────────────────────────────────────────────────────────────────────────────────────
const T = "chat";
const tmux = (...args: string[]): string => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** The terminal's own screen, scrollback included, as plain lines (trailing blanks trimmed). */
const screen = (): string[] =>
  tmux("capture-pane", "-p", "-t", T, "-S", "-200")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
const shown = (lines: string[]): string => lines.map((l) => `      │${l}`).join("\n");
async function waitFor(pass: (lines: string[]) => boolean, ms = 10_000, every = 100): Promise<string[]> {
  const end = Date.now() + ms;
  for (;;) {
    const lines = screen();
    if (pass(lines) || Date.now() > end) return lines;
    await sleep(every);
  }
}
const has = (re: RegExp) => (lines: string[]) => lines.some((l) => re.test(l));
const type = (s: string) => tmux("send-keys", "-t", T, "-l", s);
const key = (...k: string[]) => tmux("send-keys", "-t", T, ...k);
/** A real bracketed paste: tmux wraps it in ESC[200~ … ESC[201~ (paw turned mode 2004 on). */
function paste(s: string): void {
  execFileSync("tmux", ["-L", SOCK, "load-buffer", "-b", "p", "-"], { input: s });
  tmux("paste-buffer", "-p", "-d", "-b", "p", "-t", T);
}
const cursorX = (): number => Number(tmux("display-message", "-p", "-t", T, "#{cursor_x}").trim());

// ── what a screen must show ────────────────────────────────────────────────────────────────────────
const RAIL = "  │ ";
const rail = (s: string) => `${RAIL}${s}`.replace(/\s+$/, "");
const HEAD = "you → echoer> ";
const STAMP = /^ {20,}(?:[a-z]+ (?:\d+ [a-z]+ )?)?\d\d:\d\d$/;
const REPLY = (tag: string) => `${tag}: reply line one from echoer\nreply line two\nreply line three (end of ${tag})`;
const replyEnd = (tag: string) => (lines: string[]) => lines.findIndex((l) => l.endsWith(`(end of ${tag})`));
/** Where `rows` stand as one block (consecutive, exactly), or -1. */
function blockAt(lines: string[], rows: string[]): number {
  for (let i = 0; i + rows.length <= lines.length; i++) if (rows.every((r, j) => lines[i + j] === r)) return i;
  return -1;
}
const once = (lines: string[], rows: string[]) => rows.filter((r) => r.trim() !== "│").every((r) => lines.filter((l) => l === r).length === 1);

/** Mid-draft: the reply above the whole draft, the draft + the line being typed + the hint row last, each row once, no `\` echo. */
function draftUnder(name: string, lines: string[], tag: string | undefined, draft: string[], typing: string): void {
  const rows = [...draft, rail(typing)];
  const at = blockAt(lines, rows);
  const end = tag ? replyEnd(tag)(lines) : -1;
  const s = shown(lines.slice(-(rows.length + 12)));
  if (tag) ok(`${name}: the message is ABOVE the whole draft`, end >= 0 && at > end, s);
  ok(`${name}: the draft rows and the line being typed stand together, the hint row last`, at >= 0 && at + rows.length === lines.length - 1 && /^draft · \d+ lines/.test(lines[lines.length - 1]!), s);
  ok(`${name}: each draft row shows once — no row twice, no \`\\\` echo left behind`, once(lines, draft) && !lines.some((l) => /\\$/.test(l)), s);
}
/** After Enter: ONE block, one stamp right above its first row, the receipt right under its last. */
function sentBlock(name: string, lines: string[], tag: string | undefined, block: string[], receipt: RegExp): number {
  const at = blockAt(lines, block);
  const s = shown(lines.slice(-(block.length + 14)));
  ok(`${name}: the sent message is ONE block`, at >= 0 && once(lines, block), s);
  ok(`${name}: …one time stamp, on the row right above its first row`, at > 0 && STAMP.test(lines[at - 1]!), s);
  ok(`${name}: …the receipt right under its last row`, at >= 0 && receipt.test(lines[at + block.length] ?? ""), s);
  if (tag) ok(`${name}: …the reply above it, nothing of the draft left between`, replyEnd(tag)(lines) >= 0 && replyEnd(tag)(lines) < at, s);
  return at;
}
const WAITING = /^◌ waiting for echoer…$/;

// ── the mesh + echoer ─────────────────────────────────────────────────────────────────────────────
let echoer: CotalEndpoint | undefined;
let server = "";
const dms: string[] = [];
let youId: string | undefined;

/** `paw chat echoer` in a fresh pane; `booting` returns as soon as the pre-shell prompt shows (`◌`). */
async function startChat(rows = 40, opts: { cols?: number; env?: string[]; booting?: boolean } = {}): Promise<void> {
  try {
    tmux("kill-session", "-t", T);
  } catch {} // the first scenario has none
  const env = ["PAW_HOME", "PAW_SPACE", "PAW_RELEASE", "PAW_BEADS_DIR"].flatMap((k) => ["-e", `${k}=${process.env[k]}`]);
  const cmd = `${opts.env?.length ? `env ${opts.env.join(" ")} ` : ""}${process.execPath} ${join(REPO, "bin/paw.mjs")} chat echoer --history 0; echo "[chat exited $?]"; sleep 600`;
  tmux("new-session", "-d", "-s", T, "-x", String(opts.cols ?? COLS), "-y", String(rows), "-c", home!, ...env, cmd);
  tmux("set-option", "-t", T, "history-limit", "5000");
  if (opts.booting) {
    // Polled tight: keys typed while only the pre-shell is up are read by readline before boot starts.
    const pre = await waitFor(has(/^you → echoer ◌> ?$/), 30_000, 10);
    if (!has(/^you → echoer ◌> ?$/)(pre)) throw new Error(`chat never showed its pre-shell prompt:\n${shown(pre)}`);
    return;
  }
  const up = await waitFor((l) => has(/^you → echoer> ?$/)(l) || has(/^\[chat exited/)(l), 30_000);
  if (!has(/^you → echoer> ?$/)(up)) throw new Error(`chat never showed its prompt:\n${shown(up)}`);
  const end = Date.now() + 15_000;
  while (!youId && Date.now() < end) await sleep(100);
  if (!youId) throw new Error("echoer never saw `you` on the roster");
  await sleep(1500); // connected, not queued: the live composing path
}
/** The pre-shell's first frame stays in the scrollback unless a redraw cleared it (CLEAR_ALL wipes it). */
const preShellKept = (lines: string[]): boolean => lines.some((l) => /^you → echoer ◌> ?$/.test(l));
async function says(tag: string, body = REPLY(tag)): Promise<string[]> {
  await echoer!.unicast(youId!, body);
  return waitFor((l) => replyEnd(tag)(l) >= 0 && /^draft · |^chat |^📋/.test(l[l.length - 1] ?? ""));
}
/** Enter, then wait for the DM on the wire and the receipt on screen. Returns the wire DMs it sent. */
async function send(receipt = WAITING): Promise<{ wire: string[]; lines: string[] }> {
  const before = dms.length;
  key("Enter");
  const end = Date.now() + 15_000;
  while (Date.now() < end && dms.length === before) await sleep(100);
  const lines = await waitFor(has(receipt));
  await sleep(300); // a second DM (a split) would land now
  return { wire: dms.slice(before), lines: screen() };
}
/** Lines in the draft, as its hint row counts them (held + the one being typed; 1 = no draft). */
const draftLines = (l: string[]): number => Number(/^draft · (\d+) lines/.exec(l[l.length - 1] ?? "")?.[1] ?? 1);
/** Type `line` with a trailing `\` and Enter: held, once the hint row counts it. */
async function hold(line: string): Promise<void> {
  const n = draftLines(screen());
  type(`${line}\\`);
  key("Enter");
  const after = await waitFor((l) => draftLines(l) === n + 1);
  if (draftLines(after) !== n + 1) throw new Error(`"${line}\\" + Enter was never held:\n${shown(after.slice(-6))}`);
}
async function quit(): Promise<void> {
  key("C-u");
  type("/quit");
  key("Enter");
  await sleep(800);
}

async function main(): Promise<void> {
  await ensure({ needMesh: true, needManager: true, space });
  server = pawServer(space!);
  echoer = new CotalEndpoint({ space: space!, servers: server, creds: await controlCreds(space!), card: { name: "echoer", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
  echoer.on("error", (e: Error) => console.error("echoer:", e.message));
  echoer.on("warning", () => {});
  echoer.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
    d.ack();
    if (meta.kind === "dm") dms.push(text(m));
  });
  echoer.on("presence", (ev: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (ev.presence.card.name === "you" && ev.type !== "leave") youId = ev.presence.card.id;
  });
  await echoer.start();

  // A. trailing `\` continuations, a DM mid-draft, Enter, then a ←/→ redraw of the history.
  {
    await startChat();
    await hold("first line");
    await hold("second line");
    type("third");
    await sleep(300);
    draftUnder("A", await says("A"), "A", [`${HEAD}first line`, rail("second line")], "third");
    type(" and done");
    const { wire, lines } = await send();
    ok("A: ONE DM on the wire, text unchanged", JSON.stringify(wire) === JSON.stringify(["first line\nsecond line\nthird and done"]), JSON.stringify(wire));
    const block = [`${HEAD}first line`, rail("second line"), rail("third and done")];
    const at = sentBlock("A", lines, "A", block, WAITING);
    const live = lines.slice(replyEnd("A")(lines) - 3, at + block.length + 1);
    key("Right");
    await waitFor(has(/^messages /));
    key("Left");
    const redrawn = await waitFor(has(/^chat /));
    const at2 = sentBlock("A after ←/→", redrawn, "A", block, WAITING);
    ok("A: the redraw shows the same block, stamp and receipt as the live screen", JSON.stringify(redrawn.slice(replyEnd("A")(redrawn) - 3, at2 + block.length + 1)) === JSON.stringify(live), shown(redrawn.slice(-12)));
    await quit();
  }

  // B. a multi-line paste (a blank line inside) + words typed after it, a DM, Enter.
  {
    await startChat();
    paste("alpha pasted line\n\nbeta pasted line\ngamma pasted line");
    await waitFor(has(/\[1 pasted\]>/));
    type("my words after the paste");
    const before = await waitFor(has(/my words after the paste$/));
    ok("B: the paste's prompt shows its `[1 pasted]` badge, the words right after the placeholder", before.includes("you → echoer [1 pasted]> [Pasted text #1] my words after the paste"), shown(before.slice(-4)));
    await says("B");
    const { wire, lines } = await send();
    ok("B: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["[Pasted text #1] my words after the paste\n\n--- [Pasted text #1] (4 lines) ---\nalpha pasted line\n\nbeta pasted line\ngamma pasted line\n--- end [Pasted text #1] ---"]), JSON.stringify(wire));
    sentBlock("B", lines, "B", ["you → echoer [1 pasted]> [Pasted text #1] my words after the paste", rail("📋 [Pasted text #1] 4 lines, 53 B"), rail("  alpha pasted line"), rail(""), rail("  beta pasted line"), rail("  gamma pasted line")], WAITING);
    await quit();
  }

  // C. the operator's screenshot: `\` lines, a paste inside line 3, a DM, the agent mid-turn, Enter.
  {
    await startChat();
    await hold("1. corrcet");
    await hold("2. looks good");
    type("3. okay but we dont link them for now ");
    await sleep(200);
    paste("pasted row one\npasted row two\npasted row three");
    await waitFor(has(/\[Pasted text #1\] $|\[Pasted text #1\]$/));
    await hold("");
    type("4. and this is the las");
    await sleep(300);
    const draft = [`${HEAD}1. corrcet`, rail("2. looks good"), rail("3. okay but we dont link them for now [Pasted text #1]"), rail("📋 [Pasted text #1] 3 lines, 46 B"), rail("  pasted row one"), rail("  pasted row two"), rail("  pasted row three")];
    draftUnder("C", await says("C"), "C", draft, "4. and this is the las");
    await echoer.setStatus("working");
    await sleep(800);
    type("t line");
    const { wire, lines } = await send(/^◌ queued — echoer is mid-turn$/);
    ok("C: ONE DM with the paste fenced, text unchanged", JSON.stringify(wire) === JSON.stringify(["1. corrcet\n2. looks good\n3. okay but we dont link them for now [Pasted text #1] \n4. and this is the last line\n\n--- [Pasted text #1] (3 lines) ---\npasted row one\npasted row two\npasted row three\n--- end [Pasted text #1] ---"]), JSON.stringify(wire));
    sentBlock("C", lines, "C", [...draft, rail("4. and this is the last line")], /^◌ queued — echoer is mid-turn$/);
    await echoer.setStatus("idle");
    await quit();
  }

  // D. control: one line, no continuation — the path that was always right.
  {
    await startChat();
    type("just one line partial");
    await sleep(300);
    const mid = await says("D");
    ok("D: a one-line input is reprinted under the message", mid.indexOf(`${HEAD}just one line partial`) > replyEnd("D")(mid), shown(mid.slice(-4)));
    type("ly typed");
    const { wire, lines } = await send();
    ok("D: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["just one line partially typed"]), JSON.stringify(wire));
    sentBlock("D", lines, "D", [`${HEAD}just one line partially typed`], WAITING);
    await quit();
  }

  // E. a 25-line draft (row 12 wraps) in a 40-row pane, a DM, Enter, ←/→.
  const long = " — and this one is long enough to wrap past the 120-column terminal width, so its rows wrap on the rail like a real paragraph does";
  const eRows = (n: number) => Array.from({ length: n }, (_, i) => `e-row ${String(i + 1).padStart(2, "0")}${i === 11 ? long : ""}`);
  const eWire = [...eRows(24), "e-last partial end"].join("\n");
  const eBlock = (last: string) => [
    `${HEAD}e-row 01`,
    ...eRows(24)
      .slice(1)
      .flatMap((r) => (r.includes(long) ? [rail("e-row 12 — and this one is long enough to wrap past the 120-column terminal width, so its rows wrap on the rail like"), rail("a real paragraph does")] : [rail(r)])),
    ...(last ? [rail(last)] : []),
  ];
  {
    await startChat();
    for (const r of eRows(24)) await hold(r);
    type("e-last partial");
    await sleep(400);
    draftUnder("E", await says("E"), "E", eBlock(""), "e-last partial");
    type(" end");
    const { wire, lines } = await send();
    ok("E: ONE DM, all 25 lines, text unchanged", JSON.stringify(wire) === JSON.stringify([eWire]), JSON.stringify(wire).slice(0, 200));
    sentBlock("E", lines, "E", eBlock("e-last partial end"), WAITING);
    key("Right");
    await waitFor(has(/^messages /));
    key("Left");
    sentBlock("E after ←/→", await waitFor(has(/^chat /)), "E", eBlock("e-last partial end"), WAITING);
    await quit();
  }

  // E2. the same draft in a 20-row pane: taller than the screen, so the LIVE draft is capped.
  {
    await startChat(20);
    for (const r of eRows(24)) await hold(r);
    type("e-last partial");
    await sleep(400);
    const mid = await says("E");
    const count = mid.findIndex((l) => /^ {2}│ … \+\d+ more rows above$/.test(l));
    ok("E2: a draft taller than the screen shows its last rows under `… +N more rows above`", count > replyEnd("E")(mid) && mid[mid.length - 2] === rail("e-last partial") && mid[count + 1]?.startsWith(RAIL) === true, shown(mid.slice(-20)));
    ok("E2: …the hidden rows are nowhere on screen or in the scrollback, the shown ones once", !mid.some((l) => l.includes("e-row 01")) && once(mid, mid.slice(count + 1, -2)), shown(mid.slice(-20)));
    type(" end");
    const { wire, lines } = await send();
    ok("E2: the WHOLE message is sent, text unchanged", JSON.stringify(wire) === JSON.stringify([eWire]), JSON.stringify(wire).slice(0, 200));
    sentBlock("E2", lines, "E", eBlock("e-last partial end"), WAITING);
    await quit();
  }

  // F. ⌫ on the empty rail after a DM takes the last line back — in place, no redraw.
  {
    await startChat();
    await hold("f-one");
    await hold("f-two");
    const mid = await says("F");
    draftUnder("F", mid, "F", [`${HEAD}f-one`, rail("f-two")], "");
    key("BSpace");
    const back = await waitFor((l) => l[l.length - 2] === rail("f-two"));
    draftUnder("F after ⌫", back, "F", [`${HEAD}f-one`], "f-two");
    const top = replyEnd("F")(mid);
    ok("F: …taken back in place: everything above the draft is untouched (no redraw)", JSON.stringify(back.slice(0, top + 1)) === JSON.stringify(mid.slice(0, top + 1)), shown(back.slice(0, 8)));
    const { wire, lines } = await send();
    ok("F: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["f-one\nf-two"]), JSON.stringify(wire));
    sentBlock("F", lines, "F", [`${HEAD}f-one`, rail("f-two")], WAITING);
    await quit();
  }

  // G. the continuation KEYS instead of `\`: alt+enter (ESC CR) and shift+enter (CSI 13;2u).
  {
    await startChat();
    type("g-one via alt+enter");
    type("\x1b\r");
    await waitFor(has(/^ {2}│$/));
    type("g-two via shift+enter");
    type("\x1b[13;2u");
    await sleep(300);
    type("g-three partial");
    await sleep(300);
    draftUnder("G", await says("G"), "G", [`${HEAD}g-one via alt+enter`, rail("g-two via shift+enter")], "g-three partial");
    type(" end");
    const { wire, lines } = await send();
    ok("G: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["g-one via alt+enter\ng-two via shift+enter\ng-three partial end"]), JSON.stringify(wire));
    sentBlock("G", lines, "G", [`${HEAD}g-one via alt+enter`, rail("g-two via shift+enter"), rail("g-three partial end")], WAITING);
    await quit();
  }

  // H. a paste on an EMPTY prompt: the badge prompt is ON SCREEN and the caret sits where the text ends.
  {
    await startChat();
    const PROMPT = "you → echoer [1 pasted]> [Pasted text #1] ";
    paste("h-alpha\nh-beta\nh-gamma");
    const after = await waitFor(has(/\[1 pasted\]> \[Pasted text #1\]$/));
    ok("H: right after the paste, the `[1 pasted]` badge is drawn (no DM needed to heal it)", after.includes(PROMPT.trimEnd()), shown(after.slice(-3)));
    ok("H: …and the caret sits right after the placeholder (no 11-column gap)", cursorX() === [...PROMPT].length, `x=${cursorX()}, the text ends at ${[...PROMPT].length}`);
    type("typed after");
    const typed = await waitFor(has(/typed after$/));
    ok("H: typing lands straight after it, the caret with it", typed.includes(`${PROMPT}typed after`) && cursorX() === [...`${PROMPT}typed after`].length, `${shown(typed.slice(-3))} x=${cursorX()}`);
    const { wire } = await send();
    ok("H: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["[Pasted text #1] typed after\n\n--- [Pasted text #1] (3 lines) ---\nh-alpha\nh-beta\nh-gamma\n--- end [Pasted text #1] ---"]), JSON.stringify(wire));
    await quit();
  }

  // I. a burst: three DMs land while a draft is open.
  {
    await startChat();
    await hold("i-one");
    await hold("i-two");
    type("i-thr");
    await sleep(300);
    await echoer.unicast(youId!, "burst one (end of I1)");
    await echoer.unicast(youId!, "burst two (end of I2)");
    await echoer.unicast(youId!, "burst three (end of I3)");
    const mid = await waitFor((l) => replyEnd("I3")(l) >= 0);
    await sleep(500);
    const after = screen();
    const order = [replyEnd("I1")(after), replyEnd("I2")(after), replyEnd("I3")(after)];
    ok("I: a burst of three DMs prints in order", order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]!)), shown(mid.slice(-14)));
    draftUnder("I", after, "I3", [`${HEAD}i-one`, rail("i-two")], "i-thr");
    type("ee");
    const { wire, lines } = await send();
    ok("I: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["i-one\ni-two\ni-three"]), JSON.stringify(wire));
    sentBlock("I", lines, "I3", [`${HEAD}i-one`, rail("i-two"), rail("i-three")], WAITING);
    await quit();
  }

  // J. Ctrl+U on the empty rail after a DM drops the whole draft — off the screen, nothing sent.
  {
    await startChat();
    await hold("u-one");
    await hold("u-two");
    const mid = await says("J");
    const sent = dms.length;
    key("C-u");
    const cleared = await waitFor(has(/✕ cleared the draft \(2 lines\)/));
    const end = replyEnd("J")(cleared);
    ok("J: Ctrl+U takes the draft off the screen; the note says so under the reply", !cleared.some((l) => /u-one|u-two/.test(l)) && cleared.findIndex((l) => /✕ cleared the draft/.test(l)) > end && cleared[cleared.length - 2] === "you → echoer>", shown(cleared.slice(-8)));
    ok("J: …in place: everything above the draft is untouched (no redraw)", JSON.stringify(cleared.slice(0, end + 1)) === JSON.stringify(mid.slice(0, replyEnd("J")(mid) + 1)), shown(cleared.slice(0, 8)));
    type("u-after");
    const { wire } = await send();
    ok("J: nothing of the dropped draft is sent; the next line goes alone", dms.length === sent + 1 && JSON.stringify(wire) === JSON.stringify(["u-after"]), JSON.stringify(wire));
    await quit();
  }

  // K. ←/→ mid-draft: each view switch redraws the history, then the draft under it.
  {
    await startChat();
    await hold("k-one");
    await hold("k-two");
    const before = await says("K");
    // Mid-draft the hint row names the draft, not the view: a switch shows as the redraw itself.
    const redrawn = (from: string[]) => waitFor((l) => JSON.stringify(l) !== JSON.stringify(from), 3000).then(() => sleep(400)).then(screen);
    key("Right");
    const messages = await redrawn(before);
    draftUnder("K in the messages view", messages, "K", [`${HEAD}k-one`, rail("k-two")], "");
    key("Left");
    draftUnder("K back in chat", await redrawn(messages), "K", [`${HEAD}k-one`, rail("k-two")], "");
    type("k-three");
    const { wire, lines } = await send();
    ok("K: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["k-one\nk-two\nk-three"]), JSON.stringify(wire));
    sentBlock("K", lines, "K", [`${HEAD}k-one`, rail("k-two"), rail("k-three")], WAITING);
    await quit();
  }

  // M. the ↓ picker open mid-draft when a message lands: the reply goes above the draft, the picker is
  //    drawn back between the draft and the prompt, and closing it leaves no stale row behind.
  {
    await startChat();
    await hold("m-one");
    await hold("m-two");
    key("Down");
    await waitFor(has(/^agents \d+\/\d+$/));
    await echoer.unicast(youId!, REPLY("M"));
    const mid = await waitFor((l) => replyEnd("M")(l) >= 0 && /^↑↓ select/.test(l[l.length - 1] ?? ""));
    const at = blockAt(mid, [`${HEAD}m-one`, rail("m-two")]);
    const pick = mid.findIndex((l) => /^agents \d+\/\d+$/.test(l));
    ok("M: with the picker open, the message lands above the whole draft", replyEnd("M")(mid) >= 0 && at > replyEnd("M")(mid), shown(mid.slice(-12)));
    ok("M: …the picker is drawn back right under the draft, the prompt under it, the hint last", pick === at + 2 && mid[mid.length - 2] === rail("@") && mid.filter((l) => /^agents \d+\/\d+$/.test(l)).length === 1 && once(mid, [`${HEAD}m-one`, rail("m-two")]), shown(mid.slice(-12)));
    key("Escape");
    const closed = await waitFor((l) => !l.some((r) => /^agents \d+\/\d+$/.test(r)));
    ok("M: Esc closes it with no stale row: the draft, then the prompt", !closed.some((r) => /^agents |echoer ● online$|^ {2}▸ /.test(r)) && blockAt(closed, [`${HEAD}m-one`, rail("m-two"), rail("@")]) === closed.length - 4, shown(closed.slice(-8)));
    key("BSpace");
    type("m-three");
    const { wire, lines } = await send();
    ok("M: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["m-one\nm-two\nm-three"]), JSON.stringify(wire));
    sentBlock("M", lines, "M", [`${HEAD}m-one`, rail("m-two"), rail("m-three")], WAITING);
    await quit();
  }

  // L. the terminal is resized mid-draft: the draft is laid out again at the new width (a redraw), and
  //    a message after that still lands above the whole draft.
  {
    await startChat();
    await hold("l-one");
    await hold("l-two");
    type("l-thr");
    await sleep(300);
    tmux("resize-window", "-t", T, "-x", "90");
    await sleep(800);
    ok("L: the terminal really is 90 columns now", tmux("display-message", "-p", "-t", T, "#{pane_width}").trim() === "90");
    draftUnder("L after a resize", await says("L"), "L", [`${HEAD}l-one`, rail("l-two")], "l-thr");
    type("ee");
    const { wire, lines } = await send();
    ok("L: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["l-one\nl-two\nl-three"]), JSON.stringify(wire));
    sentBlock("L", lines, "L", [`${HEAD}l-one`, rail("l-two"), rail("l-three")], WAITING);
    await quit();
  }

  // N. lines EXACTLY the width (60 columns): readline writes a space to give the caret a row of its own,
  //    so its echo is one row taller than the text — an erase one row short left a `…A\` copy above
  //    every row and split the draft around a reply (S12/S22/S24).
  {
    await startChat(20, { cols: 60 });
    const a = "x".repeat(44) + "A"; // `you → echoer> ` (14) + 45 + `\` = 60
    const b = "y".repeat(54) + "B"; // the rail (4) + 55 + `\` = 60
    const z = "z".repeat(55) + "C"; // the rail (4) + 56 = 60
    await hold(a);
    await hold(b);
    const held = await waitFor((l) => l[l.length - 2] === RAIL.trimEnd());
    ok("N: an exact-width `\\` line is held once — no copy of it (or of its `\\`) left above", held.filter((l) => l.startsWith(`${HEAD}x`)).length === 1 && !held.some((l) => /\\$/.test(l)), shown(held.slice(-8)));
    const mid = await says("N");
    ok("N: the reply lands above the whole draft, its head row once (no stale copy above the reply)", replyEnd("N")(mid) >= 0 && blockAt(mid, [`${HEAD}${a}`, rail(b)]) > replyEnd("N")(mid) && mid.filter((l) => l.startsWith(`${HEAD}x`)).length === 1 && once(mid, [`${HEAD}${a}`, rail(b)]), shown(mid.slice(-12)));
    type(z);
    await sleep(300);
    const { wire, lines } = await send();
    ok("N: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify([`${a}\n${b}\n${z}`]), JSON.stringify(wire));
    sentBlock("N", lines, "N", [`${HEAD}${a}`, rail(b), rail(z)], WAITING);
    // An exact-width last line right under a receipt (no blank above it to stamp, S24).
    await hold("n-under-receipt");
    type(z);
    await sleep(300);
    const after = (await send(/^you → echoer> ?$/)).lines;
    ok("N: …and under a receipt, the sent draft's head row shows once", after.filter((l) => l === `${HEAD}n-under-receipt`).length === 1 && blockAt(after, [`${HEAD}n-under-receipt`, rail(z)]) >= 0, shown(after.slice(-6)));
    // A single exact-width line after a reply: its time goes on the blank row ABOVE readline's echo,
    // never over the end of the line (the echo's caret row counts).
    await says("N2");
    const one = "w".repeat(45) + "D"; // 14 + 46 = 60
    type(one);
    await sleep(300);
    const single = (await send()).lines;
    const at = single.indexOf(`${HEAD}${one}`);
    ok("N: a single exact-width line keeps its text whole, its time on the row above", at > 0 && STAMP.test(single[at - 1]!), shown(single.slice(-6)));
    await quit();
  }

  // O. a head row of wide glyphs: 14 + `a` + 52×界 + `b` takes THREE rows at 60 columns — a 界 that would
  //    start in the last column wraps whole (S25). Counted as two, a fragment stayed above the reply.
  {
    await startChat(20, { cols: 60 });
    const cjk = `a${"界".repeat(52)}b`;
    await hold(cjk);
    await hold("o-two");
    type("o-thr");
    await sleep(300);
    const mid = await says("O");
    const head = (l: string) => l.startsWith(`${HEAD}a界`);
    ok("O: the wide head row shows once, below the reply", mid.filter(head).length === 1 && mid.findIndex(head) > replyEnd("O")(mid), shown(mid.slice(-10)));
    type("ee");
    const { wire, lines } = await send();
    ok("O: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify([`${cjk}\no-two\no-three`]), JSON.stringify(wire));
    const top = lines.findIndex(head);
    ok("O: …sent as one block, the stamp above it, nothing of it above the reply", lines.filter(head).length === 1 && top > replyEnd("O")(lines) && STAMP.test(lines[top - 1]!) && lines[top + 3] === rail("o-two") && lines[top + 4] === rail("o-three") && WAITING.test(lines[top + 5] ?? ""), shown(lines.slice(-10)));
    await quit();
  }

  // P. `/quit` typed on the draft's rail quits: the draft is printed once as unsent, nothing is sent.
  {
    await startChat();
    await hold("p-one");
    await hold("p-two");
    const sent = dms.length;
    type("/quit");
    key("Enter");
    const out = await waitFor(has(/^\[chat exited/));
    await sleep(500);
    const at = out.indexOf("✎ your unsent draft:");
    ok("P: `/quit` on the rail quits chat", has(/^\[chat exited 0\]/)(out), shown(out.slice(-8)));
    ok("P: …nothing is sent", dms.length === sent, JSON.stringify(dms.slice(sent)));
    ok("P: …the draft is printed once, as unsent, and is nowhere else", at >= 0 && out[at + 1] === "p-one" && out[at + 2] === "p-two" && !out.some((l) => l === `${HEAD}p-one` || l === rail("p-two") || l === rail("/quit")), shown(out.slice(-8)));
  }

  // Q. the picker in a SHORT pane: it takes the rows it draws (count + 3 agents here), not a 15-row
  //    reservation — the 2-line draft stays whole with it open and after it closes (S9). Then the
  //    reviewer's P: a draft that fills the pane — the picker opening caps it, closing gives the rows back,
  //    and a reply after that still lands above all of it.
  {
    await startChat(20, { cols: 60 });
    key("Down");
    const plain = await waitFor(has(/^agents \d+\/\d+$/));
    const top = plain.findIndex((l) => /^agents \d+\/\d+$/.test(l));
    ok("Q: the picker's rows carry nothing of the hint row they are drawn over", top >= 0 && !plain.slice(top, -2).some((l) => /logs|mesh test-/.test(l)), shown(plain.slice(top)));
    key("Escape");
    await waitFor((l) => !l.some((r) => /^agents \d+\/\d+$/.test(r)));
    key("BSpace");
    await sleep(300);
    await hold("q-one");
    await hold("q-two");
    key("Down");
    await waitFor(has(/^agents \d+\/\d+$/));
    await echoer.unicast(youId!, REPLY("Q"));
    const mid = await waitFor((l) => replyEnd("Q")(l) >= 0 && /^↑↓ select/.test(l[l.length - 1] ?? ""));
    const pick = mid.findIndex((l) => /^agents \d+\/\d+$/.test(l));
    ok("Q: picker open in a 20-row pane: the 2-line draft stays whole, the reply above it", !mid.some((l) => /more rows above/.test(l)) && blockAt(mid, [`${HEAD}q-one`, rail("q-two")]) === pick - 2 && pick > replyEnd("Q")(mid), shown(mid.slice(-10)));
    key("Escape");
    const closed = await waitFor((l) => !l.some((r) => /^agents \d+\/\d+$/.test(r)));
    ok("Q: …closing it leaves the whole draft", blockAt(closed, [`${HEAD}q-one`, rail("q-two"), rail("@")]) === closed.length - 4 && !closed.some((l) => /more rows above/.test(l)), shown(closed.slice(-6)));
    await quit();
    await startChat(16);
    for (let i = 1; i <= 11; i++) await hold(`q${i}`);
    key("Down");
    const open = await waitFor(has(/^agents \d+\/\d+$/));
    ok("Q: a picker opened over a draft that fills the pane caps the draft (no scrolled-away top)", open.some((l) => /^ {2}│ … \+\d+ more rows above$/.test(l)) && !open.includes(`${HEAD}q1`), shown(open.slice(-14)));
    key("Escape");
    await waitFor((l) => !l.some((r) => /^agents \d+\/\d+$/.test(r)));
    await sleep(500);
    await echoer.unicast(youId!, REPLY("Q2"));
    const after = await waitFor((l) => replyEnd("Q2")(l) >= 0);
    await sleep(500);
    const q2 = screen();
    ok("Q: …closed again and a reply lands: above the whole draft, its head row once", q2.filter((l) => l === `${HEAD}q1`).length === 1 && q2.indexOf(`${HEAD}q1`) > replyEnd("Q2")(q2) && blockAt(q2, [`${HEAD}q1`, rail("q2")]) >= 0, shown(after.slice(-16)));
    await quit();
  }

  // R. Ctrl-C with the picker open over a draft: the area goes whole (the picker's erase ran before
  //    `closing` stood it down), the draft is printed once, without the picker's `@` (S17).
  {
    await startChat(30);
    await hold("r-one");
    await hold("r-two");
    key("Down");
    await waitFor(has(/^agents \d+\/\d+$/));
    key("C-c");
    const out = await waitFor(has(/^\[chat exited/));
    await sleep(300);
    const at = out.indexOf("✎ your unsent draft:");
    ok("R: Ctrl-C with the picker open: no picker or draft rows left on screen", !out.some((l) => /^agents \d+\/\d+$|^ {2}▸ |r-one$|r-two$/.test(l) && l !== "r-one" && l !== "r-two"), shown(out.slice(-10)));
    ok("R: …the draft printed once, its lines only (no `@`)", at >= 0 && out[at + 1] === "r-one" && out[at + 2] === "r-two" && out[at + 3] !== "@", shown(out.slice(-6)));
  }

  // S. Ctrl+L mid-draft, then a reply: readline's clear copies the screen into tmux's scrollback
  //    (scroll-on-clear) — the draft is taken off first and never starts on the home row after, so no
  //    copy of it is left anywhere above the reply (S26).
  {
    await startChat(30);
    await says("S");
    await hold("s-one");
    await hold("s-two");
    type("s-thr");
    await sleep(300);
    key("C-l");
    await sleep(800);
    const mid = await says("S2");
    const draft = [`${HEAD}s-one`, rail("s-two")];
    ok("S: after Ctrl+L and a reply, the draft shows once, below the reply", once(mid, draft) && blockAt(mid, draft) > replyEnd("S2")(mid) && mid.filter((l) => l === rail("s-thr")).length === 1, shown(mid.slice(-16)));
    type("ee");
    const { wire, lines } = await send();
    ok("S: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["s-one\ns-two\ns-three"]), JSON.stringify(wire));
    sentBlock("S", lines, "S2", [...draft, rail("s-three")], WAITING);
    await quit();
  }

  // T. a draft begun before chat connected: its first line was typed at `you → echoer ◌>`. Once the
  //    phase moves on, the head row reads `you → echoer>` — live and in the block it becomes (S10).
  {
    let early: string[] = [];
    for (let attempt = 1; attempt <= 3 && !has(/◌> t-one$/)(early); attempt++) {
      if (attempt > 1) await quit();
      await startChat(30, { booting: true });
      type("t-one\\");
      key("Enter");
      early = await waitFor(has(/◌> t-one$/), 2000, 10);
    }
    ok("T: (setup) the first line was held while chat was still connecting (3 tries)", has(/◌> t-one$/)(early), shown(early.slice(-4)));
    const settled = await waitFor((l) => l.includes(`${HEAD}t-one`), 30_000);
    ok("T: once connected, the draft's head reads after the settled prompt", settled.includes(`${HEAD}t-one`) && !settled.some((l) => /◌> t-one/.test(l)), shown(settled.slice(-4)));
    while (!youId) await sleep(100);
    await sleep(1000);
    type("t-two");
    const { wire, lines } = await send();
    ok("T: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["t-one\nt-two"]), JSON.stringify(wire));
    ok("T: …and the sent block's head has no `◌` either", blockAt(lines, [`${HEAD}t-one`, rail("t-two")]) >= 0 && !lines.some((l) => /◌> t-one/.test(l)), shown(lines.slice(-6)));
    await quit();
  }

  // U. TERM=dumb: readline's prompt() keeps no row count there (it draws no refresh at all, so the
  //    prompt row itself reads rough) — chat starts and connects all the same.
  {
    await startChat(30, { env: ["TERM=dumb"], booting: true });
    const up = await waitFor((l) => /echoer ● online/.test(l[l.length - 1] ?? "") || has(/prevRows is gone|^\[chat exited/)(l), 30_000);
    await sleep(1000);
    const later = screen();
    ok("U: TERM=dumb — chat connects, no readline hook error, still running", /echoer ● online/.test(up[up.length - 1] ?? "") && !later.some((l) => /prevRows is gone|^\[chat exited/.test(l)), shown(later.slice(-4)));
    await quit();
  }

  // V. a long line typed under a draft at its cap (60×20): each row it wraps onto is taken from the
  //    draft's room as it comes — the area never outgrows the screen, so a reply after it is placed in
  //    place, not by a redraw that wipes the scrollback (S7).
  {
    await startChat(20, { cols: 60 });
    for (let i = 1; i <= 20; i++) await hold(`v${String(i).padStart(2, "0")}`);
    const long = "v-last is a line long enough to wrap onto three rows of a sixty column pane, typed a bit at a time like a person does";
    for (let i = 0; i < long.length; i += 8) {
      type(long.slice(i, i + 8));
      await sleep(40);
    }
    await sleep(500);
    const mid = await says("V");
    ok("V: a reply after the long line lands above the capped draft, in place (the scrollback is kept)", preShellKept(mid) && mid.findIndex((l) => /^ {2}│ … \+\d+ more rows above$/.test(l)) > replyEnd("V")(mid), shown(mid.slice(-20)));
    const { wire, lines } = await send();
    ok("V: ONE DM, all 21 lines, text unchanged", JSON.stringify(wire) === JSON.stringify([[...Array.from({ length: 20 }, (_, i) => `v${String(i + 1).padStart(2, "0")}`), long].join("\n")]), JSON.stringify(wire).slice(0, 200));
    ok("V: …sent whole, still without a redraw", preShellKept(lines) && blockAt(lines, [`${HEAD}v01`, rail("v02")]) > replyEnd("V")(lines), shown(lines.slice(-8)));
    await quit();
  }

  // W. the reviewer's case: 470 characters land in ONE chunk under a draft at its cap (120×16), so the
  //    area outgrows the screen before anything can re-cap it and the draft's top scrolls away; Ctrl+U
  //    shrinks it back. The area's top can't be found by counting any more — a reply then redraws
  //    instead of erasing from the wrong row: above the whole draft, its head row once.
  {
    await startChat(16);
    for (let i = 1; i <= 12; i++) await hold(`w${i}`);
    type("z".repeat(470));
    await sleep(800);
    key("C-u");
    await sleep(800);
    await echoer.unicast(youId!, REPLY("W"));
    await waitFor((l) => replyEnd("W")(l) >= 0);
    await sleep(500);
    const lines = screen();
    ok("W: after the area outgrew the screen, a reply lands above the whole draft, its head row once", lines.filter((l) => l === `${HEAD}w1`).length === 1 && lines.indexOf(`${HEAD}w1`) > replyEnd("W")(lines) && blockAt(lines, [`${HEAD}w1`, rail("w2")]) >= 0, shown(lines.slice(-18)));
    await quit();
  }
}

let torn = false;
async function teardown(): Promise<void> {
  if (torn) return;
  torn = true;
  try {
    tmux("kill-server");
  } catch {} // no server left to kill
  rmSync(SOCK_PATH, { force: true });
  ok("teardown: the private tmux socket is gone", !existsSync(SOCK_PATH));
  await echoer?.stop().catch((e: Error) => console.error("echoer stop:", e.message));
  try {
    execFileSync(process.execPath, [join(REPO, "bin/paw.mjs"), "down"], { env: process.env, stdio: "inherit", timeout: 60_000 });
  } catch (e) {
    console.error(`paw down failed: ${(e as Error).message} — stopping directly`);
    await stop({ space }).catch((e2: Error) => console.error("teardown stop:", e2.message));
  }
  if (server)
    await purgeTestSpace(space!, server).catch((e: Error) => {
      console.error("teardown purge:", e.message);
      process.exitCode = 1;
    });
  rmSync(join(home!, "spaces", space!), { recursive: true, force: true });
}
process.on("SIGINT", () => void teardown().finally(() => process.exit(130)));
process.on("SIGTERM", () => void teardown().finally(() => process.exit(143)));

try {
  await main();
} catch (e) {
  ok("the run itself", false, (e as Error).stack ?? String(e));
} finally {
  await teardown();
}

if (failures.length) {
  console.error(`\n${failures.length} chat draft check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\na draft stays one block, whatever arrives while you write it 🐾");
process.exit(0);

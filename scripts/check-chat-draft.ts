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
 * Round 3 (the same two on the round-2 fix):
 *   X. a 450-character line pasted on the rail;  Y. a paste crossing a row edge, and a 900-character one
 *   collapsed on the rail;  Z. a 300-character URL pasted with no draft (its time stamp);  AA. `@` + Tab Tab
 *   mid-draft;  AB. Enter in the ↓ picker over a draft;  AC. `/exit` with a staged paste (its text printed);
 *   AD. Ctrl-C inside the resize debounce;  AE. Enter on the empty rail;  AF. `!` on the rail;  AG. tabs
 *   in a full-width `\` line;  AH. a second send while the agent is mid-turn (live receipt == redraw).
 * Round 4 (the same two on the round-3 fix):
 *   AI. a multi-line draft refused (its target lost) comes back whole;  AJ. the banner repainted on the
 *   home row (a fresh pane) over a draft, and `--all` booting: nothing copied into the scrollback;
 *   AK. a sent block redrawn after a resize;  AL. a draft of blank lines sent, then a reply;
 *   AM. piped chat: no cursor control;  AN. picker + mention + text + Enter in one chunk;
 *   AO. a filter naming an agent exactly;  AP. a `❤️` line filling the row;  AQ. Enter in the picker
 *   under a blank row (its time).  M and Q: Esc in the picker takes its `@` with it.
 * Every wire DM is asserted byte for byte (check:chat-tty 13 pins the same format).
 * Teardown always runs: tmux kill-server, echoer stop, `paw down`, purgeTestSpace, the space dir.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { controlCreds } from "../src/addressing.ts";
import { draftRows } from "../src/compose-view.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { makeBlock, type PasteBlock } from "../src/paste.ts";
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
const run = promisify(execFile);
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

/**
 * `paw chat echoer` in a fresh pane (the banner on its home row); `booting` returns as soon as the
 * pre-shell prompt shows (`◌`). `args` chats with something else, returning as soon as a row matches
 * `ready` (polled tight). `mark` prints PANE_START before chat starts: in the scrollback until a redraw.
 */
async function startChat(rows = 40, opts: { cols?: number; env?: string[]; booting?: boolean; mark?: boolean; args?: string; ready?: RegExp } = {}): Promise<void> {
  try {
    tmux("kill-session", "-t", T);
  } catch {} // the first scenario has none
  const env = ["PAW_HOME", "PAW_SPACE", "PAW_RELEASE", "PAW_BEADS_DIR"].flatMap((k) => ["-e", `${k}=${process.env[k]}`]);
  const cmd = `${opts.mark ? `echo ${PANE_START}; ` : ""}${opts.env?.length ? `env ${opts.env.join(" ")} ` : ""}${process.execPath} ${join(REPO, "bin/paw.mjs")} chat ${opts.args ?? "echoer --history 0"}; echo "[chat exited $?]"; sleep 600`;
  tmux("new-session", "-d", "-s", T, "-x", String(opts.cols ?? COLS), "-y", String(rows), "-c", home!, ...env, cmd);
  tmux("set-option", "-t", T, "history-limit", "5000");
  if (opts.args !== undefined) {
    if (!opts.ready) throw new Error("startChat: `args` needs `ready` — what shows once that chat is up");
    const up = await waitFor(has(opts.ready), 30_000, 10);
    if (!has(opts.ready)(up)) throw new Error(`chat ${opts.args} never showed ${opts.ready}:\n${shown(up)}`);
    return;
  }
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
/** Printed in the pane before chat (startChat `mark`): it stays in the scrollback unless a redraw cleared it. */
const PANE_START = "pane-start";
const scrollbackKept = (lines: string[]): boolean => lines.includes(PANE_START);
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
  //    drawn back between the draft and the prompt, and closing it leaves no stale row behind — nor its
  //    `@` in the line (it stayed, and went out as the start of the message's last line).
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
    ok("M: Esc closes it with no stale row: the draft, then the empty rail (the `@` gone with the picker)", !closed.some((r) => /^agents |echoer ● online$|^ {2}▸ /.test(r)) && blockAt(closed, [`${HEAD}m-one`, rail("m-two"), rail("")]) === closed.length - 4, shown(closed.slice(-8)));
    await sleep(700); // readline holds a lone Esc 500ms before it is a key of its own: typed sooner, it is alt+key
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
    const gone = await waitFor((l) => !l.some((r) => /^agents \d+\/\d+$/.test(r)));
    ok("Q: Esc takes the picker's `@` with it — the line is as it was before ↓", gone[gone.length - 2] === "you → echoer>", shown(gone.slice(-4)));
    await sleep(700);
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
    ok("Q: …closing it leaves the whole draft", blockAt(closed, [`${HEAD}q-one`, rail("q-two"), rail("")]) === closed.length - 4 && !closed.some((l) => /more rows above/.test(l)), shown(closed.slice(-6)));
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
    await startChat(20, { cols: 60, mark: true });
    for (let i = 1; i <= 20; i++) await hold(`v${String(i).padStart(2, "0")}`);
    const long = "v-last is a line long enough to wrap onto three rows of a sixty column pane, typed a bit at a time like a person does";
    for (let i = 0; i < long.length; i += 8) {
      type(long.slice(i, i + 8));
      await sleep(40);
    }
    await sleep(500);
    const mid = await says("V");
    ok("V: a reply after the long line lands above the capped draft, in place (the scrollback is kept)", scrollbackKept(mid) && mid.findIndex((l) => /^ {2}│ … \+\d+ more rows above$/.test(l)) > replyEnd("V")(mid), shown(mid.slice(-20)));
    const { wire, lines } = await send();
    ok("V: ONE DM, all 21 lines, text unchanged", JSON.stringify(wire) === JSON.stringify([[...Array.from({ length: 20 }, (_, i) => `v${String(i + 1).padStart(2, "0")}`), long].join("\n")]), JSON.stringify(wire).slice(0, 200));
    ok("V: …sent whole, still without a redraw", scrollbackKept(lines) && blockAt(lines, [`${HEAD}v01`, rail("v02")]) > replyEnd("V")(lines), shown(lines.slice(-8)));
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

  // ── round 3 (2026-11-18): a real-terminal tester + a reviewer on the round-2 fix ──────────────────────
  /** Rows of a sent draft, as the screen shows them (trailing blanks trimmed like screen()'s). */
  const sentRows = (lines: string[], blocks: PasteBlock[] = [], head = HEAD) => draftRows(head, lines, blocks, { width: COLS }).map((r) => r.replace(/\s+$/, ""));

  // X. a 450-character log line pasted on the rail (one line, under the collapse threshold: it stays
  //    typed text). readline wrote it raw, row after row, while its refresh still moved the cursor: the
  //    line showed twice, and the next reply landed between a stale copy of the draft and the repainted one.
  {
    await startChat();
    await hold("x-one");
    await hold("x-two");
    type("x the error was: ");
    const log = `Error: connect ECONNREFUSED 127.0.0.1:4222 at TCPConnectWrap.afterConnect ${Array.from({ length: 25 }, (_, i) => `stack-frame-${String(i).padStart(2, "0")} `).join("")}`;
    paste(log);
    const pasted = await waitFor(has(/ECONNREFUSED/));
    await sleep(500);
    const head = (l: string) => l === `${HEAD}x-one`;
    const drawn = (lines: string[]) => lines.filter(head).length === 1 && lines.filter((l) => l.includes("ECONNREFUSED")).length === 1 && blockAt(lines, [`${HEAD}x-one`, rail("x-two")]) >= 0 && (lines[blockAt(lines, [`${HEAD}x-one`, rail("x-two")]) + 2] ?? "").startsWith(`${RAIL}x the error was: Error: connect`);
    ok("X: a long line pasted on the rail is drawn once, right under the draft", drawn(screen()), shown(pasted.slice(-8)));
    const mid = await says("X");
    ok("X: …a reply after it lands above the whole draft, each row once", drawn(mid) && mid.findIndex(head) > replyEnd("X")(mid), shown(mid.slice(-12)));
    const { wire, lines } = await send();
    const last = `x the error was: ${log}`.trimEnd();
    ok("X: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify([`x-one\nx-two\n${last}`]), JSON.stringify(wire).slice(0, 200));
    sentBlock("X", lines, "X", sentRows(["x-one", "x-two", last]), WAITING);
    await quit();
  }

  // Y. a short paste that pushes typed text over a row edge (R7), then a 900-character one that collapses
  //    to its placeholder (X24D): each a split draft around the next reply before.
  {
    await startChat(30);
    await hold("y-one");
    type("t".repeat(100));
    await sleep(200);
    paste("short pasted words, forty characters ok");
    await waitFor(has(/forty characters ok$/));
    await sleep(400);
    const crossed = screen();
    ok("Y: a paste that pushes typed text over a row edge: the line shows once", crossed.filter((l) => l.includes("tttttttt")).length === 1 && crossed[crossed.length - 2] === "ds, forty characters ok", shown(crossed.slice(-6)));
    const mid = await says("Y");
    ok("Y: a paste crossing a row edge: the reply lands above the whole draft, each row once", mid.filter((l) => l === `${HEAD}y-one`).length === 1 && mid.indexOf(`${HEAD}y-one`) > replyEnd("Y")(mid) && mid.filter((l) => l.includes("tttttttt")).length === 1 && mid[mid.indexOf(`${HEAD}y-one`) + 1]?.startsWith(`${RAIL}tttt`) === true, shown(mid.slice(-8)));
    key("C-u");
    await sleep(300);
    type("y-two + ");
    const big = Array.from({ length: 75 }, (_, i) => `m${String(i).padStart(3, "0")}-pasted`).join(" "); // 899 characters, one line
    const raw = (l: string) => /^m\d{3}-pasted/.test(l);
    paste(big);
    await waitFor(has(/\[Pasted text #1\] ?$/));
    await sleep(400);
    const staged = await says("Y2");
    ok("Y: a 900-character paste collapsed on the rail: no raw copy of it anywhere, the draft once under the reply", !staged.some(raw) && staged.filter((l) => l === `${HEAD}y-one`).length === 1 && staged.indexOf(`${HEAD}y-one`) > replyEnd("Y2")(staged) && staged[staged.length - 2] === rail("y-two + [Pasted text #1]"), shown(staged.slice(-8)));
    const { wire, lines } = await send();
    ok("Y: ONE DM, the paste fenced, text unchanged", JSON.stringify(wire) === JSON.stringify([`y-one\ny-two + [Pasted text #1]\n\n--- [Pasted text #1] (1 line) ---\n${big}\n--- end [Pasted text #1] ---`]), JSON.stringify(wire).slice(0, 200));
    sentBlock("Y", lines, "Y2", sentRows(["y-one", "y-two + [Pasted text #1]"], [makeBlock(1, big)]), WAITING);
    ok("Y: …and still no raw copy of the paste", !lines.some(raw), shown(lines.slice(-14)));
    await quit();
  }

  // Z. a 300-character URL pasted on an empty prompt (no draft, X27A): readline's raw echo left a partial
  //    copy, and the time stamp was drawn over its last row.
  {
    await startChat(30);
    await says("Z");
    type("see ");
    const url = `https://example.com/${"a".repeat(280)}`;
    paste(url);
    await waitFor(has(/^aaaa+$/));
    await sleep(400);
    const live = screen();
    const first = (l: string) => l.startsWith(`${HEAD}see https://example.com/`);
    ok("Z: a long URL pasted on an empty prompt shows once", live.filter(first).length === 1 && live.filter((l) => /^a+$/.test(l)).length === 2, shown(live.slice(-6)));
    const { wire, lines } = await send();
    ok("Z: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify([`see ${url}`]), JSON.stringify(wire).slice(0, 120));
    const at = lines.findIndex(first);
    ok("Z: …once after Enter, its time on the blank row above, nothing drawn over its rows", lines.filter(first).length === 1 && STAMP.test(lines[at - 1] ?? "") && !lines.some((l) => /a\d\d:\d\d$/.test(l)) && WAITING.test(lines[at + 3] ?? ""), shown(lines.slice(-8)));
    await quit();
  }

  // AA. `@` + Tab Tab mid-draft (X1): readline printed its candidates under the prompt, inside the input
  //     area and over the hint row, where no erase counted them — the reply landed between two copies.
  {
    await startChat(30);
    await hold("aa-one");
    await hold("aa-two");
    type("@");
    await sleep(200);
    key("Tab");
    await sleep(250);
    key("Tab");
    const listed = await waitFor(has(/^@echoer {2}@/));
    await sleep(300);
    const row = screen().find((l) => /^@echoer {2}@/.test(l));
    const now = screen();
    ok("AA: a second Tab lists the candidates as a note ABOVE the draft, the row reading only them", row !== undefined && /^(@[\w-]+ {2})+@[\w-]+$/.test(row) && now.indexOf(row) < now.indexOf(`${HEAD}aa-one`) && blockAt(now, [`${HEAD}aa-one`, rail("aa-two"), rail("@")]) === now.length - 4, shown(listed.slice(-8)));
    const mid = await says("AA");
    ok("AA: …a reply after it lands above the whole draft, each row once", once(mid, [`${HEAD}aa-one`, rail("aa-two")]) && blockAt(mid, [`${HEAD}aa-one`, rail("aa-two"), rail("@")]) > replyEnd("AA")(mid), shown(mid.slice(-10)));
    key("BSpace");
    type("aa-three");
    const { wire, lines } = await send();
    ok("AA: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["aa-one\naa-two\naa-three"]), JSON.stringify(wire));
    sentBlock("AA", lines, "AA", [`${HEAD}aa-one`, rail("aa-two"), rail("aa-three")], WAITING);
    await quit();
  }

  // AB. Enter in the ↓ picker over a draft (X47): it sent the draft with the filter `@` as its last line.
  //     It picks the marked agent now, and the draft stays.
  {
    await startChat(24, { cols: 100 });
    await hold("ab-one");
    await hold("ab-two");
    key("Down");
    await waitFor(has(/^agents \d+\/\d+$/));
    type("echo");
    await waitFor(has(/^agents 1\/1$/));
    const sent = dms.length;
    key("Enter");
    await waitFor(has(/\(now messaging echoer\)/));
    await sleep(600);
    const s = screen();
    ok("AB: Enter in the picker over a draft picks the agent and sends nothing", dms.length === sent && s.findIndex((l) => /\(now messaging echoer\)/.test(l)) < s.indexOf(`${HEAD}ab-one`), `${JSON.stringify(dms.slice(sent))}\n${shown(s.slice(-8))}`);
    ok("AB: …the draft stays whole under the note, the filter and the list gone", blockAt(s, [`${HEAD}ab-one`, rail("ab-two"), RAIL.trimEnd()]) === s.length - 4 && !s.some((l) => /^agents \d|^ {2}│ @/.test(l)), shown(s.slice(-8)));
    type("ab-three");
    const { wire, lines } = await send();
    ok("AB: …Enter then sends the draft, no `@` in it", JSON.stringify(wire) === JSON.stringify(["ab-one\nab-two\nab-three"]), JSON.stringify(wire));
    // Right under a sys note there is no blank row to stamp (a single line there gets none either).
    const block = [`${HEAD}ab-one`, rail("ab-two"), rail("ab-three")];
    const at = blockAt(lines, block);
    ok("AB: …as ONE block, the receipt right under it", at >= 0 && once(lines, block) && WAITING.test(lines[at + block.length] ?? ""), shown(lines.slice(-8)));
    await quit();
  }

  // AC. `/exit` on the rail with a paste staged in the draft (X15): only the placeholder was printed.
  {
    await startChat(30);
    await hold("ac-one");
    type("ac-two ");
    paste("q1\nq2\nq3");
    await waitFor(has(/\[Pasted text #1\] ?$/));
    await hold("");
    type("ac-thr");
    type("\x1b\r");
    await waitFor((l) => draftLines(l) === 4);
    const sent = dms.length;
    type("/exit");
    key("Enter");
    const out = await waitFor(has(/^\[chat exited/));
    await sleep(400);
    const at = out.indexOf("✎ your unsent draft:");
    const want = ["ac-one", "ac-two [Pasted text #1]", "ac-thr", "", "--- [Pasted text #1] (3 lines) ---", "q1", "q2", "q3", "--- end [Pasted text #1] ---"];
    ok("AC: quitting with a staged paste prints the unsent draft with the paste's text, once", at >= 0 && JSON.stringify(out.slice(at + 1, at + 1 + want.length)) === JSON.stringify(want) && out.filter((l) => l === "q2").length === 1 && dms.length === sent, shown(out.slice(-14)));
  }

  // AD. Ctrl-C inside the 150ms resize debounce (X35): the draft painted at the old width can't be found
  //     by counting — it was left above the unsent copy.
  {
    await startChat(20, { cols: 60 });
    await hold("ad-one");
    await hold("ad-two is long enough to wrap differently at fifty columns wide");
    type("ad-thr");
    await sleep(300);
    tmux("resize-window", "-t", T, "-x", "50");
    key("C-c");
    const out = await waitFor(has(/^\[chat exited/));
    await sleep(300);
    ok("AD: Ctrl-C right after a resize: the draft shows once, as the unsent draft", out.filter((l) => l.includes("ad-one")).length === 1 && out[out.indexOf("✎ your unsent draft:") + 1] === "ad-one", shown(out.slice(-10)));
  }

  // AE. Enter on the EMPTY rail (X2): the sent block kept a `  │` row the message doesn't have.
  {
    await startChat(30);
    await hold("ae-one");
    await hold("ae-two");
    const { wire, lines } = await send();
    ok("AE: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify(["ae-one\nae-two"]), JSON.stringify(wire));
    sentBlock("AE (no empty rail row under it)", lines, undefined, [`${HEAD}ae-one`, rail("ae-two")], WAITING);
    await quit();
  }

  // AF. `!` typed on a draft's rail (R3): it switched to command mode, and Enter ran the whole draft as a
  //     shell script in the agent's folder. It is text of the message there.
  {
    await startChat(30);
    await hold("af-one");
    type("!");
    await sleep(300);
    type("echo af-two");
    await sleep(300);
    const mid = screen();
    ok("AF: `!` on the rail stays text — no command mode", mid[mid.length - 2] === rail("!echo af-two") && !mid.some((l) => /^\$ /.test(l)) && !/command mode/.test(mid[mid.length - 1] ?? ""), shown(mid.slice(-4)));
    const { wire } = await send();
    ok("AF: …sent as the message's last line, never run", JSON.stringify(wire) === JSON.stringify(["af-one\n!echo af-two"]), JSON.stringify(wire));
    await quit();
  }

  // AG. tabs: a `\` line of pasted `a<TAB>`s that is wider than the screen once they are expanded (R6) —
  //     counted as 0 columns, its echo was one row more than the erase took, a stale head row stayed.
  {
    await startChat(30);
    await hold("ag-one");
    paste("a\t".repeat(10));
    await sleep(300);
    type(`${"x".repeat(40)}\\`);
    key("Enter");
    const held = await waitFor((l) => draftLines(l) === 3);
    await sleep(300);
    ok("AG: a full-width `\\` line with tabs is held once — no stale head row", screen().filter((l) => l === `${HEAD}ag-one`).length === 1, shown(held.slice(-6)));
    const mid = await says("AG");
    ok("AG: …a reply lands above the whole draft, its head row once", mid.filter((l) => l === `${HEAD}ag-one`).length === 1 && mid.indexOf(`${HEAD}ag-one`) > replyEnd("AG")(mid), shown(mid.slice(-8)));
    await quit();
  }

  // AH. a second send while the agent is mid-turn (X41): the live receipt and the redrawn one disagreed —
  //     the redraw put the second message's `queued` state above that message.
  {
    await startChat(30);
    type("ah-first");
    await send();
    await echoer.setStatus("working");
    await waitFor(has(/^◌ echoer is on it$/));
    type("ah-second");
    const live = (await send(/^you → echoer> ah-second$/)).lines;
    const from = (l: string[]) => l.slice(l.indexOf(`${HEAD}ah-first`), l.indexOf(`${HEAD}ah-second`) + 1);
    key("Right");
    await waitFor(has(/^messages /));
    key("Left");
    const redrawn = await waitFor(has(/^chat /));
    ok("AH: the redraw shows the receipt the live screen shows between the two messages", from(live).length >= 3 && JSON.stringify(from(redrawn)) === JSON.stringify(from(live)), `${shown(from(live))}\n      ---\n${shown(from(redrawn))}`);
    await echoer.setStatus("idle");
    await quit();
  }

  // ── round 4 (2026-11-18): the same two on the round-3 fix ─────────────────────────────────────────────
  /** The `n` rows over the header (`echoer:`) of the reply tagged `tag`, the nearest last. */
  const aboveReply = (lines: string[], tag: string, n: number): string[] => {
    const first = lines.findIndex((l) => l.trim().startsWith(`${tag}: reply line one`));
    return first < 1 ? [] : lines.slice(Math.max(0, first - 1 - n), first - 1);
  };

  // AI. a multi-line draft to a target that can't be reached (a name registered nowhere): refused ONCE,
  //     and back in the input as the draft it was. It was typed back with its "\n" in it, which readline
  //     takes for Enter: `ai one` went again (refused again), the rest landed glued in the wrong order.
  {
    await startChat(30, { args: "ghostai --history 0", ready: /^you → ghostai ✕> ?$/ });
    await sleep(1500);
    const n = dms.length;
    type("ai one\\"); // not a key of the not-found chooser: it closes it and reaches the input
    key("Enter");
    await waitFor((l) => draftLines(l) === 2);
    type("ai two");
    key("Enter");
    await waitFor(has(/^✕ not sent to ghostai: /));
    await sleep(1000);
    const s = screen();
    ok("AI: a refused multi-line draft is refused once, nothing sent", s.filter((l) => /^✕ not sent to ghostai: /.test(l)).length === 1 && dms.length === n, shown(s.slice(-10)));
    ok("AI: …and comes back whole — its first line held, the last one in the input", JSON.stringify(s.slice(-3, -1)) === JSON.stringify(["you → ghostai ✕> ai one", rail("ai two")]), shown(s.slice(-6)));
    key("C-c");
    const out = await waitFor(has(/^\[chat exited/));
    await sleep(300);
    const at = out.indexOf("✎ your unsent draft:");
    ok("AI: …quitting prints it as typed", at >= 0 && out[at + 1] === "ai one" && out[at + 2] === "ai two", shown(out.slice(-6)));
  }

  // AJ. a fresh pane: the banner is on the HOME row. A draft typed while a name is still looked up, then
  //     the lookup settles and the banner is repainted where it stands — a clear-to-end from the home row
  //     is tmux's "whole screen" clear (scroll-on-clear), which copied the banner, the draft and the hint
  //     row into the scrollback. Without a draft too: `paw chat --all` left a stale prompt there on boot.
  {
    await startChat(40, { args: "ghostaj --history 0", ready: /^you → ghostaj ◌> ?$/ });
    type("aj one\\");
    key("Enter");
    type("aj two\\");
    key("Enter");
    type("aj typing");
    await waitFor(has(/^you → ghostaj ✕> aj one$/), 20_000);
    await sleep(1500);
    const s = screen();
    ok("AJ: the banner repainted over a draft: each draft row once, the scrollback included", ["aj one", "aj two", "aj typing"].every((t) => s.filter((l) => l.endsWith(t)).length === 1) && s.filter((l) => /🐾 paw chat/.test(l)).length === 1, `history ${tmux("display-message", "-p", "-t", T, "#{history_size}").trim()}\n${shown(s)}`);
    key("C-c");
    await waitFor(has(/^\[chat exited/));
    await startChat(40, { args: "--all --history 0", ready: /^you → #general> ?$/ });
    await sleep(3000);
    const all = screen();
    ok("AJ: `paw chat --all` boots with ONE prompt and ONE banner, the scrollback included", all.filter((l) => /^you → #general>/.test(l)).length === 1 && all.filter((l) => /🐾 paw chat/.test(l)).length === 1, shown(all));
    await quit();
  }

  // AK. a sent draft whose rail line wraps, then a resize and ←/→: the block is laid out again at the new
  //     width, as the live draft would be. It was kept laid out at the width it was sent at — redrawn
  //     narrower, its rows wrapped off the rail and words split.
  {
    await startChat(30);
    const words = `ak-two ${Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, "0")}`).join(" ")} end`;
    await hold("ak-one");
    type(words);
    const { wire } = await send();
    ok("AK: ONE DM, text unchanged", JSON.stringify(wire) === JSON.stringify([`ak-one\n${words}`]), JSON.stringify(wire));
    tmux("resize-window", "-t", T, "-x", "60");
    await sleep(800);
    key("Right");
    await waitFor(has(/^messages /));
    key("Left");
    const redrawn = await waitFor(has(/^chat /));
    const at60 = draftRows(HEAD, ["ak-one", words], [], { width: 60 }).map((r) => r.replace(/\s+$/, ""));
    ok("AK: redrawn at 60 columns, the sent block is laid out at 60 — every row on the rail, words whole", at60.length > 3 && at60.slice(1).every((r) => r.startsWith(RAIL)) && blockAt(redrawn, at60) >= 0, shown(redrawn.slice(-12)));
    await quit();
  }

  // AL. a draft of blank lines sent: nothing goes out and its area is erased whole — so the next reply is
  //     spaced as if it never was, its time on the blank row the last reply left. It took the "you" side
  //     as a typed line does: a new blank row, the time under the old one.
  {
    await startChat(30);
    await says("AL1");
    type("\\");
    key("Enter");
    await waitFor((l) => draftLines(l) === 2);
    type("   \\");
    key("Enter");
    await waitFor((l) => draftLines(l) === 3);
    const n = dms.length;
    key("Enter");
    await waitFor((l) => draftLines(l) === 1);
    await sleep(500);
    const s = await says("AL2");
    const above = aboveReply(s, "AL2", 2);
    ok("AL: an all-blank draft sends nothing", dms.length === n, JSON.stringify(dms.slice(n)));
    ok("AL: …and the next reply's time sits on the blank the last one left", above.length === 2 && above[0]!.endsWith("(end of AL1)") && STAMP.test(above[1]!), shown(s.slice(-10)));
    await quit();
  }

  // AM. chat piped (no terminal on either end): the draft goes as ONE DM and the output has no cursor
  //     control in it — every message was preceded by the input area's erase, terminal or not.
  {
    const n = dms.length;
    // Not a sync spawn: echoer's endpoint runs on this event loop.
    const { stdout: out } = await run("sh", ["-c", `(printf 'am one\\\\\\nam two\\n'; sleep 6) | ${process.execPath} ${join(REPO, "bin/paw.mjs")} chat echoer 2>&1`], { env: process.env, timeout: 60_000 });
    const end = Date.now() + 5000;
    while (Date.now() < end && dms.length === n) await sleep(100);
    await sleep(300);
    ok("AM: piped, ONE DM, text unchanged", JSON.stringify(dms.slice(n)) === JSON.stringify(["am one\nam two"]), `${JSON.stringify(dms.slice(n))}\n${out.slice(-400)}`);
    ok("AM: …and no cursor control in the output", !/\x1b(?:\[[0-9;]*[A-HJKSTfsu]|[78])/.test(out), JSON.stringify(out.slice(-400)));
  }

  // AN. the ↓ picker open, then the mention, a message and Enter in ONE chunk (a laggy link batches keys):
  //     Enter came before the picker re-filtered, and the line was swapped for the bare `@echoer` — the
  //     message dropped. Only a bare `@filter` is a pick; more than that is sent as typed.
  {
    await startChat(30);
    key("Down");
    await waitFor(has(/^agents \d+\/\d+$/));
    const n = dms.length;
    type("echoer an-hello-in-one-chunk\r");
    const end = Date.now() + 10_000;
    while (Date.now() < end && dms.length === n) await sleep(100);
    await sleep(500);
    ok("AN: the text after the mention is sent", JSON.stringify(dms.slice(n)) === JSON.stringify(["an-hello-in-one-chunk"]), JSON.stringify(dms.slice(n)));
    await quit();
  }

  // AO. a filter that names an agent exactly (`echo`, registered, offline) while a live one contains it
  //     (`echoer`, listed first): the exact one is marked first — Enter switched to `echoer`.
  {
    const personas = join(home!, "spaces", space!, "personas");
    mkdirSync(personas, { recursive: true });
    const echoPersona = join(personas, "echo.md");
    writeFileSync(echoPersona, `---\nname: echo\ncwd: ${join(home!, "no-such-folder-echo")}\n---\n`);
    try {
      await startChat(30);
      key("Down");
      await waitFor(has(/^agents \d+\/2$/));
      type("echo");
      await sleep(400);
      const listed = screen();
      const marked = listed.find((l) => /^ {2}▸ /.test(l)) ?? "";
      ok("AO: the filter `echo` marks `echo` first, not the live `echoer`", /^ {2}▸ echo /.test(marked) && listed.some((l) => /^agents 1\/2$/.test(l)), shown(listed.slice(-6)));
      key("Escape");
      await waitFor((l) => !l.some((r) => /^agents /.test(r)));
      await sleep(700);
      await quit();
    } finally {
      rmSync(echoPersona);
    }
  }

  // AP. a `\` line on the rail that ends with `❤️` exactly at the right edge (60 columns): two columns on
  //     screen, one to readline, which then writes no caret row. Counted with one, the hold erased a row
  //     too many — the blank row above the draft — and the next reply's time went over the last row of
  //     the reply before it. The hint row also wiped the line while it was typed.
  {
    await startChat(30, { cols: 60 });
    await says("AP1");
    await hold("ap-one");
    const heart = `${"y".repeat(53)}\u2764\ufe0f`;
    type(`${heart}\\`);
    await sleep(500);
    const typing = screen();
    ok("AP: the `❤️` line filling the row shows while it is typed", typing[typing.length - 2] === `${RAIL}${heart}\\`, shown(typing.slice(-4)));
    key("Enter");
    await waitFor((l) => draftLines(l) === 3);
    await sleep(300);
    const held = screen();
    const end = replyEnd("AP1")(held);
    ok("AP: …held: the blank row between the reply and the draft stays", end >= 0 && held[end + 1] === "" && held[end + 2] === `${HEAD}ap-one` && held[end + 3] === `${RAIL}${heart}`, shown(held.slice(-8)));
    const after = await says("AP2");
    const above = aboveReply(after, "AP2", 2);
    ok("AP: …and the next reply leaves the last one whole, its time on the blank", after.filter((l) => l.endsWith("(end of AP1)")).length === 1 && above[0]!.endsWith("(end of AP1)") && STAMP.test(above[1] ?? ""), shown(after.slice(-12)));
    await quit();
  }

  // AQ. Enter in the ↓ picker with no draft, under the blank row a reply left: the picker's rows stay above
  //     the line readline echoes, and its time was drawn over the last of them.
  {
    await startChat(30);
    await says("AQ");
    key("Down");
    await waitFor(has(/^agents \d+\/\d+$/));
    type("echoer");
    await waitFor(has(/^agents 1\/1$/));
    key("Enter");
    const s = await waitFor(has(/\(now messaging echoer\)/));
    await sleep(300);
    const at = s.lastIndexOf("you → echoer> @echoer");
    ok("AQ: no time drawn over the picker's last row, above the line", at > 0 && /^ {2}▸ echoer /.test(s[at - 1]!) && !/\d\d:\d\d$/.test(s[at - 1]!), shown(s.slice(-8)));
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

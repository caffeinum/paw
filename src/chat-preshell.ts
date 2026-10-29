/**
 * `paw chat`'s first frame, painted before any of paw's mesh code has loaded.
 *
 * Importing @cotal-ai/core and chat.ts's graph costs ~200ms before chat() can run; on a laggy link the
 * connect then costs seconds more. The operator's ask: "I want to be able to type right after it — the
 * UI should show instantly, with loaders". So bin/paw.ts loads THIS module first for `paw chat` on a
 * terminal: it lexes the target from argv (no validation — chat.ts does that), paints the banner and
 * prompt with loaders for everything unknown, and puts the tty in raw mode so keys typed now are held
 * by the kernel — not echoed by the line discipline, not lost — until chat's readline reads them.
 * chat.ts then adopts the frame (`takeFrame`): erases it and paints the real one in the same write.
 *
 * Known cost: Ctrl-C during those ~200ms does nothing (raw mode; no reader yet).
 *
 * CORE-FREE by contract: `check:chat` walks this module's import graph and fails on any @cotal-ai/*.
 */
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import * as readline from "node:readline";
import { renderBanner, paintedRows, type BannerState } from "./chat-banner.ts";
import { loading, LOADER } from "./chat-boot.ts";
import { readRemoteMesh } from "./remote-mesh.ts";
import { resolveSpace } from "./space.ts";

/** Flags of `paw chat` that take a value — their value is never the target. */
const VALUE_FLAGS = new Set(["--space", "--server", "--model", "--agent", "--provider", "--name", "--personality"]);

/** What the first frame can say from argv alone. Pure; `check:chat`. */
export function lexChatArgs(argv: string[], cwd: string): { space?: string; label?: string; mode: "agent" | "channel" | "all"; only: boolean } {
  let space: string | undefined;
  let positional: string | undefined;
  let all = false;
  let only = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--space") space = argv[i + 1];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a === "--all") all = true;
    else if (a === "--only") only = true;
    else if (!a.startsWith("-") && positional === undefined) positional = a;
  }
  if (all) return { ...(space ? { space } : {}), mode: "all", only };
  const raw = positional ?? ".";
  if (raw.startsWith("#")) return { ...(space ? { space } : {}), label: raw.slice(1), mode: "channel", only };
  const bare = raw.startsWith("@") ? raw.slice(1) : raw;
  return { ...(space ? { space } : {}), label: bare === "." ? basename(cwd) : bare, mode: "agent", only: only || raw.startsWith("@") };
}

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), cyan: wrap("36"), green: wrap("32"), yellow: wrap("33"), red: wrap("31") };

export interface Frame {
  /** Rows the banner took (the prompt row is the one below them). */
  rows: number;
  /** Take the frame off the screen: cursor to the banner's first row, cleared down. */
  erase(): void;
}

let frame: Frame | undefined;

/** The frame the pre-shell painted, once (chat.ts adopts it); undefined when there was none. */
export function takeFrame(): Frame | undefined {
  const f = frame;
  frame = undefined;
  return f;
}

/** Paint the skeleton and hold the keyboard. Only for a terminal on both ends; never throws past a
 *  failed paint (the real chat paints its own banner then). */
export function paintPreshell(argv: string[]): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.PAW_CHAT_PRESHELL === "0") return;
  const lex = lexChatArgs(argv, process.cwd());
  const space = lex.space ?? resolveSpace();
  const remote = readRemoteMesh(space) !== undefined;
  const st: BannerState =
    lex.mode === "channel"
      ? { mode: "channel", space, remote, room: lex.label! }
      : lex.mode === "all"
        ? { mode: "all", space, remote, room: "general", roster: loading() }
        : { mode: "agent", space, remote, agent: `${c.cyan(lex.label!)} ${c.dim(LOADER)}`, where: "", status: loading(), machine: loading(), info: loading(), only: lex.only, bang: true };
  const text = renderBanner(st, c);
  const prompt =
    lex.mode === "agent" ? `${c.dim("you → ")}${c.dim(lex.label!)} ${c.dim(LOADER)}${c.dim("> ")}` : `${c.dim(`you → #${lex.mode === "channel" ? lex.label : "general"}`)} ${c.dim(LOADER)}${c.dim("> ")}`;
  process.stdin.setRawMode(true); // keys now wait in the kernel for readline — no cooked echo, nothing lost
  process.on("exit", () => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {} // the terminal is gone — nothing to restore
  });
  process.stdout.write(text + prompt);
  if (process.env.PAW_CHAT_TIMING) appendFileSync(process.env.PAW_CHAT_TIMING, JSON.stringify({ mark: "preshell", ms: Math.round(performance.now()) }) + "\n");
  const rows = paintedRows(text, process.stdout.columns || 80);
  frame = {
    rows,
    erase: () => {
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -rows);
      readline.clearScreenDown(process.stdout);
    },
  };
}

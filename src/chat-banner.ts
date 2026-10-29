/**
 * `paw chat`'s banner, as a pure function of what is known so far.
 *
 * The same renderer paints the pre-shell's first frame (src/chat-preshell.ts, before any of paw's mesh
 * code has loaded), the REPL's banner, and every in-place repaint as the background connect fills a
 * field in. A field the network has not answered yet renders as a loader (`◌`), never a value: the
 * banner may say less than it will, never something it does not know. CORE-FREE by contract (the
 * pre-shell imports it before @cotal-ai/core is loaded) — `check:chat` walks its import graph.
 */
import { slotText, type Slot } from "./chat-boot.ts";
import { whereTag } from "./chat-views.ts";
import { displayWidth } from "./width.ts";

export interface BannerStyle {
  dim(s: string): string;
  bold(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
}

export const PLAIN: BannerStyle = { dim: (s) => s, bold: (s) => s, cyan: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s };

/** What the banner shows. Painted strings (`where`, `status`, `machine`) carry their own colour. */
export type BannerState =
  | {
      mode: "agent";
      space: string;
      remote: boolean;
      /** The agent's name, painted (hue + glyph) — or the typed label while it resolves. */
      agent: string;
      /** The folder, `(by name)`, or where it runs; "" while unknown. */
      where: string;
      status: Slot<string>;
      /** The machine running it; ok(undefined) = nothing names one (shown as nothing, not a loader). */
      machine: Slot<string | undefined>;
      /** model + context; ok(undefined) = no reading here (agent away, no persona) → rows omitted. */
      info: Slot<{ model: string; context: string } | undefined>;
      /** One line about running elsewhere, when it does. */
      away?: string;
      only: boolean;
      bang: boolean;
    }
  | { mode: "channel"; space: string; remote: boolean; room: string }
  | { mode: "all"; space: string; remote: boolean; room: string; roster: Slot<string[]> };

const HINTS = [
  "drag an image in for [Image #1] · paste multiple lines for [Pasted text #1]",
  "alt+enter (or end a line with \\\\) for a new line, not a send",
];

export function renderBanner(st: BannerState, c: BannerStyle): string {
  const mesh = c.dim(whereTag({ space: st.space, remote: st.remote }));
  if (st.mode === "channel") {
    return (
      `\n${c.bold("  🐾 paw chat")}\n\n` +
      `     channel: ${c.cyan("#" + st.room)}  ${c.dim("(subscribed)")}\n` +
      `     ${mesh}\n` +
      `     showing: ${c.dim("this channel only — DMs stay in `paw inbox`")}\n\n` +
      `     ${c.dim(`type to post to #${st.room} · @name DMs someone · /who · /ps · /quit`)}\n\n`
    );
  }
  if (st.mode === "all") {
    const roster = slotText(
      st.roster,
      (names) => (names.length ? `${names.length} live: ${names.map((n) => c.cyan(n)).join(c.dim(" · "))}` : c.dim("no agents live yet — `paw chat <folder>` spawns one")),
      c,
    );
    return (
      `\n${c.bold("  🐾 paw chat")}  ${c.dim('— joined the mesh as "you"')}\n\n` +
      `     ${st.roster.s === "loading" ? `${roster} ${c.dim("loading who's live")}` : roster}\n` +
      `     ${mesh}\n\n` +
      `     ${c.dim(`type to broadcast to #${st.room} · @name starts a sticky DM · !cmd runs in its folder · #channel · /who · /ps · /quit`)}\n` +
      HINTS.map((h) => `     ${c.dim(h)}\n`).join("") +
      `     ${c.dim("on an empty line: → your tasks   ↓ picks an agent")}\n` +
      `     ${c.dim("/imgs · /noimg · /paste · /nopaste")}\n\n`
    );
  }
  const machine = st.machine.s === "ok" && st.machine.v === undefined ? "" : `${c.dim(" · on ")}${slotText(st.machine, (m) => m ?? "", c)}`;
  const info =
    st.info.s === "ok"
      ? st.info.v
        ? `     model:  ${st.info.v.model}\n     context: ${st.info.v.context}\n`
        : ""
      : st.info.s === "loading"
        ? `     model:  ${c.dim("◌")}\n     context: ${c.dim("◌")}\n`
        : `     model:  ${c.red(`✕ ${st.info.msg}`)}\n`;
  return (
    `\n${c.bold("  🐾 paw chat")}\n\n` +
    `     agent:  ${st.agent}${st.where ? `  ${st.where}` : ""}\n` +
    `     status: ${slotText(st.status, (s) => s, c)}\n` +
    `     ${mesh}${machine}\n` +
    info +
    (st.away ? `     ${c.dim(st.away)}\n` : "") +
    `\n` +
    (st.only ? `     showing: ${c.dim("this agent only — other DMs stay in `paw inbox`")}\n\n` : "") +
    `     ${c.dim(`type to message it · ${st.bang ? "!cmd runs in its folder · " : ""}@name switches target · #channel broadcasts · /who · /ps · /quit`)}\n` +
    HINTS.map((h) => `     ${c.dim(h)}\n`).join("") +
    `     ${c.dim("on an empty line: ← → switch logs · chat · tasks   ↓ picks an agent")}\n` +
    `     ${c.dim("/imgs · /noimg · /paste · /nopaste")}\n\n`
  );
}

/**
 * How many terminal rows `text` occupies once written at column 0 of `cols` columns — the cursor then
 * sits on the row below. Wrapped lines count every row they wrap onto (display width, so an emoji is
 * two columns). Text must end with a newline: a banner always does, and a partial last row would make
 * "how far up is its first row" ambiguous.
 */
export function paintedRows(text: string, cols: number): number {
  if (!text.endsWith("\n")) throw new Error("paintedRows: text must end with a newline");
  const lines = text.split("\n");
  lines.pop();
  const w = Math.max(1, cols);
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(displayWidth(l) / w)), 0);
}

/**
 * May the banner be repainted where it stands (instead of appending a one-line delta)? Only when
 * nothing has been painted under it, the terminal was not resized since (rows re-wrap), it is a tty in
 * the chat view with no picker or paste open, and it fits on screen with the prompt (a banner partly in
 * the scrollback can't be reached by cursor moves).
 */
export function canRepaintInPlace(s: {
  bannerIsLast: boolean;
  resizedSince: boolean;
  tty: boolean;
  chatView: boolean;
  picking: boolean;
  pasting: boolean;
  bannerRows: number;
  promptRows: number;
  screenRows: number;
}): boolean {
  return s.bannerIsLast && !s.resizedSince && s.tty && s.chatView && !s.picking && !s.pasting && s.bannerRows + s.promptRows < s.screenRows;
}

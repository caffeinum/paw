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
export type BannerState = (
  | {
      mode: "agent";
      space: string;
      remote: boolean;
      /** The agent's name, painted (hue + glyph) — or the typed label while it resolves. */
      agent: string;
      /** The folder, `(by name)`, or where it runs; "" while unknown. */
      where: string;
      /** loading / ok(undefined) = nothing to add (the prompt carries the loader); ok(text) = one dim
       *  note under the agent row (a spawn, a slow start); err = `kit ✕ <why>` on the agent row. */
      status: Slot<string | undefined>;
      /** The machine running it; ok(undefined) = nothing names one (then nothing is said, never `?`). */
      machine: Slot<string | undefined>;
      /** model + context; ok(undefined) = no reading here (agent away, no persona) → row omitted. */
      info: Slot<{ model: string; context: string } | undefined>;
      /** One line about running elsewhere, when it does. */
      away?: string;
      /** `paw chat .` reached an agent that isn't this machine's: the folder's own session here is not it. */
      folderNote?: string;
      only: boolean;
      bang: boolean;
    }
  | { mode: "channel"; space: string; remote: boolean; room: string }
  | { mode: "all"; space: string; remote: boolean; room: string; roster: Slot<string[]> }
) & {
  /** Why this space: `from PAW_SPACE` when the shell's env picked it (src/space.ts spaceProvenance). */
  spaceFrom?: string;
};

/** The full key list — `/help` and a bare `?` print it; the banner only points at it. */
export const HELP_LINES = [
  "type to message it · @name switches target · #channel msg broadcasts · !cmd runs in its folder",
  "drag an image in for [Image #1] · paste multiple lines for [Pasted text #1] · /imgs · /noimg · /paste · /nopaste",
  "alt+enter (or end a line with \\) for a new line, not a send",
  "on an empty line: ← → switch logs · chat · messages · beads   ↓ picks an agent",
  "/more [N] older messages · /who · /ps · /conn · /retry · /reconnect · /quit",
];

const KEYS_HINT = "? keys · @name switches · /quit";

export function renderBanner(st: BannerState, c: BannerStyle): string {
  const mesh = c.dim(`${whereTag({ space: st.space })}${st.remote ? " (remote)" : ""}${st.spaceFrom ? ` · ${st.spaceFrom}` : ""}`);
  if (st.mode === "channel") {
    return (
      `\n${c.bold("  🐾 paw chat")}\n\n` +
      `     ${c.cyan("#" + st.room)} ${c.dim("· subscribed ·")} ${mesh}\n` +
      `     ${c.dim(`only #${st.room} · DMs stay in paw inbox`)}\n` +
      `     ${c.dim(`type to post to #${st.room} · @name DMs someone · /who · /quit`)}\n\n`
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
      `     ${roster} ${c.dim("·")} ${mesh}\n` +
      `     ${c.dim(`type to broadcast to #${st.room} · @name starts a DM · ${KEYS_HINT}`)}\n\n`
    );
  }
  // No loader on the agent row: the prompt (`you → kit ◌>`) and the footer phase carry it, and a banner
  // with anything printed under it can't be repainted in place — a loader there would never resolve.
  const agent = st.status.s === "err" ? `${st.agent} ${c.red(`✕ ${st.status.msg}`)}` : st.agent;
  const machine = st.machine.s === "ok" && st.machine.v ? `${c.dim(" · on ")}${st.machine.v}` : "";
  const note = st.status.s === "ok" && st.status.v ? `     ${st.status.v}\n` : "";
  const info =
    st.info.s === "ok" && st.info.v
      ? `     ${c.dim(`model ${st.info.v.model} · context ${st.info.v.context}`)}\n`
      : st.info.s === "err"
        ? `     ${c.red(`✕ model: ${st.info.msg}`)}\n`
        : "";
  return (
    `\n${c.bold("  🐾 paw chat")}\n\n` +
    `     ${agent}${st.where ? `  ${st.where}` : ""} ${c.dim("·")} ${mesh}${machine}\n` +
    note +
    info +
    (st.away ? `     ${c.dim(st.away)}\n` : "") +
    (st.folderNote ? `     ${c.yellow(st.folderNote)}\n` : "") +
    (st.only ? `     ${c.dim(`only ${st.agent} · other agents' DMs stay in paw inbox`)}\n` : "") +
    `     ${c.dim(KEYS_HINT)}\n\n`
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

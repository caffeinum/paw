/**
 * `paw chat` views: what the conversation shows, and the keys that move between them (2026-09-23).
 *
 * Three views, arranged left to right the way the operator described them:
 *   logs   — the targeted agent's transcript only (its turns, tool calls, results, replies)
 *   both   — the transcript AND the conversation, interleaved as they happen
 *   chat   — the conversation only (the default: what `paw chat` always was)
 * ←/→ move between them, ↓ opens the agent picker.
 *
 * REDRAW ON SWITCH, APPEND IN BETWEEN (2026-09-23). Appending a divider and a backfill on a switch was
 * built first and rejected in use — the operator: "switching between views looks bad, it just appends
 * a few lines instead of showing different views". A switch now CLEARS THE SCREEN AND THE SCROLLBACK
 * (`\e[2J\e[3J`) and reprints the new view's whole history, so scrolling up shows that view and only
 * that view, and the terminal's native scroll and selection keep working. Chosen over the alternate
 * screen (vim/htop), which would have taken native scroll away entirely. The cost, accepted: whatever
 * was in the terminal before `paw chat` started is cleared on the first switch.
 *
 * That needs ONE ordered history of everything shown — `History` — and one `Painter` that turns an
 * entry into terminal text, used by BOTH the live path and the reprint, so a redraw can never look
 * different from what was printed as it happened.
 *
 * Pure: no tty, no readline, no mesh — chat.ts wires these in; check:chat asserts them.
 */
import type { Block } from "./transcript.js";

export type ChatView = "logs" | "both" | "chat";

/** Left-to-right order. The arrows STEP along it and stop at the ends — in a three-position strip a
 *  wrap from chat back to logs would read as the key misfiring, not as a feature. */
export const VIEWS: readonly ChatView[] = ["logs", "both", "chat"];

export const VIEW_LABEL: Record<ChatView, string> = { logs: "logs", both: "logs + chat", chat: "chat" };

export function stepView(v: ChatView, dir: -1 | 1): ChatView {
  const i = VIEWS.indexOf(v) + dir;
  return VIEWS[Math.max(0, Math.min(VIEWS.length - 1, i))];
}

/** Does this view print the transcript / the conversation? */
export const showsLogs = (v: ChatView): boolean => v !== "chat";
export const showsChat = (v: ChatView): boolean => v !== "logs";

/**
 * Which navigation key a raw stdin chunk is, across the encodings real terminals send.
 *
 * Plain arrows are the obvious ones. Option/Cmd+arrow is what the operator reached for first and found
 * dead, and there is no single encoding for it: xterm-style modified CSI (`\e[1;3D` alt, `\e[1;9D`
 * super/meta — Ghostty and kitty send these), or Meta-letter (`\eb`/`\ef`, what "Option as Meta" makes
 * of Option+←/→ in iTerm and Terminal). All of them are recognised.
 *
 * The CALLER decides when they count: only on an EMPTY input line. Mid-edit, plain ←/→ move the caret
 * and Option+←/→ jump words — taking those away while someone is typing would break editing to add
 * navigation. On an empty line every one of them is a no-op, so the keys are free.
 */
export function navKey(raw: string): "left" | "right" | "down" | undefined {
  switch (raw) {
    case "\x1b[D":
    case "\x1bOD":
    case "\x1b[1;3D":
    case "\x1b[1;9D":
    case "\x1b[1;10D":
    case "\x1bb":
      return "left";
    case "\x1b[C":
    case "\x1bOC":
    case "\x1b[1;3C":
    case "\x1b[1;9C":
    case "\x1b[1;10C":
    case "\x1bf":
      return "right";
    case "\x1b[B":
    case "\x1bOB":
    case "\x1b[1;3B":
    case "\x1b[1;9B":
    case "\x1b[1;10B":
      return "down";
    default:
      return undefined;
  }
}

/**
 * The hint line printed UNDER the input. It says where each key goes FROM HERE, so it changes with
 * the view — at the left end there is no "←", at the right end no "→" — and it names the current view
 * first, since "which view am I in?" is the question a view switch leaves you with.
 *
 * No target (broadcast, or a channel) has no transcript to follow, so the views don't apply and the
 * line offers only the picker.
 */
export function hintFor(s: { view: ChatView; picking: boolean; hasTarget: boolean; bang: boolean }): string {
  if (s.picking) return "↑↓ select · enter picks · esc closes · type to filter";
  if (s.bang) return "$ command mode · esc or backspace leaves";
  if (!s.hasTarget) return "↓ mention an agent";
  const parts: string[] = [];
  if (s.view !== VIEWS[0]) parts.push(`← ${VIEW_LABEL[stepView(s.view, -1)]}`);
  parts.push("↓ mention");
  if (s.view !== VIEWS[VIEWS.length - 1]) parts.push(`${VIEW_LABEL[stepView(s.view, 1)]} →`);
  return `${VIEW_LABEL[s.view]}  │  ${parts.join("   ")}`;
}

/**
 * The slice of a long list the picker shows, kept around the selection.
 *
 * The picker used to print EVERY agent — 118 of them — above the prompt, so everything past one
 * screen ran off the top, the selection with it, and the arrows moved a marker you could not see
 * (screenshot, 2026-09-23). Now it shows `size` rows and scrolls: the selection stays in view with a
 * row of context above it where there is one, and the ends clamp so the window never shows blank rows
 * past the list.
 */
export function pickerWindow(total: number, picked: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const start = Math.max(0, Math.min(total - size, picked - 1));
  return { start, end: start + size };
}

/**
 * Which transcript blocks to print in a view.
 *
 * `logs` prints everything — it is the raw trace. `both` would otherwise say every message twice,
 * because the transcript records the conversation too: the agent's reply to you is a `reply` block AND
 * arrives as the DM, and your own message is a `wake` block AND the line you typed. In `both` the
 * conversation's copy wins (it carries the round-trip time and the follow logic), so the transcript's
 * copies of it are dropped. Anything addressed to OTHER agents stays — that is exactly what the logs
 * are for. `incoming` (the text an inbox drain printed) is the same messages a third time.
 */
export function logBlockVisible(view: ChatView, b: Block, human: string): boolean {
  return logBlockFor(view, b, human) !== undefined;
}

/**
 * The block as the view shows it — or undefined when the view hides it. Same rules as
 * logBlockVisible, plus one TRANSFORM: an inbox drain (`incoming`) in `both` keeps the messages from
 * OTHER agents and drops only yours. Dropping the whole drain hid agent-to-agent mail to the target,
 * which appears nowhere else (the critic's finding, 2026-09-23); your own messages are already on
 * screen as the lines you typed.
 */
export function logBlockFor(view: ChatView, b: Block, human: string): Block | undefined {
  if (view === "chat") return undefined;
  if (view === "logs") return b;
  if (b.kind === "reply" && b.to === human) return undefined;
  if (b.kind === "wake" && b.from === human) return undefined;
  if (b.kind === "incoming") {
    const kept = dropSender(b.text, human);
    return kept ? { kind: "incoming", text: kept } : undefined;
  }
  return b;
}

/**
 * Remove one sender's messages from an inbox-drain body. The drain prints `N messages:` then each
 * message under a header — `[DM from <name>]` for a DM, `[#<channel> <name>]` for a channel post; real
 * drains MIX the two (measured: 224 DM headers and 33 channel headers in one transcript). Continuation
 * lines belong to the header above them. Recognising only the DM form ate other agents' channel posts
 * after one of yours and doubled your own (the critic's second pass, 2026-09-23).
 *
 * Anything that doesn't parse that way is returned UNTOUCHED: showing a drain twice is a smaller harm
 * than silently eating mail from a format this doesn't know. Known limit: a message BODY line that
 * itself begins with a header shape is read as a new message.
 */
export function dropSender(text: string, sender: string): string {
  const lines = text.split("\n");
  const header = /^\[(?:DM from ([^\]\s]+)|#[^\]\s]+ ([^\]\s]+))\]/;
  if (!lines.some((l) => header.test(l))) return text;
  const kept: string[] = [];
  let keep = true;
  for (const l of lines) {
    if (/^\d+ messages?:$/.test(l.trim())) continue; // the count no longer matches what's shown
    const m = l.match(header);
    if (m) keep = (m[1] ?? m[2]) !== sender;
    if (keep) kept.push(l);
  }
  return kept.join("\n").trim();
}

/** What the follower needs from a transcript — `paw log`'s AgentLog satisfies it. */
export interface FollowSource {
  blocks(tail: number): Block[];
  pull(): Block[];
}

/**
 * Everything `paw chat` has shown, in arrival order. A view is a FILTER over it (`entryVisible`), which
 * is what lets a switch reprint a different view from the same record.
 *
 * - `banner` — the header, shown in every view.
 * - `chat` — anything emit() printed. `from` is set for an inbound DM, and only then: the logs view
 *   needs to know whose mail it is (see entryVisible). `onlyLogs` marks a note ABOUT the logs.
 * - `echo` — a line you typed, exactly as readline echoed it. readline prints it, not emit, so without
 *   recording it here your own half of the conversation would vanish on the first redraw.
 * - `log` — a batch of the target's transcript blocks, stored RAW: which blocks show depends on the view
 *   (logBlockVisible), so filtering happens at paint time, not at capture.
 */
export type Entry =
  | { kind: "banner"; text: string }
  | { kind: "chat"; text: string; side: "you" | "peer" | "sys"; tight: boolean; from?: string; onlyLogs?: boolean }
  | { kind: "echo"; text: string }
  | { kind: "log"; agent: string; blocks: Block[]; backfill: boolean; note?: string };

/**
 * Is this entry part of `view`, given who the chat is targeting?
 *
 * `logs` is the target's transcript plus every conversation line EXCEPT what that transcript already
 * says: the target's own DMs (the `↩ you` blocks — shown as DMs only if the transcript can't be read,
 * or they'd be shown nowhere) and your typed lines (the `wake from you` blocks). `chat` is everything
 * but the transcript; `both` is both. Transcript blocks only ever show for the CURRENT target — another agent's, captured before a
 * switch, would be a trace of the wrong agent.
 */
export function entryVisible(e: Entry, view: ChatView, target: string | undefined, logsReadable: boolean): boolean {
  switch (e.kind) {
    case "banner":
      return true;
    case "log":
      return showsLogs(view) && e.agent === target;
    case "echo":
      return showsChat(view);
    case "chat":
      if (e.onlyLogs) return showsLogs(view); // a note about the logs themselves ("no logs for x")
      if (showsChat(view)) return true;
      // The logs view hides ONLY what the transcript already shows: the target's own DMs (its `↩ you`
      // blocks) — and even those only while that transcript can be read. Everything else stays:
      // errors, receipts, "(now messaging x)", other agents' DMs, channel posts. Hiding all non-DM
      // lines made `@nobody hi` in the logs view print NOTHING — no error, just a prompt (the critic
      // reproduced it under a pty, 2026-09-23).
      return !(e.from !== undefined && e.from === target && logsReadable);
  }
}

/** The history's bound. A reprint writes all of it, and a day-long chat must not grow without limit. */
export const HISTORY_CAP = 3000;

export class History {
  readonly entries: Entry[] = [];
  constructor(private readonly cap = HISTORY_CAP) {}
  push(e: Entry): void {
    this.entries.push(e);
    // Drop the oldest NON-banner entry: the banner is what a reprint opens with.
    if (this.entries.length > this.cap) {
      const i = this.entries.findIndex((x) => x.kind !== "banner");
      this.entries.splice(i < 0 ? 0 : i, 1);
    }
  }
}

/**
 * Entry → terminal text, carrying the "visual rounds" state across entries: a blank line where the
 * SIDE changes (your message, its receipts and the reply group into one block), conversation closes
 * with a trailing blank (the air before the prompt), system noise stays tight. Moved here unchanged
 * from emit() so the live path and a reprint share one implementation — two copies of this is how a
 * redraw ends up spaced differently from the live screen it replaces.
 */
export class Painter {
  lastSide: "you" | "peer" | "sys" | "log" | undefined;
  trailingBlank = false;

  constructor(
    private readonly render: (b: Block) => string,
    private readonly human: string,
    private readonly dim: (s: string) => string = (s) => s,
    private readonly pad = "  ",
    /** `paw log`'s spacing predicate (src/log.ts attachesAbove): true for a `⎿` result rail. */
    private readonly attachesAbove: (rendered: string) => boolean = () => false,
  ) {}

  reset(): void {
    this.lastSide = undefined;
    this.trailingBlank = false;
  }

  /** Text for `e` in `view`, or "" when it renders to nothing (a log batch the view filters empty). */
  paint(e: Entry, view: ChatView): string {
    switch (e.kind) {
      case "banner":
        this.lastSide = undefined;
        this.trailingBlank = e.text.endsWith("\n\n");
        return e.text;
      case "echo":
        // Your typed line takes the "you" side, and whatever blank preceded it is no longer adjacent —
        // the same two facts the line handler has always asserted after readline echoes a line.
        this.lastSide = "you";
        this.trailingBlank = false;
        return e.text + "\n";
      case "chat":
        return this.put(e.side, e.text.split("\n").join(`\n${this.pad}`), e.side === "sys" || e.tight);
      case "log": {
        const lines = e.blocks
          .map((b) => logBlockFor(view, b, this.human))
          .filter((b): b is Block => b !== undefined)
          .map(this.render)
          .filter(Boolean);
        if (!lines.length) return "";
        // `paw log`'s rhythm: a blank line before each turn, none before a `⎿` result (it belongs to
        // the call above). Across batches too — the 1s poll splits a trace at arbitrary points, and the
        // first turn of a batch still needs its blank when the log was already flowing (`put` adds the
        // gap itself when the side just changed, so this never doubles it).
        const continuing = this.lastSide === "log";
        const body = lines
          .map((l, i) => ((i > 0 || continuing) && !this.attachesAbove(l) ? `\n${l}` : l))
          .join("\n");
        const head = e.backfill ? `${this.dim(`── ${e.agent} · ${e.note ?? "earlier"} ──`)}\n` : "";
        return this.put("log", head + body, true);
      }
    }
  }

  private put(side: "you" | "peer" | "sys" | "log", body: string, tight: boolean): string {
    const gap = !this.trailingBlank && this.lastSide !== undefined && side !== this.lastSide ? "\n" : "";
    const tail = tight ? "" : "\n";
    this.trailingBlank = tail !== "";
    this.lastSide = side;
    return gap + body + "\n" + tail;
  }
}

/**
 * Follows the target's transcript and hands its blocks over RAW, as `log` entries — in every view,
 * not only the logs ones: the history needs them in arrival order so a switch into `logs + chat` can
 * interleave them with the conversation truthfully, instead of printing a backlog lump at the end.
 *
 * Re-points itself LAZILY: the target moves on many paths (@name, the picker, following a reply, a
 * respawn), and checking on each pump catches all of them without hooking any. A new target starts
 * with a backfill of its recent blocks. `open` throws when there is nothing to follow (no folder, a
 * harness `paw log` can't read); that is reported once through `onError` and not retried every tick.
 */
export class LogFollower {
  private name: string | undefined;
  private src: FollowSource | undefined;
  private failed: string | undefined;
  /** Every agent followed this session, by name. Going back to one RESUMES its source — pulling what
   *  it wrote in the meantime — instead of opening it fresh and backfilling again, which printed its
   *  whole recent history a second time on A → B → A (the critic reproduced every line doubled). */
  private readonly seen = new Map<string, FollowSource>();
  /** Agents whose "(no logs …)" note has been shown — once per session, however often you go back. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly open: (name: string) => FollowSource,
    private readonly out: (e: { kind: "log"; agent: string; blocks: Block[]; backfill: boolean; note?: string }) => void,
    private readonly onError: (target: string, message: string) => void,
    private readonly backfill = 40,
  ) {}

  /** Can the CURRENT target's transcript be read? The logs view needs to know (see entryVisible). */
  readable(target: string | undefined): boolean {
    return !!target && target !== this.failed;
  }

  stop(): void {
    this.name = undefined;
    this.src = undefined;
    this.failed = undefined;
  }

  /** Capture whatever is new for `target`, re-pointing when the target moved.
   *  Returns true when it re-pointed — the caller redraws, since the visible logs just changed agent. */
  pump(target: string | undefined): boolean {
    if (!target) {
      this.stop();
      return false;
    }
    if (target !== this.name || !this.src) {
      if (target === this.failed) return false;
      this.name = target;
      const known = this.seen.get(target);
      if (known) {
        this.src = known;
        this.resume(target);
        return true;
      }
      this.src = undefined;
      let recent: Block[];
      try {
        this.src = this.open(target);
        recent = this.src.blocks(this.backfill);
      } catch (e) {
        this.failed = target;
        if (!this.reported.has(target)) {
          this.reported.add(target);
          this.onError(target, (e as Error).message.replace(/^paw: /, ""));
        }
        return true;
      }
      this.failed = undefined;
      this.seen.set(target, this.src);
      if (recent.length) this.out({ kind: "log", agent: target, blocks: recent, backfill: true });
      return true;
    }
    this.drain(target, false);
    return false;
  }

  /**
   * Back to an agent followed earlier: pull what it wrote while you were on another. After a long
   * absence that can be hundreds of blocks, so it is CAPPED at the backfill size and LABELLED — an
   * unlabelled wall of old trace reads as the agent doing all that right now.
   */
  private resume(target: string): void {
    let missed: Block[];
    try {
      missed = this.src!.pull();
    } catch {
      return;
    }
    if (!missed.length) return;
    const skipped = Math.max(0, missed.length - this.backfill);
    this.out({
      kind: "log",
      agent: target,
      blocks: missed.slice(-this.backfill),
      backfill: true,
      note: skipped ? `while you were away · ${skipped} older skipped (paw log for all)` : "while you were away",
    });
  }

  private drain(target: string, backfill: boolean): void {
    let fresh: Block[];
    try {
      fresh = this.src!.pull();
    } catch {
      return; // mid-rotation or briefly unreadable — the next pump reads it
    }
    if (fresh.length) this.out({ kind: "log", agent: target, blocks: fresh, backfill });
  }
}

/** Display width lives in src/width.ts (shared with the markdown tables and `paw status`); re-exported
 *  here because the chat's hint line and its tests reach for it through this module. */
export { displayWidth, fitWidth } from "./width.js";

/** Clear the visible screen AND the scrollback, cursor home — the start of every redraw. 2J before 3J:
 *  some terminals push the cleared screen INTO scrollback, which 3J then clears. Verified on tmux 3.5a
 *  (history 191 → 0); Ghostty/cmux, iTerm2, Terminal.app, kitty and WezTerm implement 3J. */
export const CLEAR_ALL = "\x1b[H\x1b[2J\x1b[3J";

/**
 * A chunk that is nothing but vertical arrows, as the net selection step (↓ = +1, ↑ = −1), else undefined.
 *
 * Holding ↓ to scroll a long picker is key REPEAT, and a busy process reads several repeats in one
 * `data` chunk (`\e[B\e[B\e[B`). The picker compared the chunk to exactly one ↓, so a run fell through
 * to "the user typed something", re-filtered on the line the arrows had just rewritten, and collapsed a
 * 41-agent list to the single agent that line named (reproduced under a pty, 2026-09-23).
 */
export function arrowRun(raw: string): number | undefined {
  if (!/^(?:\x1b[[O][AB])+$/.test(raw)) return undefined;
  let step = 0;
  for (const m of raw.matchAll(/\x1b[[O]([AB])/g)) step += m[1] === "B" ? 1 : -1;
  return step;
}

/**
 * `paw chat` views: what the conversation shows, and the keys that move between them (2026-09-23).
 *
 * Three views, arranged left to right the way the operator described them:
 *   logs   — the targeted agent's transcript only (its turns, tool calls, results, replies)
 *   both   — the transcript AND the conversation, interleaved as they happen
 *   chat   — the conversation only (the default: what `paw chat` always was)
 * ←/→ move between them, ↓ opens the agent picker.
 *
 * APPEND, NOT REPAINT — the operator's choice, made knowing the cost. A full-screen repaint (the
 * alternate screen vim and less use) would kill the terminal's native scrollback: the wheel does
 * nothing and every line you scrolled past is gone. So a view changes what is PRINTED FROM NOW ON,
 * announced by a divider and a short backfill, and everything already on screen stays in scrollback.
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
  if (view === "chat") return false;
  if (view === "logs") return true;
  if (b.kind === "reply" && b.to === human) return false;
  if (b.kind === "wake" && b.from === human) return false;
  if (b.kind === "incoming") return false;
  return true;
}

/** What the follower needs from a transcript — `paw log`'s AgentLog satisfies it. */
export interface FollowSource {
  blocks(tail: number): Block[];
  pull(): Block[];
}

/**
 * Follows the targeted agent's transcript for the logs views.
 *
 * Re-points itself LAZILY: the chat's target moves on many paths (@name, the picker, following a
 * reply, a respawn), and checking on each pump catches all of them without hooking any. A switch
 * backfills the new agent's recent activity under a divider; after that only new blocks print, one
 * `out` per batch — a turn can write thirty tool lines at once, and one write per line would be thirty
 * prompt redraws.
 *
 * `open` throws when there is nothing to follow (no folder, a harness `paw log` can't read); that is
 * printed once, dimly, and not retried every second.
 */
export class LogFollower {
  private name: string | undefined;
  private src: FollowSource | undefined;
  private failed: string | undefined; // the target whose open() failed — don't retry it every tick

  constructor(
    private readonly open: (name: string) => FollowSource,
    private readonly out: (text: string) => void,
    private readonly render: (b: Block) => string,
    private readonly human: string,
    private readonly backfill = 12,
  ) {}

  private text(view: ChatView, blocks: Block[]): string {
    return blocks
      .filter((b) => logBlockVisible(view, b, this.human))
      .map(this.render)
      .filter(Boolean)
      .join("\n");
  }

  /** Forget the current target (the chat view, or no target). */
  stop(): void {
    this.name = undefined;
    this.src = undefined;
    this.failed = undefined;
  }

  /** Print whatever is new for `target` in `view`, re-pointing (with a backfill) if the target moved. */
  pump(target: string | undefined, view: ChatView): void {
    if (!showsLogs(view) || !target) return this.stop();
    if (target !== this.name || !this.src) {
      if (target === this.failed) return;
      this.name = target;
      this.src = undefined;
      let recent: Block[];
      try {
        this.src = this.open(target);
        recent = this.src.blocks(this.backfill * 4); // over-read: the view's dedup drops some
      } catch (e) {
        this.failed = target;
        this.out(`(no logs for ${target} — ${(e as Error).message.replace(/^paw: /, "")})`);
        return;
      }
      this.failed = undefined;
      const shown = recent.filter((b) => logBlockVisible(view, b, this.human)).slice(-this.backfill);
      this.out(`── ${target} · recent activity ──\n${this.text(view, shown) || "(nothing yet)"}`);
      return;
    }
    let fresh: Block[];
    try {
      fresh = this.src.pull();
    } catch {
      return; // mid-rotation or briefly unreadable — the next pump reads it
    }
    const t = this.text(view, fresh);
    if (t) this.out(t);
  }
}

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

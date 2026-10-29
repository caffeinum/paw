/**
 * `paw chat`'s instant UI, the pure half: what is still loading, what the footer says while it loads,
 * which typed lines must wait for the mesh, and the queue they wait in.
 *
 * The REPL is up before the mesh is (docs/notes/chat.md "instant UI"): readline takes keys from the
 * first frame, and the connect runs behind it. Anything the screen shows that the network has not
 * answered yet is a LOADER (`◌`), never a guessed value — `offline` from a roster that was never read
 * is how a live agent looks dead. Core-free and side-effect-free: `check:chat` covers all of it.
 */

/** Where the background connect is. `failed` is terminal until `/reconnect`. */
export type BootPhase = "mesh" | "inbox" | "endpoint" | "agent" | "roster" | "ready" | "failed";

/** A field the network fills in: loading, a value, or why it could not. */
export type Slot<T> = { s: "loading" } | { s: "ok"; v: T } | { s: "err"; msg: string };

export const loading = <T>(): Slot<T> => ({ s: "loading" });
export const ok = <T>(v: T): Slot<T> => ({ s: "ok", v });
export const failed = <T>(msg: string): Slot<T> => ({ s: "err", msg });

export const LOADER = "◌";

/** A slot as text: a dim `◌` while loading, the value once known, a red `✕ <why>` on failure. */
export function slotText<T>(slot: Slot<T>, fmt: (v: T) => string, style: { dim(s: string): string; red(s: string): string }): string {
  if (slot.s === "loading") return style.dim(LOADER);
  if (slot.s === "err") return style.red(`✕ ${slot.msg}`);
  return fmt(slot.v);
}

/** The footer's left-of-mesh label while the connect runs. Seconds count up so a wait reads as a wait. */
export function bootLabel(phase: BootPhase, elapsedMs: number, name?: string): string {
  const s = `${Math.floor(Math.max(0, elapsedMs) / 1000)}s`;
  switch (phase) {
    case "mesh":
      return `${LOADER} starting mesh ${s}`;
    case "inbox":
      return `${LOADER} opening inbox ${s}`;
    case "endpoint":
      return `${LOADER} connecting ${s}`;
    case "agent":
      return name ? `${LOADER} waking ${name} ${s}` : `${LOADER} connecting ${s}`;
    case "roster":
      return name ? `${LOADER} waiting for ${name} ${s}` : `${LOADER} loading who's live ${s}`;
    case "ready":
      return "";
    case "failed":
      return "✕ not connected — /reconnect · /quit";
  }
}

/** Lines that work with no mesh at all: they read or clear local state, or leave. */
const LOCAL = new Set(["/imgs", "/noimg", "/paste", "/pastes", "/nopaste", "/help", "/quit", "/exit", "quit", "exit", "/conn", "/reconnect"]);

/**
 * Does this typed line need the mesh (and the resolved target) before it can run? Everything that
 * sends, resolves a name or reads the roster does — a plain line, `@name`, `#channel`, `!cmd`, and any
 * other `/command`. Those queue until connected; the local ones above run at once.
 */
export function lineNeedsMesh(text: string): boolean {
  return !LOCAL.has(text.trim().toLowerCase());
}

/** One line typed before the mesh was up, with what was staged FOR it at the time it was typed. */
export interface DeferredLine<A, P> {
  text: string;
  pending: A[];
  pastes: P[];
  stagedFor?: string;
  /** Typed in `!` command mode (the `!` was consumed by the mode). */
  bang: boolean;
  at: number;
}

/**
 * The lines typed before `ready`, in typed order. Replayed through the ordinary line handler once the
 * target is resolved, so `@name` switching, attachments and every refusal keep their meaning. Each line
 * carries its own attachments: an image dropped for line 1 can't ride on line 3.
 */
export class DeferredQueue<A, P> {
  private readonly items: DeferredLine<A, P>[] = [];

  push(line: DeferredLine<A, P>): void {
    this.items.push(line);
  }

  /** Take the oldest queued line (undefined when empty). Replay takes one at a time, so a line queued
   *  while an earlier one is still running lands behind it, and a quit mid-replay still lists the rest. */
  shift(): DeferredLine<A, P> | undefined {
    return this.items.shift();
  }

  /** Take every queued line, oldest first, leaving the queue empty. */
  drain(): DeferredLine<A, P>[] {
    return this.items.splice(0, this.items.length);
  }

  get count(): number {
    return this.items.length;
  }

  /** The full text of every line not yet sent — what a quit prints, never a preview. */
  unsentLines(): string[] {
    return this.items.map((i) => (i.bang ? `!${i.text}` : i.text));
  }
}

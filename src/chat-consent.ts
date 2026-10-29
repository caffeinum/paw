/**
 * The wake gate's "restart it? [y/N]" asked INSIDE paw chat's REPL.
 *
 * The gate used to open a second readline on stdin (addressing.ts cliRestartConsent). With the REPL up
 * from the first frame that is two readers on one tty — and worse, the operator is typing ahead: a `y`
 * typed as the start of a message, or a pasted line, must never restart a live agent. So the answer is
 * the REPL's own next line, and only one that was clearly typed AS the answer: into an empty buffer, its
 * first key pressed after the question had been on screen for {@link ARM_MS}, not pasted, not a replay
 * of a queued line. Anything earlier is type-ahead and stays a message.
 */
export const ARM_MS = 300;

export interface ConsentLine {
  text: string;
  /** When the first key of this line was pressed into an empty buffer (undefined: unknown → not an answer). */
  startedAt?: number;
  pasted: boolean;
  replay: boolean;
}

/** `yes`/`no` when the line answers the question, `typeahead` when it was typed before it was asked. */
export function consentAnswer(line: ConsentLine, armedAt: number): "yes" | "no" | "typeahead" {
  if (line.replay || line.pasted || line.startedAt === undefined || line.startedAt < armedAt) return "typeahead";
  return /^y(es)?$/i.test(line.text.trim()) ? "yes" : "no";
}

/** The REPL hooks the question needs: the line being edited, the prompt, and a sink for the question. */
export interface ConsentHost {
  /** Stash and clear whatever is being typed; returns a function that puts it back. */
  stashDraft(): () => void;
  ask(question: string, prompt: string): void;
  /** Restore the ordinary prompt. */
  done(): void;
  now(): number;
}

/**
 * A pending question. The REPL routes each submitted line through {@link PendingConsent.offer} first:
 * `true` means the line was the answer (consumed), `false` means it is ordinary input.
 */
export class PendingConsent {
  private resolve?: (yes: boolean) => void;
  private armedAt = Infinity;
  private restore?: () => void;

  private readonly host: ConsentHost;

  constructor(host: ConsentHost) {
    this.host = host;
  }

  get open(): boolean {
    return this.resolve !== undefined;
  }

  /** The RestartConsent function the wake gate calls. One question at a time. */
  readonly consent = (question: string): Promise<boolean> => {
    if (this.resolve) throw new Error("paw chat: a restart question is already open");
    this.restore = this.host.stashDraft();
    const name = question.split(" ")[0] ?? "it";
    this.host.ask(question.trim(), `restart ${name}? [y/N]> `);
    this.armedAt = this.host.now() + ARM_MS;
    return new Promise<boolean>((r) => (this.resolve = r));
  };

  offer(line: ConsentLine): boolean {
    if (!this.resolve) return false;
    const a = consentAnswer(line, this.armedAt);
    if (a === "typeahead") return false;
    this.finish(a === "yes");
    return true;
  }

  /** Quit or close: the answer is no, and the draft comes back. */
  cancel(): void {
    if (this.resolve) this.finish(false);
  }

  private finish(yes: boolean): void {
    const r = this.resolve!;
    this.resolve = undefined;
    this.armedAt = Infinity;
    this.host.done();
    this.restore?.();
    this.restore = undefined;
    r(yes);
  }
}

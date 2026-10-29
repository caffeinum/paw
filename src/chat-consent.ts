/**
 * The wake gate's "restart it? [y/N]" asked INSIDE paw chat's REPL.
 *
 * The gate used to open a second readline on stdin (addressing.ts cliRestartConsent). With the REPL up
 * from the first frame that is two readers on one tty — and worse, the operator is typing ahead: a `y`
 * typed as the start of a message, or a pasted line, must never restart a live agent. So the answer is
 * the REPL's own next line, and only one that was clearly typed AS the answer: into an empty buffer, its
 * first key pressed after the question had been on screen for {@link ARM_MS}, not pasted, not a replay
 * of a queued line — and only `y`/`yes`/`n`/`no`/an empty Enter. Anything else is an ordinary message:
 * the operator who keeps typing the next message never has it swallowed as "no". The draft being typed
 * when the question appears is left alone (never cut, never restored half-way); the question just takes
 * over the prompt until it is answered.
 */
export const ARM_MS = 300;

export interface ConsentLine {
  text: string;
  /** When the first key of this line was pressed into an empty buffer (undefined: unknown → not an answer). */
  startedAt?: number;
  pasted: boolean;
  replay: boolean;
}

/** `yes`/`no` when the line answers the question; `message` when it is ordinary input — typed before
 *  the question was asked, pasted, replayed, or simply not a y/n. */
export function consentAnswer(line: ConsentLine, armedAt: number): "yes" | "no" | "message" {
  if (line.replay || line.pasted || line.startedAt === undefined || line.startedAt < armedAt) return "message";
  const t = line.text.trim();
  if (/^y(es)?$/i.test(t)) return "yes";
  if (/^(no?)?$/i.test(t)) return "no";
  return "message";
}

/** The REPL hooks the question needs: the prompt, and a sink for the question. */
export interface ConsentHost {
  /** Say the question and switch the prompt to `prompt` (it stays until done()). */
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
  private shownPrompt?: string;

  private readonly host: ConsentHost;

  constructor(host: ConsentHost) {
    this.host = host;
  }

  get open(): boolean {
    return this.resolve !== undefined;
  }

  /** The question's prompt while it is open — every prompt redraw must show this, not the ordinary one. */
  get prompt(): string | undefined {
    return this.shownPrompt;
  }

  /** The RestartConsent function the wake gate calls. One question at a time. */
  readonly consent = (question: string): Promise<boolean> => {
    if (this.resolve) throw new Error("paw chat: a restart question is already open");
    const name = question.split(" ")[0] ?? "it";
    this.shownPrompt = `restart ${name}? [y/N]> `;
    this.host.ask(question.trim(), this.shownPrompt);
    this.armedAt = this.host.now() + ARM_MS;
    return new Promise<boolean>((r) => (this.resolve = r));
  };

  offer(line: ConsentLine): boolean {
    if (!this.resolve) return false;
    const a = consentAnswer(line, this.armedAt);
    if (a === "message") return false;
    this.finish(a === "yes");
    return true;
  }

  /** Quit or close: the answer is no. */
  cancel(): void {
    if (this.resolve) this.finish(false);
  }

  private finish(yes: boolean): void {
    const r = this.resolve!;
    this.resolve = undefined;
    this.armedAt = Infinity;
    this.shownPrompt = undefined;
    this.host.done();
    r(yes);
  }
}

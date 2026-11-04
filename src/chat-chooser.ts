/**
 * What `paw chat @name` offers when the live roster has no `@name` — instead of a prompt that would
 * refuse every line (operator, 2026-11-04: "load the prompt and give options on what to do if I put in
 * the wrong agent"). Pure: the options, the keys, the rows; chat.ts draws it above the prompt and acts
 * on the pick. It never creates an agent (plain `paw chat` connects, never creates) — `--fresh` is only
 * named as text — and never sends the lines typed while looking (chat.ts has already refused them: back in the input,
 * or kept and printed on quit).
 * Core-free; `check:chat` covers it.
 */
import type { SpaceHit } from "./chat-lookup.ts";

export type Choice =
  | { kind: "switch"; name: string }
  | { kind: "space"; name: string; space: string }
  | { kind: "all" }
  | { kind: "retry" }
  | { kind: "quit" };

export interface Chooser {
  /** The heading rows: what is wrong, said plainly. */
  title: string[];
  options: Array<{ label: string; choice: Choice }>;
  sel: number;
}

/** No `@name` on this space's live roster (nor registered here). */
export function notFoundChooser(o: { name: string; space: string; suggestions: string[]; elsewhere: SpaceHit[] }): Chooser {
  const options: Chooser["options"] = [
    ...o.suggestions.map((n) => ({ label: `@${n}`, choice: { kind: "switch", name: n } as Choice })),
    ...o.elsewhere.map((h) => ({
      label: `open @${o.name} in ${h.space}${h.how === "seen" ? " (seen on its mesh)" : ""}`,
      choice: { kind: "space", name: o.name, space: h.space } as Choice,
    })),
    { label: "show all conversations", choice: { kind: "all" } },
    { label: "quit", choice: { kind: "quit" } },
  ];
  return {
    title: [`✕ no agent @${o.name} in ${o.space}${o.suggestions.length ? " — did you mean:" : ""}`],
    options,
    sel: 0,
  };
}

/** The roster could not be read: say so — never a guessed "not found". */
export function unreachableChooser(o: { name: string; space: string; why: string }): Chooser {
  return {
    title: [`✕ couldn't reach ${o.space} to check @${o.name} — ${o.why}`],
    options: [
      { label: "retry", choice: { kind: "retry" } },
      { label: "quit", choice: { kind: "quit" } },
    ],
    sel: 0,
  };
}

/**
 * One raw stdin chunk against the chooser. ↑/↓ move (wrapping), Enter picks, 1–9 pick that row, Esc and
 * Ctrl-C quit. Anything else is not the chooser's: `pass` closes it and the key goes to the input (so
 * `@other …`, `/who` and editing a kept line all still work).
 */
export function chooserKey(ch: Chooser, raw: string): { sel: number; pick?: Choice; pass?: true } {
  const n = ch.options.length;
  if (raw === "\x1b[A" || raw === "\x1bOA") return { sel: (ch.sel - 1 + n) % n };
  if (raw === "\x1b[B" || raw === "\x1bOB") return { sel: (ch.sel + 1) % n };
  if (raw === "\r" || raw === "\n") return { sel: ch.sel, pick: ch.options[ch.sel]!.choice };
  if (raw === "\x1b" || raw === "\x03") return { sel: ch.sel, pick: { kind: "quit" } };
  if (/^[1-9]$/.test(raw)) {
    const i = Number(raw) - 1;
    return i < n ? { sel: i, pick: ch.options[i]!.choice } : { sel: ch.sel };
  }
  return { sel: ch.sel, pass: true };
}

/** The rows, selection marked; a closing hint names the keys and the one way to create an agent. */
export function renderChooser(ch: Chooser, s: { dim(x: string): string; red(x: string): string; cyan(x: string): string; green(x: string): string; bold(x: string): string }, createHint?: string): string[] {
  return [
    s.red(ch.title[0]!),
    ...ch.title.slice(1).map((t) => s.dim(t)),
    ...ch.options.map((o, i) => {
      const mark = i === ch.sel ? s.green("▸") : " ";
      const label = o.choice.kind === "switch" ? s.cyan(o.label) : o.label;
      return `  ${mark} ${s.dim(`${i + 1}`)} ${i === ch.sel ? s.bold(label) : label}`;
    }),
    s.dim(`  ↑↓ + enter or 1-${Math.min(9, ch.options.length)} · esc quits · any other key closes this${createHint ? ` · ${createHint}` : ""}`),
  ];
}

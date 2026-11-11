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
  | { kind: "retry" }
  | { kind: "quit" };

export interface Chooser {
  /** The heading rows: what is wrong, said plainly. */
  title: string[];
  options: Array<{ label: string; choice: Choice }>;
  sel: number;
  /** Named on the key line when it applies (not under a connection failure). */
  createHint?: string;
}

/** No `name` on this space's live roster (nor registered here). The one way to make a new agent is
 *  named on the key line; `paw chat --all` stays a flag, not an option inside a typo fix. */
export function notFoundChooser(o: { name: string; space: string; suggestions: string[]; elsewhere: SpaceHit[] }): Chooser {
  // The SAME name in another space is the likelier intent than a near-miss here (`@tracepaper#paw`
  // when tracepaper lives in team2027, 2026-11-11): it goes first, and the title says where.
  const options: Chooser["options"] = [
    ...o.elsewhere.map((h) => ({
      label: `open ${o.name} in ${h.space}${h.how === "seen" ? " (seen on its mesh)" : ""}`,
      choice: { kind: "space", name: o.name, space: h.space } as Choice,
    })),
    ...o.suggestions.map((n) => ({ label: n, choice: { kind: "switch", name: n } as Choice })),
    { label: "quit", choice: { kind: "quit" } },
  ];
  const where = o.elsewhere.length ? ` — it's in ${o.elsewhere.map((h) => h.space).join(", ")}` : o.suggestions.length ? " — did you mean:" : "";
  return {
    title: [`✕ no agent ${o.name} in ${o.space}${where}`],
    options,
    sel: 0,
    createHint: "paw chat --fresh <folder> makes a new agent",
  };
}

/** The roster could not be read and paw is NOT retrying by itself: say so — never a guessed "not found". */
export function unreachableChooser(o: { name: string; space: string }): Chooser {
  return {
    title: [`✕ not connected — can't check ${o.name} in ${o.space}`],
    options: [
      { label: "try again", choice: { kind: "retry" } },
      { label: "quit", choice: { kind: "quit" } },
    ],
    sel: 0,
  };
}

/** Registered here, but its folder is gone: it can never be woken until the folder is back or the
 *  record removed. Nothing to switch to — the fix is outside the chat. */
export function folderGoneChooser(o: { name: string; folder: string }): Chooser {
  return {
    title: [`✕ ${o.name} is registered here but its folder is gone: ${o.folder}`, `  restore it, or \`paw rm ${o.name}\``],
    options: [{ label: "quit", choice: { kind: "quit" } }],
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

/** The rows, selection marked; one closing key line. Any other key closes the chooser and goes to
 *  the input — that is not said (it is what every key does). */
export function renderChooser(ch: Chooser, s: { dim(x: string): string; red(x: string): string; cyan(x: string): string; green(x: string): string; bold(x: string): string }): string[] {
  return [
    s.red(ch.title[0]!),
    ...ch.title.slice(1).map((t) => s.dim(t)),
    ...ch.options.map((o, i) => {
      const mark = i === ch.sel ? s.green("▸") : " ";
      const label = o.choice.kind === "switch" ? s.cyan(o.label) : o.label;
      return `  ${mark} ${s.dim(`${i + 1}`)} ${i === ch.sel ? s.bold(label) : label}`;
    }),
    s.dim(`    ↑↓ enter · esc quits${ch.createHint ? ` · ${ch.createHint}` : ""}`),
  ];
}

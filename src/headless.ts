/**
 * Headless launch: turn the claude TUI launch paw's connector built into a `claude -p` stream-json
 * process with NO host process of its own (docs/notes/headless.md).
 *
 * The runtime (pty/tmux/cmux) runs `/bin/sh -c HEADLESS_SH paw-headless <dir> claude <args…>`; the
 * shell makes the FIFO and `exec`s claude, so nothing stays resident besides claude itself:
 *   - stdin  = `<dir>/in`, a FIFO opened READ-WRITE, so claude holds a writer of its own and never
 *     sees EOF when the hub (the only other writer) restarts or isn't up yet;
 *   - stdout = `<dir>/out.jsonl`, claude's stream-json output (the hub tails it for turn ends);
 *     the previous run's file is kept as `out.prev.jsonl`;
 *   - stderr stays on the runtime's terminal (tmux window / pty), where a crash is visible.
 * The hub writes each mesh wake into the FIFO as a stream-json user message (src/hub/headless.mjs).
 */
import type { LaunchSpec } from "@cotal-ai/core";

export const HEADLESS_SH = [
  `d=$1; shift`,
  `mkdir -p "$d" || exit 1`,
  `if [ ! -p "$d/in" ]; then rm -f "$d/in"; mkfifo -m 600 "$d/in" || exit 1; fi`,
  `if [ -f "$d/out.jsonl" ]; then mv -f "$d/out.jsonl" "$d/out.prev.jsonl"; fi`,
  `exec "$@" 0<>"$d/in" 1>"$d/out.jsonl"`,
].join("\n");

const DEV_CHANNELS = "--dangerously-load-development-channels";
const PRINT_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

/** Rewrite a finished claude launch into its headless form. Pure. Throws on what headless can't carry. */
export function headlessLaunch(spec: LaunchSpec, dir: string): LaunchSpec {
  const args = [...spec.args];
  // cotal puts an initial prompt first as a positional; `-p` stream-json takes turns on stdin only.
  if (args.length && !args[0]!.startsWith("-"))
    throw new Error("paw: a headless agent takes no initial prompt — DM it once it is up instead");
  // `--dangerously-load-development-channels` STAYS although -p drops the channel push (the hub
  // delivers the wake instead): -p accepts it without the TUI's confirmation gate (claude 2.1.289),
  // and it is how src/named.ts tells a mesh agent from a hand-run claude (the two-writer guard).
  if (!args.includes(DEV_CHANNELS)) throw new Error("paw: headless launch lost the dev-channels flag — named.ts would take it for a hand-run claude");
  for (const f of ["-p", "--print", "--input-format", "--output-format"])
    if (args.includes(f)) throw new Error(`paw: a headless agent sets ${f} itself — remove it from the agent's claudeArgs`);
  // No TUI ⇒ no dev-channels gate for a runtime to press Enter at.
  const { confirm: _confirm, ...rest } = spec;
  return { ...rest, command: "/bin/sh", args: ["-c", HEADLESS_SH, "paw-headless", dir, spec.command, ...PRINT_FLAGS, ...args] };
}

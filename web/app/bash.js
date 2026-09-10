/**
 * The `!<command>` form in the composer.
 *
 * Mirrors src/bash.ts's `parseBang` so the client can decide command-vs-message without a round-trip.
 * Only a LEADING `!` counts: a line that merely contains one ("that's odd!") is ordinary prose, and
 * treating it as a command would run something nobody asked for.
 */
export function parseBang(line) {
  const m = /^!([\s\S]*)$/.exec(line);
  if (!m) return undefined;
  const cmd = m[1].trim();
  return cmd.length ? cmd : undefined;
}

/**
 * Is the composer in COMMAND MODE — i.e. does the line begin with `!`?
 *
 * Deliberately NOT `parseBang`: that answers "is there a command to run", which a bare `!` is not. The
 * mode has to flip on the `!` ITSELF, the instant it is typed into an empty box, because the switch is
 * what tells you the next thing you type is a shell command rather than a message. Waiting for a second
 * character would mean the first one is typed in the wrong mode, which is exactly when you'd want to
 * know. Backspacing the `!` flips it straight back, for the same reason.
 */
export function isBangMode(line) {
  return String(line ?? "").startsWith("!");
}

/**
 * Composer slash-commands.
 *
 * A command is recognised only when the line STARTS with it, so a message that merely mentions
 * `/invite` in prose ("use /invite to add someone") still sends as an ordinary message. Anything
 * unrecognised is a message too — paw does not invent commands, and a typo'd `/invit` reaching the
 * channel as text is far better than being swallowed as a failed command nobody sees.
 */

/**
 * Parse `/invite @a @b` → the agent names, or undefined when the line is not an invite.
 *
 * The `@` is optional because the composer's own filter and the roster both show bare names, so
 * requiring the sigil would reject the form the operator is reading off the screen. `names` may come
 * back EMPTY for a bare `/invite` — that is a recognised command with nothing to do, which the caller
 * reports as usage; returning undefined there would post the word "/invite" into the channel instead.
 *
 * A token that isn't a valid agent name is separated into `invalid` rather than dropped: an agent name
 * is the manager's `[A-Za-z0-9_-]` token, so `@queue!` cannot address anything — but quietly ignoring
 * part of what the operator typed would let `/invite @a @b!` report success while @b was never asked.
 */
export function parseInvite(line) {
  const m = /^\/invite\b(.*)$/i.exec(line.trim());
  if (!m) return undefined;
  const words = m[1]
    .split(/[\s,]+/)
    .map((w) => w.replace(/^@/, "").trim())
    .filter(Boolean);
  return {
    names: words.filter((w) => /^[A-Za-z0-9_-]+$/.test(w)),
    invalid: words.filter((w) => !/^[A-Za-z0-9_-]+$/.test(w)),
  };
}

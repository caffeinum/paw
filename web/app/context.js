/**
 * How full an agent's context window is.
 *
 * cotal carries no token information at all — presence is working/idle, and the control rail's ps row
 * is name/id/lifecycleUid — so this comes from the server, which reads it out of the claude transcript
 * (src/transcript.ts `lastUsage`): the newest assistant turn's INPUT total is the whole conversation as
 * of that turn, i.e. the live occupancy.
 *
 * Pure and DOM-free so `check:web` can assert it; app.js only places the chip.
 */

/** `152k`, `928k`, `1M` — the count, at the precision a glance needs. */
export function fmtTokens(t) {
  return t >= 1_000_000 ? `${(t / 1_000_000).toFixed(t % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(t / 1000)}k`;
}

/** Amber approaching the window, red at its edge. Autocompact fires near the top, and a compaction
 *  costs the agent its working memory — so this is worth seeing BEFORE it happens, not after. */
export const CTX_WARN = 0.75;
export const CTX_HIGH = 0.9;

/**
 * What the header chip should say, as data (app.js renders it).
 *
 * `null` when there is nothing measured — an agent with no pin, a non-claude harness, or a transcript
 * tail holding only synthetic failure turns. Rendering a 0% bar there would state the opposite of the
 * truth on an agent whose context is actually full.
 *
 * The share is present ONLY when the server proved which window this session runs under. This fleet
 * runs both the 200k and the 1M window (occupancies of 152k and 928k on the same box), so a default
 * denominator would be a fabricated percentage on half the agents — and an unknown share must not
 * borrow a warning colour either, or the colour becomes the claim the number refused to make.
 */
export function contextChip(u) {
  if (!u || !u.tokens) return null;
  if (!u.limit) {
    return {
      label: `${fmtTokens(u.tokens)} ctx`,
      level: "unknown",
      title: `${u.tokens.toLocaleString()} tokens in context — the window size isn't recorded for this session yet, so no percentage is claimed`,
    };
  }
  const share = u.tokens / u.limit;
  const how =
    u.limitFrom === "autocompact"
      ? "window known from this session's own autocompact point"
      : "window inferred: this much context only fits the larger one";
  return {
    label: `${Math.round(share * 100)}% ctx`,
    level: share >= CTX_HIGH ? "high" : share >= CTX_WARN ? "warn" : "ok",
    title:
      `${u.tokens.toLocaleString()} / ${u.limit.toLocaleString()} tokens (${how})` +
      (share >= CTX_WARN ? " — a compaction is near, and it costs the agent its working memory" : ""),
  };
}

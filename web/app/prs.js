/**
 * The PRs section: what the running agents currently have open on GitHub.
 *
 * This is a different question from the roster. The roster answers "who is here"; a fleet of agents
 * that mostly write code is really working on a handful of PRs, and until now the only way to see one
 * was to focus an agent and read its header. Collected in one place it becomes the actual status of
 * the work.
 *
 * Every entry costs a `gh` network call, so the server caches for 60s and the client asks rarely.
 */

/** GitHub's own vocabulary, because that is what the operator is looking at in the other tab. A draft
 *  is deliberately NOT "open": the whole point of marking something draft is that it isn't ready. */
export function prGlyph(pr) {
  if (pr.state === "MERGED") return { glyph: "⧉", cls: "merged", label: "Merged" };
  if (pr.state === "CLOSED") return { glyph: "⊘", cls: "closed", label: "Closed" };
  if (pr.isDraft) return { glyph: "◌", cls: "draft", label: "Draft" };
  return { glyph: "◍", cls: "open", label: "Open" };
}

/** Checks roll up to three answers, or none at all. `undefined` means no checks are configured, which
 *  must render as NOTHING rather than as a pending spinner that will never resolve. */
export function checkGlyph(checks) {
  if (checks === "pass") return { glyph: "✓", cls: "pass", label: "Checks passing" };
  if (checks === "fail") return { glyph: "✕", cls: "fail", label: "Checks failing" };
  if (checks === "pending") return { glyph: "•", cls: "pending", label: "Checks running" };
  return undefined;
}

/** `+123 −45`, or "" when the API didn't say. Zero is a real answer and renders; missing does not —
 *  showing `+0 −0` for "unknown" would state something false about the diff. */
export function diffLabel(pr) {
  if (typeof pr.additions !== "number" || typeof pr.deletions !== "number") return "";
  return `+${pr.additions} −${pr.deletions}`;
}

/**
 * Should the PR list be re-fetched?
 *
 * Deliberately NOT on the 2s message poll: each entry is a GitHub round-trip behind a 60s server-side
 * cache, so asking faster than the cache can change is pure noise. It also refuses to run while the
 * section is folded shut — the cheapest network call is the one nobody can see the result of.
 */
export function shouldRefetch({ folded, lastAt, now, everyMs = 60_000 }) {
  if (folded) return false;
  return lastAt === undefined || now - lastAt >= everyMs;
}

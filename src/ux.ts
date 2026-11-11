/**
 * paw's terminal vocabulary — the one set of glyphs, reason words and the shape of a problem line,
 * shared by chat, status, top, sleep and web so one fact reads the same on every screen.
 *
 * Glyphs (always the FIRST character of a line or cell; colour follows the glyph):
 *   ◌ paw is still doing something · ● live (colour = sub-state) · ○ offline/asleep · ✓ done
 *   ✕ failed/refused/not found · ⚠ degraded, needs a human · ↻ trying again
 *
 * A problem line is `<glyph> <what happened> — <what paw is doing about it> · <what you can do>`,
 * one line, the reason in parentheses using a fixed word from {@link reasonWord} — never a raw library
 * string. Details (traces, attempt counts, raw errors) live behind /conn, --verbose or PAW_CONN_DEBUG.
 *
 * Leaf module: no imports (the chat pre-shell loads it before @cotal-ai/core).
 */

export const LOADER = "◌";
export const LIVE = "●";
export const OFF = "○";
export const OK = "✓";
export const FAIL = "✕";
export const WARN = "⚠";
export const RETRY = "↻";

/** The fixed reason words a connection problem is described with. Nothing else leaks to a screen. */
export type ReasonWord = "connection refused" | "no answer" | "hung up" | "no route" | "dns failed" | "rejected credentials" | "reconnecting";

const REASONS: Array<[RegExp, ReasonWord]> = [
  [/authoriz|authenticat|permission|not permitted|denied|expired|revoked|bad (creds|jwt)|invalid (creds|jwt|token)/i, "rejected credentials"],
  [/ECONNREFUSED|connection refused/i, "connection refused"],
  [/ENETUNREACH|EHOSTUNREACH|ENETDOWN|no route/i, "no route"],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "dns failed"],
  [/error connecting|closed before|ClosedConnectionError|mesh connection closed|connection (closed|lost|reset)|ECONNRESET|EPIPE|socket hang up|hung up/i, "hung up"],
  [/^timeout$|\btime[sd]? ?out\b|ETIMEDOUT|deadline-exceeded|no answer|not answering|TimeoutError/i, "no answer"],
  [/reconnect/i, "reconnecting"],
];

/** The fixed word for a connection error's text, or undefined when it matches none (the caller keeps
 *  the raw text then — fail loud, never a guessed word). */
export function reasonWord(text: string): ReasonWord | undefined {
  return REASONS.find(([re]) => re.test(text))?.[1];
}

/** {@link reasonWord}, falling back to the error's first clause (≤ 3 words) so an unknown error is
 *  still named on the line while its full text stays in /conn. */
export function reasonOf(text: string): string {
  const word = reasonWord(text);
  if (word) return word;
  const first = text.split(/[:\n(—]/)[0]!.trim().split(/\s+/).slice(0, 3).join(" ");
  return first || "unknown error";
}

/** `<glyph> <what> — <doing> · <can>`; empty slots are dropped with their separator. */
export function problemLine(glyph: string, what: string, doing?: string, can?: string): string {
  return `${glyph} ${what}${doing ? ` — ${doing}` : ""}${can ? ` · ${can}` : ""}`;
}

/** A duration as the screens say it: `4s`, `45s`, `2m`, `3h`. */
export function secsText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** The four presence words every surface uses for an agent: online · working · waiting · offline. */
export function presenceWord(status: string): "online" | "working" | "waiting" | "offline" {
  if (status === "working" || status === "busy") return "working";
  if (status === "waiting") return "waiting";
  if (status === "offline") return "offline";
  return "online";
}

/** Types for the build-free client helper in `context.js`, so the check suite can import it. */

/** The server's reading of the agent's context fill (src/transcript.ts `ContextUsage`). */
export interface ContextUsage {
  tokens: number;
  ts?: number;
  /** Present only when the transcript proved which window this session runs under. */
  limit?: number;
  limitFrom?: "autocompact" | "observed";
}

/** `ok` while there's room, `warn`/`high` approaching the window, `unknown` when no share is claimable. */
export type ContextLevel = "ok" | "warn" | "high" | "unknown";

export interface ContextChip {
  label: string;
  level: ContextLevel;
  title: string;
}

export const CTX_WARN: number;
export const CTX_HIGH: number;
export function fmtTokens(t: number): string;
export function contextChip(u: ContextUsage | undefined): ContextChip | null;

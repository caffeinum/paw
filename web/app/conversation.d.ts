/** Types for the build-free client helper in `conversation.js`, so the check suite can import it. */
export interface AgentRow {
  name: string;
  folder?: string;
}
export function orderTargets(input?: { channels?: string[]; rows?: AgentRow[]; filter?: string }): (string | null)[];
export function stepTarget(targets: (string | null)[], focus: string | null, delta: number): string | null;
export function firstUnreadTs(list: { ts: number; dir?: string; from?: string; text?: string }[], cursor: number | undefined, read?: Set<string>): number | undefined;
export function markScrollTop(input: { markTop: number; prevTop?: number | null; maxHeadroom?: number }): number;
export function draftKey(space: string, target: string): string;
export function recipientLabel(to: string | undefined | null, known?: string[]): string;
export function jumpScrollTop(input: { rowTop: number; rowHeight?: number; viewport?: number; maxHeadroom?: number; minMargin?: number }): number;

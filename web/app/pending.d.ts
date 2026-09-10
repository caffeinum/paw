/** Types for the build-free client helper in `pending.js`, so the check suite can import it. */
export interface PendingRow {
  /** Destination: an agent name, or `#channel` for a channel post. */
  to?: string;
  from?: string;
  channel?: string;
  text: string;
  ts?: number;
  dir?: string;
  state?: string;
}
export function isEchoed(pending: PendingRow, messages: PendingRow[], channelMessages: PendingRow[]): boolean;
export function survivingPending(pending: PendingRow[], messages: PendingRow[], channelMessages: PendingRow[]): PendingRow[];

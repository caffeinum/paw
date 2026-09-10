/** Types for the build-free client helper in `read-state.js`, so the check suite can import it. */
export interface ReadEntry {
  ts: number;
  from?: string;
  text?: string;
  dir?: string;
}
export function messageKey(m: ReadEntry): string;
export function loadRead(space: string): Set<string>;
export function saveRead(space: string, set: Set<string>): void;
export function isUnread(m: ReadEntry, cursor: number | undefined, read: Set<string>): boolean;
export function safeCursor(messages: ReadEntry[], cursor: number | undefined, read: Set<string>): number | undefined;

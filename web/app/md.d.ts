/** Types for the build-free client helper in `md.js`, so the check suite can import it. */
export function md(text: string, opts?: { gaps?: boolean }): string;
export function splitRow(line: string): string[];
export function parseAlign(line: string | undefined): string[] | undefined;

export interface Pr {
  number: number;
  url: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  branch?: string;
  additions?: number;
  deletions?: number;
  checks?: "pass" | "fail" | "pending";
}
export function prGlyph(pr: Pr): { glyph: string; cls: string; label: string };
export function checkGlyph(checks?: string): { glyph: string; cls: string; label: string } | undefined;
export function diffLabel(pr: Pr): string;
export function shouldRefetch(input: { folded?: boolean; lastAt?: number; now: number; everyMs?: number }): boolean;

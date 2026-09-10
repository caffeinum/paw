// Types for the build-free village.js so the test suite can import it without loosening the compiler.
export interface VillageRow {
  name: string;
  folder?: string;
  mesh?: string;
  live?: boolean;
  busy?: boolean;
  unregistered?: { agent: string };
  git?: { repo?: string; branch?: string; worktree?: boolean; mainPath?: string; dirty?: boolean };
}
export interface VillageTreeNode {
  name: string;
  children: Map<string, VillageTreeNode>;
  agents: Array<{ name: string; st: string }>;
}
export function placement(space: string, names: string[]): (name: string) => number;
export function segmentsFor(row: VillageRow, repoIndex?: Map<string, string[]>): string[];
export function buildTree(rows: VillageRow[]): VillageTreeNode;
export function crossRepo(
  edges: Array<{ a: string; b: string; count?: number }>,
  agentPos: Record<string, unknown>,
  rows: VillageRow[],
): Map<string, number>;
export function initVillage(opts: { onFocusAgent: (name: string) => void }): {
  open(): void;
  close(): void;
  isOpen(): boolean;
  update(space: string, rows: VillageRow[], data: unknown): void;
};

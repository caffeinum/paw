export const COLUMNS: Array<{ id: string; title: string; cls: string }>;
export function columnsFor<T extends { status: string }>(tasks: T[]): Array<{ id: string; title: string; cls: string; tasks: T[] }>;
export function initials(name: string | undefined): string;
export function initBoard(deps: { api: (path: string, opts?: unknown) => Promise<any>; el: (id: string) => HTMLElement; onSynced?: () => void }): {
  open: (tasks: any[]) => void;
  close: () => void;
  maybeRender: (tasks: any[], fetchedAt?: number) => void;
  isOpen: () => boolean;
};
export function childrenOf<T extends { id: string; parent?: string }>(tasks: T[], id: string): T[];

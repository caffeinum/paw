export function cycleStatus(status: string): string;
export function deletionPlan(hasId: boolean): "close" | "drop";
export function statusGlyph(status: string): string;
export interface TaskspadDeps {
  api: (path: string, opts?: unknown) => Promise<any>;
  el: (id: string) => HTMLElement;
  onSynced: () => void;
  onToggle?: () => void;
  loadOrder?: () => string[];
  saveOrder?: (ids: string[]) => void;
}
export function initTaskspad(deps: TaskspadDeps): {
  open: (tasks: Array<{ id: string; title: string; status: string }>) => void;
  close: () => void;
  maybeRender: (tasks: Array<{ id: string; title: string; status: string }>) => void;
  isOpen: () => boolean;
};
export function pasteLines(text: string): string[];
export function relTime(iso: string | undefined, now?: number): string;
export interface TreeTask {
  id: string;
  title?: string;
  status?: string;
  parent?: string;
}
export function treeOrder<T extends TreeTask>(tasks: T[]): T[];
export function taskDepth(t: TreeTask | undefined, byId: Map<string, TreeTask>): number;
// deps.agents?: () => string[] — names for @tag validation in the task message box
export function pasteOutline(text: string): Array<{ title: string; depth: number }>;
export function prChipHtml(t: { type?: string; externalRef?: string; pr?: { url: string; number: number; state?: string; isDraft?: boolean; checks?: string; title?: string } }, esc?: (s: unknown) => string): string;
export function closedLast<T extends { status?: string }>(tasks: T[]): T[];

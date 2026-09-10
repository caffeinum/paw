export interface TaskGlyph {
  glyph: string;
  cls: string;
  label: string;
}
export function taskGlyph(status: string | undefined): TaskGlyph;
export function parseTaskCommand(line: string): { title: string; description?: string } | undefined;
export function agentTasks<T extends { assignee?: string; createdBy?: string }>(tasks: T[], name: string): T[];

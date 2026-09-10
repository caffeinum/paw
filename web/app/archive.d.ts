export interface ArchivableRow {
  name: string;
  folder?: string;
}
export interface ArchivableMessage {
  from?: string;
  dir?: string;
  ts: number;
}
export type Archive = Record<string, number>;

export function loadArchive(space: string): Archive;
export function saveArchive(space: string, archive: Archive): void;
export function wokenSince(archive: Archive, messages: ArchivableMessage[]): string[];
export function pruneArchive(archive: Archive, messages: ArchivableMessage[]): { archive: Archive; changed: boolean; woken: string[] };
export function partitionRoster<T extends ArchivableRow>(
  rows: T[],
  archive: Archive,
  opts?: { focus?: string | null; filter?: string },
): { visible: T[]; archived: T[] };

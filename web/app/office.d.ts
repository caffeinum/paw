// Types for the build-free office.js (the 3D Office view). It imports three.js, so node never loads it;
// check:office covers its pure half (office-model.js).
import type { OfficeRow, VillageSnapshot } from "./office-model.js";

export function initOffice(opts: {
  onFocusAgent: (name: string) => void;
  avatarGlyph: (name: string) => string;
  loadVillage: () => Promise<VillageSnapshot>;
}): {
  open(): void;
  close(): void;
  isOpen(): boolean;
  update(space: string, rows: OfficeRow[], messages: Array<{ from: string; to?: string; text: string; ts: number; dir?: string }>): void;
  onMessage(entry: { from?: string; to?: string; text?: string; ts?: number; dir?: string; channel?: string }): void;
};

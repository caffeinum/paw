export interface PaletteItem { target: unknown; label: string; kind: "agent" | "channel" | "view"; status?: string; live?: boolean; busy?: boolean; hint?: string }
export function rankItems(items: PaletteItem[], query: string): PaletteItem[];
export function initPalette(opts: { getItems: () => PaletteItem[]; onPick: (target: unknown, kind: string) => void }): {
  open(): void; close(): void; isOpen(): boolean; toggle(): void;
};

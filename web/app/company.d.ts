export function initCompany(deps: {
  api: (path: string, opts?: unknown) => Promise<any>;
  el: (id: string) => HTMLElement;
  rows: () => Array<{ name: string; folder?: string; mesh: string; live: boolean; busy?: boolean }>;
  avatarColor: (name: string) => string;
  md?: (text: string) => string;
  build: string;
  navigate: (path: string) => void;
  onSubState?: () => void;
  onOpenChannel: (slug: string) => void;
  onFocusAgent?: (name: string) => void;
  openNav?: () => void;
}): {
  showCompany: (slug: string, sub?: { layout?: string; issue?: string; fromUrl?: boolean }) => void;
  showNew: (prefill?: string) => void;
  close: () => void;
  isOpen: () => boolean;
  query: () => URLSearchParams;
  onKey: (e: KeyboardEvent) => boolean;
  tick: () => void;
  loadCompanies: () => Promise<Array<{ slug: string; name: string; members?: string[] }>>;
};

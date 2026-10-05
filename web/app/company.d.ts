import type { CompanyLoc } from "./company-model.js";

export function initCompany(deps: {
  api: (path: string, opts?: unknown) => Promise<any>;
  el: (id: string) => HTMLElement;
  rows: () => Array<{ name: string; folder?: string; mesh: string; live: boolean; busy?: boolean }>;
  md?: (text: string) => string;
  build: string;
  space?: () => string;
  navigate: (path: string) => void;
  onSubState?: () => void;
  onOpenChannel: (slug: string) => void;
  openNav?: () => void;
  onLoaded?: (payload: any) => void;
  openLeadChat?: (lead: string | undefined) => void;
  lastMessage?: (name: string) => string | undefined;
}): {
  show: (loc: { page: "new"; prefill?: string } | CompanyLoc, sub?: { bead?: string; view?: string; fromUrl?: boolean }) => void;
  close: () => void;
  isOpen: () => boolean;
  query: () => URLSearchParams;
  onKey: (e: KeyboardEvent) => boolean;
  data: () => any;
  scope: () => Set<string> | undefined;
  companiesError: () => string | undefined;
  tick: () => void;
  loadCompanies: () => Promise<Array<{ slug: string; name: string; members?: string[]; onYou?: number }>>;
};

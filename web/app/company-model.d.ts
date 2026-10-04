export interface CoBead {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  updatedAt?: string;
  unlabelled?: boolean;
}
export interface CoMember { name: string; live: boolean; busy: boolean; state: string; known: boolean }
export interface AgentGroup<T = CoBead> { key: string; kind: "operator" | "member" | "other" | "unassigned"; name: string; member?: CoMember; open: T[]; done: T[]; waiting?: Array<{ bead: T; blocker: T }> }
export interface OnYou { assigned: string[]; waiting: Array<{ id: string; blocker: string }>; count?: number }
export interface StatusGroup<T = CoBead> { key: string; name: string; beads: T[] }

export const GLYPH: Record<string, string>;
export const STATUS_LABEL: Record<string, string>;
export const VIEWS: string[];
export const SLUG_RE: RegExp;
export function slugify(name: string): string;
export function beadOrder(a: CoBead, b: CoBead): number;
export function groupByAgent<T extends CoBead>(members: CoMember[], issues: T[], operator?: string, onYou?: OnYou): AgentGroup<T>[];
export function groupByStatus<T extends CoBead>(issues: T[], onYouIds?: Set<string>): StatusGroup<T & { onYou?: boolean }>[];
export function leadOf(form: { members?: string[]; lead?: string }): string | undefined;
export function parseView(v: unknown): "agent" | "status";
export function newCompanyProblems(form: { name?: string; slug?: string; members?: string[]; lead?: string }, takenSlugs: Set<string>): string[];
export function parseMention(text: string): { to: string; text: string } | undefined;
export function parsePath(pathname: string): { page: "new" } | { page: "company"; slug: string } | undefined;

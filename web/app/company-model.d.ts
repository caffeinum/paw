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
export interface SetupState { failed: Array<{ name: string; error: string; gone?: boolean }>; card?: string; kickoff?: string }
export function setupFrom(r: { failed?: Array<{ name: string; error: string; gone?: boolean }>; cardError?: string; kickoffError?: string } | undefined): SetupState | undefined;
export function retryPlan(setup: SetupState | undefined): { names: string[]; card: boolean; kickoff: boolean };
export function mergeRetry(prev: SetupState | undefined, plan: { names: string[]; card: boolean; kickoff: boolean }, r: { failed?: Array<{ name: string; error: string; gone?: boolean }>; cardError?: string; kickoffError?: string } | undefined): SetupState | undefined;
export function shortAge(t: number, now?: number): string;
export function rowMeta(b: { createdAt?: string; createdBy?: string; assignee?: string }, now?: number): { from?: string; age: string; text: string };
export function prUrls(bead: { externalRef?: string; description?: string }, comments?: Array<{ text?: string }>): string[];
export function parseView(v: unknown): "agent" | "status";
export function newCompanyProblems(form: { name?: string; slug?: string; members?: string[]; lead?: string }, takenSlugs: Set<string>): string[];
export function parseMention(text: string): { to: string; text: string } | undefined;
export interface Milestone<T = CoBead> { id: string | undefined; title: string; assignee?: string; status?: string; beads: T[]; done: number; total: number }
export function milestones<T extends CoBead & { parent?: string; type?: string }>(issues: T[], epic: string): Milestone<T>[];
export function milestoneOf<T extends CoBead & { parent?: string; type?: string }>(bead: T, byId: Map<string, T>, epic: string): T | undefined;
export function workBeads<T extends { parent?: string; type?: string }>(issues: T[], epic: string): T[];
export type CompanyLevel = "home" | "tasks" | "activity" | "chat" | "trace" | "channel";
export interface CompanyLoc { page: "company"; slug: string; agent?: string; level: CompanyLevel }
export function parsePath(pathname: string): { page: "new" } | CompanyLoc | undefined;
export function companyPath(loc: { slug: string; agent?: string; level: CompanyLevel }): string;
export function shellLevel(level: string | undefined): boolean;
export function staleThreads(issues: Array<{ id: string; comments?: number }>, byId: Record<string, unknown[]> | undefined): string[];
export function presence(row: { live?: boolean; mesh: string; busy?: boolean; tool?: { name?: string } } | undefined): { kind: "working" | "idle" | "asleep" | "offline" | "unknown"; title: string };

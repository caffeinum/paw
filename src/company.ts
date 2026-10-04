/**
 * Companies for `paw web` (docs/notes/company-spec.md, MVP §0): a company is ONE bd epic + ONE cotal
 * channel.
 *
 * No other storage. The epic carries ONE label, `company:<slug>`, which bd INHERITS into every child
 * created under it — so an agent's plain `bd create --parent <epic>` is in the company for free. The
 * roster lives in the epic's METADATA `{company, org:{<agent>:{}}}`, which does NOT inherit (as labels,
 * every child would carry member junk). Lead = assignee (the first picked agent), mission = description.
 */
import { userInfo } from "node:os";
import type { Task } from "./tasks.ts";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Agent names as they appear as org keys and bd assignees. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "vibeOS Labs!" → "vibeos-labs". Pure. Empty when nothing usable is left — the caller says so. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 41)
    .replace(/-+$/, "");
}

export interface Company {
  slug: string;
  name: string;
  epic: string;
  lead?: string;
  mission?: string;
  status: string;
  /** Agent names — the keys of `metadata.org`, in bd's order (bd re-orders JSON keys; never rely on it). */
  members: string[];
  createdAt?: string;
  /** Malformed `metadata.org`, in words — rendered as a banner, never repaired. */
  problem?: string;
}

/** The metadata a fresh company epic carries. Each member is `{}` — roles/reporting are LATER, and
 *  the object shape leaves room for them without a migration. Pure. */
export function companyMetadata(slug: string, members: string[]): Record<string, unknown> {
  return { company: slug, org: Object.fromEntries(members.map((m) => [m, {}])) };
}

/** A bead → the company it roots, or undefined when it carries no `metadata.company`. A root whose
 *  `org` is malformed still comes back — with `problem` set. Pure. */
export function companyFromTask(t: Task): Company | undefined {
  const md = t.metadata;
  if (!md || typeof md.company !== "string" || !md.company) return undefined;
  const problems: string[] = [];
  let members: string[] = [];
  const org = md.org;
  if (org === undefined) problems.push("metadata.org is missing");
  else if (!org || typeof org !== "object" || Array.isArray(org)) problems.push("metadata.org is not an object");
  else {
    members = Object.keys(org);
    for (const [name, v] of Object.entries(org as Record<string, unknown>)) if (!v || typeof v !== "object" || Array.isArray(v)) problems.push(`metadata.org["${name}"] is not an object`);
  }
  return {
    slug: md.company,
    name: t.title,
    epic: t.id,
    lead: t.assignee,
    mission: t.description,
    status: t.status,
    createdAt: t.createdAt,
    members,
    ...(problems.length ? { problem: problems.join("; ") } : {}),
  };
}

/** A company's metadata with roster key `from` renamed to `to`, member order and every other key kept.
 *  Unchanged (same object) when `from` isn't a member. Pure. */
export function renameInMetadata(md: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const org = md.org;
  if (!org || typeof org !== "object" || Array.isArray(org) || !(from in org)) return md;
  if (to in org) throw new Error(`"${to}" is already on the roster of company "${String(md.company)}" — merge by hand`);
  return { ...md, org: Object.fromEntries(Object.entries(org as Record<string, unknown>).map(([k, v]) => [k === from ? to : k, v])) };
}

/** Every company among some rows (non-roots dropped), by name. Pure. */
export function companiesFrom(tasks: Task[]): Company[] {
  return tasks.map(companyFromTask).filter((c): c is Company => !!c).sort((a, b) => a.name.localeCompare(b.name));
}

export interface CreateCompanyInput {
  name: string;
  slug: string;
  mission?: string;
  /** Picked agents. */
  members: string[];
  /** One of `members` — the epic's assignee, the CEO everyone reports to. */
  lead: string;
}

/** Validate a /new submission. The problem in words, or undefined. Pure. */
export function validateCompany(input: CreateCompanyInput, knownAgents: Set<string>, takenSlugs: Set<string>): string | undefined {
  if (!input.name.trim()) return "a company needs a name";
  if (!SLUG_RE.test(input.slug)) return `slug "${input.slug}" must match ${SLUG_RE.source}`;
  if (takenSlugs.has(input.slug)) return `company "${input.slug}" already exists`;
  if (!input.members.length) return "pick at least one agent";
  const seen = new Set<string>();
  for (const m of input.members) {
    if (!NAME_RE.test(m)) return `"${m}" is not a usable agent name`;
    if (seen.has(m)) return `"${m}" is listed twice`;
    seen.add(m);
    if (!knownAgents.has(m)) return `no agent named "${m}" in this space`;
  }
  if (!seen.has(input.lead)) return `the lead "${input.lead}" must be one of the picked agents`;
  return undefined;
}

export interface CompanyIssue extends Task {
  /** In the company by ANCESTRY only — the bead lacks `company:<slug>` (an agent created it with
   *  `--no-inherit-labels`, or it was reparented in). Listed, flagged, never silently treated as in. */
  unlabelled?: boolean;
}

/** The company's beads: the labelled set ∪ unlabelled descendants of the epic (from the global list),
 *  the epic itself excluded. Pure. */
export function companyIssues(company: Company, labelled: Task[], global: Task[]): CompanyIssue[] {
  const byId = new Map<string, Task>();
  for (const t of labelled) byId.set(t.id, t);
  const labelledIds = new Set(labelled.map((t) => t.id));
  const parentOf = new Map<string, string | undefined>();
  for (const t of [...global, ...labelled]) parentOf.set(t.id, t.parent);
  const underRoot = (id: string): boolean => {
    let cur = parentOf.get(id);
    for (let i = 0; cur !== undefined && i < 12; i++) {
      if (cur === company.epic) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };
  for (const t of global) if (!byId.has(t.id) && underRoot(t.id)) byId.set(t.id, t);
  const out: CompanyIssue[] = [];
  for (const t of byId.values()) {
    if (t.id === company.epic) continue;
    out.push(labelledIds.has(t.id) ? { ...t } : { ...t, unlabelled: true });
  }
  return out;
}

/** The company brief (§6): the channel's `instructions` and the kickoff post. The reporting rules are
 *  the point — members report to the lead; only the lead escalates to the operator, by filing a bead
 *  assigned to them (and a `blocks` dep when work waits on it). Pure. */
export function companyBrief(c: Pick<Company, "slug" | "name" | "mission" | "lead" | "members" | "epic">, operator: string): string {
  const lead = c.lead ?? "—";
  return [
    `#${c.slug} is the ${c.name} company.${c.mission ? ` Mission: ${c.mission}` : ""}`,
    `Lead (CEO): ${lead} — makes the decisions. Members: ${c.members.join(", ")}.  Operator: ${operator} (a human).`,
    `How we work:`,
    `- report to ${lead} by DM: progress, questions, blockers. Do not DM ${operator} for status.`,
    `- ${operator} gives work to ${lead} in chat; ${lead} turns it into beads and assigns them.`,
    `- ${lead} keeps milestones: bd create "<milestone>" -t epic --parent ${c.epic} -l goal; work for a`,
    `  milestone goes under it (--parent <milestone-id>). Progress = closed/total of its subtree.`,
    `- only ${lead} escalates to ${operator}: bd create "<decision needed>" --parent ${c.epic} -a ${operator}`,
    `  -d "<context, options, recommendation>"; if work waits on it: bd dep add <waiting-id> <that-id>.`,
    `  ${operator} answers by commenting and closing that bead, which unblocks the waiting work.`,
    `Work lives in beads (your BEADS_DIR):`,
    `- every bead for this company carries company:${c.slug} — create under the company: --parent ${c.epic}`,
    `  (the label is inherited) or add -l company:${c.slug}.`,
    `- your queue: bd list --label company:${c.slug} -a <you>`,
    `- claim before starting (--status in_progress), close with a reason, comment handoffs on the bead.`,
    `- ask a teammate for work by filing a bead assigned to them.`,
    `Talk here in #${c.slug}; DMs for 1:1 with ${lead}.`,
  ].join("\n");
}

export interface OnYou {
  /** Open beads assigned to the operator. */
  assigned: string[];
  /** Open beads waiting (a `blocks` dep) on an open operator bead, with that blocker's id. */
  waiting: Array<{ id: string; blocker: string }>;
  /** Distinct beads blocked on the operator: assigned ∪ waiting. */
  count: number;
}

/** "Blocked on you" (spec §0): pure over the company's beads. A closed operator bead blocks nothing —
 *  closing it is the unblock, with no further write. */
export function onYou(issues: Task[], operator: string): OnYou {
  const mine = new Set(issues.filter((t) => t.status !== "closed" && t.assignee === operator).map((t) => t.id));
  const waiting: Array<{ id: string; blocker: string }> = [];
  for (const t of issues) {
    if (t.status === "closed" || mine.has(t.id)) continue;
    const blocker = (t.waitsOn ?? []).find((id) => mine.has(id));
    if (blocker) waiting.push({ id: t.id, blocker });
  }
  return { assigned: [...mine], waiting, count: mine.size + waiting.length };
}

/** The one DM an assignment sends (§5.4). Pure. */
export function assignmentText(companyName: string, id: string, title: string): string {
  return `${companyName}: you've been assigned ${id} — ${title}. bd show ${id} for details; claim it with bd update ${id} --status in_progress.`;
}

/** The operator's bd name — assigning to them never DMs. `PAW_OPERATOR`, else the OS login (the live
 *  list already uses it as the operator's assignee). The page shows the resolved name. */
export function operatorName(): string {
  const v = process.env.PAW_OPERATOR?.trim();
  return v ? v : userInfo().username;
}

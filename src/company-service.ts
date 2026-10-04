/**
 * The company routes' behaviour (docs/notes/company-spec.md §0 MVP, §4) over bd + the mesh.
 * Everything mesh-shaped is INJECTED (`CompanyDeps`) so web.ts wires the real endpoint and a check can
 * wire fakes; bd goes through tasks.ts's serialized chain. Errors carry bd's/cotal's own words.
 *
 * Only what the MVP page calls exists: list, create, page, and the ops `issue-create` and
 * `retry-channel`. Member/role/goal/filing ops come back WITH their UI (spec §0 LATER).
 */
import { assignmentText, companiesFrom, companyBrief, companyIssues, companyMetadata, onYou, validateCompany, type Company, type CompanyIssue, type CreateCompanyInput, type OnYou } from "./company.ts";
import { createTaskGetId, listByMetadata, listLabelPattern, listLabelled, listTasks, writeGeneration, type Task } from "./tasks.ts";
import type { AgentStatus } from "./status.ts";

export interface CompanyDeps {
  operator: string;
  /** The roster the server already polls. */
  rows: () => Promise<AgentStatus[]>;
  dm: (to: string, text: string) => Promise<unknown>;
  post: (channel: string, text: string) => Promise<void>;
  /** Write the channel's registry card (description + instructions). */
  seedChannel: (slug: string, description: string, instructions: string) => Promise<void>;
  /** The /api/invite behaviour: DM each, sequentially; announce the reached ones in the channel. */
  invite: (slug: string, names: string[]) => Promise<{ invited: string[]; failed: { name: string; error: string }[] }>;
}

export interface MemberView {
  name: string;
  live: boolean;
  busy: boolean;
  /** mesh display state, or "unknown" when the name isn't in the roster at all (a stale name). */
  state: string;
  known: boolean;
}

export interface CompanyPayload {
  company: Company;
  operator: string;
  members: MemberView[];
  issues: CompanyIssue[];
  onYou: OnYou;
  errors: string[];
}

/** A sidebar row: the company plus how many of its beads are blocked on the operator. */
export type CompanyRow = Company & { onYou: number };

export interface SetupResult {
  invited: string[];
  failed: { name: string; error: string }[];
  channelError?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TTL_MS = 15_000;

export function companyService(deps: CompanyDeps) {
  let listCache: { at: number; gen: number; companies: CompanyRow[] } | undefined;
  const pageCache = new Map<string, { at: number; gen: number; payload: CompanyPayload }>();

  /** Every company + its "on you" count: TWO bd calls total (the roots, and every company's open
   *  beads by label glob), never one per company. */
  async function companies(): Promise<CompanyRow[]> {
    if (listCache && listCache.gen === writeGeneration() && Date.now() - listCache.at < TTL_MS) return listCache.companies;
    const roots = companiesFrom(await listByMetadata({ hasKey: "company" }));
    const open = await listLabelPattern("company:*");
    const list = roots.map((c) => ({ ...c, onYou: onYou(open.filter((t) => t.id !== c.epic && (t.labels ?? []).includes(`company:${c.slug}`)), deps.operator).count }));
    listCache = { at: Date.now(), gen: writeGeneration(), companies: list };
    return list;
  }

  /** Exactly one root for `slug`, else 404 / 409 naming every id. */
  async function root(slug: string): Promise<Company> {
    const rows = companiesFrom(await listByMetadata({ field: ["company", slug] })).filter((c) => c.slug === slug);
    if (!rows.length) throw new HttpError(404, `no company "${slug}"`);
    if (rows.length > 1) throw new HttpError(409, `${rows.length} company epics claim "${slug}": ${rows.map((c) => c.epic).join(", ")} — keep one (bd update <id> --unset-metadata company)`);
    return rows[0];
  }

  /** Channel card → invites → kickoff. Every step runs; failures are COLLECTED and returned, never thrown —
   *  the bead already exists and is the record, so the page offers a retry instead of pretending. */
  async function setupChannel(c: Company): Promise<SetupResult> {
    const brief = companyBrief(c, deps.operator);
    const errs: string[] = [];
    try {
      await deps.seedChannel(c.slug, (c.mission ?? c.name).split("\n")[0].slice(0, 200), brief);
    } catch (e) {
      errs.push(`channel registry: ${(e as Error).message}`);
    }
    let inv: { invited: string[]; failed: { name: string; error: string }[] } = { invited: [], failed: [] };
    try {
      inv = await deps.invite(c.slug, c.members);
    } catch (e) {
      errs.push(`invite: ${(e as Error).message}`);
    }
    try {
      await deps.post(c.slug, brief);
    } catch (e) {
      errs.push(`kickoff post: ${(e as Error).message}`);
    }
    return { ...inv, ...(errs.length ? { channelError: errs.join("; ") } : {}) };
  }

  async function create(input: CreateCompanyInput): Promise<{ slug: string; epic: string } & SetupResult> {
    const taken = new Set((await companies()).map((c) => c.slug));
    const known = new Set((await deps.rows()).map((r) => r.name));
    const problem = validateCompany(input, known, taken);
    if (problem) throw new HttpError(400, problem);
    const name = input.name.trim();
    const mission = input.mission?.trim() || undefined;
    const lead = input.lead;
    const epic = await createTaskGetId(name, mission, undefined, lead, { type: "epic", labels: [`company:${input.slug}`], metadata: companyMetadata(input.slug, input.members) });
    listCache = undefined;
    const c: Company = { slug: input.slug, name, epic, lead, mission, status: "open", members: input.members };
    return { slug: c.slug, epic, ...(await setupChannel(c)) };
  }

  async function page(slug: string, fresh = false): Promise<CompanyPayload> {
    const hit = pageCache.get(slug);
    if (!fresh && hit && hit.gen === writeGeneration() && Date.now() - hit.at < TTL_MS) return hit.payload;
    const company = await root(slug);
    const errors: string[] = [];
    if (company.problem) errors.push(company.problem);
    const labelled = await listLabelled([`company:${slug}`]);
    let global: Task[] = [];
    try {
      global = await listTasks();
    } catch (e) {
      errors.push(`couldn't read the global list for unlabelled descendants: ${(e as Error).message}`);
    }
    const issues = companyIssues(company, labelled, global);
    const byName = new Map((await deps.rows()).map((r) => [r.name, r]));
    // lead first, then bd's key order (which bd itself re-sorts — so the page sorts the rest by name)
    const names = [...company.members].sort((a, b) => (a === company.lead ? -1 : b === company.lead ? 1 : a.localeCompare(b)));
    const members: MemberView[] = names.map((name) => {
      const r = byName.get(name);
      return { name, live: !!r?.live, busy: !!r?.busy || r?.mesh === "working", state: r ? r.mesh : "unknown", known: !!r };
    });
    const payload: CompanyPayload = { company, operator: deps.operator, members, issues, onYou: onYou(issues, deps.operator), errors };
    pageCache.set(slug, { at: Date.now(), gen: writeGeneration(), payload });
    return payload;
  }

  async function op(slug: string, body: Record<string, unknown>): Promise<unknown> {
    const c = await root(slug);
    const str = (k: string): string | undefined => (typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim() : undefined);
    switch (body.op) {
      case "issue-create": {
        const title = str("title");
        if (!title) throw new HttpError(400, "issue-create needs a title");
        const assignee = str("assignee");
        if (assignee && assignee !== deps.operator && !c.members.includes(assignee)) throw new HttpError(400, `${assignee} isn't a member of ${slug}`);
        const parent = str("parent") ?? c.epic;
        if (parent !== c.epic && !(await page(slug, true)).issues.some((i) => i.id === parent)) throw new HttpError(400, `${parent} isn't one of ${slug}'s beads`);
        const id = await createTaskGetId(title, str("description"), parent, assignee, { labels: [`company:${slug}`] });
        if (!assignee || assignee === deps.operator) return { id };
        try {
          await deps.dm(assignee, assignmentText(c.name, id, title));
          return { id, nudged: assignee };
        } catch (e) {
          return { id, nudgeError: (e as Error).message }; // the bead exists; the failed nudge is said, not hidden
        }
      }
      case "retry-channel":
        return setupChannel(c);
      default:
        throw new HttpError(400, `unknown op "${String(body.op)}"`);
    }
  }

  return { companies, create, page, op };
}

export type CompanyService = ReturnType<typeof companyService>;

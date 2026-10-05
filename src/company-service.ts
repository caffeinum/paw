/**
 * The company routes' behaviour (docs/notes/company-spec.md §0 MVP, §4) over bd + the mesh.
 * Everything mesh-shaped is INJECTED (`CompanyDeps`) so web.ts wires the real endpoint and a check can
 * wire fakes; bd goes through tasks.ts's serialized chain. Errors carry bd's/cotal's own words.
 *
 * Only what the MVP page calls exists: list, create, page, and the ops `issue-create` and
 * `retry-channel`. Member/role/goal/filing ops come back WITH their UI (spec §0 LATER).
 */
import { renameInMetadata, assignmentText, companiesFrom, companyBrief, companyIssues, companyMetadata, onYou, validateCompany, type Company, type CompanyIssue, type CreateCompanyInput, type OnYou } from "./company.ts";
import { closeTask, commentTask, createTaskGetId, mutateMetadata, updateTask, listByMetadata, listLabelled, listTasks, listTasksSWR, writeGeneration, type Task } from "./tasks.ts";
import type { AgentStatus } from "./status.ts";

export interface CompanyDeps {
  operator: string;
  /** The roster the server already polls. */
  rows: () => Promise<AgentStatus[]>;
  dm: (to: string, text: string) => Promise<unknown>;
  post: (channel: string, text: string) => Promise<void>;
  /** Write the channel's registry card (description + instructions). */
  seedChannel: (slug: string, description: string, instructions: string) => Promise<void>;
  /** Channels that already exist on the mesh (registry ∪ traffic seen). A company may not claim one:
   *  its card would be overwritten, everyone invited and the brief posted there. */
  channels: () => string[];
  /** A member's registered folder when it no longer exists on disk (undefined = fine / unregistered). */
  folderGone?: (name: string) => string | undefined;
  /** The /api/invite behaviour: DM each, sequentially; announce the reached ones in the channel. */
  invite: (slug: string, names: string[]) => Promise<{ invited: string[]; failed: FailedInvite[] }>;
}

export interface MemberView {
  name: string;
  live: boolean;
  busy: boolean;
  /** mesh display state, or "unknown" when the name isn't in the roster at all (a stale name). */
  state: string;
  known: boolean;
  /** Its registered folder, when that folder no longer exists — the page offers "remove from company". */
  gone?: string;
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

export interface FailedInvite {
  name: string;
  error: string;
  /** The agent's registered folder is gone (e.g. a /tmp folder wiped by a reboot) — a retry can't
   *  help; the page offers "remove from company" instead. */
  gone?: boolean;
}

export interface SetupResult {
  invited: string[];
  failed: FailedInvite[];
  /** Per step, so a retry redoes only what failed. */
  cardError?: string;
  kickoffError?: string;
  /** All step errors joined (card · invite-call · kickoff) — the one-line summary. */
  channelError?: string;
}

/** What a setup run should (re)do. A fresh company does everything; a retry only what failed. */
export interface SetupSteps {
  card: boolean;
  /** Members to (re)invite. */
  invite: string[];
  kickoff: boolean;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TTL_MS = 15_000;

/** `paw rename`: every company whose roster holds `from` gets `to` instead (whole-metadata rewrite),
 *  and a company `from` leads gets `to` as its assignee (reassignOpenTasks only moves OPEN beads).
 *  Returns the slugs touched. */
export async function renameInCompanies(from: string, to: string): Promise<string[]> {
  const touched: string[] = [];
  for (const c of companiesFrom(await listByMetadata({ hasKey: "company" }))) {
    if (!c.members.includes(from) && c.lead !== from) continue;
    if (c.members.includes(from)) await mutateMetadata(c.epic, (md) => renameInMetadata(md, from, to));
    if (c.lead === from) await updateTask(c.epic, { assignee: to });
    touched.push(c.slug);
  }
  return touched;
}

export function companyService(deps: CompanyDeps) {
  let listCache: { at: number; gen: number; companies: CompanyRow[] } | undefined;
  const pageCache = new Map<string, { at: number; gen: number; payload: CompanyPayload }>();

  /** Every OPEN company + its "on you" count, computed EXACTLY as the page does (companyIssues → onYou)
   *  over the cached global list — the sidebar number and the page's never disagree. Closed (archived)
   *  companies drop out of the list; their pages still open by slug. */
  async function companies(): Promise<CompanyRow[]> {
    if (listCache && listCache.gen === writeGeneration() && Date.now() - listCache.at < TTL_MS) return listCache.companies;
    const roots = companiesFrom(await listByMetadata({ hasKey: "company", openOnly: true }));
    const global = await listTasksSWR();
    const list = roots.map((c) => ({ ...c, onYou: onYou(companyIssues(c, global.filter((t) => (t.labels ?? []).includes(`company:${c.slug}`)), global), deps.operator).count }));
    listCache = { at: Date.now(), gen: writeGeneration(), companies: list };
    return list;
  }

  /**
   * The company's labelled beads AND its root, from ONE `bd list -l company:<slug>` (the epic carries
   * the label), plus the shared global list for unlabelled descendants. Roots are also looked for in the
   * global list (an open duplicate WITHOUT the label still fails loud); the slow `--metadata-field`
   * scan runs only when nothing was found (a 404 must be sure) or when the caller asks for `fresh`.
   */
  async function locate(slug: string, fresh: boolean): Promise<{ company: Company; labelled: Task[]; global: Task[]; globalError?: string }> {
    const labelled = await listLabelled([`company:${slug}`]);
    let global: Task[] = [];
    let globalError: string | undefined;
    try {
      global = fresh ? await listTasks() : await listTasksSWR();
    } catch (e) {
      globalError = `couldn't read the global list for unlabelled descendants: ${(e as Error).message}`;
    }
    const byEpic = new Map<string, Company>();
    // global first, labelled last: the labelled list was JUST read, the global one may be minutes old (SWR)
    for (const c of companiesFrom([...global, ...labelled])) if (c.slug === slug) byEpic.set(c.epic, c);
    if (fresh || !byEpic.size) for (const c of companiesFrom(await listByMetadata({ field: ["company", slug] }))) if (c.slug === slug) byEpic.set(c.epic, c);
    const rows = [...byEpic.values()];
    if (!rows.length) throw new HttpError(404, `no company "${slug}"`);
    if (rows.length > 1) throw new HttpError(409, `${rows.length} company epics claim "${slug}": ${rows.map((c) => c.epic).join(", ")} — keep one (bd update <id> --unset-metadata company)`);
    return { company: rows[0], labelled, global, ...(globalError ? { globalError } : {}) };
  }

  /** Exactly one root for `slug`, else 404 / 409 naming every id. */
  async function root(slug: string): Promise<Company> {
    return (await locate(slug, false)).company;
  }

  /** Channel card → invites → kickoff. Every step runs; failures are COLLECTED and returned, never thrown —
   *  the bead already exists and is the record, so the page offers a retry instead of pretending. */
  async function setupChannel(c: Company, steps: SetupSteps = { card: true, invite: c.members, kickoff: true }): Promise<SetupResult> {
    const brief = companyBrief(c, deps.operator);
    const errs: string[] = [];
    let cardError: string | undefined;
    let kickoffError: string | undefined;
    if (steps.card) {
      try {
        await deps.seedChannel(c.slug, (c.mission ?? c.name).split("\n")[0].slice(0, 200), brief);
      } catch (e) {
        cardError = `channel registry: ${(e as Error).message}`;
        errs.push(cardError);
      }
    }
    let inv: { invited: string[]; failed: FailedInvite[] } = { invited: [], failed: [] };
    if (steps.invite.length) {
      try {
        inv = await deps.invite(c.slug, steps.invite);
      } catch (e) {
        // the whole call failed: every asked member is still un-invited, so a retry asks them again
        inv = { invited: [], failed: steps.invite.map((name) => ({ name, error: (e as Error).message })) };
        errs.push(`invite: ${(e as Error).message}`);
      }
    }
    if (steps.kickoff) {
      try {
        await deps.post(c.slug, brief);
      } catch (e) {
        kickoffError = `kickoff post: ${(e as Error).message}`;
        errs.push(kickoffError);
      }
    }
    return { ...inv, ...(cardError ? { cardError } : {}), ...(kickoffError ? { kickoffError } : {}), ...(errs.length ? { channelError: errs.join("; ") } : {}) };
  }

  async function create(input: CreateCompanyInput): Promise<{ slug: string; epic: string } & SetupResult> {
    // Before any bd call: #general (every persona subscribes) or any existing channel would be hijacked.
    if (input.slug === "general" || deps.channels().includes(input.slug)) throw new HttpError(409, `#${input.slug} is already a channel on this mesh — a company needs a channel of its own; pick another name`);
    // the open list (cached) + a direct lookup of THIS slug, so a closed company's slug isn't reused
    const taken = new Set((await companies()).map((c) => c.slug));
    if (!taken.has(input.slug) && companiesFrom(await listByMetadata({ field: ["company", input.slug] })).length) taken.add(input.slug);
    const known = new Set((await deps.rows()).map((r) => r.name));
    const problem = validateCompany(input, known, taken);
    if (problem) throw new HttpError(400, problem);
    const name = input.name.trim();
    const mission = input.mission?.trim() || undefined;
    const lead = input.lead;
    const epic = await createTaskGetId(name, mission, undefined, lead, { type: "epic", labels: [`company:${input.slug}`], metadata: companyMetadata(input.slug, input.members), actor: deps.operator });
    listCache = undefined;
    const c: Company = { slug: input.slug, name, epic, lead, mission, status: "open", members: input.members };
    return { slug: c.slug, epic, ...(await setupChannel(c)) };
  }

  async function page(slug: string, fresh = false): Promise<CompanyPayload> {
    const hit = pageCache.get(slug);
    if (!fresh && hit && hit.gen === writeGeneration() && Date.now() - hit.at < TTL_MS) return hit.payload;
    const { company, labelled, global, globalError } = await locate(slug, fresh);
    const errors: string[] = [];
    if (company.problem) errors.push(company.problem);
    if (globalError) errors.push(globalError);
    const issues = companyIssues(company, labelled, global);
    const byName = new Map((await deps.rows()).map((r) => [r.name, r]));
    // lead first, then bd's key order (which bd itself re-sorts — so the page sorts the rest by name)
    const names = [...company.members].sort((a, b) => (a === company.lead ? -1 : b === company.lead ? 1 : a.localeCompare(b)));
    const members: MemberView[] = names.map((name) => {
      const r = byName.get(name);
      const gone = deps.folderGone?.(name);
      return { name, live: !!r?.live, busy: !!r?.busy || r?.mesh === "working", state: r ? r.mesh : "unknown", known: !!r, ...(gone ? { gone } : {}) };
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
        if (parent !== c.epic && !(await page(slug)).issues.some((i) => i.id === parent)) throw new HttpError(400, `${parent} isn't one of ${slug}'s beads`);
        const id = await createTaskGetId(title, str("description"), parent, assignee, { labels: [`company:${slug}`], actor: deps.operator });
        if (!assignee || assignee === deps.operator) return { id };
        try {
          await deps.dm(assignee, assignmentText(c.name, id, title));
          return { id, nudged: assignee };
        } catch (e) {
          return { id, nudgeError: (e as Error).message }; // the bead exists; the failed nudge is said, not hidden
        }
      }
      case "comment": {
        // the operator's comment, attributed to the operator (bd --actor), not to git's user.name
        const id = str("id");
        const text = str("text");
        if (!id || !text) throw new HttpError(400, "comment needs {id, text}");
        await commentTask(id, text, deps.operator);
        return { ok: true };
      }
      case "status": {
        // Open · In progress · Blocked · Done · Not needed — for ANY company bead. Done / Not needed close
        // it; the optional reason is the close reason AND a comment (one submit). bd's refusal (an open
        // blocker…) propagates verbatim. Closing a bead someone else holds DMs them once.
        const id = str("id");
        const to = str("to");
        if (!id || !to) throw new HttpError(400, "status needs {id, to}");
        const bead = (await page(slug)).issues.find((i) => i.id === id);
        if (!bead) throw new HttpError(400, `${id} isn't one of ${slug}'s beads`);
        const reason = str("reason");
        if (to === "done" || to === "not-needed") {
          const closeReason = to === "not-needed" ? `not needed${reason ? `: ${reason}` : ""}` : (reason ?? "done");
          await closeTask(id, closeReason, deps.operator);
          if (reason) await commentTask(id, to === "not-needed" ? `closed as not needed: ${reason}` : reason, deps.operator);
          const holder = bead.assignee;
          if (holder && holder !== deps.operator && bead.status !== "closed") {
            try {
              await deps.dm(holder, `${deps.operator} closed ${id} (${bead.title}) as ${closeReason}.`);
              return { ok: true, nudged: holder };
            } catch (e) {
              return { ok: true, nudgeError: (e as Error).message };
            }
          }
          return { ok: true };
        }
        if (!["open", "in_progress", "blocked"].includes(to)) throw new HttpError(400, `unknown status "${to}"`);
        await updateTask(id, { status: to }, deps.operator);
        return { ok: true };
      }
      case "retry-channel": {
        // ONLY what failed: the named members (still on the roster), the card / kickoff if asked.
        // Never a blanket re-run — that would re-DM every agent that already got its invite.
        const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string" && c.members.includes(n)) : [];
        const steps: SetupSteps = { card: body.card === true, invite: names, kickoff: body.kickoff === true };
        if (!steps.card && !steps.kickoff && !names.length) throw new HttpError(400, "retry-channel: name what to retry — {names, card, kickoff}");
        return setupChannel(c, steps);
      }
      case "member-remove": {
        // The one roster edit the MVP has: drop a member (e.g. one whose folder is gone). The agent itself
        // is untouched; its beads keep their assignee.
        const name = str("name");
        if (!name || !c.members.includes(name)) throw new HttpError(400, `${name ?? "?"} isn't a member of ${slug}`);
        if (name === c.lead) throw new HttpError(400, `${name} is the lead — a company can't lose its lead here`);
        await mutateMetadata(c.epic, (md) => {
          const org = md.org && typeof md.org === "object" && !Array.isArray(md.org) ? { ...(md.org as Record<string, unknown>) } : {};
          delete org[name];
          return { ...md, org };
        });
        listCache = undefined;
        return { ok: true, removed: name };
      }
      default:
        throw new HttpError(400, `unknown op "${String(body.op)}"`);
    }
  }

  return { companies, create, page, op };
}

export type CompanyService = ReturnType<typeof companyService>;

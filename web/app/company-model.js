/**
 * Pure shaping for the company page (docs/notes/company-spec.md §0 MVP): who holds which bead, in a
 * form every view renders — "By agent" (Simple 2) and "By status" (Simple 3). A column-per-agent view
 * (Simple 1) would reuse groupByAgent unchanged. Tested in check:web.
 */

export const GLYPH = { open: "○", in_progress: "◐", blocked: "⊘", deferred: "❄", closed: "✓" };
export const STATUS_LABEL = { open: "To do", in_progress: "In progress", blocked: "Blocked", deferred: "Deferred", closed: "Done" };
const STATUS_ORDER = { in_progress: 0, blocked: 1, open: 2, deferred: 3, closed: 9 };
/** The company page's views; each renders the SAME payload. "columns" slots in here later. */
export const VIEWS = ["agent", "status"];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** "vibeOS Labs!" → "vibeos-labs" — mirrors src/company.ts slugify. */
export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 41)
    .replace(/-+$/, "");
}

const ts = (s) => (s ? Date.parse(s) : NaN);

/** Within a group: in progress, blocked, to do, (other); newest update first. Closed sort last. */
export function beadOrder(a, b) {
  const s = (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5);
  if (s) return s;
  return (ts(b.updatedAt) || 0) - (ts(a.updatedAt) || 0);
}

/**
 * Beads grouped by holder: the OPERATOR first ("You" — an implicit member of every company), then one
 * group per member (server order — lead first), then any OTHER assignee that holds a company bead
 * (`kind: "other"` — an outsider or a stale name, shown as itself, never folded into someone else),
 * then Unassigned at the end (only when non-empty). Each group splits `open` (not closed) and `done`
 * (closed — the page collapses it). Every bead lands in exactly one group by assignee; the You group
 * ALSO carries `waiting` — other members' beads blocked on an operator bead (a reference, not a move),
 * each with its blocker.
 */
export function groupByAgent(members, issues, operator, onYou = { assigned: [], waiting: [] }) {
  const groups = new Map();
  const byId = new Map(issues.map((i) => [i.id, i]));
  if (operator) {
    const waiting = onYou.waiting.map((w) => ({ bead: byId.get(w.id), blocker: byId.get(w.blocker) })).filter((w) => w.bead && w.blocker);
    groups.set(operator, { key: "you", kind: "operator", name: operator, open: [], done: [], waiting });
  }
  for (const m of members) if (m.name !== operator) groups.set(m.name, { key: `agent:${m.name}`, kind: "member", name: m.name, member: m, open: [], done: [] });
  const others = new Map();
  const unassigned = { key: "unassigned", kind: "unassigned", name: "Unassigned", open: [], done: [] };
  for (const i of issues) {
    let g;
    if (!i.assignee) g = unassigned;
    else if (groups.has(i.assignee)) g = groups.get(i.assignee);
    else g = others.get(i.assignee) ?? others.set(i.assignee, { key: `other:${i.assignee}`, kind: "other", name: i.assignee, open: [], done: [] }).get(i.assignee);
    (i.status === "closed" ? g.done : g.open).push(i);
  }
  const out = [...groups.values(), ...[...others.values()].sort((a, b) => a.name.localeCompare(b.name))];
  if (unassigned.open.length || unassigned.done.length) out.push(unassigned);
  for (const g of out) {
    g.open.sort(beadOrder);
    g.done.sort(beadOrder);
  }
  return out;
}

/** Beads grouped by status: In progress, Blocked, To do, Done — every bead in exactly one (an unknown
 *  status lands in To do rather than vanishing). A bead blocked ON THE OPERATOR (`onYouIds`: assigned
 *  to them, or waiting on such a bead — bd leaves those `open`) sits in Blocked, flagged `onYou`. */
export function groupByStatus(issues, onYouIds = new Set()) {
  const cols = [
    { key: "in_progress", name: "In progress", beads: [] },
    { key: "blocked", name: "Blocked", beads: [] },
    { key: "open", name: "To do", beads: [] },
    { key: "closed", name: "Done", beads: [] },
  ];
  const by = new Map(cols.map((c) => [c.key, c]));
  for (const i of issues) {
    if (i.status !== "closed" && onYouIds.has(i.id)) by.get("blocked").beads.push({ ...i, onYou: true });
    else (by.get(i.status) ?? by.get("open")).beads.push(i);
  }
  for (const c of cols) c.beads.sort(beadOrder);
  return cols;
}

/** A milestone = an epic whose parent is the company epic (the `goal` label is optional — agents make
 *  them with plain `bd create -t epic --parent`). Each carries done/total over its WHOLE subtree, from
 *  the company list (which includes closed beads, so the count isn't cut to a week), and its direct +
 *  deeper beads. Beads directly under the epic that aren't milestones form a final "No milestone" row
 *  (`id: undefined`), only when there are any. Pure. */
export function milestones(issues, epic) {
  const kids = new Map();
  for (const i of issues) if (i.parent) (kids.get(i.parent) ?? kids.set(i.parent, []).get(i.parent)).push(i);
  const subtree = (id) => {
    const out = [];
    const walk = (p, depth) => {
      for (const k of kids.get(p) ?? []) {
        out.push(k);
        if (depth < 12) walk(k.id, depth + 1);
      }
    };
    walk(id, 0);
    return out;
  };
  const isMilestone = (i) => i.parent === epic && i.type === "epic";
  const rows = issues
    .filter(isMilestone)
    .map((m) => {
      const beads = subtree(m.id);
      return { id: m.id, title: m.title, assignee: m.assignee, status: m.status, beads: beads.sort(beadOrder), done: beads.filter((b) => b.status === "closed").length, total: beads.length };
    })
    .sort((a, b) => (a.status === "closed") - (b.status === "closed") || a.title.localeCompare(b.title));
  const loose = issues.filter((i) => i.parent === epic && !isMilestone(i));
  if (loose.length) {
    const beads = loose.flatMap((l) => [l, ...subtree(l.id)]);
    rows.push({ id: undefined, title: "No milestone", beads: beads.sort(beadOrder), done: beads.filter((b) => b.status === "closed").length, total: beads.length });
  }
  return rows;
}

/** The beads the Work views list: everything but the milestones themselves (they have their own block). */
export function workBeads(issues, epic) {
  return issues.filter((i) => !(i.parent === epic && i.type === "epic"));
}

/** The milestone a bead sits under (its nearest ancestor that is a milestone), or undefined. */
export function milestoneOf(bead, byId, epic) {
  let cur = bead.parent ? byId.get(bead.parent) : undefined;
  for (let i = 0; cur && i < 12; i++) {
    if (cur.parent === epic && cur.type === "epic") return cur;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return undefined;
}

/**
 * The persisted "setup didn't finish" state of a company: `{failed:[{name,error,gone?}], card?, kickoff?}`
 * (card/kickoff = that step's error). `setupFrom(result)` builds it from a create / retry response,
 * `undefined` when nothing failed. Pure.
 */
export function setupFrom(r) {
  const st = { failed: Array.isArray(r?.failed) ? r.failed.filter((f) => f && typeof f.name === "string") : [] };
  if (r?.cardError) st.card = r.cardError;
  if (r?.kickoffError) st.kickoff = r.kickoffError;
  return st.failed.length || st.card || st.kickoff ? st : undefined;
}

/** What a retry should redo: ONLY the failed steps, and only the failed members whose folder still
 *  exists (a gone folder can't be fixed by retrying). Pure. */
export function retryPlan(setup) {
  return { names: (setup?.failed ?? []).filter((f) => !f.gone).map((f) => f.name), card: !!setup?.card, kickoff: !!setup?.kickoff };
}

/** Fold a retry's response into the previous state: the retried members/steps take the new outcome,
 *  everything not retried (the gone members) stays. Pure. */
export function mergeRetry(prev, plan, r) {
  const retried = new Set(plan.names);
  const kept = (prev?.failed ?? []).filter((f) => !retried.has(f.name));
  return setupFrom({ failed: [...kept, ...(r?.failed ?? [])], cardError: plan.card ? r?.cardError : prev?.card, kickoffError: plan.kickoff ? r?.kickoffError : prev?.kickoff });
}

/** A stored view name → itself, or "agent" (the default) when nothing/something stale is stored. A
 *  remembered UI preference, not data — a stale value falls back rather than failing the page. */
export function parseView(v) {
  return VIEWS.includes(v) ? v : "agent";
}

/** Which form errors block Create on /new (in words), or [] when it can go. */
export function newCompanyProblems(form, takenSlugs) {
  const out = [];
  const lead = leadOf(form);
  if (!String(form.name ?? "").trim()) out.push("name the company");
  if (!SLUG_RE.test(form.slug ?? "")) out.push("slug must be lowercase letters, digits and dashes");
  else if (takenSlugs.has(form.slug)) out.push(`#${form.slug} already exists`);
  if (!(form.members ?? []).length) out.push("pick at least one agent");
  else if (!lead) out.push("pick a lead");
  return out;
}

/** The /new lead: the chosen one while still picked, else the first picked agent. */
export function leadOf(form) {
  const members = form.members ?? [];
  return members.includes(form.lead) ? form.lead : members[0];
}

/** `@agent rest` at the start of a comment → {to, text}; anything else → undefined (a plain comment). */
export function parseMention(text) {
  const m = /^@([A-Za-z0-9][A-Za-z0-9._-]*)\s+([\s\S]+)$/.exec(String(text ?? "").trim());
  return m ? { to: m[1], text: m[2].trim() } : undefined;
}

/** The parsed path: `/new` → {page:"new"}, `/company/<slug>` → {page:"company", slug}, else undefined. */
export function parsePath(pathname) {
  if (pathname === "/new" || pathname === "/new/") return { page: "new" };
  const m = /^\/company\/([^/]+)(?:\/([^/]+)(?:\/(dialog|trace))?)?\/?$/.exec(pathname);
  if (!m) return undefined;
  try {
    const slug = decodeURIComponent(m[1]);
    if (!m[2]) return { page: "company", slug, level: "home" };
    return { page: "company", slug, agent: decodeURIComponent(m[2]), level: m[3] ?? "tasks" };
  } catch {
    return undefined;
  }
}

/** The inverse of parsePath for a company location. */
export function companyPath(loc) {
  const base = `/company/${encodeURIComponent(loc.slug)}`;
  if (!loc.agent || loc.level === "home") return base;
  return `${base}/${encodeURIComponent(loc.agent)}${loc.level === "dialog" || loc.level === "trace" ? `/${loc.level}` : ""}`;
}

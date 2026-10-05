/**
 * The company pages (docs/notes/company-spec.md §0, look S1–S9 / company-simple-views.html), inside
 * paw web's own shell so the lead chat, Dialog and Trace are the REAL renderers (app.js owns those):
 *
 *   /new                              create a company
 *   /company/<slug>                   home: team, You, chat with the lead (app.js's chat in a right
 *                                     column ≥1100px), milestones, Work (By agent | By status)
 *   /company/<slug>/<agent>           Tasks — that agent's beads, By status
 *   /company/<slug>/<agent>/dialog    Dialog — app.js renders /api/dialog in #msgs; this draws the bar
 *   /company/<slug>/<agent>/trace     Trace — app.js's renderTrace; this draws the bar
 *   …?bead=<id>                       the bead panel over any of them
 *
 * This module owns `#company` (home/tasks/new) and `#cobar` (the breadcrumb + Tasks·Dialog·Trace tabs
 * over Dialog/Trace). Data: GET /api/company/<slug>, POST op `issue-create` (+ ONE DM nudge,
 * server-side, never to the operator) / `retry-channel`; beads via /api/tasks `comments`/`comment`/
 * `close`. Never rebuilds under the caret; refusals show the server's own words; nothing is invented.
 */
import {
  GLYPH,
  STATUS_LABEL,
  VIEWS,
  SLUG_RE,
  groupByAgent,
  groupByStatus,
  leadOf,
  milestoneOf,
  milestones,
  newCompanyProblems,
  parseMention,
  parseView,
  slugify,
  workBeads,
  companyPath,
  shellLevel,
  rowMeta,
  setupFrom,
  retryPlan,
  mergeRetry,
} from "./company-model.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const POLL_MS = 15_000;
const VIEW_LABEL = { agent: "By agent", status: "By status" };
const TABS = [
  ["tasks", "Tasks"],
  ["activity", "Activity"],
  ["chat", "Chat"],
  ["trace", "Trace"],
];

function rel(t, now = Date.now()) {
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** localStorage, never trusted: every access may throw (private mode, blocked site data). */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, v) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* UI state only — losing it is cosmetic */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* same */
    }
  },
};

export function initCompany(deps) {
  const root = deps.el("company");
  const bar = deps.el("cobar");
  const head = deps.el("cohead");
  const modal = deps.el("comodal");
  const s = {
    page: undefined, // "company" | "new"
    slug: undefined,
    agent: undefined,
    level: "home",
    data: undefined,
    error: undefined,
    view: "agent",
    bead: undefined,
    thread: undefined, // {id, comments?, error?}
    adding: undefined, // whose "+ Add" input is open
    open: new Set(), // expanded milestone ids (this visit)
    note: new Map(), // bead id / "add:<who>" / "err:<id>" → {ok, text}
    closing: false,
    setup: undefined, // {failed:[{name,error,gone}], card?, kickoff?} — persisted per company until dismissed
    companies: [],
    form: undefined,
    steps: undefined,
  };
  let pollTimer;
  let seq = 0;

  // per SPACE too: two spaces share one browser origin (same rule as drafts / read-state)
  const k = (name) => `paw.company.${deps.space?.() ?? ""}.${s.slug}.${name}`;
  const kNew = () => `paw.company.${deps.space?.() ?? ""}.new.draft`;
  const post = (path, body) => deps.api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const editing = () => {
    const a = document.activeElement;
    return !!a && (root.contains(a) || modal.contains(a)) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  };
  const isMember = (d, name) => name === d.operator || d.members.some((m) => m.name === name);

  /**
   * Stale-while-revalidate, in the browser: the last payload of each company (and the company list)
   * is kept in localStorage per space, painted INSTANTLY on open with an "updating…" mark, and replaced
   * by every successful fetch (which re-writes the cache — it is a copy of server data, never a source).
   * A FAILED refresh never passes cached data off as current: the page keeps it but says the refresh
   * failed and how old it is.
   */
  const cacheKey = (slug) => `paw.company.${deps.space?.() ?? ""}.${slug}.cache`;
  const listKey = () => `paw.company.${deps.space?.() ?? ""}.list.cache`;

  /** Paint from the localStorage copy (payload + company list) when the space is known and there is one. */
  function adoptCache() {
    if (!deps.space?.()) return;
    if (!s.data) {
      const cached = store.get(cacheKey(s.slug), undefined);
      if (cached && typeof cached === "object" && cached.data?.company?.slug === s.slug) {
        s.data = cached.data;
        s.cachedAt = cached.at; // set ⇒ what's on screen is a copy awaiting its refresh
        deps.onLoaded?.(s.data);
      }
    }
    if (!s.companies.length) {
      const list = store.get(listKey(), []);
      if (Array.isArray(list)) s.companies = list;
    }
  }

  async function load(fresh = false) {
    if (s.page !== "company") return;
    const mine = ++seq;
    try {
      const d = await deps.api(`/api/company/${encodeURIComponent(s.slug)}${fresh ? "?fresh=1" : ""}`);
      if (mine !== seq) return; // a newer read, or a navigation, superseded this one
      s.data = d;
      s.cachedAt = undefined;
      s.error = undefined;
      store.set(cacheKey(s.slug), { at: Date.now(), data: d });
      deps.onLoaded?.(d);
    } catch (e) {
      if (mine !== seq) return;
      s.error = String(e?.message ?? e);
      if (/^no company "/.test(s.error)) {
        s.data = undefined; // gone for real — a cached copy must not keep it alive
        store.del(cacheKey(s.slug));
      }
    }
    paint();
  }

  async function loadCompanies() {
    try {
      s.companies = (await deps.api("/api/companies")).companies ?? [];
      s.companiesError = undefined;
      store.set(listKey(), s.companies);
    } catch (e) {
      s.companiesError = String(e?.message ?? e);
    }
    return s.companies;
  }

  /* ── navigation ─────────────────────────────────────────────────────────────────────────── */

  /** Show a location: {page:"new", prefill} or {page:"company", slug, agent?, level} (+ sub-state
   *  from the URL: bead, view). Idempotent for the same location — render() calls it every tick. */
  function show(loc, sub = {}) {
    if (loc.page === "new") return showNew(loc.prefill);
    const sameCompany = s.page === "company" && s.slug === loc.slug;
    const sameLoc = sameCompany && s.agent === loc.agent && s.level === loc.level;
    if (sameLoc && !sub.fromUrl) return place();
    if (!sameCompany) {
      s.page = "company";
      s.slug = loc.slug;
      s.data = undefined;
      s.cachedAt = undefined;
      s.error = undefined;
      adoptCache();
      s.open = new Set();
      store.del(k("banner")); // the pre-structured banner string; gone members now come from the server
      s.setup = store.get(k("setup"), undefined);
      if (!s.setup || !Array.isArray(s.setup.failed)) s.setup = undefined;
      clearInterval(pollTimer);
      pollTimer = setInterval(() => void load(), POLL_MS);
      void load();
      void loadCompanies().then(() => paint());
    }
    s.agent = loc.agent;
    s.level = loc.level;
    s.adding = undefined;
    s.view = sub.view ? parseView(sub.view) : parseView(store.get(k("view"), undefined));
    if (sub.fromUrl && sub.bead !== s.bead) {
      if (!sub.bead) s.pushed = false; // Back closed it
      s.bead = sub.bead;
      if (s.bead) void loadThread(s.bead);
    }
    paint(true);
  }

  function showNew(prefill) {
    clearInterval(pollTimer);
    if (s.page === "new") return place();
    s.page = "new";
    s.slug = undefined;
    s.steps = undefined;
    const blank = { name: "", slug: "", slugEdited: false, mission: "", members: [], lead: undefined, filter: "" };
    const draft = store.get(kNew(), undefined);
    s.form = draft && typeof draft === "object" && Array.isArray(draft.members) ? { ...blank, ...draft } : blank;
    if (prefill) {
      s.form.slug = prefill;
      s.form.slugEdited = true;
      if (!s.form.name) s.form.name = prefill;
    }
    void loadCompanies().then(() => paint());
    paint(true);
  }

  function close() {
    clearInterval(pollTimer);
    modal.hidden = true;
    modal.innerHTML = "";
    document.body.classList.remove("co-modal-open");
    head.innerHTML = "";
    s.page = undefined;
    s.slug = undefined;
    s.bead = undefined;
    root.hidden = true;
    root.innerHTML = "";
    bar.hidden = true;
    bar.innerHTML = "";
  }

  /** The URL sub-state this page owns; app.js writes the path. */
  function query() {
    const q = new URLSearchParams();
    if (s.page === "company" && s.bead) q.set("bead", s.bead);
    return q;
  }
  const go = (loc) => deps.navigate(companyPath({ slug: s.slug, ...loc }));

  /* ── painting ───────────────────────────────────────────────────────────────────────────── */

  /** Which surface is visible: #company for new/home/tasks (and the not-a-member page), #cobar over
   *  app.js's own Dialog/Trace. The bead panel rides #company, so it can open over Dialog/Trace too. */
  function place() {
    // Over Dialog/Trace the shell's own renderers paint — but never for someone outside the company:
    // a stranger gets the "not in" page painted over everything instead.
    const stranger = s.page === "company" && s.agent && s.data && !isMember(s.data, s.agent);
    const overDialog = s.page === "company" && shellLevel(s.level) && !stranger;
    root.hidden = !s.page;
    root.classList.toggle("co-overlay-only", overDialog); // only the panel paints over the real chat/trace
    root.classList.toggle("co-home", s.page === "company" && s.level === "home");
    bar.hidden = !overDialog;
  }

  function paint(force = false) {
    if (!s.page) return;
    place();
    if (!force && editing()) return; // never under the caret — the next poll catches up
    const keep = [...root.querySelectorAll("[data-scroll]"), ...modal.querySelectorAll("[data-scroll]")].map((el) => [el.dataset.scroll, el.scrollTop]);
    // a rebuild destroys the focused node — remember WHICH control had focus and give it back after
    const act = document.activeElement;
    const inside = act && (root.contains(act) || modal.contains(act)) ? act : undefined;
    const focusKey = inside ? ["data-open", "data-act", "data-status", "data-view", "data-level"].map((a) => (inside.hasAttribute(a) ? `[${a}="${CSS.escape(inside.getAttribute(a))}"]` : "")).find(Boolean) : undefined;
    const focusIn = inside && modal.contains(inside) ? modal : root;
    root.innerHTML = s.page === "new" ? newHtml() : companyHtml();
    head.innerHTML = headHtml();
    const mHtml = s.page === "company" ? modalHtml(s.data) : "";
    modal.hidden = !mHtml;
    modal.innerHTML = mHtml;
    document.body.classList.toggle("co-modal-open", !!mHtml);
    bar.innerHTML = s.page === "company" && shellLevel(s.level) ? crumbsHtml() : "";
    for (const [key, top] of keep) {
      const el = root.querySelector(`[data-scroll="${key}"]`) ?? modal.querySelector(`[data-scroll="${key}"]`);
      if (el) el.scrollTop = top;
    }
    if (focusKey) focusIn.querySelector(focusKey)?.focus({ preventScroll: true });
  }

  const rowsByName = () => new Map((deps.rows() ?? []).map((r) => [r.name, r]));
  function dot(name) {
    const r = rowsByName().get(name);
    const live = !!r && r.live && r.mesh !== "offline";
    return `<span class="co-dot${live ? " live" : ""}" title="${esc(!r ? "not in this space's roster" : live ? r.mesh : "asleep — a DM wakes it")}"></span>`;
  }
  const errLine = (text, retry) => `<p class="co-bad">${esc(text)}${retry ? ` <button class="co-link" data-act="${retry}">retry</button>` : ""}</p>`;

  /** The company pages' own slim header (the global sidebar + filter bar are hidden here — a company
   *  view is scoped): ← paw, the company, a switcher when there's more than one, New company. */
  function headHtml() {
    const list = s.companies ?? [];
    const here = s.page === "company" ? s.slug : undefined;
    const name = s.page === "new" ? "New company" : (s.data?.company.name ?? s.slug ?? "");
    const home = here ? companyPath({ slug: here, level: "home" }) : "/new";
    const switcher =
      list.length > 1 || (list.length === 1 && list[0].slug !== here)
        ? `<select class="co-switch" data-input="switch" aria-label="Switch company">${here ? "" : `<option value="" selected>Switch to…</option>`}${list.map((c) => `<option value="${esc(c.slug)}"${c.slug === here ? " selected" : ""}>${esc(c.name)}${c.onYou ? ` · ${c.onYou} on you` : ""}</option>`).join("")}</select>`
        : "";
    const mark =
      s.page === "company" && s.cachedAt
        ? s.error
          ? `<span class="co-stale co-bad" title="${esc(s.error)}">couldn't refresh — showing a copy from ${esc(rel(s.cachedAt))}</span>`
          : `<span class="co-stale">updating…</span>`
        : "";
    return `<a class="co-back" href="/" data-nav="/" title="back to paw">← paw</a><a class="co-cname" href="${esc(home)}" data-nav="${esc(home)}">${esc(name)}</a>${mark}<span class="co-hgap"></span>${switcher}${here ? `<a class="co-small co-chanlink" href="${esc(companyPath({ slug: here, level: "channel" }))}" data-nav="${esc(companyPath({ slug: here, level: "channel" }))}" title="the company channel">#${esc(here)}</a>` : ""}${s.page === "new" ? "" : `<a class="co-small" href="/new" data-nav="/new">New company</a>`}`;
  }

  function crumbsHtml() {
    const name = s.data?.company.name ?? s.slug;
    if (s.level === "channel")
      return `<div class="co-crumbs"><a href="${esc(companyPath({ slug: s.slug, level: "home" }))}" data-nav="${esc(companyPath({ slug: s.slug, level: "home" }))}">${esc(name)}</a> › #${esc(s.slug)} <span class="co-dim">— the company channel; everyone in ${esc(name)} reads it</span></div>`;
    const tabs = TABS.map(([lv, label]) => `<button data-level="${lv}" aria-pressed="${s.level === lv}">${label}</button>`).join("");
    return `<div class="co-crumbs"><a href="${esc(companyPath({ slug: s.slug, level: "home" }))}" data-nav="${esc(companyPath({ slug: s.slug, level: "home" }))}">${esc(name)}</a> › ${esc(s.agent === s.data?.operator ? `You (${s.agent})` : s.agent)}</div><nav class="co-views co-tabs" aria-label="Agent view">${tabs}</nav>`;
  }

  function companyHtml() {
    const d = s.data;
    if (!d) {
      if (s.error && /^no company "/.test(s.error))
        return `<div class="co-wrap" data-scroll="page"><div class="co-col"><h1>No company “${esc(s.slug)}”</h1><p class="co-dim"><a href="/new?name=${encodeURIComponent(s.slug)}" data-nav="/new?name=${esc(encodeURIComponent(s.slug))}">Create it</a></p></div></div>`;
      if (s.error) return `<div class="co-wrap" data-scroll="page"><div class="co-col"><h1>${esc(s.slug)}</h1>${errLine(s.error, "retry")}</div></div>`;
      return skeletonHtml();
    }
    if (s.agent && !isMember(d, s.agent))
      return `<div class="co-wrap" data-scroll="page"><div class="co-col"><h1>${esc(s.agent)} is not in ${esc(s.slug)}</h1><p><a href="${esc(companyPath({ slug: s.slug, level: "home" }))}" data-nav="${esc(companyPath({ slug: s.slug, level: "home" }))}">Back to ${esc(d.company.name)}</a></p></div></div>`;
    if (shellLevel(s.level)) return ""; // app.js paints the body (members only — see place())
    return s.level === "tasks" ? tasksHtml(d) : homeHtml(d);
  }

  /** No payload yet and no cached copy: a quiet skeleton, never a blank page. Whatever the company
   *  LIST already knows (name, mission, members — from its own localStorage copy) fills in for real. */
  function skeletonHtml() {
    const row = s.companies.find((c) => c.slug === s.slug);
    const team = row?.members?.length
      ? `<p class="co-team">${row.members.map((m) => `${esc(m)}${m === row.lead ? " ★" : ""}${dot(m)}`).join(" &nbsp;·&nbsp; ")}</p>`
      : `<p class="co-team"><span class="co-skel" style="width:60%"></span></p>`;
    const rows = [72, 55, 64, 48, 58].map((w) => `<div class="co-bead"><span class="co-st">○</span><span class="co-skel" style="width:${w}%"></span></div>`).join("");
    return `<div class="co-wrap" data-scroll="page"><div class="co-col co-loading">
      <header class="co-header"><div class="co-title"><h1>${esc(row?.name ?? s.slug)}</h1>${row?.mission ? `<p class="co-mission">${esc(row.mission)}</p>` : ""}</div></header>
      ${team}
      <section class="co-work"><div class="co-workhead"><h2>Work</h2><span class="co-dim co-small">loading…</span></div>${rows}</section>
    </div></div>`;
  }

  /** The lead of `slug` as far as anything local knows: the payload, its cached copy, the company list. */
  function leadFor(slug) {
    if (s.data?.company.slug === slug && s.data.company.lead) return s.data.company.lead;
    const cached = store.get(cacheKey(slug), undefined);
    if (cached?.data?.company?.slug === slug && cached.data.company.lead) return cached.data.company.lead;
    const list = s.companies.length ? s.companies : store.get(listKey(), []);
    return Array.isArray(list) ? list.find((c) => c?.slug === slug)?.lead : undefined;
  }

  function banners(d) {
    return [s.error ? errLine(s.error, "retry") : "", ...(d.errors ?? []).map((e) => errLine(e)), setupHtml()].join("");
  }

  function saveSetup(st) {
    s.setup = st;
    if (st) store.set(k("setup"), st);
    else store.del(k("setup"));
  }

  /** "Setup didn't finish": what failed, in words. Retry redoes ONLY the failed steps/members; a member
   *  whose folder is gone gets "remove from company" instead (a retry can't fix that). */
  function setupHtml() {
    const st = s.setup;
    if (!st) return "";
    const plan = retryPlan(st);
    const lines = [
      st.card ? `<li>${esc(st.card)}</li>` : "",
      ...st.failed.map((f) =>
        f.gone
          ? `<li>${esc(f.error)} — <button class="co-link" data-act="member-remove" data-name="${esc(f.name)}">remove from company</button></li>`
          : `<li>${esc(f.name)}: ${esc(f.error)}</li>`,
      ),
      st.kickoff ? `<li>${esc(st.kickoff)}</li>` : "",
    ].join("");
    const canRetry = plan.names.length || plan.card || plan.kickoff;
    return `<div class="co-bad co-setup"><p>Setup didn't finish${st.note ? ` — ${esc(st.note)}` : ""}:</p><ul>${lines}</ul><p>${canRetry ? `<button class="co-link" data-act="retry-channel">retry ${plan.names.length ? `${plan.names.length} invite${plan.names.length === 1 ? "" : "s"}` : "setup"}</button> · ` : ""}<button class="co-link" data-act="dismiss">dismiss</button></p></div>`;
  }

  function beadRow(b, d, { who = false, milestone = false, waitingOn } = {}) {
    const note = s.note.get(b.id);
    const byId = new Map(d.issues.map((i) => [i.id, i]));
    const ms = milestone ? milestoneOf(b, byId, d.company.epic) : undefined;
    const onYou = b.onYou ? `<span class="co-acc co-tag">on you</span>` : "";
    return `<div class="co-bead${b.status === "closed" ? " done" : ""}${s.bead === b.id ? " sel" : ""}" data-open="${esc(b.id)}" tabindex="0" role="button">
      <span class="co-st" title="${esc(STATUS_LABEL[b.status] ?? b.status)}">${GLYPH[b.status] ?? "?"}</span>
      <span class="co-t">${esc(b.title)}${waitingOn ? ` <span class="co-dim">← ${esc(waitingOn.title)}</span>` : ""}</span>
      ${onYou}
      ${b.unlabelled ? `<span class="co-tag co-bad" title="under the company epic but missing the company:${esc(s.slug)} label">unlabelled</span>` : ""}
      ${note ? `<span class="co-tag${note.ok ? "" : " co-bad"}" title="${esc(note.text)}">${note.ok ? "nudged" : "nudge failed"}</span>` : ""}
      ${ms ? `<span class="co-tag co-ms">${esc(ms.title)}</span>` : ""}
      ${who ? `<span class="co-tag">${b.assignee ? esc(b.assignee === d.operator ? "you" : b.assignee) : "unassigned"}</span>` : ""}
      ${rmeta(b, d)}</div>`;
  }

  /** The right-aligned "from <agent> · 3d" slot every row shares (the agent links to its page). */
  function rmeta(b, d) {
    const m = rowMeta(b);
    if (!m.text) return "";
    const from = m.from ? `from ${d.members.some((x) => x.name === m.from) ? `<a href="${esc(companyPath({ slug: s.slug, agent: m.from, level: "tasks" }))}" data-nav="${esc(companyPath({ slug: s.slug, agent: m.from, level: "tasks" }))}">${esc(m.from)}</a>` : esc(m.from)} · ` : "";
    return `<span class="co-rmeta" title="created ${esc(b.createdAt ? new Date(b.createdAt).toLocaleString() : "")}${b.createdBy ? ` by ${esc(b.createdBy)}` : ""}">${from}${esc(m.age)}</span>`;
  }

  function adder(name, d) {
    const note = s.note.get(`add:${name}`);
    const err = note ? `<p class="co-bad co-small">${esc(note.text)}</p>` : "";
    const label = name === d.operator ? "yourself" : name;
    if (s.adding === name) return `<input class="co-addin" data-input="add" data-agent="${esc(name)}" placeholder="New bead for ${esc(label)}" value="${esc(store.get(k(`draft.add.${name}`), ""))}">${err}`;
    return `<button class="co-link co-add" data-act="add" data-agent="${esc(name)}">+ Add</button>${err}`;
  }

  function homeHtml(d) {
    const c = d.company;
    const work = workBeads(d.issues, c.epic);
    const counts = (n) => {
      const mine = work.filter((b) => b.assignee === n && b.status !== "closed");
      return mine.length ? ` <span class="co-dim">${mine.length} open</span>` : "";
    };
    const team = `<p class="co-team">${d.members.map((m) => `<a class="co-name" href="${esc(companyPath({ slug: c.slug, agent: m.name, level: "tasks" }))}" data-nav="${esc(companyPath({ slug: c.slug, agent: m.name, level: "tasks" }))}">${esc(m.name)}${m.name === c.lead ? " ★" : ""}</a>${dot(m.name)}${counts(m.name)}`).join(" &nbsp;·&nbsp; ")}</p>`;
    // A member whose folder is gone (e.g. /tmp wiped by a reboot) can't be woken: say so, offer the fix.
    const goneHtml = d.members
      .filter((m) => m.gone)
      .map((m) => `<p class="co-bad co-small">${esc(m.name)}'s folder ${esc(m.gone)} no longer exists${m.name === c.lead ? " — it's the lead; re-register its folder (paw adopt / paw claude in a new folder)" : ` — <button class="co-link" data-act="member-remove" data-name="${esc(m.name)}">remove from company</button>`}</p>`)
      .join("");
    const byId = new Map(d.issues.map((i) => [i.id, i]));
    const mine = d.onYou.assigned.map((id) => byId.get(id)).filter(Boolean);
    const waiting = d.onYou.waiting.map((w) => ({ bead: byId.get(w.id), blocker: byId.get(w.blocker) })).filter((w) => w.bead && w.blocker);
    const you = d.onYou.count
      ? `<section class="co-group co-you"><h2>You <span class="co-acc co-norm">· ${d.onYou.count}</span> <span class="co-dim co-norm">(${esc(d.operator)})</span></h2>${mine.map((b) => beadRow(b, d)).join("")}${waiting.length ? `<h3 class="co-sub">waiting on you</h3>${waiting.map((w) => beadRow(w.bead, d, { who: true, waitingOn: w.blocker })).join("")}` : ""}</section>`
      : "";
    const lead = c.lead;
    const last = lead ? deps.lastMessage?.(lead) : undefined;
    const chatRow = lead ? `<button class="co-chatrow" data-act="lead-chat"><span>Chat with ${esc(lead)} →</span>${last ? `<span class="co-dim co-last">${esc(last)}</span>` : ""}</button>` : `<p class="co-bad">this company has no lead (the epic has no assignee)</p>`;
    const ms = milestones(d.issues, c.epic);
    const msHtml = ms.length
      ? `<section class="co-group"><h2>Milestones</h2>${ms
          .map((m) => {
            const key = m.id ?? "none";
            const open = s.open.has(key);
            const pct = m.total ? (100 * m.done) / m.total : 0;
            return `<div class="co-ms-row" data-act="ms" data-ms="${esc(key)}" aria-expanded="${open}"><span class="co-t">${esc(m.title)}</span>${m.assignee ? `<span class="co-dim co-small">${esc(m.assignee)}</span>` : ""}<span class="co-bar"><i style="width:${pct}%"></i></span><span class="co-count">${m.done}/${m.total}</span></div>${
              open ? `<div class="co-ms-beads">${m.beads.map((b) => beadRow(b, d, { who: true })).join("") || `<p class="co-dim co-small">No beads yet.</p>`}</div>` : ""
            }`;
          })
          .join("")}</section>`
      : "";
    const toggle = `<nav class="co-views" aria-label="View">${VIEWS.map((v) => `<button data-view="${v}" aria-pressed="${s.view === v}">${VIEW_LABEL[v]}</button>`).join("")}</nav>`;
    return `<div class="co-wrap" data-scroll="page"><div class="co-col">
      <header class="co-header"><div class="co-title"><h1>${esc(c.name)}</h1>${c.mission ? `<p class="co-mission">${esc(c.mission)}</p>` : ""}</div></header>
      ${banners(d)}
      ${team}
      ${goneHtml}
      ${you}
      <div class="co-chatslot">${chatRow}</div>
      ${msHtml}
      <section class="co-work"><div class="co-workhead"><h2>Work</h2>${toggle}</div>${s.view === "status" ? statusHtml(d, work) : agentHtml(d, work)}</section>
      <p class="co-build">build ${esc(deps.build)}</p>
    </div></div>`;
  }

  function agentHtml(d, work) {
    const waiting = new Map(d.onYou.waiting.map((w) => [w.id, w.blocker]));
    const onYou = new Set([...d.onYou.assigned, ...d.onYou.waiting.map((w) => w.id)]);
    // The operator's own beads are NOT repeated here — the You block above is their group (S3).
    const groups = groupByAgent(d.members, work, d.operator, d.onYou).filter((g) => g.kind !== "operator");
    if (!work.length) return `<p class="co-dim">No beads yet.</p>${groups.filter((g) => g.kind === "member" || g.kind === "operator").map((g) => `<section class="co-group"><h2>${groupHead(g, d)}</h2>${adder(g.name, d)}</section>`).join("")}`;
    return groups
      .map((g) => {
        const open = !!store.get(k(`done.${g.key}`), false);
        const done = g.done.length ? `<button class="co-link co-fold" data-act="done" data-key="${esc(g.key)}">✓ ${g.done.length} done</button>${open ? g.done.map((b) => beadRow(b, d, { milestone: true })).join("") : ""}` : "";
        const rows = g.open.map((b) => beadRow(onYou.has(b.id) ? { ...b, onYou: true } : b, d, { milestone: true, waitingOn: waiting.has(b.id) ? d.issues.find((i) => i.id === waiting.get(b.id)) : undefined })).join("");
        const canAdd = g.kind === "member" || g.kind === "operator";
        return `<section class="co-group" data-group="${esc(g.key)}"><h2>${groupHead(g, d)}</h2>${rows}${done}${canAdd ? adder(g.name, d) : ""}</section>`;
      })
      .join("");
  }

  function groupHead(g, d) {
    const link = (name, label) => `<a href="${esc(companyPath({ slug: s.slug, agent: name, level: "tasks" }))}" data-nav="${esc(companyPath({ slug: s.slug, agent: name, level: "tasks" }))}">${label}</a>`;
    if (g.kind === "operator") return `${link(g.name, "You")} <span class="co-dim co-norm">(${esc(g.name)})</span>`;
    if (g.kind === "member") return `${link(g.name, esc(g.name))}${g.name === d.company.lead ? " ★" : ""}${dot(g.name)}${g.member.known ? "" : ` <span class="co-bad co-norm">not in this space</span>`}`;
    if (g.kind === "other") return `${esc(g.name)} <span class="co-dim co-norm">— not a member</span>`;
    return "Unassigned";
  }

  function statusHtml(d, work, { only } = {}) {
    const onYouIds = new Set([...d.onYou.assigned, ...d.onYou.waiting.map((w) => w.id)]);
    const list = only ? work.filter((b) => b.assignee === only) : work;
    const whom = only ? [only] : [d.operator, ...d.members.map((m) => m.name)];
    const pick = only ?? store.get(k("addAgent"), d.company.lead ?? whom[0]);
    const label = (n) => (n === d.operator ? `you (${n})` : n);
    const addbar = `<div class="co-addbar"><input class="co-addin" data-input="add" data-agent="${only ? esc(only) : ""}" placeholder="Add a bead${only ? ` for ${esc(label(only))}` : "…"}" value="${esc(store.get(k(only ? `draft.add.${only}` : "draft.add.bar"), ""))}">${only ? "" : `<select data-input="add-agent" aria-label="assign to">${whom.map((n) => `<option value="${esc(n)}"${n === pick ? " selected" : ""}>${esc(label(n))}</option>`).join("")}</select>`}</div>${s.note.get(only ? `add:${only}` : "add:bar") ? `<p class="co-bad co-small">${esc(s.note.get(only ? `add:${only}` : "add:bar").text)}</p>` : ""}`;
    const doneOpen = !!store.get(k("done.status"), false);
    const groups = groupByStatus(list, onYouIds)
      .filter((c) => c.beads.length)
      .map((c) => {
        const fold = c.key === "closed" && !doneOpen;
        const head = `<h2>${esc(c.name)} <span class="co-dim co-norm">${c.beads.length}</span></h2>`;
        if (c.key === "closed") return `<section class="co-group">${head}<button class="co-link co-fold" data-act="done" data-key="status">${fold ? "Show" : "Hide"} done</button>${fold ? "" : c.beads.map((b) => beadRow(b, d, { who: !only, milestone: true })).join("")}</section>`;
        return `<section class="co-group">${head}${c.beads.map((b) => beadRow(b, d, { who: !only, milestone: true })).join("")}</section>`;
      })
      .join("");
    return addbar + (groups || `<p class="co-dim">No beads yet.</p>`);
  }

  function tasksHtml(d) {
    const work = workBeads(d.issues, d.company.epic);
    const isYou = s.agent === d.operator;
    return `<div class="co-wrap" data-scroll="page"><div class="co-col">
      <div class="co-crumbs"><a href="${esc(companyPath({ slug: s.slug, level: "home" }))}" data-nav="${esc(companyPath({ slug: s.slug, level: "home" }))}">${esc(d.company.name)}</a> › ${esc(isYou ? `You (${s.agent})` : s.agent)}</div>
      ${isYou ? "" : `<nav class="co-views co-tabs" aria-label="Agent view">${TABS.map(([lv, label]) => `<button data-level="${lv}" aria-pressed="${s.level === lv}">${label}</button>`).join("")}</nav>`}
      <h1 class="co-agenth">${esc(isYou ? "You" : s.agent)}${s.agent === d.company.lead ? " ★" : ""}${isYou ? "" : dot(s.agent)}</h1>
      ${banners(d)}
      ${statusHtml(d, work, { only: s.agent })}
    </div></div>`;
  }

  /** The bead, opened: a centred MODAL over the whole window (lists never reflow behind it, the lead
   *  chat column stays put). Header (title + status line) is opaque; only the body scrolls. */
  function modalHtml(d) {
    if (!s.bead || !d) return "";
    const b = d.issues.find((i) => i.id === s.bead);
    const shell = (inner) => `<div class="co-backdrop" data-act="backdrop"></div><div class="co-modal" role="dialog" aria-modal="true" aria-label="${esc(b?.title ?? s.bead)}">${inner}</div>`;
    if (!b) return shell(`<div class="co-mhead"><h3>${esc(s.bead)}</h3><button class="co-close" data-act="close" aria-label="close">×</button></div><div class="co-mbody"><p class="co-bad">Not one of ${esc(s.slug)}'s beads.</p></div>`);
    const th = s.thread?.id === b.id ? s.thread : undefined;
    const err = s.note.get(`err:${b.id}`);
    const comments = th?.error
      ? `<p class="co-bad">${esc(th.error)}</p>`
      : !th?.comments
        ? `<p class="co-dim co-small">Loading comments…</p>`
        : th.comments.length
          ? th.comments.map((c) => `<div class="co-comment"><div class="co-who">${esc(c.author)} · <span title="${esc(c.createdAt)}">${rel(Date.parse(c.createdAt))}</span></div>${deps.md ? deps.md(c.text) : esc(c.text)}</div>`).join("")
          : `<p class="co-dim co-small">No comments yet.</p>`;
    const sending = s.sending?.id === b.id;
    const draft = sending ? s.sending.text : store.get(k(`draft.c.${b.id}`), "");
    return shell(`
      <div class="co-mhead"><h3>${esc(b.title)}</h3><button class="co-close" data-act="close" aria-label="close">×</button>
        <div class="co-dim co-small co-mmeta">${metaLine(b, d)}</div></div>
      <div class="co-mbody" data-scroll="modal">
        ${statusHtml_(b, d)}
        <p class="co-desc${b.description ? "" : " co-dim"}">${esc(b.description || "No description.")}</p>
        <h4 class="co-sub">Comments</h4>${comments}
      </div>
      <div class="co-mfoot">
        ${err ? `<p class="co-bad co-small">${esc(err.text)}</p>` : ""}
        <textarea data-input="comment" rows="3" placeholder="Write a comment… (@agent pings them) — ⏎ send · ⇧⏎ newline"${sending ? " disabled" : ""}>${esc(draft)}</textarea>
        <div class="co-panelfoot"><button class="co-btn" data-act="comment"${sending ? " disabled" : ""}>${sending ? "sending…" : "Comment"}</button></div>
      </div>`);
  }

  /** "◐ In progress · beta · ct-1 · created 3d ago by alpha · updated 2h ago" (exact times in tooltips);
   *  a closed bead says "closed 1h ago — <reason>". */
  function metaLine(b, d) {
    const who = b.assignee ? agentLink(b.assignee, d) : "unassigned";
    const when = (iso) => `<span title="${esc(iso ? new Date(iso).toLocaleString() : "")}">${rel(Date.parse(iso ?? ""))}</span>`;
    const by = b.createdBy ? ` by ${agentLink(b.createdBy, d)}` : "";
    const parts = [`${GLYPH[b.status] ?? "?"} ${esc(STATUS_LABEL[b.status] ?? b.status)}`, who, esc(b.id)];
    if (b.createdAt) parts.push(`created ${when(b.createdAt)}${by}`);
    if (b.status === "closed" && b.closedAt) parts.push(`closed ${when(b.closedAt)}${b.closeReason ? ` — ${esc(b.closeReason)}` : ""}`);
    else if (b.updatedAt && b.updatedAt !== b.createdAt) parts.push(`updated ${when(b.updatedAt)}`);
    return parts.join(" · ");
  }

  function agentLink(name, d) {
    if (name === d.operator) return `you`;
    if (!d.members.some((m) => m.name === name)) return esc(name);
    const href = companyPath({ slug: s.slug, agent: name, level: "tasks" });
    return `<a href="${esc(href)}" data-nav="${esc(href)}">${esc(name)}</a>`;
  }

  /** Status controls for ANY company bead: Open · In progress · Blocked · Done, + Close as not needed.
   *  Done / Not needed first open a reason field (optional) — one submit closes with it as the close
   *  reason AND posts it as a comment. Disabled while a change is in flight; bd's refusal is shown. */
  function statusHtml_(b, d) {
    const busy = s.statusBusy === b.id;
    const opts = [
      ["open", "Open"],
      ["in_progress", "In progress"],
      ["blocked", "Blocked"],
      ["done", "Done"],
      ["not-needed", "Not needed"],
    ];
    const cur = b.status === "closed" ? (/^not needed/i.test(b.closeReason ?? "") ? "not-needed" : "done") : b.status;
    const chips = opts
      .map(([v, label]) => `<button class="co-chip${cur === v ? " on" : ""}" data-status="${v}" aria-pressed="${cur === v}"${busy ? " disabled" : ""}>${GLYPH[v === "done" || v === "not-needed" ? "closed" : v] ?? ""} ${label}</button>`)
      .join("");
    const asking = s.closing && s.closing.id === b.id;
    const reason = asking
      ? `<div class="co-closebar"><input class="co-addin" data-input="reason" placeholder="${s.closing.to === "not-needed" ? "Why it isn't needed (optional)" : "What was done (optional)"} — becomes the close reason and a comment"${busy ? " disabled" : ""}><button class="co-btn" data-act="close-bead"${busy ? " disabled" : ""}>${busy ? "saving…" : s.closing.to === "not-needed" ? "Close as not needed" : "Mark done"}</button> <button class="co-link" data-act="close-cancel">cancel</button></div>`
      : "";
    return `<div class="co-stchips">${chips}</div>${reason}`;
  }

  async function loadThread(id) {
    s.thread = { id };
    try {
      const r = await post("/api/tasks", { op: "comments", id });
      if (s.thread?.id === id) s.thread = { id, comments: r.comments ?? [] };
    } catch (e) {
      if (s.thread?.id === id) s.thread = { id, error: String(e?.message ?? e) };
    }
    paint();
  }

  function openBead(id, from) {
    s.bead = id;
    s.closing = false;
    s.returnTo = from; // the row to give focus back to on close
    s.pushed = true; // a history entry: Back closes the modal
    deps.onSubState?.(true);
    paint(true);
    modal.querySelector(".co-close")?.focus();
    void loadThread(id);
  }
  function closePanel() {
    const back = s.returnTo;
    s.bead = undefined;
    s.thread = undefined;
    s.closing = false;
    s.returnTo = undefined;
    if (s.pushed) {
      s.pushed = false;
      history.back(); // pops ?bead= — popstate re-reads the URL (no bead) and repaints
    } else deps.onSubState?.();
    paint(true);
    // after the popstate that history.back() queues (it re-runs the shell's focus logic)
    if (back) setTimeout(() => root.querySelector(`[data-open="${CSS.escape(back)}"]`)?.focus(), 80);
  }

  /* /new ------------------------------------------------------------------------------------- */

  function newHtml() {
    const f = s.form;
    const taken = new Set(s.companies.map((c) => c.slug));
    const problems = newCompanyProblems(f, taken);
    const q = f.filter.trim().toLowerCase();
    const rows = deps.rows() ?? [];
    const shown = rows.filter((r) => !q || r.name.toLowerCase().includes(q));
    const lead = leadOf(f);
    const picks = shown
      .map((r) => {
        const on = f.members.includes(r.name);
        return `<div class="co-pick"><label><input type="checkbox" data-pick="${esc(r.name)}"${on ? " checked" : ""}> ${esc(r.name)}${dot(r.name)}</label>${on ? `<label class="co-leadpick"><input type="radio" name="co-lead" data-lead="${esc(r.name)}"${lead === r.name ? " checked" : ""}> lead</label>` : ""}</div>`;
      })
      .join("");
    const slugLine = !f.slug
      ? "Creates a channel with these agents."
      : !SLUG_RE.test(f.slug)
        ? `<span class="co-bad">#${esc(f.slug)} isn't a valid channel name — lowercase letters, digits, dashes.</span>`
        : taken.has(f.slug)
          ? `<span class="co-bad">#${esc(f.slug)} already exists — <a href="/company/${esc(f.slug)}" data-nav="/company/${esc(f.slug)}">open it</a>.</span>`
          : `Creates <b>#<input class="co-slugin" data-nf="slug" value="${esc(f.slug)}" size="${Math.max(4, f.slug.length)}" aria-label="channel name"></b> with these agents`;
    const steps = s.steps ? `<ol class="co-steps">${s.steps.map((st) => `<li class="${st.bad ? "co-bad" : st.wait ? "co-dim" : ""}">${st.bad ? "✕" : st.wait ? "…" : "✓"} ${esc(st.text)}${st.retry ? ` <button class="co-link" data-act="steps-retry">retry</button>` : ""}</li>`).join("")}</ol>` : "";
    return `<div class="co-form" data-scroll="page"><div class="co-formcol">
      <h1>New company</h1>
      <label class="co-f" for="co-name">Name</label>
      <input type="text" id="co-name" data-nf="name" value="${esc(f.name)}" placeholder="Acme Labs" autocomplete="off">
      <label class="co-f" for="co-mission">Mission <span class="co-faint">(optional)</span></label>
      <input type="text" id="co-mission" data-nf="mission" value="${esc(f.mission)}" placeholder="What is it for?" autocomplete="off">
      <label class="co-f">Agents</label>
      ${rows.length > 8 ? `<input type="text" class="co-filter" data-nf="filter" value="${esc(f.filter)}" placeholder="Filter" autocomplete="off">` : ""}
      <div class="co-picks" data-scroll="picks">${picks || `<p class="co-dim co-small">${rows.length ? "No agent matches." : "No agents in this space."}</p>`}</div>
      <button class="co-btn" data-act="create"${problems.length || s.steps ? " disabled" : ""} title="${esc(problems.join(" · "))}">Create</button>
      <p class="co-dim co-small co-note">${slugLine} · <a href="/" data-nav="/">Cancel</a></p>
      ${s.companiesError ? `<p class="co-bad co-small">Couldn't check existing companies: ${esc(s.companiesError)}</p>` : ""}
      ${steps}
    </div></div>`;
  }

  const saveDraft = () => store.set(kNew(), s.form);

  async function createCompany() {
    const f = s.form;
    if (s.steps || newCompanyProblems(f, new Set(s.companies.map((c) => c.slug))).length) return;
    // The server runs these IN ORDER: bead → channel card → invites → kickoff; the list shows that order.
    s.steps = [{ text: "filing the company bead…", wait: true }];
    paint(true);
    try {
      const r = await post("/api/companies", { name: f.name.trim(), slug: f.slug, mission: f.mission.trim(), members: f.members, lead: leadOf(f) });
      const chErr = r.channelError ?? "";
      const failed = (r.failed ?? []).map((x) => `${x.name}: ${x.error}`);
      s.steps = [
        { text: `company bead filed (${r.epic})` },
        /channel registry/.test(chErr) ? { text: `channel #${f.slug}: ${chErr}`, bad: true } : { text: `channel #${f.slug} created` },
        { text: `invited ${(r.invited ?? []).length}/${f.members.length}${failed.length ? ` — ${failed.join(" · ")}` : ""}`, bad: failed.length > 0 || /invite:/.test(chErr) },
        ...(/kickoff/.test(chErr) ? [{ text: chErr, bad: true }] : [{ text: "kickoff posted" }]),
      ];
      const problems = [chErr, ...failed].filter(Boolean);
      const st = setupFrom(r);
      if (st) store.set(`paw.company.${deps.space?.() ?? ""}.${f.slug}.setup`, st);
      store.del(kNew());
      paint(true);
      setTimeout(() => deps.navigate(`/company/${f.slug}`), problems.length ? 2500 : 600);
    } catch (e) {
      s.steps = [{ text: String(e?.message ?? e), bad: true }];
      paint(true);
      setTimeout(() => {
        s.steps = undefined; // back to the form, everything typed intact
        paint(true);
      }, 6000);
    }
  }

  /* ── writes ─────────────────────────────────────────────────────────────────────────────── */

  async function addBead(agent, title, noteKey) {
    try {
      const r = await post(`/api/company/${encodeURIComponent(s.slug)}`, { op: "issue-create", title, assignee: agent });
      s.note.delete(noteKey);
      store.del(k(noteKey === "add:bar" ? "draft.add.bar" : `draft.add.${agent}`));
      if (r.nudged) {
        s.note.set(r.id, { ok: true, text: `DM'd ${r.nudged}` });
        setTimeout(() => {
          s.note.delete(r.id);
          paint();
        }, 30_000);
      }
      if (r.nudgeError) s.note.set(r.id, { ok: false, text: r.nudgeError });
    } catch (e) {
      s.note.set(noteKey, { ok: false, text: `Not added: ${e?.message ?? e}` }); // the draft stays in storage
    }
    await load();
    paint(true);
  }

  /** Set a bead's status. Open/In progress/Blocked apply at once; Done/Not needed ask for a reason first.
   *  The chips are disabled while it's in flight; on bd's refusal the real status stays and its words show. */
  async function setStatus(id, to, reason) {
    if (s.statusBusy) return;
    s.note.delete(`err:${id}`);
    s.statusBusy = id;
    paint(true);
    try {
      const r = await post(`/api/company/${encodeURIComponent(s.slug)}`, { op: "status", id, to, ...(reason ? { reason } : {}) });
      s.closing = undefined;
      if (r.nudgeError) s.note.set(`err:${id}`, { ok: false, text: `closed, but the DM to its holder failed: ${r.nudgeError}` });
      await load();
      if (reason) await loadThread(id);
    } catch (e) {
      s.note.set(`err:${id}`, { ok: false, text: String(e?.message ?? e) });
    } finally {
      s.statusBusy = undefined;
    }
    paint(true);
  }

  async function closeBead() {
    if (s.closing?.id && s.closing.id === s.bead) return void setStatus(s.closing.id, s.closing.to, modal.querySelector('[data-input="reason"]')?.value.trim() || undefined);
  }

  /** Send a comment. The box and button are DISABLED ("sending…") from submit until the refreshed
   *  thread — with the new comment in it — has rendered; on failure they come back with the text and
   *  the server's words. */
  async function sendComment() {
    const ta = modal.querySelector('[data-input="comment"]');
    const raw = ta?.value ?? "";
    const text = raw.trim();
    const id = s.bead;
    if (!text || !id || s.sending) return;
    s.note.delete(`err:${id}`);
    s.sending = { id, text: raw };
    ta.blur();
    paint(true);
    try {
      await post(`/api/company/${encodeURIComponent(s.slug)}`, { op: "comment", id, text }); // attributed to the operator
      const at = parseMention(text);
      if (at) await post("/api/dm", { to: at.to, text: `comment on ${id} (${s.slug}): ${at.text} — bd show ${id} for the thread` });
      store.del(k(`draft.c.${id}`));
      await loadThread(id);
      s.sending = undefined;
    } catch (e) {
      s.sending = undefined;
      store.set(k(`draft.c.${id}`), raw); // the text stays
      s.note.set(`err:${id}`, { ok: false, text: `Comment not sent: ${e?.message ?? e}` });
    }
    paint(true);
    modal.querySelector('[data-input="comment"]')?.focus();
  }

  /* ── events (on both #company and #cobar) ───────────────────────────────────────────────── */

  function onClick(e) {
    const t = e.target;
    const nav = t.closest("[data-nav]");
    if (nav) {
      e.preventDefault();
      return deps.navigate(nav.dataset.nav);
    }
    const el = t.closest("[data-act]");
    const act = el?.dataset.act;
    if (act === "menu") return deps.openNav?.();
    if (s.page === "new") {
      if (act === "create") void createCompany();
      return;
    }
    const lv = t.closest("[data-level]");
    if (lv) return go({ agent: s.agent, level: lv.dataset.level });
    const v = t.closest("[data-view]");
    if (v) {
      s.view = parseView(v.dataset.view);
      store.set(k("view"), s.view);
      return paint(true);
    }
    const st = t.closest("[data-status]");
    if (st && s.bead && modal.contains(st)) {
      const to = st.dataset.status;
      if (to === "done" || to === "not-needed") {
        s.closing = { id: s.bead, to };
        paint(true);
        return modal.querySelector('[data-input="reason"]')?.focus();
      }
      return void setStatus(s.bead, to);
    }
    switch (act) {
      case "retry":
        return void load(true);
      case "channel":
        return deps.onOpenChannel(s.slug);
      case "lead-chat":
        return deps.openLeadChat?.(s.data?.company.lead);
      case "dismiss":
        s.setup = undefined;
        store.del(k("setup"));
        return paint(true);
      case "retry-channel": {
        const plan = retryPlan(s.setup);
        return void post(`/api/company/${encodeURIComponent(s.slug)}`, { op: "retry-channel", ...plan })
          .then((r) => saveSetup(mergeRetry(s.setup, plan, r)))
          .catch((err) => saveSetup({ ...s.setup, note: `retry failed: ${err?.message ?? err}` }))
          .finally(() => paint(true));
      }
      case "member-remove": {
        const name = el.dataset.name;
        if (!window.confirm(`Take ${name} off ${s.data?.company.name ?? s.slug}? The agent itself is untouched.`)) return;
        return void post(`/api/company/${encodeURIComponent(s.slug)}`, { op: "member-remove", name })
          .then(() => saveSetup(setupFrom({ ...s.setup, failed: (s.setup?.failed ?? []).filter((f) => f.name !== name), cardError: s.setup?.card, kickoffError: s.setup?.kickoff })))
          .catch((err) => saveSetup({ ...s.setup, note: `couldn't remove ${name}: ${err?.message ?? err}` }))
          .finally(() => void load(true));
      }
      case "ms": {
        const key = el.dataset.ms;
        if (s.open.has(key)) s.open.delete(key);
        else s.open.add(key);
        return paint(true);
      }
      case "add":
        s.adding = el.dataset.agent;
        paint(true);
        return root.querySelector('[data-input="add"]')?.focus();
      case "done": {
        const key = el.dataset.key === "status" ? "done.status" : `done.${el.dataset.key}`;
        store.set(k(key), !store.get(k(key), false));
        return paint(true);
      }
      case "close":
      case "backdrop":
        return closePanel();
      case "comment":
        return void sendComment();
      case "close-bead":
        return void closeBead();
      case "close-cancel":
        s.closing = undefined;
        return paint(true);
    }
    const open = t.closest("[data-open]");
    if (open) return openBead(open.dataset.open, open.dataset.open);
  }
  root.addEventListener("click", onClick);
  modal.addEventListener("click", onClick);
  modal.addEventListener("input", (e) => {
    if (e.target.dataset?.input === "comment" && s.bead) store.set(k(`draft.c.${s.bead}`), e.target.value);
  });
  modal.addEventListener("keydown", (e) => {
    const t = e.target;
    // Enter sends, Shift+Enter is a newline — never mid-IME-composition (Enter confirms the candidate there)
    if (t.dataset?.input === "comment" && e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      return void sendComment();
    }
    if (t.dataset?.input === "reason" && e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      return void closeBead();
    }
    if (e.key === "Tab") {
      // focus trap: Tab cycles inside the modal
      const f = [...modal.querySelectorAll("button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select")];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
    }
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest?.(".co-bead[data-open]");
    if (row && (e.key === "Enter" || e.key === " ") && e.target === row) {
      e.preventDefault();
      openBead(row.dataset.open, row.dataset.open);
    }
  });
  bar.addEventListener("click", onClick);
  head.addEventListener("click", onClick);
  head.addEventListener("change", (e) => {
    const v = e.target.dataset?.input === "switch" ? e.target.value : "";
    if (v) deps.navigate(companyPath({ slug: v, level: "home" }));
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (s.page === "new" && t.dataset.pick) {
      const f = s.form;
      f.members = t.checked ? [...f.members.filter((m) => m !== t.dataset.pick), t.dataset.pick] : f.members.filter((m) => m !== t.dataset.pick);
      saveDraft();
      return paint(true);
    }
    if (s.page === "new" && t.dataset.lead) {
      s.form.lead = t.dataset.lead;
      saveDraft();
      return paint(true);
    }
    if (t.dataset.input === "add-agent") store.set(k("addAgent"), t.value);
  });

  root.addEventListener("input", (e) => {
    const t = e.target;
    if (s.page === "new" && t.dataset.nf) {
      const f = s.form;
      const field = t.dataset.nf;
      if (field === "name") {
        f.name = t.value;
        if (!f.slugEdited) f.slug = slugify(t.value);
      } else if (field === "slug") {
        f.slug = t.value.trim().toLowerCase();
        f.slugEdited = true;
      } else f[field] = t.value;
      saveDraft();
      // re-render (validation, filtered list) and put the caret back where it was
      const [a, b] = [t.selectionStart, t.selectionEnd];
      paint(true);
      const again = root.querySelector(`[data-nf="${field}"]`);
      again?.focus();
      try {
        again?.setSelectionRange(a, b);
      } catch {
        /* not a text field */
      }
      return;
    }
    if (t.dataset.input === "add") store.set(k(t.dataset.agent ? `draft.add.${t.dataset.agent}` : "draft.add.bar"), t.value);
    if (t.dataset.input === "comment" && s.bead) store.set(k(`draft.c.${s.bead}`), t.value);
  });

  root.addEventListener("keydown", (e) => {
    const t = e.target;
    if (s.page === "new") {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void createCompany();
      }
      return;
    }
    if (t.dataset.input === "add" && e.key === "Enter") {
      e.preventDefault();
      const title = t.value.trim();
      const barAdd = !t.dataset.agent;
      const agent = barAdd ? root.querySelector('[data-input="add-agent"]')?.value : t.dataset.agent;
      if (!title || !agent) return;
      t.value = "";
      t.blur();
      s.adding = undefined;
      return void addBead(agent, title, barAdd ? "add:bar" : `add:${agent}`);
    }
    if (t.dataset.input === "comment" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return void sendComment();
    }
  });

  root.addEventListener("focusout", (e) => {
    // "Esc or blur-when-empty cancels" an open + Add
    const t = e.target;
    if (t.dataset?.input === "add" && t.dataset.agent && s.adding === t.dataset.agent && !t.value.trim())
      setTimeout(() => {
        if (s.adding === t.dataset.agent) {
          s.adding = undefined;
          paint(true);
        }
      }, 0);
  });

  /** Esc: blur a field, else close the bead panel. Never leaves the page — it's a page, not an overlay. */
  function onKey(e) {
    if (!s.page || e.key !== "Escape") return false;
    const a = document.activeElement;
    if (a && root.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) {
      if (a.dataset.input === "add") s.adding = undefined;
      a.blur();
      paint(true);
      return true;
    }
    if (s.page === "company" && s.bead) {
      if (a && modal.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) a.blur();
      closePanel();
      return true;
    }
    return s.page === "company" && !shellLevel(s.level);
  }

  return {
    show,
    close,
    isOpen: () => !!s.page,
    query,
    onKey,
    data: () => s.data,
    leadFor,
    /** Names the company pages may show: its roster + the operator ("you"). */
    scope: () => (s.data ? new Set([...s.data.members.map((m) => m.name), s.data.operator, "you"]) : undefined),
    companiesError: () => s.companiesError,
    /** app.js's render tick: repaint for fresh roster dots (never under the caret). */
    tick: () => {
      // the cache is keyed by SPACE, which the shell learns from its first read — a page opened before
      // that couldn't see its copy yet; adopt it the moment the space is known (unless fresh data won)
      if (s.page === "company" && !s.data) adoptCache();
      paint();
    },
    loadCompanies,
  };
}

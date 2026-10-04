/**
 * The company pages (docs/notes/company-spec.md §0 MVP, look = the "Simple" mocks): `/new` and
 * `/company/<slug>`. A FOCUS TARGET like the board — app.js's render() opens/closes it from state;
 * this module owns everything inside `#company`.
 *
 * Data: GET /api/company/<slug> (the epic + members + their beads), POST op `issue-create` (+ ONE DM
 * nudge, server-side) and `retry-channel`; bead details via the existing /api/tasks ops
 * (`comments`, `comment`). Views (VIEWS in company-model.js) render the SAME groups: "By agent"
 * (default) and "By status"; the choice is remembered per company in localStorage.
 *
 * Rules carried over from the pad/board: never rebuild under the caret (a poll skips the render while
 * a field inside #company has focus); a refused write shows the server's own words; nothing is
 * fabricated — an empty state says what is empty.
 */
import { GLYPH, STATUS_LABEL, VIEWS, SLUG_RE, groupByAgent, groupByStatus, leadOf, newCompanyProblems, parseMention, parseView, slugify } from "./company-model.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const POLL_MS = 15_000;
const VIEW_LABEL = { agent: "By agent", status: "By status" };

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
  const s = {
    page: undefined, // "company" | "new"
    slug: undefined,
    data: undefined,
    error: undefined,
    view: "agent",
    issue: undefined,
    thread: undefined, // {id, comments?, error?}
    adding: undefined, // member name whose "+ Add" input is open
    note: new Map(), // bead id / "add:<agent>" / "err:<id>" → {ok, text}
    banner: undefined,
    companies: [],
    form: undefined,
    steps: undefined,
  };
  let pollTimer;
  let seq = 0;

  const k = (name) => `paw.company.${s.slug}.${name}`;
  const post = (path, body) => deps.api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const editing = () => {
    const a = document.activeElement;
    return !!a && root.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  };

  async function load(fresh = false) {
    if (s.page !== "company") return;
    const mine = ++seq;
    try {
      const d = await deps.api(`/api/company/${encodeURIComponent(s.slug)}${fresh ? "?fresh=1" : ""}`);
      if (mine !== seq) return; // a newer read, or a navigation, superseded this one
      s.data = d;
      s.error = undefined;
    } catch (e) {
      if (mine !== seq) return;
      s.error = String(e?.message ?? e);
    }
    paint();
  }

  async function loadCompanies() {
    try {
      s.companies = (await deps.api("/api/companies")).companies ?? [];
      s.companiesError = undefined;
    } catch (e) {
      s.companiesError = String(e?.message ?? e);
    }
    return s.companies;
  }

  /* ── open / close ───────────────────────────────────────────────────────────────────────── */

  function showCompany(slug, sub = {}) {
    root.hidden = false;
    const same = s.page === "company" && s.slug === slug;
    if (same && !sub.fromUrl) return;
    if (!same) {
      s.page = "company";
      s.slug = slug;
      s.data = undefined;
      s.error = undefined;
      s.adding = undefined;
      s.view = parseView(store.get(k("view"), undefined));
      s.banner = store.get(k("banner"), undefined);
      clearInterval(pollTimer);
      pollTimer = setInterval(() => void load(), POLL_MS);
      void load(true);
    }
    if (sub.issue !== s.issue) {
      s.issue = sub.issue;
      if (s.issue) void loadThread(s.issue);
    }
    paint(true);
  }

  function showNew(prefill) {
    clearInterval(pollTimer);
    root.hidden = false;
    if (s.page === "new") return;
    s.page = "new";
    s.slug = undefined;
    s.steps = undefined;
    const blank = { name: "", slug: "", slugEdited: false, mission: "", members: [], lead: undefined, filter: "" };
    const draft = store.get("paw.company.new.draft", undefined);
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
    s.page = undefined;
    s.slug = undefined;
    s.issue = undefined;
    root.hidden = true;
    root.innerHTML = "";
  }

  /** The URL sub-state this page owns (`?issue=`); app.js writes the path. */
  function query() {
    const q = new URLSearchParams();
    if (s.page === "company" && s.issue) q.set("issue", s.issue);
    return q;
  }

  /* ── painting ───────────────────────────────────────────────────────────────────────────── */

  function paint(force = false) {
    if (!s.page) return;
    if (!force && editing()) return; // never under the caret — the next poll catches up
    const keep = [...root.querySelectorAll("[data-scroll]")].map((el) => [el.dataset.scroll, el.scrollTop]);
    root.innerHTML = s.page === "new" ? newHtml() : companyHtml();
    for (const [key, top] of keep) {
      const el = root.querySelector(`[data-scroll="${key}"]`);
      if (el) el.scrollTop = top;
    }
  }

  const rowsByName = () => new Map((deps.rows() ?? []).map((r) => [r.name, r]));
  function dot(name) {
    const r = rowsByName().get(name);
    const live = !!r && r.live && r.mesh !== "offline";
    return `<span class="co-dot${live ? " live" : ""}" title="${esc(!r ? "not in this space's roster" : live ? r.mesh : "asleep — a DM wakes it")}"></span>`;
  }
  const menu = `<button class="co-menu" data-act="menu" aria-label="Show sidebar">☰</button>`;

  function companyHtml() {
    const d = s.data;
    if (!d) {
      if (s.error && /^no company "/.test(s.error))
        return `<div class="co-wrap" data-scroll="page">${menu}<h1>No company “${esc(s.slug)}”</h1><p class="co-dim"><a href="/new?name=${encodeURIComponent(s.slug)}" data-nav="/new?name=${esc(encodeURIComponent(s.slug))}">Create it</a></p></div>`;
      return `<div class="co-wrap" data-scroll="page">${menu}<h1>${esc(s.slug)}</h1>${s.error ? `<p class="co-bad">${esc(s.error)} <button class="co-link" data-act="retry">retry</button></p>` : `<p class="co-dim">Loading…</p>`}</div>`;
    }
    const c = d.company;
    const toggle = `<div class="co-views" role="group" aria-label="View">${VIEWS.map((v) => `<button data-view="${v}" aria-pressed="${s.view === v}">${VIEW_LABEL[v]}</button>`).join("")}</div>`;
    const banners = [
      s.error ? `<p class="co-bad">${esc(s.error)} <button class="co-link" data-act="retry">retry</button></p>` : "",
      ...(d.errors ?? []).map((e) => `<p class="co-bad">${esc(e)}</p>`),
      s.banner ? `<p class="co-warnline">${esc(s.banner)} <button class="co-link" data-act="retry-channel">Retry channel setup</button> · <button class="co-link" data-act="dismiss">Dismiss</button></p>` : "",
    ].join("");
    return `<div class="co-wrap" data-scroll="page">
      <header class="co-header">${menu}<div class="co-title"><h1>${esc(c.name)}</h1>${c.mission ? `<p class="co-mission">${esc(c.mission)}</p>` : ""}</div>
        <div class="co-hright"><button class="co-link co-chan" data-act="channel" title="open the channel in the chat view">#${esc(c.slug)}</button>${toggle}</div></header>
      ${banners}
      <main class="co-main" data-view="${s.view}">${s.view === "status" ? statusHtml(d) : agentHtml(d)}</main>
      <p class="co-build">build ${esc(deps.build)}</p>
    </div>
    ${panelHtml(d)}`;
  }

  function beadRow(b, { tag = false, waitingOn } = {}) {
    const note = s.note.get(b.id);
    const onYouTag = b.onYou || waitingOn ? `<span class="co-tag co-acc" title="${esc(waitingOn ? `waits on ${waitingOn.id} — ${waitingOn.title}` : "blocked on you")}">${waitingOn ? `waits on: ${esc(waitingOn.title)}` : "on you"}</span>` : "";
    return `<div class="co-bead${b.status === "closed" ? " done" : ""}${s.issue === b.id ? " sel" : ""}" data-open="${esc(b.id)}">
      <span class="co-st" title="${esc(STATUS_LABEL[b.status] ?? b.status)}">${GLYPH[b.status] ?? "?"}</span>
      <span class="co-t">${esc(b.title)}</span>
      ${b.unlabelled ? `<span class="co-tag co-warn" title="under the company epic but missing the company:${esc(s.slug)} label">unlabelled</span>` : ""}
      ${note ? `<span class="co-tag ${note.ok ? "" : "co-bad"}" title="${esc(note.text)}">${note.ok ? "nudged" : "nudge failed"}</span>` : ""}
      ${onYouTag}${tag ? `<span class="co-tag">${b.assignee ? esc(b.assignee) : "unassigned"}</span>` : ""}</div>`;
  }

  function adder(name) {
    const note = s.note.get(`add:${name}`);
    const err = note ? `<p class="co-bad co-small">${esc(note.text)}</p>` : "";
    if (s.adding === name)
      return `<input class="co-addin" data-input="add" data-agent="${esc(name)}" placeholder="New bead for ${esc(name)} — Enter to add" value="${esc(store.get(k(`draft.add.${name}`), ""))}">${err}`;
    return `<button class="co-link co-add" data-act="add" data-agent="${esc(name)}">+ Add</button>${err}`;
  }

  function agentHtml(d) {
    const waitsOn = new Map(groupByAgent([], d.issues, d.operator, d.onYou)[0].waiting.map((w) => [w.bead.id, w.blocker]));
    return groupByAgent(d.members, d.issues, d.operator, d.onYou)
      .map((g) => {
        const open = !!store.get(k(`done.${g.key}`), false);
        if (g.kind === "operator") {
          const count = d.onYou.count;
          const waiting = g.waiting.length ? `<h3 class="co-sub">Waiting on you</h3>${g.waiting.map((w) => beadRow(w.bead, { tag: true, waitingOn: w.blocker })).join("")}` : "";
          const done = g.done.length ? `<button class="co-link co-fold" data-act="done" data-key="you">${open ? "Hide" : "Show"} ${g.done.length} done</button>${open ? g.done.map((b) => beadRow(b)).join("") : ""}` : "";
          const empty = !g.open.length && !g.waiting.length && !g.done.length ? `<p class="co-dim co-small">Nothing on you.</p>` : "";
          return `<section class="co-group co-you" data-group="you"><h2>You <span class="co-dim co-norm">(${esc(g.name)})</span>${count ? ` <span class="co-acc co-norm">${count} on you</span>` : ""}</h2>${g.open.map((b) => beadRow(b)).join("")}${waiting}${empty}${done}${adder(g.name)}</section>`;
        }
        const head =
          g.kind === "member"
            ? `${esc(g.name)}${dot(g.name)}${g.name === d.company.lead ? ` <span class="co-dim co-norm">★ lead</span>` : ""}${g.member.known ? "" : ` <span class="co-bad co-norm">not in this space</span>`}`
            : g.kind === "other"
              ? `${esc(g.name)} <span class="co-warn co-norm" title="holds company beads but isn't on the roster">not a member</span>`
              : `Unassigned`;
        const done = g.done.length ? `<button class="co-link co-fold" data-act="done" data-key="${esc(g.key)}">${open ? "Hide" : "Show"} ${g.done.length} done</button>${open ? g.done.map((b) => beadRow(b)).join("") : ""}` : "";
        const empty = !g.open.length && !g.done.length && g.kind === "member" ? `<p class="co-dim co-small">Nothing yet.</p>` : "";
        return `<section class="co-group" data-group="${esc(g.key)}"><h2>${head}</h2>${g.open.map((b) => beadRow(b, { waitingOn: waitsOn.get(b.id) })).join("")}${empty}${done}${g.kind === "member" ? adder(g.name) : ""}</section>`;
      })
      .join("");
  }

  function statusHtml(d) {
    const members = `<p class="co-members">You (${esc(d.operator)})${d.onYou.count ? ` <span class="co-acc">${d.onYou.count} on you</span>` : ""} &nbsp;·&nbsp; ${d.members.map((m) => `${esc(m.name)}${m.name === d.company.lead ? " ★" : ""}${dot(m.name)}`).join(" &nbsp;·&nbsp; ")}</p>`;
    const pick = store.get(k("addAgent"), d.company.lead ?? d.members[0]?.name);
    const whom = [{ value: d.operator, label: `You (${d.operator})` }, ...d.members.map((m) => ({ value: m.name, label: m.name }))];
    const bar = `<div class="co-addbar"><input class="co-addin" data-input="add" data-agent="" placeholder="Add a bead…" value="${esc(store.get(k("draft.add.bar"), ""))}"><select data-input="add-agent" aria-label="assign to">${whom.map((w) => `<option value="${esc(w.value)}"${w.value === pick ? " selected" : ""}>${esc(w.label)}</option>`).join("")}</select></div>${s.note.get("add:bar") ? `<p class="co-bad co-small">${esc(s.note.get("add:bar").text)}</p>` : ""}`;
    const doneOpen = !!store.get(k("done.status"), false);
    const groups = groupByStatus(d.issues, new Set([...d.onYou.assigned, ...d.onYou.waiting.map((w) => w.id)]))
      .filter((c) => c.beads.length)
      .map((c) => {
        const fold = c.key === "closed" && !doneOpen;
        return `<section class="co-group" data-group="status:${c.key}"><h2>${esc(c.name)} <span class="co-dim co-norm">${c.beads.length}</span></h2>${
          fold ? `<button class="co-link co-fold" data-act="done" data-key="status">Show ${c.beads.length} done</button>` : c.beads.map((b) => beadRow(b, { tag: true })).join("")
        }${c.key === "closed" && !fold ? `<button class="co-link co-fold" data-act="done" data-key="status">Hide done</button>` : ""}</section>`;
      })
      .join("");
    return members + bar + (groups || `<p class="co-dim">No beads yet.</p>`);
  }

  function panelHtml(d) {
    if (!s.issue) return `<aside class="co-panel" hidden></aside>`;
    const b = d.issues.find((i) => i.id === s.issue);
    if (!b) return `<aside class="co-panel" role="dialog"><button class="co-close" data-act="close" aria-label="close">×</button><h3>${esc(s.issue)}</h3><p class="co-bad">Not one of ${esc(s.slug)}'s beads.</p></aside>`;
    const th = s.thread?.id === b.id ? s.thread : undefined;
    const err = s.note.get(`err:${b.id}`);
    const comments = th?.error
      ? `<p class="co-bad">${esc(th.error)}</p>`
      : !th?.comments
        ? `<p class="co-dim co-small">Loading comments…</p>`
        : th.comments.length
          ? th.comments.map((c) => `<div class="co-comment"><div class="co-who">${esc(c.author)} · ${rel(Date.parse(c.createdAt))}</div>${deps.md ? deps.md(c.text) : esc(c.text)}</div>`).join("")
          : `<p class="co-dim co-small">No comments yet.</p>`;
    return `<aside class="co-panel" role="dialog" aria-label="${esc(b.id)}">
      <button class="co-close" data-act="close" aria-label="close">×</button>
      <h3>${esc(b.title)}</h3>
      <div class="co-dim co-small">${GLYPH[b.status] ?? "?"} ${esc(STATUS_LABEL[b.status] ?? b.status)} · ${b.assignee ? esc(b.assignee) : "unassigned"} · ${esc(b.id)}</div>
      <div class="co-scroll" data-scroll="panel"><p class="co-desc${b.description ? "" : " co-dim"}">${esc(b.description || "No description.")}</p>${comments}</div>
      ${err ? `<p class="co-bad co-small">${esc(err.text)}</p>` : ""}
      ${b.assignee === d.operator && b.status !== "closed" ? `<div class="co-closebar"><input class="co-addin" data-input="reason" placeholder="Reason (optional) — closing unblocks what waits on it"><button class="co-btn co-ghost" data-act="close-bead">Close</button></div>` : ""}
      <textarea data-input="comment" rows="3" placeholder="Write a comment… (@agent pings them)">${esc(store.get(k(`draft.c.${b.id}`), ""))}</textarea>
      <div class="co-panelfoot"><button class="co-btn" data-act="comment">Comment</button></div>
    </aside>`;
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

  function openBead(id) {
    s.issue = id;
    deps.onSubState?.();
    paint(true);
    void loadThread(id);
  }
  function closePanel() {
    s.issue = undefined;
    s.thread = undefined;
    deps.onSubState?.();
    paint(true);
  }

  /* /new ------------------------------------------------------------------------------------- */

  function newHtml() {
    const f = s.form;
    const taken = new Set(s.companies.map((c) => c.slug));
    const problems = newCompanyProblems(f, taken);
    const q = f.filter.trim().toLowerCase();
    const rows = deps.rows() ?? [];
    const shown = rows.filter((r) => !q || r.name.toLowerCase().includes(q));
    const picks = shown
      .map((r) => {
        const on = f.members.includes(r.name);
        const lead = on && leadOf(f) === r.name;
        return `<div class="co-pick"><label><input type="checkbox" data-pick="${esc(r.name)}"${on ? " checked" : ""}> ${esc(r.name)}${dot(r.name)}</label>${on ? `<label class="co-leadpick${lead ? " on" : ""}"><input type="radio" name="co-lead" data-lead="${esc(r.name)}"${lead ? " checked" : ""}> ${lead ? "★ lead" : "lead"}</label>` : ""}</div>`;
      })
      .join("");
    const slugLine = !f.slug
      ? "Creates a channel with these agents."
      : !SLUG_RE.test(f.slug)
        ? `<span class="co-bad">#${esc(f.slug)} isn't a valid channel name — lowercase letters, digits, dashes.</span>`
        : taken.has(f.slug)
          ? `<span class="co-bad">#${esc(f.slug)} already exists — <a href="/company/${esc(f.slug)}" data-nav="/company/${esc(f.slug)}">open it</a>.</span>`
          : `Creates <b>#<input class="co-slugin" data-nf="slug" value="${esc(f.slug)}" size="${Math.max(4, f.slug.length)}" aria-label="channel name"></b> with these agents.`;
    const steps = s.steps ? `<ol class="co-steps">${s.steps.map((st) => `<li class="${st.bad ? "co-bad" : st.wait ? "co-dim" : ""}">${st.bad ? "✕" : st.wait ? "…" : "✓"} ${esc(st.text)}</li>`).join("")}</ol>` : "";
    return `<div class="co-form" data-scroll="page">${menu}
      <h1>New company</h1>
      <label class="co-f" for="co-name">Name</label>
      <input type="text" id="co-name" data-nf="name" value="${esc(f.name)}" placeholder="Acme Labs" autocomplete="off">
      <label class="co-f" for="co-mission">Mission <span class="co-faint">(optional)</span></label>
      <input type="text" id="co-mission" data-nf="mission" value="${esc(f.mission)}" placeholder="What is it for?" autocomplete="off">
      <label class="co-f">Agents <span class="co-faint">— pick the lead (CEO); the others report to them</span></label>
      ${rows.length > 8 ? `<input type="text" class="co-filter" data-nf="filter" value="${esc(f.filter)}" placeholder="Filter" autocomplete="off">` : ""}
      <div class="co-picks" data-scroll="picks">${picks || `<p class="co-dim co-small">${rows.length ? "No agent matches." : "No agents in this space."}</p>`}</div>
      <button class="co-btn" data-act="create"${problems.length || s.steps ? " disabled" : ""} title="${esc(problems.join(" · "))}">Create</button>
      <p class="co-dim co-small co-note">${slugLine} <a href="/" data-nav="/">Cancel</a></p>
      ${s.companiesError ? `<p class="co-bad co-small">Couldn't check existing companies: ${esc(s.companiesError)}</p>` : ""}
      ${steps}
    </div>`;
  }

  const saveDraft = () => store.set("paw.company.new.draft", s.form);

  async function createCompany() {
    const f = s.form;
    if (s.steps || newCompanyProblems(f, new Set(s.companies.map((c) => c.slug))).length) return;
    // The server runs these IN ORDER: bead → channel card → invites → kickoff; the list shows that order.
    s.steps = [{ text: "Filing the company bead…", wait: true }];
    paint(true);
    try {
      const r = await post("/api/companies", { name: f.name.trim(), slug: f.slug, mission: f.mission.trim(), members: f.members, lead: leadOf(f) });
      const chErr = r.channelError ?? "";
      const failed = (r.failed ?? []).map((x) => `${x.name}: ${x.error}`);
      s.steps = [
        { text: `company bead filed (${r.epic})` },
        /channel registry/.test(chErr) ? { text: `channel #${f.slug}: ${chErr}`, bad: true } : { text: `channel #${f.slug} created` },
        { text: `invited ${(r.invited ?? []).length}/${f.members.length}${failed.length ? ` — ${failed.join(" · ")}` : ""}`, bad: failed.length > 0 || /invite:/.test(chErr) },
        /kickoff/.test(chErr) ? { text: chErr, bad: true } : { text: "kickoff posted" },
      ];
      const problems = [chErr, ...failed].filter(Boolean);
      if (problems.length) store.set(`paw.company.${f.slug}.banner`, `Setup didn't finish: ${problems.join(" · ")}`);
      store.del("paw.company.new.draft");
      paint(true);
      setTimeout(() => deps.navigate(`/company/${f.slug}`), problems.length ? 1500 : 600);
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
      if (noteKey !== "add:bar") s.adding = agent;
    }
    await load(true);
    paint(true);
  }

  async function closeBead() {
    const id = s.issue;
    if (!id) return;
    const reason = root.querySelector('[data-input="reason"]')?.value.trim();
    s.note.delete(`err:${id}`);
    try {
      await post("/api/tasks", { op: "close", id, ...(reason ? { reason } : {}) });
    } catch (e) {
      s.note.set(`err:${id}`, { ok: false, text: `Not closed: ${e?.message ?? e}` }); // bd's words
    }
    await load(true);
    paint(true);
  }

  async function sendComment() {
    const ta = root.querySelector('[data-input="comment"]');
    const text = ta?.value.trim();
    const id = s.issue;
    if (!text || !id) return;
    s.note.delete(`err:${id}`);
    try {
      await post("/api/tasks", { op: "comment", id, text });
      const at = parseMention(text);
      if (at) await post("/api/dm", { to: at.to, text: `comment on ${id} (${s.slug}): ${at.text} — bd show ${id} for the thread` });
      store.del(k(`draft.c.${id}`));
      ta.value = "";
      ta.blur();
      await loadThread(id);
    } catch (e) {
      s.note.set(`err:${id}`, { ok: false, text: `Comment not sent: ${e?.message ?? e}` }); // the text stays in the box
      paint(true);
    }
  }

  /* ── events ─────────────────────────────────────────────────────────────────────────────── */

  root.addEventListener("click", (e) => {
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
    const v = t.closest("[data-view]");
    if (v) {
      s.view = parseView(v.dataset.view);
      store.set(k("view"), s.view);
      return paint(true);
    }
    switch (act) {
      case "retry":
        return void load(true);
      case "channel":
        return deps.onOpenChannel(s.slug);
      case "dismiss":
        s.banner = undefined;
        store.del(k("banner"));
        return paint(true);
      case "retry-channel":
        return void post(`/api/company/${encodeURIComponent(s.slug)}`, { op: "retry-channel" })
          .then((r) => {
            const problems = [r.channelError, ...(r.failed ?? []).map((x) => `${x.name}: ${x.error}`)].filter(Boolean);
            s.banner = problems.length ? `Setup didn't finish: ${problems.join(" · ")}` : undefined;
            if (s.banner) store.set(k("banner"), s.banner);
            else store.del(k("banner"));
          })
          .catch((err) => {
            s.banner = `Setup retry failed: ${err?.message ?? err}`;
          })
          .finally(() => paint(true));
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
        return closePanel();
      case "comment":
        return void sendComment();
      case "close-bead":
        return void closeBead();
    }
    const open = t.closest("[data-open]");
    if (open) return openBead(open.dataset.open);
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
    if (t.dataset.input === "comment" && s.issue) store.set(k(`draft.c.${s.issue}`), t.value);
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
      const bar = !t.dataset.agent;
      const agent = bar ? root.querySelector('[data-input="add-agent"]')?.value : t.dataset.agent;
      if (!title || !agent) return;
      t.value = "";
      t.blur();
      if (!bar) s.adding = undefined;
      return void addBead(agent, title, bar ? "add:bar" : `add:${agent}`);
    }
    if (t.dataset.input === "comment" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return void sendComment();
    }
  });

  /** Esc: blur a field (closing an open "+ Add"), else close the panel. Never leaves the page — it's
   *  a page, not an overlay. */
  function onKey(e) {
    if (!s.page || root.hidden || e.key !== "Escape") return false;
    const a = document.activeElement;
    if (a && root.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) {
      if (a.dataset.input === "add" && a.dataset.agent) s.adding = undefined;
      a.blur();
      paint(true);
      return true;
    }
    if (s.page === "company" && s.issue) {
      closePanel();
      return true;
    }
    return s.page === "company";
  }

  return {
    showCompany,
    showNew,
    close,
    isOpen: () => !!s.page,
    query,
    onKey,
    /** app.js's render tick: repaint for fresh roster dots (never under the caret). */
    tick: () => paint(),
    loadCompanies,
  };
}

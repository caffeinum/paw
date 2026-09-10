/**
 * The Board: the shared beads list as a kanban, one column per bd status. A vanilla port of a
 * 21st.dev/shadcn "trello-kanban-board" React component (operator's ask, 2026-08-26: "ignore the
 * tailwind stuff and rewrite it into your system") — paw web is no-build vanilla JS served from the
 * checkout, so the port keeps the component's SHAPE (columns, draggable cards, drop highlight, add-a-
 * card) and swaps its state for bd: dragging a card between columns is a `bd update --status`, dropping
 * on Done is a `bd close`, adding a card is a `bd create`. Optimistic, with bd's refusal shown and the
 * card put back — the same honesty rules as the task pad, because it is the same data.
 */

/** bd statuses → columns, in workflow order. Done holds the last week's closed beads (the server
 *  keeps them visible) — finished work stays on the board, dimmed, at the end. */
export const COLUMNS = [
  { id: "open", title: "To do", cls: "todo" },
  { id: "in_progress", title: "In progress", cls: "prog" },
  { id: "blocked", title: "Blocked", cls: "blocked" },
  { id: "closed", title: "Done", cls: "done" },
];

/** Bucket tasks by status. Unknown statuses land in To do rather than vanishing — a status the
 *  board doesn't know is still work someone filed. A task whose parent is ON the board is not a
 *  card of its own: it rides inside the parent's card as a sub-task (operator's call, 2026-08-26).
 *  Orphans (parent closed/absent) stay cards. Pure. */
export function columnsFor(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const by = new Map(COLUMNS.map((c) => [c.id, []]));
  for (const t of tasks) {
    if (t.parent && ids.has(t.parent)) continue;
    (by.get(t.status) ?? by.get("open")).push(t);
  }
  return COLUMNS.map((c) => ({ ...c, tasks: by.get(c.id) }));
}

/** Direct children of `id` among `tasks`, in list order. Pure. */
export function childrenOf(tasks, id) {
  return tasks.filter((t) => t.parent === id);
}

/** Initials for the assignee chip: "Aleksey Bykhun" → "AB", "research" → "RE". */
export function initials(name) {
  const parts = String(name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

import { wireEditableList } from "./editlist.js";
import { prChipHtml } from "./taskspad.js";

export function initBoard(deps) {
  const log = (...a) => console.log("[board]", ...a);
  const root = deps.el("board");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let byId = new Map();
  let dragging; // { id, from }
  let inflight = 0;
  let lastWriteAt = 0;

  const GLYPH = { open: "○", in_progress: "◐", blocked: "●", deferred: "❄", closed: "✓" };

  function subRowHtml(k) {
    return `<div class="eli bsi${k.status === "closed" ? " done" : ""}" data-id="${esc(k.id)}" data-sub="${esc(k.id)}"><span class="bsb st ${k.status === "in_progress" ? "prog" : k.status}">${GLYPH[k.status] ?? "?"}</span><span class="elt bst" contenteditable="true" spellcheck="false">${esc(k.title)}</span><span class="bopen" title="open this sub-task">↗</span></div>`;
  }
  function subListHtml(parentId, kids) {
    return `<div class="bsub" data-parent="${esc(parentId)}" title="sub-tasks — type to rename · enter = new · backspace on empty = remove · bullet = status">${kids.map(subRowHtml).join("")}</div>`;
  }
  /** Wire every checklist under `scope` with the shared editable-list contract. */
  function wireSubLists(scope) {
    for (const el of scope.querySelectorAll(".bsub:not([data-wired])")) {
      el.dataset.wired = "1";
      wireEditableList(el, {
        api: deps.api,
        parent: el.dataset.parent,
        log,
        onCreated: (id, title) => byId.set(id, { id, title, status: "open", parent: el.dataset.parent }),
        onRenamed: (id, title) => {
          const t = byId.get(id);
          if (t) t.title = title;
        },
        onRemoved: (id) => byId.delete(id),
        onSynced: () => {
          lastWriteAt = Date.now();
        },
      });
    }
  }

  function cardHtml(t) {
    const kids = childrenOf([...byId.values()], t.id);
    const done = kids.filter((k) => k.status === "closed").length;
    return `<div class="bcard${t.status === "closed" ? " bdone" : ""}" draggable="true" data-id="${esc(t.id)}" title="${esc(t.closeReason ? `closed — ${t.closeReason}` : (t.description ?? t.title))}">
      <div class="bt">${esc(t.title)}</div>
      ${t.description ? `<div class="bd">${esc(t.description.slice(0, 140))}${t.description.length > 140 ? "…" : ""}</div>` : ""}
      ${kids.length ? subListHtml(t.id, kids) : ""}
      <div class="bf">
        <span class="bid">${esc(t.id.replace(/^[a-z0-9]+-/, ""))}</span>${prChipHtml(t, esc)}
        ${t.blockedBy?.length ? `<span class="bblk" title="blocked by ${esc(t.blockedBy.join(", "))}">⛓ ${t.blockedBy.length}</span>` : ""}
        ${t.comments ? `<span class="bcm">💬 ${t.comments}</span>` : ""}
        ${t.assignee ? `<span class="bav" title="${esc(t.assignee)}">${esc(initials(t.assignee))}</span>` : ""}
      </div>
    </div>`;
  }

  function render(tasks) {
    byId = new Map(tasks.map((t) => [t.id, t]));
    const cols = columnsFor(tasks);
    root.querySelector("#bcols").innerHTML = cols
      .map(
        (c) => `<div class="bcol" data-col="${c.id}">
        <div class="bhead"><span class="bdot ${c.cls}"></span><span class="bttl">${esc(c.title)}</span><span class="bcount">${c.tasks.length}</span></div>
        <div class="bcards">${c.tasks.map(cardHtml).join("")}${
          c.id === "closed" && !c.tasks.length ? `<div class="bdrop">drop a card here to close it</div>` : ""
        }</div>
        ${c.id !== "closed" ? `<button class="badd" data-add="${c.id}">+ add a card</button>` : ""}
      </div>`,
      )
      .join("");
    wireSubLists(root);
    log(`render ${tasks.length} task(s)`);
  }

  function maybeRender(tasks, fetchedAt = Date.now()) {
    if (root.hidden) return;
    if (inflight || fetchedAt < lastWriteAt || root.querySelector(".badd-form")) return;
    if (root.contains(document.activeElement) && document.activeElement.closest?.(".elt")) return; // mid-edit
    render(tasks);
  }

  const post = (b) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  async function move(id, from, to) {
    const t = byId.get(id);
    if (!t || from === to) return;
    const card = root.querySelector(`.bcard[data-id="${CSS.escape(id)}"]`);
    const target = root.querySelector(`.bcol[data-col="${to}"] .bcards`);
    const prevStatus = t.status;
    t.status = to;
    if (card && target) target.insertBefore(card, target.querySelector(".bdrop")); // optimistic
    inflight++;
    try {
      if (to === "closed") await deps.api("/api/tasks", post({ op: "close", id, reason: "moved to Done on the board" }));
      else await deps.api("/api/tasks", post({ op: "update", id, status: to }));
      lastWriteAt = Date.now();
      card?.classList.toggle("bdone", to === "closed"); // closed cards stay in Done, dimmed
      deps.onSynced?.();
    } catch (e) {
      t.status = prevStatus;
      const back = root.querySelector(`.bcol[data-col="${prevStatus}"] .bcards`);
      if (card && back) back.appendChild(card);
      card?.classList.add("bfail");
      card?.setAttribute("data-error", String(e?.message ?? e).slice(0, 140));
      log(`move FAILED ${id}: ${e?.message ?? e}`);
    } finally {
      inflight--;
    }
  }

  root.addEventListener("dragstart", (e) => {
    const card = e.target.closest?.(".bcard");
    if (!card) return;
    if (e.target.closest?.(".bsub")) return void e.preventDefault(); // the checklist is not a handle
    dragging = { id: card.dataset.id, from: card.closest(".bcol").dataset.col };
    card.classList.add("bdragging");
    e.dataTransfer.effectAllowed = "move";
  });
  root.addEventListener("dragend", (e) => {
    e.target.closest?.(".bcard")?.classList.remove("bdragging");
    for (const c of root.querySelectorAll(".bcol.bover")) c.classList.remove("bover");
    dragging = undefined;
  });
  root.addEventListener("dragover", (e) => {
    const col = e.target.closest?.(".bcol");
    if (!col || !dragging) return;
    e.preventDefault();
    for (const c of root.querySelectorAll(".bcol.bover")) if (c !== col) c.classList.remove("bover");
    if (col.dataset.col !== dragging.from) col.classList.add("bover");
  });
  root.addEventListener("drop", (e) => {
    const col = e.target.closest?.(".bcol");
    if (!col || !dragging) return;
    e.preventDefault();
    col.classList.remove("bover");
    void move(dragging.id, dragging.from, col.dataset.col);
    dragging = undefined;
  });

  // Add a card: an inline input at the column foot; Enter files it (create, then status if not open).
  root.addEventListener("click", async (e) => {
    const add = e.target.closest?.(".badd");
    if (add) {
      const colId = add.dataset.add;
      add.outerHTML = `<div class="badd-form"><input type="text" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" placeholder="card title…" spellcheck="false"><div class="bhint"></div></div>`;
      const form = root.querySelector(`.bcol[data-col="${colId}"] .badd-form`);
      const input = form.querySelector("input");
      input.focus();
      input.addEventListener("keydown", async (ev) => {
        ev.stopPropagation();
        if (ev.key === "Escape") return void form.replaceWith(Object.assign(document.createElement("button"), { className: "badd", textContent: "+ add a card", dataset: undefined })) || render([...byId.values()]);
        if (ev.key !== "Enter") return;
        const title = input.value.trim();
        if (!title) return;
        input.disabled = true;
        form.querySelector(".bhint").textContent = "filing…";
        inflight++;
        try {
          const d = await deps.api("/api/tasks", post({ op: "create", title }));
          if (colId !== "open") await deps.api("/api/tasks", post({ op: "update", id: d.id, status: colId }));
          lastWriteAt = Date.now();
          byId.set(d.id, { id: d.id, title, status: colId });
          render([...byId.values()]);
          deps.onSynced?.();
        } catch (err) {
          form.querySelector(".bhint").textContent = `failed: ${err?.message ?? err}`;
          input.disabled = false;
        } finally {
          inflight--;
        }
      });
      return;
    }
    const sub = e.target.closest?.(".bsi");
    if (sub) {
      // The bullet is the status control, ↗ opens the sub-task's own card, and the text is an
      // EDITOR (the pad's contract, via editlist.js) — so a click on it just places the caret.
      if (e.target.closest(".bsb")) void cycleSub(sub);
      else if (e.target.closest(".bopen") && sub.dataset.id) void openModal(sub.dataset.id);
      return;
    }
    const card = e.target.closest?.(".bcard");
    if (card) void openModal(card.dataset.id); // Notion-style full card: details, sub-tasks, comments
  });

  // ---- the card modal ----
  const rel = (iso) => {
    const t = Date.parse(iso ?? "");
    if (!Number.isFinite(t)) return "";
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    return sec < 60 ? `${sec}s ago` : sec < 3600 ? `${Math.round(sec / 60)}m ago` : sec < 86400 ? `${Math.round(sec / 3600)}h ago` : `${Math.round(sec / 86400)}d ago`;
  };
  let modalFor;
  function closeModal() {
    root.querySelector("#bmodal")?.remove();
    modalFor = undefined;
  }
  async function openModal(id) {
    const t = byId.get(id);
    if (!t) return;
    closeModal();
    modalFor = id;
    const kids = childrenOf([...byId.values()], id);
    const meta = (k, v) => (v ? `<div class="mrow"><span class="mk">${esc(k)}</span><span>${esc(v)}</span></div>` : "");
    const wrap = document.createElement("div");
    wrap.id = "bmodal";
    wrap.innerHTML = `<div class="mbox" role="dialog">
      <div class="mhead">
        <div class="mstatus">${COLUMNS.map((c) => `<button class="mst${t.status === c.id ? " on" : ""}" data-st="${c.id}"><span class="bdot ${c.cls}"></span>${esc(c.title)}</button>`).join("")}</div>
        <button class="mclose" title="close (esc)">✕</button>
      </div>
      <h2 class="mtitle">${esc(t.title)}${prChipHtml(t, esc) ? ` <span class="mpr">${prChipHtml(t, esc)}</span>` : ""}</h2>
      ${t.description ? `<div class="mdesc">${esc(t.description)}</div>` : `<div class="mdesc dim">no description — \`bd update ${esc(id)} -d "…"\` adds one</div>`}
      <div class="mmeta">
        ${meta("id", t.id)}${meta("priority", t.priority !== undefined ? `p${t.priority}` : "")}
        ${meta("created", t.createdAt ? `${rel(t.createdAt)}${t.createdBy ? " by " + t.createdBy : ""}` : "")}
        ${meta("updated", t.updatedAt ? rel(t.updatedAt) : "")}${meta("assigned", t.assignee)}
        ${meta("blocked by", t.blockedBy?.length ? t.blockedBy.join(", ") : "")}
      </div>
      <div class="msec">Sub-tasks</div>${subListHtml(id, kids)}<button class="badd msubadd">+ add a sub-task</button>
      <div class="msec">Comments</div>
      <div class="mcomments"><div class="dim">loading…</div></div>
      <div class="mcompose"><input type="text" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" placeholder="comment — or @agent message to notify them" spellcheck="false"><div class="mhint"></div></div>
    </div>`;
    root.appendChild(wrap);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) closeModal(); // backdrop
    });
    wrap.querySelector(".mclose").addEventListener("click", closeModal);
    for (const btn of wrap.querySelectorAll(".mst")) {
      btn.addEventListener("click", async () => {
        const to = btn.dataset.st;
        const cur = byId.get(id)?.status;
        if (!cur || to === cur) return;
        await move(id, cur, to);
        for (const x of wrap.querySelectorAll(".mst")) x.classList.toggle("on", x.dataset.st === byId.get(id)?.status);
        if (to === "closed" && byId.get(id)?.status === "closed") closeModal(); // it left the board
      });
    }
    wireSubLists(wrap);
    wrap.querySelector(".msubadd").addEventListener("click", () => {
      const list = wrap.querySelector(".bsub");
      list.insertAdjacentHTML("beforeend", `<div class="eli bsi" data-id=""><span class="bsb st open">○</span><span class="elt bst" contenteditable="true" spellcheck="false"></span><span class="bopen" title="open this sub-task">↗</span></div>`);
      list.lastElementChild.querySelector(".elt").focus();
    });
    const input = wrap.querySelector(".mcompose input");
    const hint = wrap.querySelector(".mhint");
    const list = wrap.querySelector(".mcomments");
    const renderComments = (cs) => {
      list.innerHTML = cs.length
        ? cs.map((c) => `<div class="mc"><span class="mca">${esc(c.author)}</span><span class="mct">${esc(rel(c.createdAt))}</span><div class="mcb">${esc(c.text)}</div></div>`).join("")
        : `<div class="dim">no comments yet</div>`;
    };
    const loadComments = async () => {
      try {
        const d = await deps.api("/api/tasks", post({ op: "comments", id }));
        if (modalFor === id) renderComments(d.comments ?? []);
      } catch (err) {
        list.innerHTML = `<div class="dim">couldn't load comments: ${esc(err?.message ?? err)}</div>`;
      }
    };
    void loadComments();
    input.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key === "Escape") return closeModal();
      if (e.key !== "Enter") return;
      const raw = input.value.trim();
      if (!raw) return;
      const tags = [...raw.matchAll(/@([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      const text = raw.replace(/@[A-Za-z0-9_-]+/g, "").trim() || raw;
      const known = deps.agents?.() ?? [];
      const targets = tags.filter((n) => known.includes(n));
      const unknown = tags.filter((n) => !known.includes(n));
      if (unknown.length && !targets.length) return void (hint.textContent = `no agent named ${unknown.join(", ")}`);
      input.disabled = true;
      hint.textContent = targets.length ? `commenting + notifying ${targets.map((n) => "@" + n).join(", ")}…` : "commenting…";
      try {
        await deps.api("/api/tasks", post({ op: "comment", id, text: targets.length ? `${text} (→ ${targets.map((n) => "@" + n).join(", ")})` : text }));
        const body = `New comment on [task ${id}] ${t.title}:\n${text}\n(run \`bd show ${id}\` for the task and its comments)`;
        for (const to of targets) await deps.api("/api/dm", post({ to, text: body }));
        lastWriteAt = Date.now();
        input.value = "";
        hint.textContent = targets.length ? "commented + sent ✓" : "comment saved ✓";
        const task = byId.get(id);
        if (task) task.comments = (task.comments ?? 0) + 1;
        await loadComments();
        deps.onSynced?.();
      } catch (err) {
        hint.textContent = `failed: ${err?.message ?? err}`;
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
    setTimeout(() => input.focus(), 0);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !modalFor) return;
    // Esc inside an editor (a checklist row, the comment box) ends the EDIT — the modal stays. Only
    // a "bare" Esc closes it; otherwise leaving a row you were typing in threw the whole card away.
    if (e.target.closest?.(".elt, input, textarea")) return;
    e.stopPropagation();
    closeModal();
  }, true);

  const NEXT = { open: "in_progress", in_progress: "closed" }; // anything else → open
  async function cycleSub(el) {
    const id = el.dataset.id || el.dataset.sub;
    const t = byId.get(id);
    if (!t) return;
    const prev = t.status;
    const next = NEXT[prev] ?? "open";
    const paint = (st) => {
      const b = el.querySelector(".bsb");
      b.textContent = GLYPH[st] ?? "?";
      b.className = `bsb st ${st === "in_progress" ? "prog" : st}`;
      el.classList.toggle("done", st === "closed");
    };
    t.status = next;
    paint(next);
    inflight++;
    try {
      if (next === "closed") await deps.api("/api/tasks", post({ op: "close", id, reason: "checked off on the board" }));
      else await deps.api("/api/tasks", post({ op: "update", id, status: next }));
      lastWriteAt = Date.now();
      // A closed child stays visible (struck) until the next rebuild drops it from `bd list` — the
      // parent's card keeps its checklist shape while you tick through it.
    } catch (err) {
      t.status = prev;
      paint(prev);
      el.title = `⚠ ${String(err?.message ?? err).slice(0, 140)}`;
      log(`sub-task FAILED ${id}: ${err?.message ?? err}`);
    } finally {
      inflight--;
    }
  }

  function open(tasks) {
    root.hidden = false;
    render(tasks);
    deps.onSynced?.(); // fresh list on entry, like the pad
  }
  function close() {
    root.hidden = true;
  }
  return { open, close, maybeRender, isOpen: () => !root.hidden };
}

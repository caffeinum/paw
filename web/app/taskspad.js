/**
 * The task pad: the fleet's shared beads list as an EDITABLE bullet list, Apple-Notes style, opened
 * full-size over the main pane.
 *
 * The design premise: a todo list you have to leave the keyboard to edit isn't one you keep. So the
 * pad is text-first — every row's title is contenteditable, Enter makes the next task, Backspace on
 * an emptied row removes it, and the bullet is the status control (click cycles ○ open → ◐ in
 * progress → ✓ done). bd stays the store: edits debounce (1s) into `bd update`/`bd create` through
 * /api/tasks, and a new row gets its bd-assigned id stamped in as soon as the create lands — the
 * operator never names an id.
 *
 * The sync discipline that keeps it honest:
 *  - the pad is the WRITER while the operator is in it: a poll refresh never rebuilds rows while one
 *    is focused or a sync is pending — clobbering a row mid-keystroke is the lost-draft bug the
 *    composer already solved, one surface over.
 *  - a failed sync marks the row (red id chip) and keeps the text — the operator's words never
 *    vanish because bd hiccuped.
 *  - deleting a row that EXISTS in bd closes it (with a reason), never deletes: the list is shared,
 *    and another agent may hold context on that id. A row that never synced simply evaporates.
 */

/** Click-the-bullet state machine. closed → open (reopening a done task is the "wait, not done"
 *  gesture); blocked/deferred cycle back to open first so the pad never buries a task in a state
 *  it has no glyph affordance for. */
export function cycleStatus(status) {
  if (status === "open") return "in_progress";
  if (status === "in_progress") return "closed";
  return "open";
}

/** What removing a row means: a row bd knows about is CLOSED (shared list — never hard-delete an id
 *  a teammate may reference); a row that never synced just drops. */
export function deletionPlan(hasId) {
  return hasId ? "close" : "drop";
}

/**
 * Turn pasted text into task titles: one non-empty line each, list markers stripped — pasting a
 * bulleted list from notes/slack should FILE those bullets, not decorate one title with them.
 * (Numbered markers too: `1. thing` pastes as `thing`.)
 */
export function pasteLines(text) {
  return pasteOutline(text).map((x) => x.title);
}

/**
 * Parse pasted text into an OUTLINE: each non-empty line a title plus its indent depth, so a
 * tabulated list pastes as parents and children rather than a flat run. Depth is measured in
 * indent STEPS (a tab, or the smallest non-zero space-indent in the paste), normalized so the
 * shallowest line is depth 0; list markers and numbering are stripped after the indent is read.
 */
export function pasteOutline(text) {
  const rows = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => {
      const indent = /^[\t ]*/.exec(l)[0];
      const title = l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, "").trim();
      const units = indent.replace(/\t/g, "  ").length; // a tab counts as one 2-space step
      return { title, units };
    })
    .filter((r) => r.title);
  if (!rows.length) return [];
  const min = Math.min(...rows.map((r) => r.units));
  const steps = [...new Set(rows.map((r) => r.units - min))].sort((a, b) => a - b);
  const step = steps.find((x) => x > 0) ?? 2;
  return rows.map((r) => ({ title: r.title, depth: Math.min(5, Math.round((r.units - min) / step)) }));
}

/** "3h ago" / "2d ago" from an ISO stamp — the card's dates are for orientation, not audit. */
export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Children ride directly under their parent, whatever order the flat list arrived in. Top-level
 * order is preserved; orphans (parent not in the list — e.g. the parent is closed) render top-level
 * rather than vanishing. Pure.
 */
/** Stable partition: open first, closed after — the SAME relative order inside each half, so a
 *  manual drag order survives, just with done work sunk to the bottom of its level. Pure. */
export function closedLast(tasks) {
  return [...tasks.filter((t) => t.status !== "closed"), ...tasks.filter((t) => t.status === "closed")];
}

export function treeOrder(tasks) {
  const byParent = new Map();
  const ids = new Set(tasks.map((t) => t.id));
  const tops = [];
  for (const t of tasks) {
    if (t.parent && ids.has(t.parent)) {
      if (!byParent.has(t.parent)) byParent.set(t.parent, []);
      byParent.get(t.parent).push(t);
    } else tops.push(t);
  }
  const out = [];
  const walk = (t) => {
    out.push(t);
    for (const c of closedLast(byParent.get(t.id) ?? [])) walk(c); // closed children at the end of THEIR parent's list
  };
  for (const t of closedLast(tops)) walk(t); // closed top-levels at the end of the list, whatever the drag order said
  return out;
}

/** Display depth: how many parents above this task, bounded so a cycle can't hang the render. */
export function taskDepth(t, byId) {
  let d = 0;
  let cur = t;
  while (cur?.parent && d < 6) {
    cur = byId.get(cur.parent);
    d++;
  }
  return d;
}

/** A PR chip for a merge-request bead: state glyph · #number · checks — the PRs sidebar's vocabulary,
 *  linking to the PR. Pure; a bead without a resolved PR but with a ref still gets a plain link. */
export function prChipHtml(t, esc = (s) => String(s)) {
  if (t.type !== "merge-request" || !t.externalRef) return "";
  const pr = t.pr;
  if (!pr) return `<a class="prchip" href="${esc(t.externalRef)}" target="_blank" rel="noreferrer noopener" title="PR — not resolved yet">↗ PR</a>`;
  const st = pr.state === "MERGED" ? ["⧉", "merged", "Merged"] : pr.state === "CLOSED" ? ["⊘", "closed", "Closed"] : pr.isDraft ? ["◌", "draft", "Draft"] : ["◍", "open", "Open"];
  const ck = pr.checks === "pass" ? ` <span class="ck pass">✓</span>` : pr.checks === "fail" ? ` <span class="ck fail">✕</span>` : pr.checks === "pending" ? ` <span class="ck pending">•</span>` : "";
  return `<a class="prchip ${st[1]}" href="${esc(pr.url)}" target="_blank" rel="noreferrer noopener" title="${esc(st[2])} · ${esc(pr.title ?? "")}">${st[0]} #${pr.number}${ck}</a>`;
}

const GLYPH = { open: "○", in_progress: "◐", blocked: "●", deferred: "❄", closed: "✓" };

export function statusGlyph(status) {
  return GLYPH[status] ?? "?";
}

/** Wire the pad. `deps`: {api(path, opts), el(id), onSynced()} — injected so the module owns no
 *  globals and the pure parts stay testable. Returns {open, close, maybeRender, isOpen}. */
export function initTaskspad(deps) {
  // Breadcrumbs, always on: this pad has failed silently twice, and "doesn't work" plus a screenshot
  // was the entire signal both times. Cheap logs beat another guessing round.
  const log = (...a) => console.log("[taskspad]", ...a);
  const pad = deps.el("taskspad");
  const rowsEl = deps.el("padrows");
  /** When the last WRITE (create/update/close) completed — a fetch that STARTED before this is stale
   *  and must not render (it would revert rows to their pre-save state). */
  let lastWriteAt = 0;
  const timers = new Map(); // row element → debounce timer
  let byId = new Map(); // id → the task as last fetched (feeds the hover metadata card)
  const dirty = new Set(); // row elements with unsent edits
  let inflight = 0;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function rowHtml(t) {
    const done = t.status === "closed";
    const depth = taskDepth(t, byId);
    return `<div class="padrow${done ? " done" : ""}" data-id="${esc(t.id)}" data-status="${esc(t.status)}"${t.parent ? ` data-parent="${esc(t.parent)}"` : ""} style="padding-left:${22 + depth * 26}px">
      <span class="bullet st ${t.status === "in_progress" ? "prog" : t.status}" title="${esc(t.status)} — click to change">${statusGlyph(t.status)}</span>
      <span class="pid" draggable="true" title="drag to reorder · hover for details">${esc(t.id.replace(/^[a-z0-9]+-/, ""))}</span>
      <span class="ptitle" contenteditable="true" spellcheck="false">${esc(t.title)}</span>${prChipHtml(t, esc)}
      <span class="cmt${t.comments ? " has" : ""}" title="${t.comments ? `${t.comments} comment${t.comments === 1 ? "" : "s"} — click to read/add` : "message an agent about this task"}">💬${t.comments ? `<span class="cn">${t.comments}</span>` : ""}</span><span class="spacer"></span>${
        t.blockedBy?.length
          ? `<span class="blockedby" title="bd will refuse to close this until ${esc(t.blockedBy.join(", "))} close">⛓ ${t.blockedBy.map((b) => esc(b.replace(/^[a-z0-9]+-/, ""))).join(" ")}</span>`
          : ""
      }
    </div>`;
  }

  const ghostHtml = `<div class="padrow ghost">
      <span class="bullet st open">○</span><span class="pid"></span>
      <span class="ptitle" contenteditable="true" spellcheck="false" data-ghost="1"></span>
    </div>`;

  /** Rebuilds keep the ORDER already on screen: the server sorts by status/priority, so a row you
   *  just touched would otherwise jump to its "correct" slot mid-thought (reported 2026-08-25). The
   *  server's sort applies when the pad OPENS; new ids append in server order. */
  function stableOrder(tasks) {
    const shown = [...rowsEl.querySelectorAll(".padrow:not(.ghost)")].map((r) => r.dataset.id).filter(Boolean);
    if (!shown.length) return tasks;
    const pos = new Map(shown.map((id, i) => [id, i]));
    return [...tasks].sort((a, b) => (pos.get(a.id) ?? shown.length) - (pos.get(b.id) ?? shown.length));
  }

  /** The operator's dragged order, applied to TOP-LEVEL tasks (children follow their parent). */
  function manualOrder(tasks) {
    const saved = deps.loadOrder?.() ?? [];
    if (!saved.length) return tasks;
    const pos = new Map(saved.map((id, i) => [id, i]));
    return [...tasks].sort((a, b) => (pos.get(a.id) ?? saved.length) - (pos.get(b.id) ?? saved.length));
  }

  function render(tasks, { keepOrder = false } = {}) {
    const list = treeOrder(keepOrder ? stableOrder(tasks) : manualOrder(tasks));
    log(`render ${list.length} task(s)${keepOrder ? " (display order kept)" : ""}`);
    byId = new Map(list.map((t) => [t.id, t]));
    rowsEl.innerHTML = list.map(rowHtml).join("") + ghostHtml;
  }

  // The metadata card: hover a task's id chip to see when/who/status without leaving the list.
  // `interactive` adds the @agent message box (opened by the row's 💬 or by hovering the title): the
  // text is DM'd to the tagged agent WITH the task id, so the agent starts from the task.
  let card;
  let cardFor;
  function showCard(pidEl, t, interactive = false) {
    if (card && cardFor === t.id + (interactive ? "+i" : "")) return;
    hideCard();
    cardFor = t.id + (interactive ? "+i" : "");
    card = document.createElement("div");
    card.className = "padcard";
    if (interactive) card.classList.add("live");
    const line = (k, v) => (v ? `<div><span class="k">${esc(k)}</span> ${esc(v)}</div>` : "");
    card.innerHTML =
      line("", t.id) +
      line("status", t.status + (t.priority !== undefined ? ` · p${t.priority}` : "")) +
      line("created", t.createdAt ? `${relTime(t.createdAt)}${t.createdBy ? " by " + t.createdBy : ""}` : "") +
      line("updated", t.updatedAt ? relTime(t.updatedAt) : "") +
      line("type", t.type && t.type !== "task" ? t.type : "") +
      (t.pr ? `<div><span class="k">PR</span> <a href="${esc(t.pr.url)}" target="_blank" rel="noreferrer noopener">#${t.pr.number} ${esc(t.pr.state ?? "")}${t.pr.checks ? " · checks " + esc(t.pr.checks) : ""}</a></div>` : t.externalRef ? line("ref", t.externalRef) : "") +
      line("assigned", t.assignee ?? "—") +
      line("closed", t.closedAt ? `${relTime(t.closedAt)}${t.closeReason ? " — " + t.closeReason : ""}` : "") +
      line("blocked by", t.blockedBy?.length ? t.blockedBy.join(", ") : "") +
      (interactive
        ? `<div class="cmsg"><input type="text" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" placeholder="@agent your message — sends as DM with ${esc(t.id)}" spellcheck="false"><div class="chint"></div></div>`
        : "");
    pad.appendChild(card);
    if (interactive) {
      const input = card.querySelector("input");
      const hint = card.querySelector(".chint");
      input.addEventListener("keydown", async (e) => {
        e.stopPropagation(); // the pad's own keymap (Tab, arrows, Esc-closes-pad) must not fire in here
        if (e.key === "Escape") return hideCard();
        if (e.key !== "Enter") return;
        const raw = input.value.trim();
        const tags = [...raw.matchAll(/@([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
        const text = raw.replace(/@[A-Za-z0-9_-]+/g, "").trim();
        const known = deps.agents?.() ?? [];
        const targets = tags.filter((n) => known.includes(n));
        const unknown = tags.filter((n) => !known.includes(n));
        if (!targets.length && unknown.length) {
          hint.textContent = `no agent named ${unknown.join(", ")} — @name from the sidebar`;
          return;
        }
        if (!targets.length) {
          // No tag = a note to the bead itself. Still recorded; nobody is nudged.
          if (!text) return void (hint.textContent = "write a note, or @agent message to notify someone");
          hint.textContent = "commenting…";
          input.disabled = true;
          try {
            await deps.api("/api/tasks", post({ op: "comment", id: t.id, text }));
            hint.textContent = "comment saved ✓ (no agent notified — @tag to nudge one)";
            input.value = "";
          } catch (err) {
            hint.textContent = `failed: ${err?.message ?? err}`;
          } finally {
            input.disabled = false;
          }
          return;
        }
        if (!text) {
          hint.textContent = "add the message after the @name";
          return;
        }
        hint.textContent = `sending to ${targets.map((n) => "@" + n).join(", ")}…`;
        input.disabled = true;
        // The words live on the BEAD (a bd comment — durable, anyone running `bd show` sees them);
        // the DM is the nudge that points the agent at the thread.
        const body = `New comment on [task ${t.id}] ${t.title}:\n${text}\n(run \`bd show ${t.id}\` for the task and its comments)`;
        try {
          await deps.api("/api/tasks", post({ op: "comment", id: t.id, text: `${text} (→ ${targets.map((n) => "@" + n).join(", ")})` }));
          for (const to of targets) await deps.api("/api/dm", post({ to, text: body }));
          hint.textContent = `commented + sent ✓${unknown.length ? ` (ignored @${unknown.join(", @")})` : ""}`;
          input.value = "";
          setTimeout(() => hideCard(), 1200);
        } catch (err) {
          hint.textContent = `failed: ${err?.message ?? err}`;
        } finally {
          input.disabled = false;
        }
      });
      setTimeout(() => input.focus(), 0);
    }
    const r = pidEl.getBoundingClientRect();
    const pr = pad.getBoundingClientRect();
    // Clamp INSIDE the pad: anchored near the right edge the card overflowed the pane and shifted the
    // whole page sideways ("it moves the whole page", 2026-08-26). Overflow on #taskspad is the belt;
    // this is the braces.
    const cw = card.offsetWidth || 340;
    const ch = card.offsetHeight || 160;
    card.style.left = `${Math.max(8, Math.min(r.left - pr.left, pr.width - cw - 8))}px`;
    const below = r.bottom - pr.top + 4;
    card.style.top = `${below + ch > pr.height - 8 ? Math.max(8, r.top - pr.top - ch - 4) : below}px`;
  }
  function hideCard() {
    card?.remove();
    card = undefined;
    cardFor = undefined;
  }

  /** A rebuild is only safe when the operator isn't mid-edit and nothing is still syncing.
   *
   *  "Mid-edit" is judged by CONTENT, not mere focus: opening the pad before the first fetch lands
   *  focuses the empty ghost, and a focus-based guard then skipped every later render — the pad sat
   *  blank forever while the sidebar counted 15 (reported live, twice, 2026-08-25). An empty ghost
   *  holding focus loses nothing by being rebuilt; a row with words in it does. */
  function maybeRender(tasks, fetchedAt = Date.now()) {
    if (pad.hidden) return;
    const active = document.activeElement?.closest?.(".padrow");
    const editing = active && !(active.classList.contains("ghost") && titleOf(active) === "");
    if (dirty.size || inflight || editing || fetchedAt < lastWriteAt) {
      log(`maybeRender skipped (dirty=${dirty.size} inflight=${inflight} editing=${!!editing} stale=${fetchedAt < lastWriteAt})`);
      return;
    }
    const ghostHadFocus = !!active;
    render(tasks, { keepOrder: true });
    if (ghostHadFocus) rowsEl.querySelector(".padrow.ghost .ptitle")?.focus();
  }

  function titleOf(row) {
    return row.querySelector(".ptitle").textContent.trim();
  }

  /** Turn the ghost into a real (unsynced) row and grow a fresh ghost under it. */
  function materialize(row) {
    if (!row.classList.contains("ghost")) return row;
    row.classList.remove("ghost");
    row.querySelector(".ptitle").removeAttribute("data-ghost");
    rowsEl.insertAdjacentHTML("beforeend", ghostHtml);
    return row;
  }

  async function sync(row) {
    timers.delete(row);
    if (row.classList.contains("ghost")) return;
    const title = titleOf(row);
    const id = row.dataset.id;
    if (!title) return; // emptied rows are the deletion path, not an update to ""
    dirty.delete(row);
    inflight++;
    row.classList.add("saving"); // shown only while the write is genuinely in flight — from the
    // keystroke it read as a 4s save when the clock hadn't even started (blur is the trigger)
    try {
      if (id) {
        await deps.api("/api/tasks", post({ op: "update", id, title }));
      } else {
        const parent = row.dataset.parent || undefined; // a sibling made with Enter carries its parent
        const d = await deps.api("/api/tasks", post({ op: "create", title, parent }));
        row.dataset.id = d.id;
        byId.set(d.id, { id: d.id, title, status: "open", parent }); // so a rebuild keeps it nested
        row.querySelector(".pid").textContent = d.id.replace(/^[a-z0-9]+-/, "");
      }
      row.classList.remove("failed");
      row.classList.remove("saving");
      lastWriteAt = Date.now();
      log(`sync ok ${row.dataset.id}`);
    } catch (e) {
      // The text stays; the row says it hasn't landed. The next keystroke retries.
      log(`sync FAILED ${row.dataset.id || "(new)"}: ${e?.message ?? e}`);
      row.classList.remove("saving");
      row.classList.add("failed");
      dirty.add(row);
    } finally {
      inflight--;
      if (!dirty.size && !inflight) deps.onSynced();
    }
  }

  function queueSync(row, ms = 8000) {
    dirty.add(row);
    clearTimeout(timers.get(row));
    timers.set(row, setTimeout(() => void sync(row), ms));
  }

  async function removeRow(row) {
    const id = row.dataset.id;
    const prev = row.previousElementSibling;
    clearTimeout(timers.get(row));
    timers.delete(row);
    dirty.delete(row);
    row.remove();
    if (deletionPlan(!!id) === "close") {
      inflight++;
      try {
        await deps.api("/api/tasks", post({ op: "close", id, reason: "removed from the task pad" }));
        lastWriteAt = Date.now();
      } catch {
        /* it stays open in bd and reappears on the next rebuild — visible, not lost */
      } finally {
        inflight--;
        if (!dirty.size && !inflight) deps.onSynced();
      }
    }
    const t = prev?.querySelector?.(".ptitle");
    if (t) focusEnd(t);
  }

  function focusEnd(el) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  /** Caret column in a (single-text-node) title, for arrow navigation that keeps your place. */
  function caretOffset(el) {
    const s = getSelection();
    if (!s.rangeCount || !el.contains(s.anchorNode)) return 0;
    return s.anchorOffset;
  }

  function focusAt(el, offset) {
    el.focus();
    const node = el.firstChild;
    const s = getSelection();
    const r = document.createRange();
    if (node && node.nodeType === Node.TEXT_NODE) {
      const at = Math.min(offset, node.textContent.length);
      r.setStart(node, at);
    } else {
      r.selectNodeContents(el);
      r.collapse(true);
    }
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
  }

  /** ↑/↓ move between rows like one multiline document — each row is its own contenteditable, so
   *  without this the arrows dead-end at the row boundary (reported 2026-08-25, first click-through). */
  function moveFocus(row, t, dir) {
    const target = (dir < 0 ? row.previousElementSibling : row.nextElementSibling)?.querySelector?.(".ptitle");
    if (!target) return false;
    focusAt(target, caretOffset(t));
    return true;
  }

  function paintStatus(row, status) {
    row.dataset.status = status;
    const b = row.querySelector(".bullet");
    b.textContent = statusGlyph(status);
    b.className = `bullet st ${status === "in_progress" ? "prog" : status}`;
    row.classList.toggle("done", status === "closed");
  }

  async function cycleRow(row) {
    const id = row.dataset.id;
    if (!id) return; // an unsynced row has no status to cycle yet
    const prev = row.dataset.status;
    const next = cycleStatus(prev);
    paintStatus(row, next); // optimistic…
    inflight++;
    try {
      if (next === "closed") await deps.api("/api/tasks", post({ op: "close", id, reason: "checked off in the task pad" }));
      else await deps.api("/api/tasks", post({ op: "update", id, status: next }));
      lastWriteAt = Date.now();
      row.classList.remove("failed");
      row.removeAttribute("data-error");
    } catch (e) {
      // …but never a lying checkmark: bd's refusal (e.g. "blocked by open issues") reverts the
      // bullet and shows ITS words, not a generic "not saved".
      paintStatus(row, prev);
      row.classList.add("failed");
      row.setAttribute("data-error", ` ${String(e?.message ?? e).slice(0, 120)}`);
      log(`status FAILED ${id}: ${e?.message ?? e}`);
    } finally {
      inflight--;
      if (!dirty.size && !inflight) deps.onSynced();
    }
  }

  /** A brand-new, not-yet-synced row (no id — sync() creates it in bd on the debounce). */
  function blankRowHtml(title) {
    return `<div class="padrow" data-id="" data-status="open">
      <span class="bullet st open" title="open — click to change">○</span>
      <span class="pid"></span>
      <span class="ptitle" contenteditable="true" spellcheck="false">${esc(title)}</span>
    </div>`;
  }

  // Paste is intercepted for two reasons, both found on the first real paste (2026-08-25 screenshot):
  // contenteditable takes the clipboard's RICH HTML by default (a pasted notes list rendered blue
  // links and nested bullets inside one title), and a MULTILINE paste belongs in multiple tasks —
  // that's what the operator pasting a todo list means. Line 1 lands at the caret; every further
  // non-empty line becomes its own new row below, each syncing into bd as its own task.
  rowsEl.addEventListener("paste", (e) => {
    const t = e.target.closest(".ptitle");
    if (!t) return;
    e.preventDefault();
    const outline = pasteOutline(e.clipboardData?.getData("text/plain"));
    if (!outline.length) return;
    const first = materialize(t.closest(".padrow"));
    document.execCommand("insertText", false, outline[0].title);
    if (outline.length === 1) return void queueSync(first);
    // A multi-line paste with structure syncs SEQUENTIALLY: a child's create needs its parent's
    // bd-assigned id, which only exists once the parent's create lands. Rows appear immediately
    // (indented, optimistic); ids stamp in as the chain walks.
    const rows = [{ row: first, depth: outline[0].depth }];
    let prev = first;
    for (const item of outline.slice(1)) {
      prev.insertAdjacentHTML("afterend", blankRowHtml(item.title));
      prev = prev.nextElementSibling;
      prev.style.paddingLeft = `${22 + item.depth * 26}px`;
      rows.push({ row: prev, depth: item.depth });
    }
    void (async () => {
      const parentAt = []; // depth → task id of the nearest ancestor at that depth
      for (const { row, depth } of rows) {
        const title = titleOf(row);
        if (!title) continue;
        const parent = depth > 0 ? parentAt[depth - 1] : undefined;
        row.classList.add("saving");
        inflight++;
        try {
          const d = await deps.api("/api/tasks", post({ op: "create", title, parent }));
          row.dataset.id = d.id;
          if (parent) row.dataset.parent = parent;
          row.querySelector(".pid").textContent = d.id.replace(/^[a-z0-9]+-/, "");
          parentAt[depth] = d.id;
          parentAt.length = depth + 1; // deeper ancestors from an earlier branch are gone
          lastWriteAt = Date.now();
          row.classList.remove("saving", "failed");
        } catch (err) {
          row.classList.remove("saving");
          row.classList.add("failed");
          log(`paste create FAILED "${title}": ${err?.message ?? err}`);
        } finally {
          inflight--;
        }
      }
      if (!dirty.size && !inflight) deps.onSynced();
    })();
  });

  let lastCycleAt = 0;
  rowsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".bullet");
    if (!b) return;
    // A double-click is one intent, not two: unthrottled, it cycled open→in_progress→CLOSED and
    // "marked as done" tasks the operator only meant to touch once (reported 2026-08-25).
    const now = Date.now();
    if (now - lastCycleAt < 350) return;
    lastCycleAt = now;
    void cycleRow(b.closest(".padrow"));
  });

  // Grab the id chip to reorder. Display order only — persisted per space in the browser
  // (deps.saveOrder); bd has no order field, and inventing one via priority would overload a
  // meaningful field with cosmetics.
  /** The dragged row plus every descendant under it — a parent moves WITH its children, or the
   *  drop leaves orphans indented under whoever happens to sit above (reported 2026-08-25). */
  function subtreeRows(row) {
    const isUnder = (id, ancestor) => {
      let cur = byId.get(id);
      for (let i = 0; cur?.parent && i < 6; i++) {
        if (cur.parent === ancestor) return true;
        cur = byId.get(cur.parent);
      }
      return false;
    };
    const out = [row];
    let next = row.nextElementSibling;
    while (next && next.dataset?.id && isUnder(next.dataset.id, row.dataset.id)) {
      out.push(next);
      next = next.nextElementSibling;
    }
    return out;
  }

  let dragging; // Array of rows: [the grabbed row, ...its subtree]
  rowsEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".padrow");
    if (!row || row.classList.contains("ghost")) return void e.preventDefault();
    dragging = subtreeRows(row);
    e.dataTransfer.effectAllowed = "move";
    for (const r of dragging) r.classList.add("dragging");
  });
  rowsEl.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest?.(".padrow");
    if (!over || over.classList.contains("ghost") || dragging.includes(over)) return; // never drop a parent into its own subtree
    const r = over.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) over.before(...dragging);
    else over.after(...dragging);
  });
  rowsEl.addEventListener("dragend", () => {
    if (!dragging) return;
    for (const r of dragging) r.classList.remove("dragging");
    dragging = undefined;
    const order = [...rowsEl.querySelectorAll(".padrow:not(.ghost)")].map((r) => r.dataset.id).filter(Boolean);
    deps.saveOrder?.(order);
    log(`order saved (${order.length})`);
  });

  rowsEl.addEventListener("click", (e) => {
    const c = e.target.closest?.(".cmt");
    if (!c) return;
    const id = c.closest(".padrow")?.dataset.id;
    const t = id ? byId.get(id) : undefined;
    if (t) showCard(c, t, true);
  });
  let hoverTimer;
  rowsEl.addEventListener("mouseover", (e) => {
    const pid = e.target.closest?.(".pid");
    const id = pid?.closest(".padrow")?.dataset.id;
    const t = id ? byId.get(id) : undefined;
    if (!t) return;
    clearTimeout(hoverTimer);
    if (pid) showCard(pid, t); // the passive metadata card stays hover-driven on the ID chip only —
    // the INTERACTIVE card is click-only (💬): an input that appears under a passing cursor was
    // more ambush than affordance (operator's call, 2026-08-25).
  });
  rowsEl.addEventListener("mouseout", (e) => {
    clearTimeout(hoverTimer);
    if (!e.target.closest?.(".pid")) return;
    // An interactive card must survive the trip from the row INTO the card.
    setTimeout(() => {
      if (card && !card.matches(":hover") && !card.contains(document.activeElement)) hideCard();
    }, 250);
  });
  rowsEl.addEventListener("scroll", hideCard);

  rowsEl.addEventListener("input", (e) => {
    const t = e.target.closest(".ptitle");
    if (!t) return;
    const row = materialize(t.closest(".padrow"));
    queueSync(row);
  });

  rowsEl.addEventListener("keydown", (e) => {
    const t = e.target.closest(".ptitle");
    if (!t) return;
    const row = t.closest(".padrow");
    if (e.key === "Enter") {
      // Enter = next task (the auto-bullet). Never a newline inside the title — a title is one line.
      e.preventDefault();
      const real = materialize(row);
      clearTimeout(timers.get(real));
      void sync(real);
      const ghost = rowsEl.querySelector(".padrow.ghost .ptitle");
      if (ghost) {
        const g = ghost.closest(".padrow");
        if (real.nextElementSibling !== g) real.after(g); // continue the list where you are, not at the bottom
        // Enter on a nested row makes a SIBLING: same parent, same indent. Without this the new row
        // sat visually among the children but filed top-level — "new task is starting in global"
        // (reported 2026-08-26).
        if (real.dataset.parent) {
          g.dataset.parent = real.dataset.parent;
          g.style.paddingLeft = real.style.paddingLeft;
        } else {
          delete g.dataset.parent;
          g.style.paddingLeft = "";
        }
        focusEnd(ghost);
      }
    } else if (e.key === "Tab") {
      // Tab nests under the row above (its level), Shift-Tab lifts to top level — bd holds the real
      // parent/child link (`--parent`), so the hierarchy is the fleet's, not this browser's.
      e.preventDefault();
      const id = row.dataset.id;
      if (!id) return; // an unsynced row nests once it exists
      let parent = "";
      if (!e.shiftKey) {
        const prevRow = row.previousElementSibling;
        const prevId = prevRow?.dataset?.id;
        if (!prevId || prevId === id) return;
        const prevTask = byId.get(prevId);
        parent = prevTask?.parent && prevTask.parent !== id ? prevTask.parent : prevId;
      }
      const offset = caretOffset(t);
      // OPTIMISTIC: indent NOW (a keystroke must answer at keystroke speed), write behind it —
      // bd costs ~1s per write and waiting for it made Tab feel broken (reported 2026-08-25).
      const task = byId.get(id);
      const prevParent = task?.parent;
      if (task) task.parent = parent || undefined;
      const refocus = () => {
        const back = rowsEl.querySelector(`.padrow[data-id="${CSS.escape(id)}"] .ptitle`);
        if (back) focusAt(back, offset);
      };
      render([...byId.values()], { keepOrder: true });
      refocus();
      inflight++;
      deps
        .api("/api/tasks", post({ op: "update", id, parent }))
        .then(() => {
          lastWriteAt = Date.now();
        })
        .catch((err) => {
          log(`reparent FAILED ${id}: ${err?.message ?? err} — reverting`);
          if (task) task.parent = prevParent;
          render([...byId.values()], { keepOrder: true });
          refocus();
        })
        .finally(() => {
          inflight--;
        });
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (moveFocus(row, t, e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
    } else if (e.key === "ArrowLeft" && caretOffset(t) === 0 && getSelection().isCollapsed) {
      // ← at the start of a row walks up to the end of the previous one, like one document.
      const prev = row.previousElementSibling?.querySelector?.(".ptitle");
      if (prev) {
        e.preventDefault();
        focusEnd(prev);
      }
    } else if (e.key === "ArrowRight" && caretOffset(t) >= t.textContent.length && getSelection().isCollapsed) {
      const next = row.nextElementSibling?.querySelector?.(".ptitle");
      if (next) {
        e.preventDefault();
        focusAt(next, 0);
      }
    } else if (e.key === "Backspace" && titleOf(row) === "" && !row.classList.contains("ghost")) {
      e.preventDefault();
      void removeRow(row);
    } else if (e.key === "Backspace" && caretOffset(t) === 0 && getSelection().isCollapsed && titleOf(row) !== "") {
      // Backspace at the START of a non-empty row walks to the end of the previous one — the gesture
      // a multiline editor trains. No merging: two tasks joined by a keystroke would be a surprise
      // write, where a caret move is free.
      const prev = row.previousElementSibling?.querySelector?.(".ptitle");
      if (prev) {
        e.preventDefault();
        focusEnd(prev);
      }
    } else if (e.key === "Escape") {
      leave();
    }
  });

  rowsEl.addEventListener(
    "blur",
    (e) => {
      const t = e.target.closest?.(".ptitle");
      if (!t) return;
      const row = t.closest(".padrow");
      if (dirty.has(row)) {
        clearTimeout(timers.get(row));
        void sync(row); // blur is THE save: leaving the row is "I'm done here" (operator's model, 2026-08-25)
      }
    },
    true,
  );

  function open(tasks) {
    log(`open with ${tasks.length} task(s)`);
    pad.hidden = false;
    render(tasks);
    const ghost = rowsEl.querySelector(".padrow.ghost .ptitle");
    if (ghost && !tasks.length) ghost.focus();
    deps.onSynced(); // opening asks for a FRESH list — the caller's copy may predate the first fetch
    deps.onToggle?.();
  }
  function close() {
    pad.hidden = true;
    deps.onToggle?.();
  }
  // ✕ and Esc ask the HOST to leave the view (deps.onClose → focus model); close() itself is what the
  // host calls when focus moves on. Calling close() here directly would desync the pad from focus.
  const leave = () => (deps.onClose ? deps.onClose() : close());
  deps.el("padclose").addEventListener("click", leave);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pad.hidden) leave();
  });

  return { open, close, maybeRender, isOpen: () => !pad.hidden };
}

function post(body) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

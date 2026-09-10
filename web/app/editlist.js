/**
 * An editable bullet list over bd — the task pad's row contract, packaged so the board's sub-task
 * checklists edit the SAME way (operator's call, 2026-08-26: "editable input same as tasks global
 * view, reuse it"). One contract, two hosts:
 *   - a row's title is contenteditable; leaving it (blur) saves `op:update title`
 *   - Enter files a NEW sibling right after it (`op:create` with the same parent) and focuses it
 *   - Backspace on an EMPTIED row removes it: synced → `op:close` (shared list, never delete), unsynced → drop
 *   - ↑/↓ move between rows keeping the caret column; ←/→ cross at the edges
 * The host renders rows (`.eli` with a `.elt[contenteditable]` and `data-id`); this module wires
 * the behaviour onto a container and reports writes through callbacks so the host can keep its own
 * model (`byId`) and refresh (`onSynced`). The pad still carries its original copy of this logic;
 * folding it onto this module is the next consolidation, not done here.
 */

/** Classify a keydown on a row into an action. Pure — the arrow/backspace rules are the ones that
 *  went wrong in the pad, so they are testable here. `caret` = {offset, len, collapsed}. */
export function keyAction(key, title, caret, shift = false) {
  if (key === "Enter") return "new-sibling";
  if (key === "Escape") return "blur";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowLeft" && caret.offset === 0 && caret.collapsed) return "prev-end";
  if (key === "ArrowRight" && caret.offset >= caret.len && caret.collapsed) return "next-start";
  if (key === "Backspace" && title === "") return "remove";
  if (key === "Backspace" && caret.offset === 0 && caret.collapsed) return "prev-end";
  if (key === "Tab") return shift ? "outdent" : "indent";
  return "none";
}

const post = (b) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

function caretOf(el) {
  const s = getSelection();
  const inside = s.rangeCount && el.contains(s.anchorNode);
  return { offset: inside ? s.anchorOffset : 0, len: el.textContent.length, collapsed: !s.rangeCount || s.isCollapsed };
}
function focusAt(el, offset) {
  el.focus();
  const node = el.firstChild;
  const r = document.createRange();
  if (node && node.nodeType === Node.TEXT_NODE) r.setStart(node, Math.min(offset, node.textContent.length));
  else r.selectNodeContents(el), r.collapse(true);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

/**
 * Wire one container. `opts`: {api, parent (the list's parent task id), onCreated(id,title),
 * onRenamed(id,title), onRemoved(id), onSynced(), log}. Rows: `.eli[data-id]` > `.elt[contenteditable]`.
 * Returns {newRowHtml(title)} so the host can append rows in its own markup.
 */
export function wireEditableList(container, opts) {
  const log = opts.log ?? (() => {});
  const dirty = new Set();
  const rowOf = (el) => el.closest(".eli");
  const titleOf = (row) => row.querySelector(".elt").textContent.trim();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const newRowHtml = (title = "") => `<div class="eli bsi" data-id=""><span class="bsb st open">○</span><span class="elt bst" contenteditable="true" spellcheck="false">${esc(title)}</span></div>`;

  async function save(row) {
    if (!dirty.has(row)) return;
    dirty.delete(row);
    const title = titleOf(row);
    const id = row.dataset.id;
    if (!title) return; // emptied rows are the removal path
    row.classList.add("saving");
    try {
      if (id) {
        await opts.api("/api/tasks", post({ op: "update", id, title }));
        opts.onRenamed?.(id, title);
      } else {
        const d = await opts.api("/api/tasks", post({ op: "create", title, parent: opts.parent }));
        row.dataset.id = d.id;
        opts.onCreated?.(d.id, title);
      }
      row.classList.remove("failed");
      row.removeAttribute("data-error");
    } catch (e) {
      row.classList.add("failed");
      row.setAttribute("data-error", String(e?.message ?? e).slice(0, 120));
      dirty.add(row);
      log(`save FAILED ${id || "(new)"}: ${e?.message ?? e}`);
    } finally {
      row.classList.remove("saving");
      opts.onSynced?.();
    }
  }

  async function remove(row) {
    const id = row.dataset.id;
    const prev = row.previousElementSibling?.querySelector?.(".elt");
    dirty.delete(row);
    row.remove();
    if (prev) focusAt(prev, prev.textContent.length);
    if (id) {
      try {
        await opts.api("/api/tasks", post({ op: "close", id, reason: "removed from the checklist" }));
        opts.onRemoved?.(id);
      } catch (e) {
        log(`remove FAILED ${id}: ${e?.message ?? e}`);
      } finally {
        opts.onSynced?.();
      }
    }
  }

  container.addEventListener("input", (e) => {
    const t = e.target.closest?.(".elt");
    if (t) dirty.add(rowOf(t));
  });
  container.addEventListener(
    "blur",
    (e) => {
      const t = e.target.closest?.(".elt");
      if (t) void save(rowOf(t));
    },
    true,
  );
  container.addEventListener("keydown", (e) => {
    const t = e.target.closest?.(".elt");
    if (!t) return;
    e.stopPropagation(); // the host's own keymap (Esc closes a modal, the board's shortcuts) stays out
    const row = rowOf(t);
    const act = keyAction(e.key, titleOf(row), caretOf(t), e.shiftKey);
    if (act === "none") return;
    e.preventDefault();
    if (act === "new-sibling") {
      void save(row);
      row.insertAdjacentHTML("afterend", newRowHtml());
      focusAt(row.nextElementSibling.querySelector(".elt"), 0);
    } else if (act === "remove") void remove(row);
    else if (act === "up" || act === "down") {
      const target = (act === "up" ? row.previousElementSibling : row.nextElementSibling)?.querySelector?.(".elt");
      if (target) focusAt(target, caretOf(t).offset);
    } else if (act === "prev-end") {
      const prev = row.previousElementSibling?.querySelector?.(".elt");
      if (prev) focusAt(prev, prev.textContent.length);
    } else if (act === "next-start") {
      const next = row.nextElementSibling?.querySelector?.(".elt");
      if (next) focusAt(next, 0);
    } else if (act === "blur") t.blur();
  });
  return { newRowHtml };
}

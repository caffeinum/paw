// Cmd+K command palette (operator ask, 2026-09-09): a quick jump to any agent — plus channels and the
// views — without reaching for the sidebar. ⌘K/Ctrl+K opens it, you type to filter, ↑/↓ move, Enter
// picks, Esc closes. It is a VIEW over the same `focusTarget` the sidebar uses, so picking here and
// clicking there do exactly the same thing.
//
// initPalette({ getItems, onPick }) → { open, close, isOpen, toggle }.
//   getItems() → [{ target, label, kind: "agent"|"channel"|"view", status?, live?, hint? }]
//   onPick(target)  — target is whatever focusTarget expects (an agent name, "#channel", or a sentinel)

/** Rank matches so the useful one is first: exact, then prefix, then substring; non-matches dropped.
 *  Pure/exported for the test. */
export function rankItems(items, query) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored = [];
  for (const it of items) {
    const l = String(it.label).toLowerCase();
    const i = l.indexOf(q);
    if (i === -1) continue;
    const score = l === q ? 0 : i === 0 ? 1 : 2;
    scored.push({ it, score, i });
  }
  scored.sort((a, b) => a.score - b.score || a.i - b.i || String(a.it.label).length - String(b.it.label).length);
  return scored.map((s) => s.it);
}

export function initPalette({ getItems, onPick }) {
  const root = document.getElementById("palette");
  let openState = false;
  let items = [];
  let sel = 0;
  const input = () => root.querySelector(".palq");
  const listEl = () => root.querySelector(".pallist");

  const isOpen = () => openState;

  function open() {
    openState = true;
    root.hidden = false;
    root.innerHTML = `<div class="palbox" role="dialog" aria-label="Command palette">
        <input class="palq" type="text" autocomplete="off" spellcheck="false" placeholder="Jump to an agent, channel, or view…" data-1p-ignore data-lpignore="true">
        <div class="pallist" role="listbox"></div>
      </div>`;
    sel = 0;
    refresh("");
    const q = input();
    q.addEventListener("input", () => refresh(q.value));
    q.addEventListener("keydown", onKey);
    // A click on the backdrop (outside the box) closes; a click on a row picks it.
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    q.focus();
  }
  function close() {
    openState = false;
    root.hidden = true;
    root.innerHTML = "";
  }
  function toggle() {
    openState ? close() : open();
  }

  function refresh(query) {
    items = rankItems(getItems(), query);
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    render();
  }

  function render() {
    const l = listEl();
    if (!l) return;
    if (!items.length) {
      l.innerHTML = `<div class="palempty">no match</div>`;
      return;
    }
    l.innerHTML = items
      .map((it, i) => {
        const dot =
          it.kind === "agent"
            ? `<span class="paldot ${!it.live ? "off" : it.busy || it.status === "working" ? "busy" : "on"}"></span>`
            : it.kind === "channel"
              ? `<span class="palhash">#</span>`
              : `<span class="palview">▤</span>`;
        const hint = it.hint ? `<span class="palhint">${esc(it.hint)}</span>` : "";
        return `<div class="palrow${i === sel ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === sel}">${dot}<span class="pallabel">${esc(it.label)}</span>${hint}</div>`;
      })
      .join("");
    for (const row of l.querySelectorAll(".palrow")) {
      row.addEventListener("mousemove", () => {
        const i = Number(row.dataset.i);
        if (i !== sel) { sel = i; paint(); }
      });
      row.addEventListener("click", () => pick(Number(row.dataset.i)));
    }
    scrollSelIntoView();
  }

  /** Repaint the selection without rebuilding the list (keeps mousemove cheap). */
  function paint() {
    const rows = listEl()?.querySelectorAll(".palrow") || [];
    rows.forEach((r, i) => {
      r.classList.toggle("sel", i === sel);
      r.setAttribute("aria-selected", String(i === sel));
    });
    scrollSelIntoView();
  }
  function scrollSelIntoView() {
    listEl()?.querySelectorAll(".palrow")[sel]?.scrollIntoView({ block: "nearest" });
  }

  function onKey(e) {
    if (e.key === "Escape") return void (e.preventDefault(), close());
    if (e.key === "ArrowDown") return void (e.preventDefault(), move(1));
    if (e.key === "ArrowUp") return void (e.preventDefault(), move(-1));
    if (e.key === "Enter") return void (e.preventDefault(), pick(sel));
  }
  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    paint();
  }
  function pick(i) {
    const it = items[i];
    if (!it) return;
    close();
    onPick(it.target, it.kind);
  }

  return { open, close, isOpen, toggle };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * The paw web client. Vanilla, no build step, no framework — one page against a frozen local API.
 *
 * It renders three things the terminal already shows and `cotal web` structurally cannot: paw's
 * per-folder agents, the human's DM conversation, and an agent's TRACE (its claude transcript, which
 * lives on disk and never crosses the mesh).
 *
 * Everything it knows comes from the daemon. It computes no state of its own — notably NOT unread,
 * which the server owns: paw's Raycast notes record two failed designs where each surface counted for
 * itself and then disagreed with the others about what had been read.
 */
import { md } from "./md.js";
import { survivingPending } from "./pending.js";
import { parseInvite } from "./commands.js";
import { isBangMode, parseBang } from "./bash.js";
import { orderTargets, stepTarget, draftKey as keyFor, firstUnreadTs, markScrollTop, recipientLabel, jumpScrollTop } from "./conversation.js";
import { loadRead, saveRead, isUnread, safeCursor, messageKey } from "./read-state.js";
import { loadArchive, saveArchive, pruneArchive, partitionRoster } from "./archive.js";
import { channelMembersFor, sortMembers, loadOpen as loadChOpen, saveOpen as saveChOpen, toggleOpen as toggleChOpen, loadSeen as loadChSeen, saveSeen as saveChSeen, markSeen as markChSeen, channelUnread } from "./channels.js";
import { prGlyph, checkGlyph, diffLabel, shouldRefetch } from "./prs.js";
import { parseTaskCommand, agentTasks } from "./tasks.js";
import { wireEditableList } from "./editlist.js";
import { initTaskspad } from "./taskspad.js";
import { initBoard } from "./board.js";
import { initVillage } from "./village.js";
import { initPalette } from "./palette.js";
import { composeQuote, quotable } from "./quote.js";

const $ = (id) => document.getElementById(id);

/** The task pad as a focus target — a VIEW in the same model as agents and channels, so selecting
 *  anything else naturally replaces it and there is exactly one "current view" (operator's call,
 *  2026-08-26: "it should be a normal tab like everything else"). `~` can't begin an agent name. */
const TASKS = "~tasks";
const BOARD = "~board"; // the kanban view of the same list — a sibling of Tasks in the focus model
const SEARCH = "~search"; // results of the last search, a view like Tasks/Board (the composer hides)
const VILLAGE = "~village"; // the transit-map view of the fleet — a sibling of Tasks/Board in the focus model

/**
 * Any uncaught error becomes VISIBLE — a red banner with the message, on the page itself. "The tab
 * doesn't work" debugging kept stalling on screenshots of blank panes while the actual exception sat
 * unseen in a closed devtools (2026-08-25); a client this size has no error reporting, so the page is
 * the error report. Click the banner to dismiss.
 */
function showFault(msg) {
  console.error("[paw]", msg);
  let b = document.getElementById("fault");
  if (!b) {
    b = document.createElement("div");
    b.id = "fault";
    b.style.cssText =
      "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99;background:#c0392b;color:#fff;" +
      "padding:8px 14px;border-radius:8px;font:12px/1.5 ui-monospace,monospace;max-width:80%;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)";
    b.title = "click to dismiss";
    b.addEventListener("click", () => b.remove());
    document.body.appendChild(b);
  }
  b.textContent = `⚠ ${msg}`;
}
window.addEventListener("error", (e) => showFault(`${e.message} (${String(e.filename ?? "").split("/").pop()}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => showFault(`unhandled: ${e.reason?.message ?? e.reason}`));

// The client names its own build, loudly, so "which code is this tab running" is answered by any
// screenshot instead of a forensic session (the 2026-08-25 evening: three rounds of fixes debugged
// against tabs of unknown vintage). Stamped by paw-folder at edit time; shown in the header hint.
const CLIENT_BUILD = "palette-1";
console.log("[paw] client build", CLIENT_BUILD);

const state = {
  space: "",
  /** name → archived-at ms. Agents filed out of the sidebar; an inbound message un-files them. */
  archive: {},
  /** A rebuild was postponed because text was selected; run it when the selection clears. */
  pendingRender: false,
  /** This render is the operator's own action and must not be postponed. */
  forceRender: false,
  /** A message ts to scroll to on the next render (timestamp click). One-shot. */
  jumpTo: undefined,
  search: undefined, // { q, phase: "messages"|"transcripts"|"done", messages, transcripts, truncated, errors }
  chseen: undefined, // channel → last-seen ts (client-side, per space; see channels.js)
  chactivity: {}, // channel → { latest, unread } from /api/channel-unread
  /** The message currently highlighted after a jump. Held in STATE, not as a class on the node: the
   *  2s poll rebuilds every row, so a class set once is gone within two seconds — usually before the
   *  highlight has finished doing its job. */
  flashTs: undefined,
  /** Open PRs across the LIVE agents, and when they were last fetched (each is a GitHub call). */
  prs: [],
  prsAt: undefined,
  /** The fleet's shared beads task list, and when it was last fetched. */
  tasks: [],
  tasksAt: undefined,
  /** Which sidebar sections are folded shut. Persisted: a fold you must redo every reload is a
   *  setting that fights you rather than one that helps. */
  folded: {},
  rows: [],
  messages: [],
  unread: 0,
  /** Which agent the composer addresses and the transcript filters to. null = the whole inbox. */
  focus: null,
  mode: "chat",
  channels: [],
  /** Sidebar filter text, from the top-bar box. */
  filter: "",
  /** Images staged for the next send: absolute paths the server wrote for us. */
  pendingImages: [],
  channelMessages: [],
  /** agent name → PR or null. Cached because `gh pr view` is a network call. */
  prByAgent: {},
  /** How far back into the transcript the trace reads. The BYTE window is the real limit, not the
   *  block count: a 50MB transcript full of long messages holds only ~30 blocks in the default 512KB,
   *  and asking for more blocks returns the same ones. "Load older" doubles this. */
  traceBytes: 512 * 1024,
  /** How many trace blocks to put in the DOM. Bounded independently of how far back we READ: asking
   *  for 4000 blocks and rendering all of them froze the renderer outright — a trace is read from the
   *  end, so showing the tail and offering more is both faster and what you actually want. */
  traceBlocks: 250,
  trace: null,
  /** Sends not yet seen coming back from the server. Rendered under the conversation with their own
   *  state, and retired only when the echo actually arrives — see {@link reconcilePending}. */
  pending: [],
  /** Timestamp of the first message that was unread when this conversation was OPENED — where the
   *  "new messages" line is drawn. Frozen on open: the cursor advances as messages are displayed, so a
   *  live one would slide away while you were still looking for your place. null = nothing new. */
  unreadMark: null,
  /** One-shot: scroll the divider into view on the render that follows opening a conversation, and
   *  never again. Scrolling on every poll is the bug that made reading anything older impossible. */
  scrollToMark: false,
  /** Command mode: the `!` has been CONSUMED and the composer is a shell prompt. Held as state rather
   *  than read from the text, because the `!` is no longer in the text — that is the whole point. */
  bang: false,
  /** Messages read HERE, per message — the overlay on the server's single-timestamp cursor, which
   *  cannot say "this conversation is read" without burying every other agent's older mail.
   *  See read-state.js. Loaded once the space is known. */
  read: new Set(),
};

/* ── time ─────────────────────────────────────────────────────────────────────────────────────── */

/** Relative stamps computed from ONE instant per render, so the list can never disagree with itself. */
function ago(ts, now) {
  if (!Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** `/Users/x/repo` → `~/repo`, matching what the roster already shows. Home is only known from the
 *  folders themselves, so it is inferred from the common prefix the server already sends. */
function tilde(p) {
  const m = /^(\/(?:Users|home)\/[^/]+)(\/.*)?$/.exec(String(p ?? ""));
  return m ? `~${m[2] ?? ""}` : String(p ?? "");
}

/**
 * A path short enough to sit on one line, keeping the ends that identify it.
 *
 * Worktrees live at paths like `~/.superconductor/worktrees/evals/sc-coupled-helium-4`, which simply
 * ran off the edge of the composer. Eliding the MIDDLE rather than the tail is what keeps it useful:
 * the last segment is the specific thing (which worktree) and the first says where it lives, while the
 * middle is the part every sibling shares. A plain CSS ellipsis would have cut off exactly the end that
 * distinguishes one worktree from another.
 */
function shortPath(p, max = 44) {
  const full = tilde(p);
  if (full.length <= max) return full;
  const parts = full.split("/");
  if (parts.length <= 3) return full;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

const avatarColor = (name) => {
  // Deterministic per name: an agent keeps its colour across reloads, which is what makes the sidebar
  // scannable. A random palette would reshuffle on every refresh.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
};

/**
 * Pull paw's attachment lines out of a message body.
 *
 * The convention is a `📷 [Image #N] <absolute path>` line under the text (src/images.ts explains why
 * the carrier is plain text rather than a data part). In a terminal you read the path and open it; in
 * a browser the image can simply BE there — so the line becomes an <img> and the prose keeps its
 * `[Image #N]` placeholder exactly where the sender put it.
 *
 * Only images are lifted. A `📎 [File #N]` line stays as text, because paw itself refuses to promise a
 * picture for a type Read cannot display, and the browser should not promise more than paw does.
 */
function peelAttachments(text) {
  const images = [];
  const body = String(text ?? "")
    .split("\n")
    .filter((line) => {
      const m = line.match(/^\s*📷\s*\[Image #\d+\]\s+(\/.+)$/);
      if (m && /\.(png|jpe?g|gif|webp)$/i.test(m[1].trim())) {
        images.push(m[1].trim());
        return false; // the line becomes the picture; leaving it would print the path twice
      }
      return true;
    })
    .join("\n");
  return { body, images };
}

/* ── rendering ────────────────────────────────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderSidebarExtras() {
  // "Activity" IS the unfocused inbox — every conversation at once. Giving it a row makes that a place
  // you can go back to rather than a state you fall into by deselecting.
  // Exactly ONE row reads as the current view: with the pad open it covers whatever focus points at,
  // so Activity (focus === null) must not ALSO light — two highlighted rows was the "weird bug".
  $("activity").innerHTML = `<div class="row${state.focus === null ? " active" : ""}${state.unread ? " unread" : ""}" data-activity="1">
      <span class="pip ${state.unread ? "busy" : "on"}"></span><span class="nm">Activity</span>
      ${state.unread ? `<span class="count">${state.unread}</span>` : ""}
    </div>`;
  $("activity").firstElementChild.addEventListener("click", () => focusTarget(null));

  const cq = state.filter.trim().toLowerCase();
  // A channel is a FOLDER of agents (operator's ask, 2026-09-03): the ▸ unfolds who is in it — click the
  // channel to message the channel, click an agent under it to DM that agent. Membership is what paw
  // can actually know on an open mesh (agents seen posting; #general = everyone) — see channels.js.
  if (!state.chopen) state.chopen = loadChOpen(state.space);
  $("channels").innerHTML = state.channels
    .filter((ch) => !cq || ch.toLowerCase().includes(cq))
    .map((ch) => {
      const open = !!state.chopen[ch];
      const members = open ? sortMembers(channelMembersFor(ch, state.channelMembers, state.rows)) : [];
      const subs = members
        .map((m) => `<div class="row sub${m.agent && state.focus === m.name ? " active" : ""}${m.agent ? "" : " nonagent"}" data-member="${esc(m.name)}" data-agent-member="${m.agent ? 1 : 0}" title="${m.agent ? "DM " + esc(m.name) : esc(m.name) + " posted here (not a paw agent)"}">
          <span class="pip ${m.agent ? (m.live ? "on" : "off") : "off"}"></span><span class="nm">${esc(m.name)}</span></div>`)
        .join("");
      const empty = open && !members.length ? `<div class="row sub nonagent"><span class="nm" style="opacity:.6">nobody seen here yet</span></div>` : "";
      const add = open && ch !== "general" ? `<div class="row sub addag" data-addto="${esc(ch)}" title="ask agents to join #${esc(ch)}"><span class="hash">+</span><span class="nm">add agent…</span></div>` : "";
      // Unread = messages after the moment you last LOOKED at this channel (not merely had it open in
      // a background tab) — the server counts against the client's seen stamp; 0 when it knows nothing.
      const n = channelUnread(state.chactivity, ch);
      return `<div class="row${state.focus === "#" + ch ? " active" : ""}${n ? " unread" : ""}" data-channel="${esc(ch)}">
        <span class="chev${open ? " open" : ""}" data-chev="${esc(ch)}" title="${open ? "hide" : "show"} agents in #${esc(ch)}">▸</span><span class="hash">#</span><span class="nm">${esc(ch)}</span>${n ? `<span class="count">${n}</span>` : ""}</div>${subs}${empty}${add}`;
    })
    .join("");
  $("channels").insertAdjacentHTML(
    "beforeend",
    `<div class="row" id="newChannel" style="opacity:.7"><span class="hash">+</span><span class="nm">new channel</span></div>`,
  );
  for (const r of $("channels").querySelectorAll("[data-channel]")) {
    const target = "#" + r.dataset.channel;
    r.addEventListener("click", () => (state.focus === target ? scrollToEnd() : focusTarget(target))); // same rule as agents
  }
  for (const c of $("channels").querySelectorAll("[data-chev]")) {
    c.addEventListener("click", (e) => {
      e.stopPropagation(); // unfolding is not "open this channel"
      state.chopen = toggleChOpen(state.chopen, c.dataset.chev);
      saveChOpen(state.space, state.chopen);
      render();
    });
  }
  for (const a of $("channels").querySelectorAll("[data-addto]")) {
    a.addEventListener("click", () => {
      // Same request as `/invite`: paw can only ASK an agent to join — membership is its own act.
      const ch = a.dataset.addto;
      const raw = (prompt(`agents to invite to #${ch} (space-separated, @ optional)`) ?? "").trim();
      if (!raw) return;
      const names = raw.split(/\s+/).map((n) => n.replace(/^@/, "")).filter(Boolean);
      const known = new Set(state.rows.map((r) => r.name));
      void runInvite(ch, names.filter((n) => known.has(n)), names.filter((n) => !known.has(n)));
    });
  }
  for (const m of $("channels").querySelectorAll("[data-member]")) {
    if (m.dataset.agentMember !== "1") continue; // a human/endpoint author has no DM conversation here
    m.addEventListener("click", () => focusAgent(m.dataset.member));
  }
  $("newChannel").addEventListener("click", () => {
    // No create call: the channel exists once something is posted to it, so this only opens the view.
    // The name is validated the same way the server validates it, so a bad one is refused here rather
    // than after you have typed a message into a channel that cannot exist.
    const name = (prompt("channel name") ?? "").trim().replace(/^#/, "");
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) return void ($("hint").textContent = "channel names are letters, digits, dash or underscore");
    if (!state.channels.includes(name)) state.channels = [...state.channels, name];
    focusTarget("#" + name);
    $("hint").textContent = `#${name} exists once you post to it`;
  });
}

function renderAgents(now) {
  const el = $("agents");
  const unreadBy = new Map();
  for (const m of state.messages) if (m.dir !== "out" && m.unread) unreadBy.set(m.from, (unreadBy.get(m.from) ?? 0) + 1);

  const q = state.filter.trim().toLowerCase();
  const matching = q ? state.rows.filter((r) => r.name.toLowerCase().includes(q) || (r.folder ?? "").toLowerCase().includes(q)) : state.rows;
  // An agent that has spoken since you archived it is live work again, so it comes back on its own —
  // that is the whole rule, and it is why the archive doesn't need pruning by hand.
  const pruned = pruneArchive(state.archive, state.messages);
  if (pruned.changed) {
    state.archive = pruned.archive;
    saveArchive(state.space, state.archive);
  }
  const { visible, archived } = partitionRoster(matching, state.archive, { focus: state.focus, filter: state.filter });
  const rowHtml = (list) => list
    .map((r) => {
      // Three presence words stay three. `working` is what the agent SAID; `busy` is what paw WORKED
      // OUT from transcript mtime, because the mesh only publishes `working` on a user prompt and a
      // peer-woken turn never sends one. Collapsing them would make the UI overstate what it knows.
      // `busy` is paw's inference that a turn is in flight; `working` is the agent saying so itself.
      // Both light the amber pip, because to a reader they mean the same thing — something is happening.
      const cls = r.failure ? "fail" : r.mesh === "offline" ? "off" : r.busy || r.mesh === "working" ? "busy" : "on";
      const n = unreadBy.get(r.name) ?? 0;
      // While the pad is the open view, NOTHING else reads as current — the same one-view rule as
      // Activity (a lit agent row under an open pad was the "double selected" report).
      const active = state.focus === r.name ? " active" : "";
      const strong = n > 0 ? " unread" : "";
      const filed = state.archive[r.name] !== undefined;
      // The control says what it DOES, in the direction it will go. One glyph, revealed on hover, so a
      // 56-row list isn't 56 buttons competing with the names for attention.
      const act = `<span class="arch" data-arch="${r.name}" title="${filed ? "Unarchive" : "Archive — returns on its next message"}">${filed ? "↩" : "⊘"}</span>`;
      return `<div class="row${active}${strong}${filed ? " filed" : ""}" data-agent="${r.name}"${r.failure ? ` title="last turn failed: ${esc(r.failure.text)}"` : ""}>
        <span class="pip ${cls}"></span>
        <span class="nm">${r.name}</span>
        ${act}
        ${n ? `<span class="count">${n}</span>` : `<span class="count" style="background:none;color:var(--sidebar-txt);font-weight:400">${ago(r.activeMs, now)}</span>`}
      </div>`;
    })
    .join("");
  el.innerHTML = rowHtml(visible);
  // Archived agents get their OWN section rather than a toggle inside this one: it is foldable like
  // the others, and its header is the honest statement that N agents are filed away — a sidebar that
  // silently omits rows is one you cannot trust.
  const arch = $("archived");
  arch.innerHTML = rowHtml(archived);
  $("archivedHead").hidden = archived.length === 0;
  $("archivedCount").textContent = state.folded.archived ? String(archived.length) : "";
  $("agentCount").textContent = state.folded.agents ? String(visible.length) : "";
  for (const row of [...el.querySelectorAll(".row"), ...arch.querySelectorAll(".row")]) {
    row.addEventListener("click", () => focusAgent(row.dataset.agent));
  }
  for (const btn of [...el.querySelectorAll("[data-arch]"), ...arch.querySelectorAll("[data-arch]")]) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // archiving is not "open this conversation"
      toggleArchive(btn.dataset.arch);
    });
  }
}

/**
 * Command mode, shown BEFORE you commit to it: a line starting with `!` will run a shell command in a
 * folder, and that must not look identical to typing a message. Called on every keystroke as well as
 * every render — the mode changes as you type, and a switch that only appeared on the next poll would
 * be worse than none.
 *
 * The label names the FOLDER, not just the agent: the same command means different things in different
 * directories, and the whole point of `!` is which folder it lands in.
 */
function renderComposerMode() {
  const agentFocus = state.focus && !String(state.focus).startsWith("#") ? String(state.focus) : undefined;
  const banging = agentFocus !== undefined && state.bang;
  $("comp").classList.toggle("bang", banging);
  const folder = banging ? state.rows.find((r) => r.name === agentFocus)?.folder : undefined;
  $("sendTo").textContent = banging
    ? `$ runs in ${folder ? shortPath(folder) : agentFocus} → then tells ${agentFocus}`
    : state.focus
      ? `→ ${state.focus}`
      : "";
}

/**
 * Images load AFTER the list has been laid out and scrolled, and each one that lands grows the list:
 * if you were at the bottom you are no longer at the bottom, and if you were reading mid-way the
 * text slides under your eyes (reported 2026-08-26). The render's own keep-position logic runs once,
 * at render time — this is the same logic re-applied at the moment each attachment actually loads.
 *
 * `load` doesn't bubble, so it is caught in the CAPTURE phase on the list. The pre-growth height is
 * tracked continuously (`msgsSeen`) rather than read at load time — by then the growth has happened.
 *
 * Why not invert the list (column-reverse, the operator's suggestion): it would make "bottom" the
 * browser's natural anchor, but jump-to-message, the unread divider and follow-to-bottom all compute
 * against normal scroll direction and would each need re-deriving; compensating at the source is the
 * change that touches nothing else.
 */
const msgsSeen = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
function trackMsgs(el) {
  msgsSeen.scrollHeight = el.scrollHeight;
  msgsSeen.scrollTop = el.scrollTop;
  msgsSeen.clientHeight = el.clientHeight;
}
$("msgs").addEventListener("scroll", () => trackMsgs($("msgs")), { passive: true });
$("msgs").addEventListener(
  "load",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const el = $("msgs");
    const delta = el.scrollHeight - msgsSeen.scrollHeight;
    if (delta <= 0) return void trackMsgs(el);
    const wasAtBottom = msgsSeen.scrollHeight - msgsSeen.scrollTop - msgsSeen.clientHeight < 60;
    if (wasAtBottom) el.scrollTop = el.scrollHeight; // stay pinned to the newest message
    else if (img.getBoundingClientRect().top < el.getBoundingClientRect().top) el.scrollTop += delta; // grew ABOVE the viewport: keep what's under the eyes
    trackMsgs(el);
  },
  true,
);

/** The search view lives in the message pane: one row per hit, newest first, clickable to the place. */
function renderSearch(now) {
  const el = $("msgs");
  const s = state.search;
  if (!s) return void (el.innerHTML = `<div class="empty">type in the filter box and press Enter to search messages and transcripts</div>`);
  const row = (cls, data, head, body) => `<div class="srch ${cls}" ${data}><div class="sh">${head}</div><div class="sb">${body}</div></div>`;
  const msgs = s.messages
    .map((h) => row("smsg", `data-kind="${h.kind}" data-target="${esc(h.target)}" data-ts="${h.ts}"`,
      `${h.kind === "channel" ? "#" + esc(h.target) : esc(h.target)} · <b>${esc(h.from)}</b> · ${ago(h.ts, now)} ago`, esc(h.snippet)))
    .join("");
  const trs = s.transcripts
    .map((h) => row("stx", `data-kind="transcript" data-target="${esc(h.agent)}"`,
      `${esc(h.agent)} · trace · <i>${esc(h.role)}</i>${h.ts ? ` · ${ago(h.ts, now)} ago` : ""}`, esc(h.snippet)))
    .join("");
  const phase = s.phase === "done" ? "" : `<div class="empty">searching ${s.phase}…</div>`;
  const none = s.phase === "done" && !s.messages.length && !s.transcripts.length ? `<div class="empty">nothing matched "${esc(s.q)}"</div>` : "";
  const trunc = s.truncated ? `<div class="empty">more matches than shown — narrow the query or filter the agents</div>` : "";
  const errs = s.errors.length ? `<div class="empty">${esc(s.errors[0])}</div>` : "";
  const sec = (title, body) => (body ? `<div class="ssec">${title}</div>${body}` : "");
  el.innerHTML = sec(`messages (${s.messages.length})`, msgs) + sec(`transcripts (${s.transcripts.length})`, trs) + phase + none + trunc + errs;
  el.dataset.sig = "";
  for (const r of el.querySelectorAll(".srch")) {
    r.addEventListener("click", () => {
      const { kind, target, ts } = r.dataset;
      if (kind === "transcript") { focusTarget(target); setMode("trace"); return; }
      if (kind === "channel") { focusTarget("#" + target); state.jumpTo = Number(ts); return; }
      focusTarget(target);
      state.jumpTo = Number(ts); // consumed by renderMessages once the conversation is loaded
      render();
    });
  }
}

/** Run a search: messages first (cheap, the daemon holds them), then transcripts (rg over the jsonl,
 *  budgeted server-side). `agents` = the sidebar filter's current matches when it names some. */
async function runSearch(q) {
  q = String(q ?? "").trim();
  if (!q) return;
  state.search = { q, phase: "messages", messages: [], transcripts: [], truncated: false, errors: [] };
  if (state.focus !== SEARCH) focusTarget(SEARCH); else render();
  try {
    const m = await api(`/api/search?q=${encodeURIComponent(q)}&scope=messages`);
    if (state.search?.q !== q) return; // a newer search replaced this one
    state.search = { ...state.search, messages: m.messages ?? [], errors: m.errors ?? [], truncated: !!m.truncated, phase: "transcripts" };
    render();
    const filt = state.filter.trim().toLowerCase();
    const agents = filt ? state.rows.filter((r) => r.name.toLowerCase().includes(filt)).map((r) => r.name) : [];
    const t = await api(`/api/search?q=${encodeURIComponent(q)}&scope=transcripts${agents.length ? "&agents=" + encodeURIComponent(agents.join(",")) : ""}`);
    if (state.search?.q !== q) return;
    state.search = { ...state.search, transcripts: t.transcripts ?? [], errors: [...state.search.errors, ...(t.errors ?? [])], truncated: state.search.truncated || !!t.truncated, phase: "done" };
  } catch (e) {
    if (state.search?.q === q) state.search = { ...state.search, phase: "done", errors: [...state.search.errors, String(e.message)] };
  }
  render();
}

/** A standing notice above a failed agent's conversation: the DM you send will WAIT (it queues in the
 *  agent's durable inbox) — but nothing answers until the cause clears. Rendered by renderMessages. */
function failureNotice() {
  const row = state.rows.find((r) => r.name === state.focus);
  if (!row?.failure) return "";
  return `<div class="failnote">⚠ ${esc(row.name)} couldn't run its last turn (${ago(row.failure.ts, Date.now())} ago): <b>${esc(row.failure.text)}</b> — your DMs queue and will be answered once it can run again.</div>`;
}

function renderMessages(now) {
  if (state.focus === SEARCH) return renderSearch(now);
  const el = $("msgs");
  const inChannel = String(state.focus ?? "").startsWith("#");
  const list = inChannel
    ? state.channelMessages
    : state.focus
      ? state.messages.filter((m) => m.from === state.focus || (m.dir === "out" && m.to === state.focus))
      : state.messages;

  if (!list.length) {
    // "Nothing here" is only true once we have actually read. Before that it is not-yet-known, and
    // flashing an empty state reads as a dead mesh.
    el.innerHTML = `<div class="empty">${state.loaded ? "no messages yet" : "loading…"}</div>`;
    return;
  }
  const rows = state.focus ? [...list, ...state.pending.filter((p) => p.to === state.focus)] : [...list, ...state.pending];
  // Where the reader was, measured BEFORE the repaint destroys it.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const keepTop = el.scrollTop;
  const keepHeight = el.scrollHeight;
  let last = "";
  // The divider goes before the FIRST row at or after the frozen mark, so it survives the cursor moving
  // on underneath it. `drawn` makes it exactly one line even though many rows match the comparison.
  let drawn = false;
  // Writing innerHTML destroys every node here and takes the operator's text selection with it. The
  // relative stamps ("3m ago") change on their own, so a poll eventually produces different HTML
  // through no action of yours — which is why a selection vanished every 15–30s while reading.
  //
  // Someone mid-selection is READING, not waiting for an update, so the rebuild waits and runs the
  // moment the selection clears. A send bypasses it: your own message is your action, not a poll.
  //
  // Deliberately NOT paired with a "skip if the HTML is identical" memo. I tried that and it broke the
  // list outright: the empty-state branch above writes #msgs without touching the memo, so the two
  // desync and every later render is skipped against a DOM that no longer matches. A cache of what the
  // DOM holds must be invalidated by EVERY writer, and this function is not the only one.
  if (!state.forceRender && selectionInside(el)) {
    state.pendingRender = true;
    return;
  }
  state.pendingRender = false;
  state.forceRender = false;
  el.innerHTML = rows
    .map((m) => {
      const divider =
        !drawn && state.unreadMark !== null && m.dir !== "out" && m.ts >= state.unreadMark
          ? ((drawn = true), `<div class="newmark" data-newmark="1"><span>new</span></div>`)
          : "";
      const who = m.dir === "out" ? "you" : m.from;
      // In Activity — every conversation at once — an outgoing row saying only "you" leaves out the one
      // thing the mixed feed can't tell you: WHICH agent you said it to. In a focused conversation the
      // answer is the view itself, so the chip would be noise on every row.
      const sentTo = m.dir === "out" && state.focus === null ? recipientLabel(m.to, state.rows?.map((r) => r.name) ?? []) : "";
      // Group by RECIPIENT as well as sender, so two consecutive sends to different agents don't merge
      // into one block under a single avatar — in Activity that's exactly the confusion being fixed.
      const key = m.dir === "out" ? `you→${m.to ?? ""}` : m.from;
      const cont = key === last ? " cont" : "";
      last = key;
      const tag = m.dir === "out"
        ? sentTo
          ? `<span class="tag who" data-open="${esc(m.to ?? sentTo)}">→ ${esc(sentTo)}</span>`
          : ""
        : `<span class="tag">agent</span>`;
      const { body, images } = peelAttachments(m.text);
      // A pending send says what it is doing ON THE ROW, not in an ambient hint line: the row is what
      // you look at. paw's Raycast notes reached the same place — `sending…`, then a ticking wait, then
      // `failed`, and a failed row keeps its mark rather than quietly vanishing.
      const stamp = m.state
        ? m.state === "failed"
          ? `<span class="time" style="color:var(--red)">failed — click to retry</span>`
          : `<span class="time">${Math.max(0, Math.round((now - m.ts) / 1000)) < 2 ? "sending…" : `waiting ${ago(m.ts, now)}`}</span>`
        // The timestamp is a LINK to this exact moment in the conversation. It was already the row's
        // most precise handle; it just did nothing.
        : `<span class="time jump" data-jump="${m.ts}" title="Open this conversation here">${ago(m.ts, now)} ago</span>`;
      // The conversation this row belongs to: for an inbound message its sender, for your own send the
      // agent you sent it to. Both are "the DM this row lives in", which is what a click should open.
      const convo = m.dir === "out" ? (m.to ?? "") : m.from;
      return divider + `<div class="m${cont}${m.ts === state.flashTs ? " flash" : ""}" data-ts="${m.ts}" data-convo="${esc(convo)}"${m.state === "failed" ? ` data-retry="${m.id}"` : ""}${m.state ? ' style="opacity:.7"' : ""}>
        <div class="av" style="background:${avatarColor(who)}">${who[0]?.toUpperCase() ?? "?"}</div>
        <div>
          <div class="hdr"><span class="name${m.dir === "out" ? "" : " who"}"${m.dir === "out" ? "" : ` data-open="${esc(who)}"`}>${who}</span>${tag}${stamp}</div>
          <div class="txt">${md(body)}${images.map((p) => `<a href="/api/file?path=${encodeURIComponent(p)}" target="_blank" rel="noreferrer"><img class="att" src="/api/file?path=${encodeURIComponent(p)}" alt="${p.split("/").pop()}" loading="lazy"></a>`).join("")}</div>
        </div>
      </div>`;
    })
    .join("");
  for (const row of el.querySelectorAll("[data-retry]")) row.addEventListener("click", () => void retry(row.dataset.retry));
  // A name (or the → chip) opens that conversation. In Activity this is the whole navigation story:
  // you read something in the mixed feed and the obvious next move is "show me just this".
  for (const el2 of el.querySelectorAll("[data-open]")) {
    el2.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = el2.dataset.open;
      // The recipient may be an unresolved ID (see recipientLabel) — there is no conversation to open
      // under a name we don't have, and focusing a raw id would show an empty view.
      if (name && state.rows.some((r) => r.name === name)) focusTarget(name);
    });
  }
  // The timestamp opens the conversation AT this message, which is the thing Activity cannot do by
  // scrolling: the mixed feed's neighbours are other conversations.
  for (const t of el.querySelectorAll("[data-jump]")) {
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = t.closest(".m");
      const convo = row?.dataset.convo;
      const ts = Number(t.dataset.jump);
      if (!convo || !state.rows.some((r) => r.name === convo)) return;
      state.jumpTo = ts; // consumed by the next renderMessages, after the filtered list exists
      focusTarget(convo);
    });
  }
  // Follow the conversation only if the reader was ALREADY at the bottom. Scrolling them there on
  // every poll made reading anything older impossible — you scroll up, the next refresh two seconds
  // later throws you back down. When they are further up, hold their position against content that
  // may have grown ABOVE them: keeping scrollTop alone would slide the text under their eyes.
  // A pending JUMP owns the scroll for this render. Without this the follow-to-bottom below runs
  // afterwards and throws you back to the newest message — the row still flashed, three screens away,
  // which is the most confusing possible outcome: it looks like the click half-worked.
  const jumpRow = state.jumpTo !== undefined ? el.querySelector(`[data-ts="${state.jumpTo}"]`) : null;
  const mark = !jumpRow && state.scrollToMark ? el.querySelector("[data-newmark]") : null;
  if (jumpRow) {
    // Top-aligned with whatever headroom is spare — NOT centred. An agent message is routinely taller
    // than the viewport, and centring one starts it above the top of the list, which reads as the text
    // being cut off by the header.
    el.scrollTop = jumpScrollTop({
      rowTop: jumpRow.offsetTop - el.offsetTop,
      rowHeight: jumpRow.offsetHeight,
      viewport: el.clientHeight,
    });
    const ts = state.jumpTo;
    state.flashTs = ts;
    jumpRow.classList.add("flash");
    setTimeout(() => {
      if (state.flashTs === ts) {
        state.flashTs = undefined;
        render();
      }
    }, 1800);
    state.jumpTo = undefined;
  } else if (mark) {
    // Leave the tail of the last-read message above the line, so it divides two things you can see
    // rather than floating at the top of the viewport. One-shot — a poll must not yank you back here.
    const prev = mark.previousElementSibling;
    el.scrollTop = markScrollTop({
      markTop: mark.offsetTop - el.offsetTop,
      prevTop: prev ? prev.offsetTop - el.offsetTop : undefined,
    });
    state.scrollToMark = false;
  } else if (atBottom) el.scrollTop = el.scrollHeight;
  else el.scrollTop = keepTop + (el.scrollHeight - keepHeight);
  trackMsgs(el);
  if (state.scrollToMark && rows.length) state.scrollToMark = false; // nothing to scroll to; don't keep trying
  // Mark read only what was actually LOOKED AT, which is stricter than "rendered".
  //
  // A hidden or unfocused tab renders exactly the same DOM as a visible one, so marking on render
  // means opening the app — or leaving it open in a background tab — clears mail nobody read. That
  // failure is worse than a stuck badge in the way that matters: a stuck badge is visible and
  // recoverable, silently-cleared mail is neither. Raycast reached the same place from the other
  // direction, marking a message read when you SELECT it.
  //
  // With an agent focused the other conversations are off screen, so they stay unread too.
  const lookedAt = document.visibilityState === "visible" && document.hasFocus();
  if (lookedAt && !inChannel) void markVisibleRead(list);
  if (lookedAt && inChannel) markChannelSeen(String(state.focus).slice(1));
}

/**
 * Mark the messages currently ON SCREEN as read.
 *
 * Per message, not per cursor. The shared cursor is a single timestamp for the whole inbox, so it can
 * only ever say "everything before here is read" — advancing it from inside one agent's chat would
 * bury older, genuinely unread mail from every other agent. That is why this used to run in Activity
 * ONLY, and why reading a specific chat cleared nothing: the badge and the divider stayed forever
 * (reported 2026-08-07). The overlay in read-state.js is what makes a focused chat markable at all.
 *
 * The shared cursor is still advanced, but only as far as is provably safe — to just before the
 * OLDEST message left unread anywhere — so `paw inbox` and the CLI keep in step without this ever
 * hiding mail from a conversation you did not open.
 *
 * Channels are excluded: they are not part of the DM cursor and carry no unread of their own.
 */
/** A channel you are LOOKING at is seen up to its newest message — forward-only, persisted per space,
 *  and re-counted on the next poll so the row's badge clears without waiting for a message. */
function markChannelSeen(ch) {
  const newest = Math.max(0, ...state.channelMessages.map((m) => m.ts ?? 0));
  if (!newest) return;
  if (!state.chseen) state.chseen = loadChSeen(state.space);
  const next = markChSeen(state.chseen, ch, newest);
  if (next === state.chseen) return;
  state.chseen = next;
  saveChSeen(state.space, state.chseen);
  if (state.chactivity[ch]) state.chactivity = { ...state.chactivity, [ch]: { ...state.chactivity[ch], unread: 0 } };
  void pollChannelUnread();
}

let chUnreadInFlight = false;
/** Ask the server how much landed per channel after what this browser has seen. Skips a tick while
 *  one is in flight (a slow poll must not stack requests), and tolerates an older daemon without the route. */
async function pollChannelUnread() {
  if (chUnreadInFlight || !state.space) return;
  chUnreadInFlight = true;
  try {
    if (!state.chseen) state.chseen = loadChSeen(state.space);
    const d = await api("/api/channel-unread", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seen: state.chseen }) });
    if (d && d.activity && typeof d.activity === "object") state.chactivity = d.activity;
  } catch {
    /* an older daemon, or a failed poll: the last known counts stand rather than flashing to zero */
  } finally {
    chUnreadInFlight = false;
  }
}

function markVisibleRead(list) {
  let added = false;
  for (const m of list) {
    if (!isUnread(m, state.cursor, state.read)) continue;
    state.read.add(messageKey(m));
    m.unread = false;
    added = true;
  }
  if (!added) return;
  saveRead(state.space, state.read);
  state.unread = state.messages.filter((m) => isUnread(m, state.cursor, state.read)).length;
  const safe = safeCursor(state.messages, state.cursor, state.read);
  if (safe !== undefined) void markRead(safe);
  render();
}

/**
 * The header line for a focused agent: where it is, what it's on, and whether that work has a PR.
 *
 * The worktree detail rides the branch's TITLE rather than the visible line — most agents sit in a
 * plain checkout, so a "worktree" note would be noise on the common case, and a hover is exactly what
 * that belongs in. The PR link appears only once the lazy lookup answers; its absence means "nothing
 * to link to", which covers no-PR, no-`gh` and not-authenticated alike.
 */
/** The failure line, shortened for a header: the sentence that names the cause, not the /usage-credits advice. */
function shortFailure(text) {
  return String(text).split(/\s+\/usage|\s+·\s+\/|\n/)[0].slice(0, 90);
}

function headerTopic(row) {
  const g = row.git ?? {};
  const parts = [];
  // A cotal_spawn'd peer paw never registered: no folder to show, so say what IS known (its harness)
  // and why paw can't do more (no revival, no trace) — "it's on the mesh but the dashboard hides it"
  // was the question this row exists to answer.
  if (row.unregistered) parts.push(`<span title="spawned outside paw (cotal_spawn) — no folder, pin or transcript; not revived by paw restart/start">unregistered ${esc(row.unregistered.agent)} peer</span>`);
  else if (!g.repo && !g.branch) parts.push(esc(row.folder)); // not a checkout — the folder is all there is
  if (g.repo) parts.push(esc(g.repo));
  if (g.branch) {
    const hint = g.worktree ? `worktree · main checkout at ${g.mainPath}` : `checkout at ${row.folder}`;
    const marks = `${g.dirty ? " ✎" : ""}${g.ahead ? ` ↑${g.ahead}` : ""}`;
    parts.push(
      `<span title="${esc(hint)}" style="border-bottom:1px dotted var(--txt-dim);cursor:help">${g.worktree ? "⑂ " : ""}${esc(g.branch)}</span>${marks}`,
    );
  }
  const pr = state.prByAgent[row.name];
  if (pr) parts.push(`<a href="${esc(pr.url)}" target="_blank" rel="noreferrer noopener">#${pr.number}${pr.isDraft ? " draft" : ""}</a>`);
  if (row.failure) {
    // The mesh says idle; the transcript says the model never ran. The transcript wins the header,
    // because "idle" is what makes a refused turn look like being ignored (reported 2026-09-03).
    parts.push(`<span class="fail" title="${esc(row.failure.text)}">⚠ ${esc(shortFailure(row.failure.text))} · ${ago(row.failure.ts, Date.now())} ago</span>`);
  } else parts.push(esc(row.busy && row.mesh === "idle" ? "busy" : row.mesh));
  if (row.runtime) parts.push(esc(row.runtime));
  return parts.join(" · ");
}

/**
 * Ask for the focused agent's PR. The SERVER holds a 60s TTL cache, so this is safe to call on every
 * focus — a reload or a second tab hits that cache rather than GitHub, which a client-side-only cache
 * could not do. Kept per-agent here purely to avoid a duplicate in-flight request from one page.
 */
async function loadPr(name) {
  if (name in state.prByAgent) return;
  state.prByAgent[name] = null; // claim the slot first, so two renders don't both fetch
  try {
    const d = await api(`/api/pr/${encodeURIComponent(name)}`);
    state.prByAgent[name] = d.pr ?? null;
    render();
  } catch {
    /* leave it null — a failed lookup and "no PR" are the same answer to this header */
  }
}

function renderTrace() {
  const el = $("tbody");
  if (!state.focus) return void (el.innerHTML = `<div class="empty">pick an agent to see what it's doing</div>`);
  const t = state.trace;
  if (!t) return void (el.innerHTML = `<div class="empty">loading trace…</div>`);
  if (t.error) {
    $("traceTopic").innerHTML = `trace unavailable · <b>esc</b> back`;
    el.innerHTML = `<div class="empty">${esc(t.error)}</div>`;
    el.dataset.sig = "";
    return;
  }

  // A snapshot that doesn't admit it's a snapshot is the failure mode: it looks live and silently ages.
  // Live deltas are a later phase; saying WHEN this was read costs one line and is honest today.
  const age = ago(t.readAt, Date.now());
  $("traceTopic").innerHTML = `live trace · read <span class="${Number(age.replace(/\D/g, "")) > 30 ? "stale" : ""}">${age} ago</span> · <b>esc</b> back`;

  // Repaint ONLY when the content changed. Rewriting identical HTML every 5s throws the reader back to
  // the top of a 60-block trace mid-sentence, which alone would make the pane unusable — and the trace
  // is the reason this UI exists rather than `cotal web`.
  // Same markers `paw log` prints, and for the same reasons: ● is the agent acting, ⎿ is what came
  // back, │ is someone else's words, > is a turn it was given. Laid out as a 2-column grid so a
  // wrapped line aligns under its own text rather than under the marker. An EMPTY block renders
  // nothing at all — a lone bullet on a line reads as a turn that did nothing.
  // The MARKERS COME FROM CSS, not from here: `.tt::before` is `●`, `.tu::before` is `>`, `.tr::before`
  // is `⎿` — the mock already drew them, and emitting a gutter span as well printed every marker twice.
  const row = (cls, body) => `<div class="${cls}">${body}</div>`;
  // Reading further back costs O(bytes) on a file that keeps growing, so it is a button rather than
  // something that happens on scroll: the reader asks, and pays, explicitly.
  const more = state.traceBytes < 16 * 1024 * 1024
    ? `<div class="loadmore"><button id="olderBtn">load older turns (${Math.round(state.traceBytes / 1024)}KB read)</button></div>`
    : `<div class="loadmore"><span>reached the ${16}MB read limit</span></div>`;
  const html = more +
    t.blocks
      .map((b) => {
        if (b.kind === "assistant") return b.markdown.trim() ? row("tt", `<div class="trace-md">${md(b.markdown, { gaps: true })}</div>`) : "";
        if (b.kind === "tool") return row("tt", `<b>${esc(b.display)}</b>${b.arg ? `(${esc(b.arg)})` : ""}`);
        // Only the FIRST line of a result carries the ⎿; the rest align under it, as `paw log` prints them.
        if (b.kind === "result") return b.lines.filter((l) => String(l).trim()).map((l, i) => row(`tr${b.isError ? " err" : ""}${i ? " cont" : ""}`, esc(l))).join("");
        if (b.kind === "incoming") return b.text.trim() ? row("tin", `<div class="trace-md">${md(b.text, { gaps: true })}</div>`) : "";
        if (b.kind === "user") return b.text.trim() ? row("tu", esc(b.text)) : "";
        if (b.kind === "wake") return row("twake", `📨 ${esc(b.via)} from ${esc(b.from)}`);
        // A monitor/hook wake, the way Claude Code shows it: one line naming the event, with the event
        // body on the rail. The raw <task-notification> envelope — task id, tags, and the standing
        // PushNotification instruction — is machinery, and printing it buried the actual trace.
        // Amber, matching Claude Code: the runtime failing, not the agent speaking.
        if (b.kind === "failure") return row("tt", `<span style="color:var(--amber,#d29922)">● ${esc(b.text)}</span>`);
        if (b.kind === "notification")
          return (
            // The summary verbatim: it already reads as the sentence Claude Code shows, and a label of
            // our own doubled it ("Monitor event: "Monitor event: …"") on real transcripts.
            row("tt", esc(b.summary)) +
            // The event body goes on the SAME ⎿ rail every other "what came back" detail uses, so a
            // monitor wake reads like the rest of the trace instead of a new visual language.
            (b.event ? b.event.split("\n").filter((l) => l.trim()).map((l, i) => row(`tr${i ? " cont" : ""}`, esc(l))).join("") : "")
          );
        if (b.kind === "reply") return row("tt", `<span style="color:var(--green)">↩ ${esc(b.to)}</span> ${esc(b.text)}`);
        if (b.kind === "channelReply") return row("tt", `<span style="color:var(--green)">↩ #${esc(b.channel)}</span> ${esc(b.text)}`);
        return "";
      })
      .join("") || `<div class="empty">no turns yet</div>`;
  if (el.dataset.sig === html) {
    bindOlder();
    return;
  }
  // Stick to the bottom only if the reader was already there; otherwise leave them where they are.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const keep = el.scrollTop;
  el.innerHTML = failureNotice() + html;
  el.dataset.sig = html;
  el.scrollTop = atBottom ? el.scrollHeight : keep;
  bindOlder();
}

/** Wire the load-older control. Doubling keeps the number of round-trips logarithmic in how far back
 *  the reader wants to go, instead of one request per screenful. */
function bindOlder() {
  const btn = document.getElementById("olderBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    // Widen BOTH: more bytes reaches further back, more blocks actually shows what that reached.
    state.traceBytes = Math.min(state.traceBytes * 4, 16 * 1024 * 1024);
    state.traceBlocks = Math.min(state.traceBlocks * 2, 2000);
    btn.textContent = "reading…";
    void loadTrace().then(render);
  });
}

/** Is there a live (non-collapsed) selection inside this element? */
function selectionInside(el) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const host = node.nodeType === 1 ? node : node.parentElement;
  return !!host && el.contains(host);
}

// Run a postponed rebuild as soon as its reason goes away, or the list sits stale until the next poll
// happens to notice — turning "your selection is safe" into "the app stopped updating".
document.addEventListener("selectionchange", () => {
  if (!state.pendingRender || selectionInside($("msgs"))) return;
  // Clear FIRST: render() rebuilds the sidebar, which perturbs the selection and re-fires this event.
  // With the flag still set that is an infinite loop — it froze the tab outright while testing.
  state.pendingRender = false;
  render();
});

function render() {
  const now = Date.now();
  $("spaceName").textContent = state.space;

  const row = state.focus ? state.rows.find((r) => r.name === state.focus) : undefined;
  $("title").textContent = state.focus ?? "inbox";
  $("pip").className = `pip ${!row ? "off" : row.mesh === "offline" ? "off" : row.busy || row.mesh === "working" ? "busy" : "on"}`;
  const chFocus = String(state.focus ?? "").startsWith("#") ? String(state.focus).slice(1) : undefined;
  $("topic").innerHTML = row
    ? headerTopic(row)
    : chFocus
      ? esc(chFocus === "general" ? `everyone subscribes · ${state.rows.length} agents` : `${channelMembersFor(chFocus, state.channelMembers, state.rows).length} seen here`)
      : state.focus === SEARCH
        ? esc(state.search ? `search "${state.search.q}" · ${state.search.phase === "done" ? "done" : state.search.phase + "…"}` : "search")
        : esc(`${state.rows.length} agents · ${state.unread} unread`);
  renderComposerMode();
  $("main").classList.toggle("nofocus", !state.focus || state.focus === TASKS || state.focus === BOARD || state.focus === SEARCH || state.focus === VILLAGE);
  // The pad follows FOCUS — it is never opened or closed on its own. (Render is the one place that
  // reconciles it, so a deep link, a poll, and a click all end in the same state.)
  if (state.focus === TASKS) {
    if (!taskspad.isOpen()) taskspad.open(state.tasks);
  } else if (taskspad.isOpen()) taskspad.close();
  if (state.focus === BOARD) {
    if (!board.isOpen()) board.open(state.tasks);
  } else if (board.isOpen()) board.close();
  if (state.focus === VILLAGE) {
    if (!village.isOpen()) village.open();
    village.update(state.space, state.rows, state.village || {});
    void loadVillage(); // refresh edges/last-lines from /api/village; re-renders on arrival
  } else if (village.isOpen()) village.close();
  $("input").placeholder = state.focus ? `message ${state.focus}` : "";
  renderSidebarExtras();
  renderTasks();
  renderAgents(now);
  renderPrs();
  applyFolds();
  void loadPrs();
  void loadTasks();
  renderMessages(now);
  if (state.mode === "trace") renderTrace();
  {
    // The right sidebar: this agent's tasks beside its chat. Never for channels/Activity/the pad/board.
    const agentFocused = !!state.focus && !String(state.focus).startsWith("#") && !String(state.focus).startsWith("~");
    $("grid").classList.toggle("withaside", agentFocused);
    $("aside").hidden = !agentFocused;
    if (agentFocused) renderAgentTasks();
  }
}

/* ── data ─────────────────────────────────────────────────────────────────────────────────────── */

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    // The server's error text IS the answer ("blocked by open issues …") — a bare status code turned
    // bd's meaningful refusals into a generic "not saved" (2026-08-25).
    let detail = "";
    try {
      detail = (await res.json()).error ?? "";
    } catch {
      /* non-json error body */
    }
    throw new Error(detail || `${path} → ${res.status}`);
  }
  return res.json();
}

/** Retire any pending send the server has now echoed back — see `pending.js` for why the two
 *  destinations need different tests. */
function reconcilePending() {
  if (!state.pending.length) return;
  state.pending = survivingPending(state.pending, state.messages, state.channelMessages);
}

let inflight = null;
let queued = false;
/**
 * Read the conversation, at most one read at a time.
 *
 * Overlapping reads resolve OUT OF ORDER, so an older 300-row response can repaint over a newer one —
 * the same race `feed.ts` guards `pollLoop` against, arriving here because every inbound frame asks
 * for a re-read. One in flight, one queued, the rest dropped: a dropped read costs nothing because the
 * queued one reads the same source of truth, only later.
 */
async function loadInbox() {
  if (inflight) {
    queued = true;
    return inflight;
  }
  inflight = (async () => {
    const d = await api("/api/inbox?sent=1&limit=300");
    if (d.space && d.space !== state.space) {
      state.read = loadRead(d.space); // keys are per space
      state.archive = loadArchive(d.space); // …and so is the archive: one browser, two spaces, two lists
      state.folded = loadFolds(d.space);
    }
    state.space = d.space;
    state.messages = d.messages;
    state.cursor = d.cursor;
    // The server's cursor is the BASELINE; the per-message overlay on top of it is what lets reading
    // ONE conversation clear only that conversation (read-state.js). So the count is recomputed here
    // rather than taken from `d.unread`, which knows only the cursor and would keep counting mail you
    // have already read in a focused chat.
    for (const m of state.messages) m.unread = isUnread(m, d.cursor, state.read);
    state.unread = state.messages.filter((m) => m.unread).length;
    reconcilePending();
    state.loaded = true;
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
  if (queued) {
    queued = false;
    return loadInbox();
  }
}

/**
 * Tell the server what we have actually SHOWN.
 *
 * Without this the badge only ever counts up: the shared cursor advances when a paw surface DISPLAYS a
 * message, and a browser is not one of paw's surfaces unless it says so. `ts` is the newest message on
 * SCREEN rather than `Date.now()` — marking to wall-clock would swallow anything that arrived between
 * the render and this request. The server returns the resulting cursor, so we re-sync from it instead
 * of assuming our own write landed.
 */
async function markRead(ts) {
  if (!Number.isFinite(ts) || ts <= (state.cursor ?? 0)) return;
  try {
    const d = await api("/api/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts }) });
    if (Number.isFinite(d?.cursor)) {
      state.cursor = d.cursor;
      for (const m of state.messages) m.unread = isUnread(m, state.cursor, state.read);
      state.unread = state.messages.filter((m) => m.unread).length;
    }
  } catch {
    /* the endpoint may not exist on an older daemon — an unread badge that lingers beats a broken page */
  }
}

async function loadStatus() {
  const d = await api("/api/status");
  state.rows = d.rows;
  if (Array.isArray(d.channels)) state.channels = d.channels;
  if (d.channelMembers && typeof d.channelMembers === "object") state.channelMembers = d.channelMembers;
  void pollChannelUnread().then(render);
  if (d.errors?.length) $("hint").textContent = d.errors[0];
}

async function loadTrace() {
  if (!state.focus) return;
  try {
    state.trace = await api(`/api/trace/${encodeURIComponent(state.focus)}?tail=${state.traceBlocks}&bytes=${state.traceBytes}`);
  } catch (e) {
    // Carried in STATE, not painted here: renderTrace repaints the topic line on every render, so a
    // message written directly was clobbered within a tick and the pane showed an empty trace with a
    // live-looking header (the codex1 report, 2026-08-31).
    state.trace = { blocks: [], readAt: Date.now(), error: String(e.message) };
  }
}

/**
 * Drafts are PER CONVERSATION, not per composer.
 *
 * There is one textarea, so without this the half-typed line simply stays in the box when you switch —
 * which reads as one global draft following you around, and is how a message meant for one agent gets
 * sent to the next one you open.
 *
 * Persisted in localStorage (keyed by space AND target, so two spaces don't share a draft) because the
 * point of keeping what you typed is that it survives — an in-memory draft is lost to the reload that
 * is exactly when you most want it back. Activity has no composer, so it has no draft.
 */
const draftKey = (target) => keyFor(state.space, target);
function saveDraft(target, text) {
  // The key is scoped by space, and the space only arrives with the first inbox read. Writing before
  // then would file the draft under "?" and orphan it the moment the real space is known.
  if (!target || !state.space) return;
  try {
    if (text.trim()) localStorage.setItem(draftKey(target), text);
    else localStorage.removeItem(draftKey(target)); // an emptied box is not a draft to restore
  } catch {
    /* storage full or blocked — a lost draft must never break the composer */
  }
}
function readDraft(target) {
  if (!target) return "";
  try {
    return localStorage.getItem(draftKey(target)) ?? "";
  } catch {
    return "";
  }
}
/** Drop a conversation's draft entirely — what was typed has left the composer for good. */
function clearDraft(target) {
  if (!target) return;
  imageDrafts.delete(target);
  try {
    localStorage.removeItem(draftKey(target));
  } catch {
    /* ignore — see saveDraft */
  }
}

/**
 * Staged images move with the draft, but are NOT persisted.
 *
 * Leaving them un-scoped would attach the picture you dropped for one agent to whatever you open next —
 * the same bug as the text, with a worse outcome. They stay in MEMORY only, because a staged path can be
 * reaped (cmux deletes its temp images), so restoring one after a reload would promise a file that is
 * no longer there — the exact failure `images.ts` stages files to avoid.
 */
const imageDrafts = new Map();

/** Move the composer's contents into the outgoing conversation's draft, and load the incoming one's. */
function switchDraft(from, to) {
  const input = $("input");
  if (from) {
    saveDraft(from, input.value);
    if (state.pendingImages.length) imageDrafts.set(from, state.pendingImages);
    else imageDrafts.delete(from);
  }
  input.value = readDraft(to);
  state.pendingImages = to ? (imageDrafts.get(to) ?? []) : [];
  renderPending();
  autogrow();
}

/**
 * Work out where the reader left off, and remember it for as long as this conversation stays open.
 *
 * Called on OPEN only. Channels are deliberately excluded: unread is tracked against the DM cursor and
 * there is no channel equivalent, so a divider there would be a claim paw cannot support.
 */
function markUnreadBoundary(target) {
  const list = target ? state.messages.filter((m) => m.from === target || (m.dir === "out" && m.to === target)) : state.messages;
  state.unreadMark = String(target ?? "").startsWith("#") ? null : (firstUnreadTs(list, state.cursor, state.read) ?? null);
  state.scrollToMark = state.unreadMark !== null;
}

/**
 * The PRs section. Two lines per PR, because it carries two kinds of fact: WHAT it is (status, checks,
 * number, title) and WHERE it came from (agent, branch, size). One line forces the branch to truncate
 * and takes the title down with it.
 *
 * The whole row is one link to GitHub — the operator's next move is almost always to open it.
 */
function renderPrs() {
  const head = $("prsHead");
  head.hidden = state.prs.length === 0;
  $("prsCount").textContent = state.folded.prs ? String(state.prs.length) : "";
  $("prs").innerHTML = state.prs
    .map(({ agent, pr, task }) => {
      const st = prGlyph(pr);
      const ck = checkGlyph(pr.checks);
      const diff = diffLabel(pr);
      return `<a class="pr" href="${esc(pr.url)}" target="_blank" rel="noreferrer noopener" title="${esc(pr.title ?? "")}">
        <span class="l1">
          <span class="st ${st.cls}" title="${st.label}">${st.glyph}</span>
          <span class="num">#${pr.number}</span>
          <span class="ttl">${esc(pr.title ?? "(untitled)")}</span>
          ${ck ? `<span class="ck ${ck.cls}" title="${ck.label}">${ck.glyph}</span>` : ""}
        </span>
        <span class="l2">
          <span>${esc(agent)}</span>
          ${task ? `<span class="br" title="review bead ${esc(task)}">◇ ${esc(task.replace(/^[a-z0-9]+-/, ""))}</span>` : ""}
          ${pr.branch ? `<span class="br">${esc(pr.branch)}</span>` : ""}
          ${diff ? `<span><span class="add">+${pr.additions}</span> <span class="del">−${pr.deletions}</span></span>` : ""}
        </span>
      </a>`;
    })
    .join("");
}

async function loadPrs() {
  if (!shouldRefetch({ folded: state.folded.prs, lastAt: state.prsAt, now: Date.now() })) return;
  state.prsAt = Date.now(); // stamped BEFORE the await, so a slow sweep can't be started twice
  try {
    const d = await api("/api/prs");
    state.prs = d.prs ?? [];
    renderPrs();
    applyFolds();
  } catch {
    /* a failed sweep leaves the last known list up: stale PRs are more useful than an empty section,
       and the roster next to it already shows whether the daemon is reachable at all */
  }
}

/**
 * The Tasks section: the fleet's shared beads list (the same machine-wide db every agent's BEADS_DIR
 * pins), so the work agents file is the list the operator manages. One line per task: status glyph,
 * id, title; assignee when someone holds it.
 */
function renderTasks() {
  // A first-class row NEXT TO Activity, same anatomy (pip · name · count) — the task pad is a view
  // you live in, not a section header (operator's call, 2026-08-25). The pip lights while the pad
  // is open, mirroring how Activity marks the focused state.
  const open = state.focus === TASKS;
  const openCount = state.tasks.filter((t) => t.status !== "closed").length; // closed beads are shown but not counted as work
  $("tasksRow").innerHTML = `<div class="row${open ? " active" : ""}" data-tasks="1">
      <span class="pip ${open ? "on" : ""}"></span><span class="nm">Tasks</span>
      ${openCount ? `<span class="count" style="background:none;color:var(--sidebar-txt);font-weight:400">${openCount}</span>` : ""}
    </div>`;
    $("tasksRow").firstElementChild.addEventListener("click", () => focusTarget(TASKS));
  const bopen = state.focus === BOARD;
  $("boardRow").innerHTML = `<div class="row${bopen ? " active" : ""}" data-board="1">
      <span class="pip ${bopen ? "on" : ""}"></span><span class="nm">Board</span>
    </div>`;
  $("boardRow").firstElementChild.addEventListener("click", () => focusTarget(BOARD));
  const vopen = state.focus === VILLAGE;
  $("villageRow").innerHTML = `<div class="row${vopen ? " active" : ""}" data-village="1">
      <span class="pip ${vopen ? "on" : ""}"></span><span class="nm">Village</span>
    </div>`;
  $("villageRow").firstElementChild.addEventListener("click", () => focusTarget(VILLAGE));
}

/**
 * The per-agent Tasks pane (Chat | Trace | Tasks): the GLOBAL list filtered to this agent — assigned
 * to it or filed by it — as an editable checklist on the shared editlist.js contract. A new row here
 * is created ASSIGNED to the agent, so "add a task under research" means what it says.
 */
function renderAgentTasks() {
  const pane = $("aside");
  const name = state.focus && !String(state.focus).startsWith("#") && !String(state.focus).startsWith("~") ? state.focus : null;
  if (!name) return; // the aside is only shown for a focused agent (render() hides it otherwise)
  if (pane.contains(document.activeElement) && document.activeElement.closest?.(".elt")) return; // mid-edit: never rebuild under the caret
  const mine = agentTasks(state.tasks, name); // server order: closed already sort last
  const openMine = mine.filter((t) => t.status !== "closed").length;
  const assigned = mine.filter((t) => (t.assignee ?? "").toLowerCase() === name.toLowerCase());
  const filed = mine.filter((t) => !assigned.includes(t));
  const G = { open: "○", in_progress: "◐", blocked: "●", deferred: "❄", closed: "✓" };
  const row = (t) => `<div class="eli bsi${t.status === "closed" ? " done" : ""}" data-id="${esc(t.id)}"><span class="bsb st ${t.status === "in_progress" ? "prog" : t.status}" title="${esc(t.status)} — click to change">${G[t.status] ?? "?"}</span><span class="elt bst" contenteditable="true" spellcheck="false">${esc(t.title)}</span></div>`;
  // One quiet line, not a sentence: in a 320px column the explanatory header wrapped into a word
  // salad (screenshot, 2026-08-26). The explanation lives in the tooltip; the numbers on the line.
  const done = mine.length - openMine;
  pane.innerHTML = `<div class="athead" title="the shared task list, filtered to tasks assigned to ${esc(name)} or filed by it"><b>Tasks</b> <span class="atn">${openMine} open${done ? ` · ${done} done` : ""}</span><a data-alltasks="1" title="open the full task pad">all ↗</a></div>
    <div class="atgroup">assigned</div><div class="bsub" data-assignee="${esc(name)}">${assigned.map(row).join("")}<div class="eli bsi" data-id=""><span class="bsb st open">○</span><span class="elt bst" contenteditable="true" spellcheck="false" data-ghost="1"></span></div></div>
    ${filed.length ? `<div class="atgroup">filed by ${esc(name)}</div><div class="bsub">${filed.map(row).join("")}</div>` : ""}`;
  pane.querySelector("[data-alltasks]").addEventListener("click", () => focusTarget(TASKS));
  for (const list of pane.querySelectorAll(".bsub")) {
    wireEditableList(list, {
      api: (path, opts) => {
        // creates from the assigned list carry the assignee; the wrapper is the only seam editlist gives
        if (list.dataset.assignee && opts?.body?.includes?.('"op":"create"')) {
          const b = JSON.parse(opts.body);
          opts = { ...opts, body: JSON.stringify({ ...b, assignee: list.dataset.assignee }) };
        }
        return api(path, opts);
      },
      onSynced: () => {
        state.tasksAt = undefined;
        void loadTasks();
      },
      log: (...a) => console.log("[agenttasks]", ...a),
    });
    list.addEventListener("click", async (e) => {
      const b = e.target.closest(".bsb");
      const r = b?.closest(".eli");
      if (!r?.dataset.id) return;
      const t = state.tasks.find((x) => x.id === r.dataset.id);
      if (!t) return;
      const next = t.status === "open" ? "in_progress" : t.status === "in_progress" ? "closed" : "open";
      try {
        if (next === "closed") await api("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "close", id: t.id, reason: "checked off in the agent's task list" }) });
        else await api("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "update", id: t.id, status: next }) });
        t.status = next;
        state.tasksAt = undefined;
        void loadTasks();
        renderAgentTasks();
      } catch (err) {
        r.classList.add("failed");
        r.setAttribute("data-error", String(err?.message ?? err).slice(0, 120));
      }
    });
  }
}

/** The full-size editable task pad (taskspad.js). Wired once; opened from the Tasks section header. */
/** The kanban view over the same list — a module-level singleton like the pad (NOT inside a render
 *  function: declared there once, `render()` resolved `board` to the #board ELEMENT — window.board —
 *  and threw `board.isOpen is not a function`; the fault banner earned its keep, 2026-08-26). */
const board = initBoard({
  api,
  el: $,
  agents: () => state.rows.map((r) => r.name), // the modal's @tag set — forgotten here, so every @name read as unknown (2026-08-26)
  onSynced: () => {
    state.tasksAt = undefined;
    void loadTasks();
  },
});
const taskspad = initTaskspad({
  api,
  el: $,
  onClose: () => focusTarget(null), // ✕ / Esc leave the view the same way any view is left
  agents: () => state.rows.map((r) => r.name), // @tag completion set for the task message box
  loadOrder: () => {
    try {
      const v = JSON.parse(localStorage.getItem(`paw.taskorder.${state.space}`) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  },
  saveOrder: (ids) => {
    try {
      localStorage.setItem(`paw.taskorder.${state.space}`, JSON.stringify(ids.slice(0, 500)));
    } catch {
      /* a lost order is a cosmetic loss */
    }
  },
  onSynced: () => {
    state.tasksAt = undefined; // the pad wrote — the next poll re-reads instead of trusting the cache gate
    void loadTasks();
  },
});
try { document.querySelector(".padhint").textContent += ` · build ${CLIENT_BUILD}`; } catch { /* hint is cosmetic */ }
const village = initVillage({ onFocusAgent: (name) => { state.mode = "chat"; focusTarget(name); } }); // a village click opens the CHAT, not whatever mode was last active (a codex worker has no trace)
// ⌘K/Ctrl+K command palette: jump to any agent, channel, or view. A VIEW over focusTarget — picking
// here is identical to a sidebar click. Items are built fresh on open from the current state.
const palette = initPalette({
  getItems: () => [
    { target: null, label: "Activity", kind: "view" },
    { target: TASKS, label: "Tasks", kind: "view" },
    { target: BOARD, label: "Board", kind: "view" },
    { target: VILLAGE, label: "Village", kind: "view" },
    ...state.channels.map((ch) => ({ target: "#" + ch, label: "#" + ch, kind: "channel" })),
    ...state.rows.map((r) => ({ target: r.name, label: r.name, kind: "agent", live: r.live, busy: r.busy, status: r.mesh, hint: shortPath(r.folder || "") })),
  ],
  onPick: (target, kind) => {
    if (kind === "agent") state.mode = "chat"; // an agent pick opens the chat, like a village click
    focusTarget(target);
  },
});
async function loadVillage() {
  try {
    const d = await api("/api/village");
    state.village = d;
    if (village.isOpen()) village.update(state.space, state.rows, d);
  } catch {
    /* a daemon without the route (501) or a transient miss: keep the last snapshot, stations still render */
  }
}

async function loadTasks() {
  // 15s, not the 2s message poll: each read spins bd's embedded engine, and the server caches at 15s
  // anyway — asking faster than the cache can change is noise (same reasoning as the PR section).
  if (!shouldRefetch({ folded: false, lastAt: state.tasksAt, now: Date.now(), everyMs: 15_000 })) return; // tasks can no longer fold — the pad is the view
  state.tasksAt = Date.now();
  const fetchStarted = Date.now(); // the pad compares this to its last WRITE — a fetch older than a save must not render
  try {
    const d = await api("/api/tasks");
    state.tasks = d.tasks ?? [];
    renderTasks();
    taskspad.maybeRender(state.tasks, fetchStarted);
    board.maybeRender(state.tasks, fetchStarted);
    applyFolds();
  } catch {
    /* stale tasks beat an empty section; a broken bd surfaces when the operator files one */
  }
}

/** Folded sections, per space. Same reasoning as drafts and the archive: a view preference for this
 *  surface. A corrupt value reads as NOTHING folded — the failure that shows you too much, again,
 *  because a section silently folded shut looks like data that has gone missing. */
/** Show or hide each section's body from the fold state, and point every chevron the way its click
 *  will go. Driven from state on every render so a fold survives the 2s poll rebuilding the rows. */
function applyFolds() {
  /**
 * Quote reply. The button follows the selection and disappears the moment the selection does.
 *
 * `mouseup` rather than `selectionchange`: the latter fires on every character as you drag, so the
 * button would chase the cursor mid-drag. A selection is finished when the mouse comes up.
 */
let quoteBtn;
function hideQuote() {
  // Remove EVERY button in the DOM, not just the one this closure happens to be holding. The tracked
  // reference can be reassigned by a selection event that lands between creating and hiding, and the
  // orphan then floats over the page with nothing selected — a control that does something to a
  // selection you can no longer see is worse than no control.
  for (const b of document.querySelectorAll(".quotebtn")) b.remove();
  quoteBtn = undefined;
}

document.addEventListener("mouseup", (ev) => {
  // A click ON the button is not a new selection. Without this the button's own mouseup re-runs this
  // handler after the click has hidden it, and a fresh button appears where the old one was — leaving
  // a "Quote reply" floating over the page with nothing selected.
  if (ev.target?.closest?.(".quotebtn")) return;
  // Deferred: at mouseup time the selection is not yet what the browser will report after this click
  // is processed, and a click that CLEARS a selection would otherwise still read as the old one.
  setTimeout(() => {
    const sel = document.getSelection();
    const text = sel?.toString() ?? "";
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    const insideMessage = !!host?.closest?.("#msgs .m .txt");
    if (!quotable({ text, insideMessage })) return hideQuote();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    hideQuote();
    quoteBtn = document.createElement("button");
    quoteBtn.className = "quotebtn";
    quoteBtn.textContent = "Quote reply";
    // Above the selection, clamped into the viewport — a button drawn off-screen is the same as none.
    quoteBtn.style.top = `${Math.max(8, rect.top - 34)}px`;
    quoteBtn.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 130)}px`;
    quoteBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
    quoteBtn.addEventListener("click", () => {
      // In Activity there is no composer to quote into, so quoting also OPENS the conversation the
      // quoted message belongs to — the same jump the name and timestamp make, triggered by the quote.
      const row = host.closest(".m");
      const convo = row?.dataset.convo;
      if (!state.focus && convo && state.rows.some((r) => r.name === convo)) focusTarget(convo);
      const input = $("input");
      input.value = composeQuote(input.value, text);
      input.dispatchEvent(new Event("input", { bubbles: true })); // autogrow + draft save
      input.focus();
      // Deferred: the input handlers above run first and can move the caret, so setting it now would
      // be overwritten and leave you typing INSIDE the quote you just made.
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      hideQuote();
      document.getSelection()?.removeAllRanges();
    });
    document.body.appendChild(quoteBtn);
  }, 0);
});
// Any scroll or keystroke invalidates where the button was drawn.
document.addEventListener("scroll", hideQuote, true);
document.addEventListener("keydown", hideQuote);

for (const head of document.querySelectorAll("[data-fold]")) {
    const name = head.dataset.fold;
    const shut = !!state.folded[name];
    head.classList.toggle("folded", shut);
    const body = $(name);
    if (body) body.style.display = shut ? "none" : "";
  }
}

function loadFolds(space) {
  try {
    const v = JSON.parse(localStorage.getItem(`paw.folds.${space}`) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toggleFold(section) {
  state.folded = { ...state.folded, [section]: !state.folded[section] };
  try {
    localStorage.setItem(`paw.folds.${state.space}`, JSON.stringify(state.folded));
  } catch {
    /* storage blocked — the fold still works for this session */
  }
  render();
}

/** File an agent away, or bring it back. Archiving the OPEN conversation also leaves it — otherwise
 *  the row stays pinned on screen (partitionRoster never hides the focus) and nothing appears to
 *  happen, which reads as a broken button. */
function toggleArchive(name) {
  if (state.archive[name] === undefined) {
    state.archive = { ...state.archive, [name]: Date.now() };
    if (state.focus === name) focusTarget(null);
  } else {
    const next = { ...state.archive };
    delete next[name];
    state.archive = next;
  }
  saveArchive(state.space, state.archive);
  render();
}

/** Point the view at an agent, a `#channel`, or null for Activity. */
function focusTarget(target) {
  // Command mode is per conversation: it names a FOLDER, and switching changes which one. Carrying it
  // across would leave a `$` pointed at somewhere you did not choose.
  if (target !== state.focus) state.bang = false;
  if (target !== state.focus) switchDraft(state.focus, target);
  if (target !== state.focus) markUnreadBoundary(target);
  state.focus = target;
  if (target && !String(target).startsWith("#")) void loadPr(target);
  state.trace = null;
  state.traceBytes = 512 * 1024; // a new agent starts at the cheap window again
  state.traceBlocks = 250;
  if (String(target ?? "").startsWith("#")) {
    setMode("chat"); // a channel has no transcript of its own to trace
    void loadChannel(target.slice(1)).then(render);
  }
  syncUrl();
  render();
  // Put the caret WHERE YOU JUST AIMED. Choosing a conversation is an unambiguous "I want to talk to
  // this one", but the composer came up without focus, so you typed and nothing appeared — the box
  // looked broken when it was merely unfocused (reported 2026-08-19: "input field does not work").
  // Most visible coming from Activity, which has no composer at all, so the box is newly revealed.
  //
  // Only on a DELIBERATE switch, never in render(): render runs on every 2s poll, and stealing the
  // caret on a timer would yank it out of wherever you were typing.
  // Size it now that render() has actually revealed it — `switchDraft` measured it while it was still
  // hidden, and a restored multi-line draft needs its real height.
  autogrow();
  focusComposer();
  if (state.mode === "trace") void loadTrace().then(render);
}

/**
 * Focus the composer, unless the operator is typing in some OTHER field.
 *
 * The sidebar filter is a text input too, and Option-↑/↓ steps conversations while you are still in it
 * — taking the caret there would break filtering to fix typing, which is a trade in the wrong
 * direction. A click on an agent row lands focus on BODY first, so the ordinary path is unaffected.
 */
function focusComposer() {
  const ta = $("input");
  const a = document.activeElement;
  if (!ta || ta.disabled || getComputedStyle(ta).display === "none") return;
  if (a && a !== ta && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
  ta.focus();
}

/** Jump the conversation to its newest message — what a second click on the already-selected row
 *  means (operator's call, 2026-08-27: it used to toggle back to Activity, which reads as "the click
 *  broke" when you are three screens up and just want the end). */
function scrollToEnd() {
  const el = $("msgs");
  el.scrollTop = el.scrollHeight;
  trackMsgs(el);
}

function focusAgent(name) {
  if (state.focus === name) return void scrollToEnd();
  focusTarget(name);
}

/**
 * Keep the address bar in step with what is on screen, so a view can be linked, reloaded and
 * back-buttoned. `replaceState`, not push: clicking through six agents should not mean six presses of
 * Back to leave the page.
 */
function syncUrl() {
  const q = new URLSearchParams();
  if (state.focus === TASKS) q.set("at", "tasks");
  else if (state.focus === BOARD) q.set("at", "board");
  else if (state.focus === SEARCH) { q.set("at", "search"); if (state.search?.q) q.set("q", state.search.q); }
  else if (state.focus === VILLAGE) q.set("at", "village");
  else if (state.focus) q.set("at", state.focus);
  if (state.mode !== "chat") q.set("view", state.mode);
  history.replaceState(null, "", q.toString() ? `?${q}` : location.pathname);
}

async function loadChannel(name) {
  try {
    const d = await api(`/api/channel/${encodeURIComponent(name)}?limit=200`);
    state.channelMessages = d.messages ?? [];
    // An authed mesh refuses the backlog read; saying so beats rendering an empty list, because
    // "nothing was said" and "you may not look" must not appear identical.
    state.channelError = d.historyError;
  } catch (e) {
    state.channelMessages = [];
    state.channelError = e.message;
  }
  // The channel read is the ONLY thing that can retire a pending channel post — `loadInbox` reconciles
  // too, but it reads DMs and never sees a channel echo. Safe on the failure path above: an empty list
  // echoes nothing, so the optimistic row correctly stays put.
  reconcilePending();
}

function setMode(mode) {
  state.mode = mode;
  syncUrl();
  $("main").classList.toggle("tracing", mode === "trace");
  for (const b of document.querySelectorAll(".modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  if (mode === "trace") void loadTrace().then(render);
  render();
}

/** Resize the composer to its content, capped by CSS. Height is reset to `auto` first because
 *  scrollHeight only ever GROWS against a fixed height — without the reset the box can expand and
 *  never shrink back after you delete a line. */
function autogrow() {
  const el = $("input");
  // NEVER size from a hidden measurement. Activity hides the composer outright
  // (`.main.nofocus .comp{display:none}`), and a hidden element measures `scrollHeight` 0 — so writing
  // that back PINS the box to zero height. `switchDraft` runs before `render()` reveals the composer,
  // which is exactly that case: switching from Activity to an agent left a 0px-tall textarea you could
  // neither see nor click into, and it stayed collapsed because nothing re-measures on its own. The
  // NEXT switch looked fine because by then the composer was already visible — hence "only the first
  // switch is broken" (reported 2026-08-19).
  if (el.offsetParent === null) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Put a dropped or pasted image somewhere an AGENT can read it.
 *
 * paw's attachment convention is a `📷 [Image #N] <absolute path>` line in the message text — bytes
 * never cross the mesh, the agent opens the path with Read. A browser has bytes and no path, so the
 * daemon writes them into the same staging directory `paw chat` and `paw dm` already use and hands
 * back the path. That is why this uploads first and only then composes the message: the path IS the
 * attachment.
 */
async function stageImage(file) {
  if (!file || !/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return; // paw only promises what Read renders
  try {
    const res = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file });
    if (!res.ok) throw new Error(`${res.status}`);
    const { path } = await res.json();
    state.pendingImages.push(path);
    renderPending();
  } catch (e) {
    $("hint").textContent = `couldn't attach that image: ${e.message}`;
  }
}

/** Show what will ride along with the next message, and let it be taken back off. */
function renderPending() {
  const el = $("pending");
  el.innerHTML = state.pendingImages
    .map(
      (p, i) =>
        `<span class="chip" data-drop="${i}" title="${esc(p)}">📷 [Image #${i + 1}] ${esc(p.split("/").pop())} ✕</span>`,
    )
    .join("");
  for (const c of el.querySelectorAll("[data-drop]"))
    c.addEventListener("click", () => {
      state.pendingImages.splice(Number(c.dataset.drop), 1);
      renderPending();
    });
}

async function send() {
  const input = $("input");
  const typed = input.value.trim();
  // A path-only send is legitimate — an image with no words is still a message. But an empty box AND
  // no images is nothing to send.
  if ((!typed && !state.pendingImages.length) || !state.focus) return;
  // Same wire format the CLI produces (src/images.ts composeMessage): the placeholder stays in the
  // prose, each path follows on its own line under a 📷.
  const text = state.pendingImages.length
    ? [typed || state.pendingImages.map((_, i) => `[Image #${i + 1}]`).join(" ")]
        .concat(state.pendingImages.map((p, i) => `📷 [Image #${i + 1}] ${p}`))
        .join("\n")
    : typed;
  // In command mode the `!` was consumed on the way in, so the whole line IS the command. `parseBang`
  // still covers the case where a line arrives with the sigil intact (a paste, a restored draft).
  const bang = state.focus && !String(state.focus).startsWith("#") ? (state.bang ? text.trim() || undefined : parseBang(text)) : undefined;
  if (bang) {
    state.pendingImages = [];
    renderPending();
    input.value = "";
    clearDraft(state.focus);
    autogrow();
    state.bang = false; // one command per entry; the next line starts as a message again
    renderComposerMode();
    return void (await runCommand(String(state.focus), bang));
  }

  // `/task <title> [-- description]` files a beads task instead of sending — anywhere, because the
  // task list is fleet-wide, not a property of who is focused.
  const task = parseTaskCommand(text);
  if (task) {
    input.value = "";
    clearDraft(state.focus);
    autogrow();
    $("hint").textContent = `filing task "${task.title}"…`;
    try {
      const d = await api("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: task.title, description: task.description }),
      });
      state.tasks = d.tasks ?? [];
      renderTasks();
      applyFolds();
      $("hint").textContent = `task filed — ${state.tasks.length} open in the Tasks section`;
    } catch (e) {
      // The text is put BACK: a task that failed to file must not also be lost from the composer.
      input.value = text;
      autogrow();
      $("hint").textContent = `task not filed: ${e?.message ?? e}`;
    }
    return;
  }

  // A slash-command is handled INSTEAD of being sent, and only in a channel — `/invite` in a DM has
  // no channel to invite anyone to, so there it stays an ordinary message rather than failing.
  const invite = String(state.focus).startsWith("#") ? parseInvite(text) : undefined;
  if (invite) {
    state.pendingImages = [];
    renderPending();
    input.value = "";
    clearDraft(state.focus);
    autogrow();
    return void (await runInvite(String(state.focus).slice(1), invite.names, invite.invalid));
  }

  state.pendingImages = [];
  renderPending();
  input.value = "";
  // The draft has become a message; a send that FAILS keeps its text in the pending row (retryable),
  // so leaving the draft behind too would resurrect it in the box on the next switch.
  clearDraft(state.focus);
  autogrow(); // back to one row, or the emptied box keeps the height of what was just sent
  await deliver({ id: `p${Date.now()}${Math.random()}`, from: "you", to: state.focus, text, ts: Date.now(), dir: "out", state: "sending" });
}

/**
 * Run `!cmd` in the focused agent's folder, then let the agent read the result.
 *
 * The row goes up immediately as a pending send, because a command can take a while and a composer that
 * simply empties looks like the line was lost. It is NOT retired by the echo the way a message is —
 * what comes back from the agent is its own message, so this row is replaced by the real one carrying
 * the transcript once the read lands.
 */
async function runCommand(agent, command) {
  const id = `b${Date.now()}${Math.random()}`;
  state.pending = [...state.pending, { id, from: "you", to: agent, text: `! ${command}`, ts: Date.now(), dir: "out", state: "sending" }];
  render();
  try {
    const r = await api("/api/bash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, command }),
    });
    state.pending = state.pending.filter((p) => p.id !== id);
    // Say what actually happened to BOTH halves: a command can succeed and still fail to reach the
    // agent, and reporting only the exit code would hide that the point of running it was missed.
    const status = r.timedOut ? "timed out" : r.code === 0 ? "ok" : `exit ${r.code}`;
    $("hint").textContent = `${command} — ${status}${r.delivered === false ? " · couldn't hand it to the agent" : ""}`;
    await loadInbox();
    render();
  } catch (e) {
    const row = state.pending.find((p) => p.id === id);
    if (row) row.state = "failed";
    $("hint").textContent = `! failed: ${e.message}`;
    render();
  }
}

/**
 * Ask agents to join the channel being viewed.
 *
 * This is a REQUEST, not an admin action, and the UI must not pretend otherwise: cotal has no "add
 * someone else to a channel" — an agent joins ITSELF (`cotal_join`) — so all paw can do is DM each
 * agent asking, and record in the channel that they were asked. An agent may still decline or fail,
 * which is why the outcome is reported per name rather than announced as done.
 */
async function runInvite(channel, names, invalid = []) {
  // Everything the operator typed is accounted for, including what could not be used — an invite that
  // silently ignores half its arguments reads as complete.
  const unusable = invalid.length ? `ignored ${invalid.join(", ")} (not an agent name)` : "";
  if (!names.length) {
    $("hint").textContent = [unusable, "usage: /invite @agent — names come from the sidebar, the @ is optional"].filter(Boolean).join(" · ");
    return;
  }
  $("hint").textContent = `inviting ${names.map((n) => "@" + n).join(", ")}…`;
  try {
    const r = await api("/api/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, names }),
    });
    const ok = (r.invited ?? []).map((n) => "@" + n);
    const bad = r.failed ?? [];
    $("hint").textContent = [
      ok.length ? `asked ${ok.join(", ")} to join #${channel} — they join themselves, so watch for them here` : "",
      bad.length ? `could not reach ${bad.map((f) => "@" + f.name + " (" + f.error + ")").join(", ")}` : "",
      unusable,
    ]
      .filter(Boolean)
      .join(" · ");
    await loadChannel(channel);
    render();
  } catch (e) {
    $("hint").textContent = `invite failed: ${e.message}`;
  }
}

/**
 * Put a send on screen immediately and carry its own state until the server echoes it back.
 *
 * The optimistic row is held in `state.pending`, NOT pushed into `state.messages` — the next inbox read
 * REPLACES that array wholesale, so a row pushed there vanishes the moment a reload lands and reappears
 * only if the send actually worked. Silently disappearing is worse than a duplicate: it looks like the
 * message was never typed.
 */
async function deliver(p) {
  state.pending = [...state.pending.filter((x) => x.id !== p.id), { ...p, state: "sending", ts: Date.now() }];
  state.forceRender = true; // your own message appears NOW, selection or not
  render();
  try {
    if (String(p.to).startsWith("#")) {
      // Posting to a channel IS creating it — cotal has no separate create step, so a name nobody has
      // used yet becomes a channel the moment something is said in it.
      await api(`/api/channel/${encodeURIComponent(p.to.slice(1))}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: p.text }),
      });
      await loadChannel(p.to.slice(1));
      await loadStatus(); // the channel list may have just grown by one
    } else {
      await api("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: p.to, text: p.text }) });
      await loadInbox(); // reconcile immediately rather than waiting for the frame
    }
  } catch (e) {
    const row = state.pending.find((x) => x.id === p.id);
    if (row) row.state = "failed";
    $("hint").textContent = `send failed: ${e.message} — click the message to retry`;
  }
  render();
}

/** A failed row must be re-sendable, or "we didn't lose what you typed" is only half true. */
async function retry(id) {
  const row = state.pending.find((x) => x.id === id);
  if (row) await deliver(row);
}

/* ── live ─────────────────────────────────────────────────────────────────────────────────────── */

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("open", () => {
    $("conn").placeholder = "filter agents…";
    $("conn").classList.remove("stale");
    // A full re-read on EVERY open, not just the first. The live tail is an ephemeral tap with no
    // durable behind it, so anything published while the socket was down is never replayed — a client
    // that reconnects and waits for the next frame silently misses the gap while the banner says
    // "connected". Re-reading is cheap; a hole in the conversation is not.
    void Promise.all([loadInbox(), loadStatus()]).then(render).catch(() => {});
  });
  ws.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return; // a frame we can't parse is not a frame we should act on
    }
    if (frame.type === "status") {
      state.rows = frame.rows ?? state.rows;
      // The cursor rides this frame so a SECOND tab converges: tab A marks read, and tab B learns of it
      // on the next tick instead of holding a badge for mail that has already been read elsewhere.
      // Forward-only here too — an older cursor on a late frame must not resurrect read messages.
      if (Number.isFinite(frame.cursor) && frame.cursor > (state.cursor ?? 0)) {
        state.cursor = frame.cursor;
        for (const m of state.messages) m.unread = isUnread(m, state.cursor, state.read);
        state.unread = state.messages.filter((m) => m.unread).length;
      }
      render();
    } else if (frame.type === "message") {
      if (frame.entry?.channel) void pollChannelUnread().then(render); // a channel post: recount, the row lights up
      void loadInbox().then(render); // re-read rather than splice: the server owns ordering and unread
    }
  });
  // A closed socket must be VISIBLE. A page that silently stops updating looks like a quiet mesh.
  ws.addEventListener("close", () => {
    // Placeholder, not value: replacing what someone typed to tell them about the network would be
    // the app taking the keyboard away at the moment it is least welcome.
    $("conn").placeholder = "disconnected — retrying…";
    $("conn").classList.add("stale");
    setTimeout(connect, 2000);
  });
}

/* ── boot ─────────────────────────────────────────────────────────────────────────────────────── */

for (const b of document.querySelectorAll(".modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));
$("send").addEventListener("click", () => void send());
// Cmd-V of an image: the clipboard hands us a File with no path, which is exactly what stageImage is
// for. Text paste is untouched — only image items are intercepted.
for (const head of document.querySelectorAll("[data-fold]")) {
  head.addEventListener("click", () => toggleFold(head.dataset.fold));
}

$("input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file").map((i) => i.getAsFile());
  const images = files.filter((f) => f && f.type.startsWith("image/"));
  if (!images.length) return;
  e.preventDefault(); // or the browser also drops a filename into the box
  for (const f of images) void stageImage(f);
});

// Drag and drop, anywhere on the page — aiming at a small target while holding a file is a needless
// precision task, and there is nothing else here a file could plausibly be meant for.
for (const ev of ["dragenter", "dragover"]) {
  window.addEventListener(ev, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    document.body.classList.add("dropping");
  });
}
for (const ev of ["dragleave", "drop"]) window.addEventListener(ev, () => document.body.classList.remove("dropping"));
window.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) void stageImage(f);
});

$("conn").addEventListener("input", (e) => {
  state.filter = e.target.value;
  render();
});
// Typing FILTERS the lists (as before); Enter SEARCHES — messages, then transcripts (operator's ask,
// 2026-09-03). Same box, two verbs, and the second is explicit because it costs a scan.
$("conn").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void runSearch(e.target.value);
});
$("input").addEventListener("input", () => {
  // Entering command mode CONSUMES the `!`: it is the mode now, shown as the composer's own `$`, not a
  // character sitting in what you typed. Leaving it in means the thing you send and the thing you see
  // disagree by one character, and every command carries a sigil that is not part of it.
  if (!state.bang && isBangMode($("input").value) && state.focus && !String(state.focus).startsWith("#")) {
    state.bang = true;
    $("input").value = $("input").value.slice(1);
  }
  autogrow();
  renderComposerMode(); // the `!` switch has to appear as you type it, not on the next poll
  // Saved on every keystroke rather than only on switch, so a reload or a crash keeps what you typed.
  saveDraft(state.focus, $("input").value);
});
$("input").addEventListener("keydown", (e) => {
  // Backspace on an EMPTY command line leaves command mode — the reverse of the `!` that entered it.
  // Without this the mode has no exit but clearing the box and hoping, and a mode you cannot back out
  // of by the same key that made it is a trap.
  if (e.key === "Backspace" && state.bang && $("input").value === "") {
    e.preventDefault();
    state.bang = false;
    renderComposerMode();
    return;
  }
  // Escape leaves it too, keeping whatever was typed — that text is still a perfectly good message.
  if (e.key === "Escape" && state.bang) {
    e.preventDefault();
    state.bang = false;
    renderComposerMode();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});
/** Move `delta` conversations through the sidebar order (see conversation.js for why it clamps). */
function stepConversation(delta) {
  const next = stepTarget(orderTargets(state), state.focus, delta);
  if (next !== state.focus) focusTarget(next);
}

document.addEventListener("keydown", (e) => {
  // ⌘K / Ctrl+K toggles the command palette from anywhere (composer included).
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    palette.toggle();
    return;
  }
  if (e.key === "Escape" && state.mode === "trace") return void setMode("chat");
  // Option+↑/↓ = previous/next conversation, the way a chat app does it. Handled on the DOCUMENT so it
  // works while the cursor is in the composer — which is exactly where it will be — and preventDefault
  // because macOS otherwise moves the caret by paragraph inside the textarea.
  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    stepConversation(e.key === "ArrowDown" ? 1 : -1);
  }
});

// Theme: "system" removes the attribute so prefers-color-scheme takes over again.
const themeButtons = [...document.querySelectorAll(".theme button")];
const applyTheme = (mode) => {
  if (mode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  for (const b of themeButtons) b.setAttribute("aria-pressed", String(b.dataset.set === mode));
  try {
    localStorage.setItem("paw.theme", mode);
  } catch {
    /* private mode — not worth failing over */
  }
};
for (const b of themeButtons) b.addEventListener("click", () => applyTheme(b.dataset.set));
applyTheme((() => {
  try {
    return localStorage.getItem("paw.theme") || "system";
  } catch {
    return "system";
  }
})());

(function readUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get("at") === "tasks") state.focus = TASKS;
  else if (q.get("at") === "board") state.focus = BOARD;
  else if (q.get("at") === "search") { state.focus = SEARCH; if (q.get("q")) setTimeout(() => runSearch(q.get("q")), 0); }
  else if (q.get("at") === "village") state.focus = VILLAGE;
  else if (q.get("at")) state.focus = q.get("at");
  if (q.get("view") === "trace") state.mode = "trace";
})();
await Promise.all([loadInbox().catch(() => {}), loadStatus().catch(() => {})]);
// Restore the draft HERE rather than in readUrl: drafts are keyed by space, and the space is only known
// once the first inbox read lands — restoring any earlier reads the wrong key and comes back empty,
// leaving a saved draft on disk that the operator can see no way to get back.
if (state.focus) {
  $("input").value = readDraft(state.focus);
  autogrow();
}
// Same reason the draft restore waits: the boundary is computed against the cursor and the message
// list, neither of which exists until the first inbox read. Opening straight onto ?at=agent must show
// the divider too, not only a conversation you click into.
markUnreadBoundary(state.focus);
if (String(state.focus ?? "").startsWith("#")) await loadChannel(state.focus.slice(1)).catch(() => {});
if (state.mode === "trace") { $("main").classList.add("tracing"); void loadTrace().then(render); }
render();
connect();
// The roster changes on a human timescale; the transcript under an open trace does not.
setInterval(() => void loadStatus().then(render), 15000);
setInterval(() => {
  if (state.mode === "trace") void loadTrace().then(render);
}, 5000);
setInterval(render, 30000); // keep relative stamps from freezing at whatever they said on last paint
// Returning to the tab is the moment you actually look at what is on screen, so it is the moment to
// mark it read — otherwise mail that arrived while you were away stays unread until something else
// forces a render.
/**
 * Drag the sidebar wider or narrower.
 *
 * The width persists, because a size you re-drag every time you open the app is not a setting. Clamped
 * so it cannot be dragged to nothing (a zero-width sidebar has no grip left to drag BACK) or past half
 * the window, which would leave the conversation narrower than the list of who to have it with.
 */
(function resizable() {
  const grid = $("grid");
  const grip = $("grip");
  const MIN = 170;
  const apply = (w) => grid.style.setProperty("--side-w", `${Math.round(w)}px`);
  try {
    const saved = Number(localStorage.getItem("paw.sideWidth"));
    if (Number.isFinite(saved) && saved >= MIN) apply(saved);
  } catch { /* private mode */ }

  let dragging = false;
  grip.addEventListener("mousedown", (e) => {
    dragging = true;
    grip.classList.add("dragging");
    document.body.classList.add("resizing");
    e.preventDefault(); // or the drag selects text across the whole page
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    apply(Math.max(MIN, Math.min(e.clientX, window.innerWidth / 2)));
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove("dragging");
    document.body.classList.remove("resizing");
    try {
      localStorage.setItem("paw.sideWidth", String(parseInt(getComputedStyle(grid).getPropertyValue("--side-w"), 10) || 260));
    } catch { /* private mode */ }
  });
})();

window.addEventListener("focus", render);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });

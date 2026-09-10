// The Village view — "village E": the fleet as one CONNECTED folder-tree metro (operator picked E from
// the tracepaper mocks and asked for steppy connections, 2026-09-09). The grey backbone IS the
// filesystem — ~ branches to Github/.superconductor/.paw, Github to team2027/caffeinum, each folder to
// its repos, each repo to the agents living in it — so you can trace any agent home by walking the line
// to the root. DM traffic (from /api/village) is drawn as STEPPY orange rails on the right: orthogonal,
// same grid feel as the backbone, never diagonal; weight = message count. Hover a station for its last
// spoken line; click it to open that chat. "you" is a leaf hanging straight off the root.
//
// Persistence (operator's "persistent locations" ask): sibling ordering within a folder is kept in
// localStorage and a new agent is APPENDED, so an agent never jumps slots once you've learned where it
// is. A corrupt store reads as empty (falls back to the name sort), never throws.

const NS = "http://www.w3.org/2000/svg";
const COL = 132; // px per folder depth
const X0 = 58;
const TOP = 54;
const ROWH = 30; // px per leaf row
const LABELPAD = 100; // clearance past an agent label before the traffic rail
const FOLD = "#8a7d97";

function loadOrder(space) {
  try {
    const v = JSON.parse(localStorage.getItem(`village.order.${space}`) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveOrder(space, order) {
  try {
    localStorage.setItem(`village.order.${space}`, JSON.stringify(order.slice(0, 4000)));
  } catch {
    /* private window / quota — ordering falls back to the name sort, never throws */
  }
}
/** Stable sibling order: keep every name where it was, append names never seen before (name-sorted so
 *  two fresh loads agree), persist. Returns rank(name). */
export function placement(space, names) {
  const order = loadOrder(space);
  const known = new Set(order);
  const fresh = names.filter((n) => !known.has(n)).sort();
  if (fresh.length) {
    order.push(...fresh);
    saveOrder(space, order);
  }
  const rank = new Map(order.map((n, i) => [n, i]));
  return (n) => (rank.has(n) ? rank.get(n) : order.length + 1);
}

function statusClass(row) {
  if (!row) return "off";
  if (row.mesh === "offline") return "off";
  if (row.busy || row.mesh === "working") return "busy";
  return "on";
}

/** An agent's folder path → the segment chain that places it in the tree. No folder / a cotal_spawn
 *  peer lives under a synthetic "· workers" branch (it has no street address). Home is the "~" root. */
function pathSegs(folder) {
  let f = String(folder);
  const home = f.match(/^\/Users\/[^/]+/);
  if (home) f = f.slice(home[0].length);
  const segs = f.split("/").filter(Boolean);
  return segs.length ? segs : ["home"];
}
export function segmentsFor(row, repoIndex) {
  if (row.unregistered || !row.folder) return ["· workers"];
  // A worktree lives under its repo, not where it physically sits (operator: "worktrees belong to its
  // repo's folder"). Two ways to know it's a worktree and find its repo:
  //  (a) git reports it — place it at its repo's MAIN checkout (git.mainPath).
  //  (b) git DIDN'T detect the repo (a detached/odd checkout) but the folder is `…/worktrees/<name>/…`
  //      — resolve <name> against the repos other agents DO report, so a superconductor worktree of
  //      evals still lands under team2027/evals instead of its own .superconductor branch.
  if (row.git && row.git.worktree && row.git.mainPath) return pathSegs(row.git.mainPath);
  const m = String(row.folder).match(/\/worktrees\/([^/]+)(?:\/|$)/);
  if (m && repoIndex && repoIndex.has(m[1])) return repoIndex.get(m[1]).slice();
  return pathSegs(row.folder);
}

/** Build a folder trie from rows, then COMPRESS single-child chains (a node with no agents and exactly
 *  one child merges with that child, joining the label with "/"), so `…/evals/.claude/worktrees`
 *  reads as one hop instead of three empty ones. Pure; exported for the test. */
export function buildTree(rows) {
  // Map a repo NAME (the last segment of git.repo) → its canonical folder segments, learned from every
  // agent that reports a repo, so a git-less worktree can be resolved to the same repo by path name.
  const repoIndex = new Map();
  for (const r of rows) {
    if (r.git && r.git.repo) {
      const name = r.git.repo.split("/").pop();
      const loc = pathSegs(r.git.worktree && r.git.mainPath ? r.git.mainPath : r.folder);
      if (name && !repoIndex.has(name)) repoIndex.set(name, loc);
    }
  }
  const root = { name: "~", children: new Map(), agents: [] };
  for (const r of rows) {
    const segs = segmentsFor(r, repoIndex);
    let node = root;
    for (const seg of segs) {
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), agents: [] });
      node = node.children.get(seg);
    }
    node.agents.push({ name: r.name, st: statusClass(r), branch: r.git && r.git.branch, worktree: !!(r.git && r.git.worktree) });
  }
  const compress = (node) => {
    for (const [, child] of node.children) compress(child);
    while (node.children.size === 1 && node.agents.length === 0 && node !== root) {
      const only = [...node.children.values()][0];
      node.name = `${node.name}/${only.name}`;
      node.agents = only.agents;
      node.children = only.children;
    }
  };
  for (const [, child] of root.children) compress(child);
  return root;
}

/** Which agents talk OUTSIDE their own top-level folder (or to you) → interchange rings. Pure. */
export function crossRepo(edges, agentPos, rows) {
  const owner = new Map(rows.map((r) => [r.name, segmentsFor(r).slice(0, 2).join("/")]));
  const out = new Map();
  for (const e of edges) {
    if (!agentPos[e.a] || !agentPos[e.b]) continue;
    const oa = e.a === "you" ? "__you" : owner.get(e.a);
    const ob = e.b === "you" ? "__you" : owner.get(e.b);
    if (oa !== ob) { out.set(e.a, (out.get(e.a) || 0) + 1); out.set(e.b, (out.get(e.b) || 0) + 1); }
  }
  return out;
}

export function initVillage({ onFocusAgent }) {
  const root = document.getElementById("village");
  let open = false;
  let tip;

  const isOpen = () => open;
  const show = () => { open = true; root.hidden = false; };
  const close = () => { open = false; root.hidden = true; hideTip(); };
  const hideTip = () => { if (tip) { tip.remove(); tip = undefined; } };
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  function update(space, rows, data) {
    if (!open) return;
    const edges = (data && data.edges) || [];
    const last = (data && data.last) || {};
    const edgeNames = new Set();
    for (const e of edges) { edgeNames.add(e.a); edgeNames.add(e.b); }

    // The living map: live agents + anyone currently in an edge. A silent sleeper is hidden (its slot is
    // still remembered) so the tree stays about who is around now.
    const shown = rows.filter((r) => r.name && (r.live || edgeNames.has(r.name)));
    const tree = buildTree(shown);

    // Tidy layout: leaves get sequential rows, an internal node sits at the mean of its subtree, x by
    // depth. There is NO ~ root node (operator, 2026-09-09) — each top-level folder is its own root at
    // depth 0, and "you" is a top-level leaf at the very top.
    const rank = placement(space, shown.map((r) => r.name));
    const nodePos = new Map();
    const agentPos = {};
    let rowN = 0;
    agentPos["you"] = { x: X0, y: TOP + rowN++ * ROWH, st: "you" };
    const layout = (node, depth) => {
      const ys = [];
      node.agents.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
      for (const a of node.agents) {
        const y = TOP + rowN++ * ROWH;
        agentPos[a.name] = { x: X0 + (depth + 1) * COL, y, st: a.st, branch: a.branch, worktree: a.worktree };
        ys.push(y);
      }
      for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        layout(child, depth + 1);
        ys.push(nodePos.get(child).y);
      }
      const y = ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : TOP + rowN * ROWH;
      nodePos.set(node, { x: X0 + depth * COL, y, depth });
    };
    const topLevel = [...tree.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of topLevel) layout(t, 0);

    const others = Object.entries(agentPos).filter(([n]) => n !== "you").map(([, p]) => p.x);
    const maxLeafX = Math.max(X0, ...others);
    agentPos["you"].x = maxLeafX; // "you" sits on the RIGHT with the agent stations (operator, 2026-09-09)
    const railBase = maxLeafX + LABELPAD;
    const width = railBase + Math.min(edges.length, 8) * 18 + 200; // + room for the widest agent label
    const height = TOP + rowN * ROWH + 24;

    root.innerHTML = "";
    const head = document.createElement("div");
    head.className = "villhead";
    head.innerHTML = `<span class="vtitle">Village</span><span class="vhint">the folder tree is the map — repos hold their worktrees · orange rails are DM traffic (thicker = more) · hover for the last message · click to open the chat</span>`;
    root.appendChild(head);
    const scroll = document.createElement("div");
    scroll.className = "villscroll";
    root.appendChild(scroll);
    // The whole map SCALES to the pane width (viewBox is the content, CSS sizes it to 100% width) so it
    // stays contained instead of zoomed-in-and-scrolling; it only scrolls vertically if the tree is
    // taller than the pane at that scale.
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "xMinYMin meet", style: "width:100%;height:auto;display:block" }, scroll);

    // 1. folder backbone — orthogonal elbows parent→child and parent→agent.
    const elbow = (ax, ay, bx, by) => {
      const mx = ax + (bx - ax) / 2;
      el("path", { d: `M${ax} ${ay} H${mx} V${by} H${bx}`, fill: "none", stroke: FOLD, "stroke-width": 3, "stroke-opacity": 0.85, "stroke-linejoin": "round" }, svg);
    };
    const drawBackbone = (node) => {
      const p = nodePos.get(node);
      for (const child of node.children.values()) { elbow(p.x, p.y, nodePos.get(child).x, nodePos.get(child).y); drawBackbone(child); }
      for (const a of node.agents) { const ap = agentPos[a.name]; elbow(p.x, p.y, ap.x, ap.y); }
    };
    for (const t of topLevel) drawBackbone(t);

    // 2. STEPPY DM traffic — each agent stubs to a right-hand rail, runs vertically, stubs into the
    // partner. Orthogonal, staggered lanes, drawn under the stations.
    let k = 0;
    for (const e of edges) {
      const A = agentPos[e.a], B = agentPos[e.b];
      if (!A || !B) continue; // an edge to an agent not on the map (silent sleeper) is skipped
      const rail = railBase + (k++ % 8) * 20;
      const w = e.count >= 10 ? 4 : e.count >= 4 ? 2.5 : 1.5;
      el("path", { d: `M${A.x + 9} ${A.y} H${A.x + LABELPAD - 24} H${rail} V${B.y} H${B.x + LABELPAD - 24} H${B.x + 9}`, fill: "none", stroke: "#c0663c", "stroke-opacity": 0.45, "stroke-width": w, "stroke-linejoin": "round" }, svg);
    }

    // 3. folder nodes.
    const drawNodes = (node) => {
      const p = nodePos.get(node);
      el("circle", { cx: p.x, cy: p.y, r: p.depth === 0 ? 6 : 5, fill: "var(--vbg)", stroke: FOLD, "stroke-width": 2.5 }, svg);
      const t = el("text", { x: p.x + (p.depth === 0 ? 11 : 0), y: p.y - 11, "font-size": p.depth === 0 ? 12 : 11, "font-weight": 700, fill: "var(--vfold)", "text-anchor": p.depth === 0 ? "start" : "middle" }, svg);
      t.textContent = node.name;
      for (const child of node.children.values()) drawNodes(child);
    };
    for (const t of topLevel) drawNodes(t);

    // 4. agent stations (drawn last, on top).
    const crosses = crossRepo(edges, agentPos, shown);
    for (const name in agentPos) {
      const p = agentPos[name];
      const inter = name === "you" || crosses.has(name);
      const fill = name === "you" ? "var(--vbg)" : p.st === "off" ? "var(--vbg)" : p.st === "busy" ? "#e0a23a" : "#3aa76d";
      const stroke = name === "you" ? "#1e1b22" : p.st === "off" ? "var(--vdim)" : p.st === "busy" ? "#b57d1f" : "#2b8557";
      const g = el("g", { class: "vstation", "data-name": name, style: "cursor:pointer" }, svg);
      el("circle", { cx: p.x, cy: p.y, r: inter ? 8 : 6.5, fill, stroke, "stroke-width": 2.5 }, g);
      if (inter && name !== "you") el("circle", { cx: p.x, cy: p.y, r: 3, fill: "#1e1b22" }, g);
      if (p.st === "busy") el("circle", { cx: p.x, cy: p.y, r: 13, fill: "none", stroke: "#e0a23a", "stroke-width": 1.5, "stroke-dasharray": "3 3" }, g);
      // Label ON TOP of the station (operator, 2026-09-09), not to the right — so the DM rails leaving
      // the dot don't run through the text, and long agent names don't push the tree wide.
      const t = el("text", { x: p.x, y: p.y - 10, "font-size": 11.5, "font-weight": name === "you" ? 700 : 500, fill: p.st === "off" ? "var(--vdim)" : "var(--vink)", "text-anchor": "start" }, g);
      t.textContent = stationLabel(name, p.branch, p.worktree);
      g.addEventListener("mouseenter", () => showTip(g, name, last[name], crosses.get(name) || 0, p.branch));
      g.addEventListener("mouseleave", hideTip);
      if (name !== "you") g.addEventListener("click", () => onFocusAgent(name));
    }
  }

  function showTip(gEl, name, lastMsg, crossN, branch) {
    hideTip();
    tip = document.createElement("div");
    tip.className = "villtip";
    const when = lastMsg ? relTime(lastMsg.ts) : "";
    const body = lastMsg ? esc(lastMsg.text) : '<span class="vmuted">no messages seen yet</span>';
    const who = branch ? `${esc(name)} · ${esc(branch)}` : esc(name);
    const ft = name === "you" ? "" : `<div class="vft">${crossN ? `talks across ${crossN} repo${crossN > 1 ? "s" : ""} · ` : ""}click to open the chat</div>`;
    tip.innerHTML = `<div class="vh"><b>${who}</b><span>${when}</span></div><div class="vmsg">${body}</div>${ft}`;
    const host = document.getElementById("village");
    host.appendChild(tip);
    // Position from the hovered element's OWN screen rect — the svg is scaled, so content coords are not
    // pixels; the rect is. Clamp inside the pane.
    const gr = gEl.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    tip.style.left = Math.min(gr.left - hr.left + 16, hr.width - 300) + "px";
    tip.style.top = gr.top - hr.top + 16 + "px";
  }

  return { open: show, close, isOpen, update };
}

/** Station text: agent name, plus the checkout's branch when we have one. Worktrees get ⑂ so they
 *  don't look like a second copy of the same agent on main. */
export function stationLabel(name, branch, worktree) {
  if (!branch) return name;
  return `${name} · ${worktree ? "⑂ " : ""}${branch}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return Math.round(d / 60000) + "m ago";
  if (d < 86400000) return Math.round(d / 3600000) + "h ago";
  return Math.round(d / 86400000) + "d ago";
}

// The Office view's pure half: seats, layout, status → pose, DM diffing, label culling, procedural limb
// angles. No three.js, no DOM (localStorage only through assignSeats), so check:office imports it in node.
//
// Units are metres-ish. The room sits in +x/+z from the origin corner where the two visible walls meet:
// back wall along z=0, left wall along x=0. Back strip (kitchen · TV · lounge) → pod grid → front strip
// with the operator's desk.

import { segmentsFor, placement } from "./village.js";

export const DESK_W = 1.4;
export const DESK_D = 0.8;
export const CHAIR_CLEAR = 0.9; // per side: the 1.8u spec clearance split across both chair rows
export const AISLE = 1.2;
export const RUG_MARGIN = 0.6;
export const PAIRS_PER_BLOCK = 4; // a block is up to 4 facing pairs (8 desks); bigger pods stack blocks
export const BACK_STRIP = 4;
export const FRONT_STRIP = 3.2;
export const WORKERS = "· workers";

export const RUG_COLORS = ["#879184", "#64795B", "#E8DFD0", "#d0ba97", "#a9bce3"];
export const HAIR_FALLBACK = ["#f08a2e", "#5f83b5", "#22b2bb", "#e2577a", "#7f9726", "#1f6fd6"];
export const HAIR_STYLES = ["bob", "spikes", "bun", "curls", "beanie"];

export function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The name hash avatarColor() in app.js uses, so a character's hair matches its sidebar square. */
export function nameHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** A row → what the character is doing. Order matters: failure beats busy beats waiting. */
export function poseFor(row) {
  if (!row || !row.live || row.mesh === "offline") return "absent";
  if (row.failure || row.stuck) return "slumped";
  if (row.mesh === "starting") return "arriving";
  if (row.mesh === "working" || row.busy) return "typing";
  if (row.mesh === "waiting") return "waiting";
  return "roam";
}

/** Seated poses hold the desk; roam wanders; absent has no character at all. */
export const SEATED_POSES = new Set(["typing", "waiting", "slumped"]);

export function statusDot(pose) {
  if (pose === "typing") return "live";
  if (pose === "waiting" || pose === "arriving") return "waiting";
  if (pose === "slumped") return "failed";
  return "idle";
}

/** Pill detail text — real fields only, never invented. */
export function pillDetail(row, pose) {
  if (pose === "slumped") return row.failure ? "failed" : "stuck";
  if (pose === "typing") return (row.tool && row.tool.name) || "working";
  if (pose === "waiting") return "waiting";
  if (pose === "arriving") return "starting";
  return "";
}

/** Deterministic look: persona hue when set, else the sidebar name hash; hair style by hash. */
export function lookFor(name, row) {
  const h = hashStr(name);
  const hue = row && typeof row.hue === "number" ? row.hue : nameHue(name);
  return {
    hue,
    hair: `hsl(${hue}, 55%, 55%)`, // commas: three's Color parser rejects the space syntax (silently white)
    style: HAIR_STYLES[h % HAIR_STYLES.length],
    emoji: (row && row.emoji) || "",
  };
}

/** Which pod (repo) a row sits in: the Village folder chain, so worktrees join their repo. */
export function podKeysFor(rows) {
  const repoIndex = new Map();
  for (const r of rows) {
    if (r.git && r.git.repo) {
      const nm = r.git.repo.split("/").pop();
      if (nm && !repoIndex.has(nm)) repoIndex.set(nm, segmentsFor({ ...r, git: { ...r.git } }).slice());
    }
  }
  const out = new Map();
  for (const r of rows) {
    if (r.unregistered) { out.set(r.name, WORKERS); continue; }
    out.set(r.name, segmentsFor(r, repoIndex).join("/"));
  }
  return out;
}

export function podLabel(key) {
  if (key === WORKERS) return WORKERS;
  const segs = key.split("/");
  return segs.slice(-1)[0] || key;
}

function readSeats(space) {
  try {
    const v = JSON.parse(localStorage.getItem(`office.seats.${space}`) || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out = {};
    for (const [k, s] of Object.entries(v)) {
      if (s && typeof s === "object" && typeof s.pod === "string" && Number.isInteger(s.i) && s.i >= 0) out[k] = { pod: s.pod, i: s.i };
    }
    return out;
  } catch {
    return {};
  }
}
function writeSeats(space, seats) {
  try {
    localStorage.setItem(`office.seats.${space}`, JSON.stringify(seats));
  } catch {
    /* private window / quota — seats fall back to this session's assignment */
  }
}

/** Pure seat assignment: a known agent in the same pod keeps its index; a new one (or one whose repo
 *  changed) takes the lowest index nobody in that pod holds — including agents gone from the roster,
 *  whose slots stay reserved so they come back to the same desk. New names are seated name-sorted so two
 *  fresh loads agree. Returns a NEW store. */
export function seatsFrom(store, podOf) {
  const seats = { ...store };
  const taken = new Map();
  const hold = (pod, i) => { if (!taken.has(pod)) taken.set(pod, new Set()); taken.get(pod).add(i); };
  for (const [name, s] of Object.entries(seats)) {
    if (podOf.has(name) && podOf.get(name) !== s.pod) { delete seats[name]; continue; }
    hold(s.pod, s.i);
  }
  for (const name of [...podOf.keys()].sort()) {
    if (seats[name]) continue;
    const pod = podOf.get(name);
    const used = taken.get(pod) ?? new Set();
    let i = 0;
    while (used.has(i)) i++;
    seats[name] = { pod, i };
    hold(pod, i);
  }
  return seats;
}

/** localStorage-backed seats for this space. Never throws on a corrupt store. */
export function assignSeats(space, rows) {
  const podOf = podKeysFor(rows);
  const before = readSeats(space);
  const seats = seatsFrom(before, podOf);
  if (JSON.stringify(seats) !== JSON.stringify(before)) writeSeats(space, seats);
  return seats;
}

/** One desk's local placement inside its pod (pod-relative x/z, centre of the desk top). */
export function deskSlot(i) {
  const block = Math.floor(i / (PAIRS_PER_BLOCK * 2));
  const j = i % (PAIRS_PER_BLOCK * 2);
  const pair = Math.floor(j / 2);
  const side = j % 2;
  const blockD = 2 * DESK_D + 2 * CHAIR_CLEAR;
  const z0 = RUG_MARGIN + block * blockD + CHAIR_CLEAR;
  const x = RUG_MARGIN + pair * DESK_W + DESK_W / 2;
  // side 0: chair on the low-z side, sitter faces +z; side 1: the facing desk, sitter faces -z.
  const z = side === 0 ? z0 + DESK_D / 2 : z0 + DESK_D + DESK_D / 2;
  const yaw = side === 0 ? 0 : Math.PI;
  const chairZ = side === 0 ? z - DESK_D / 2 - 0.35 : z + DESK_D / 2 + 0.35;
  return { x, z, yaw, chairZ, side, block };
}

function podSize(n) {
  const desks = Math.max(1, n);
  const pairs = Math.min(PAIRS_PER_BLOCK, Math.ceil(desks / 2));
  const blocks = Math.ceil(desks / (PAIRS_PER_BLOCK * 2));
  return {
    w: pairs * DESK_W + 2 * RUG_MARGIN,
    d: blocks * (2 * DESK_D + 2 * CHAIR_CLEAR) + 2 * RUG_MARGIN,
  };
}

/** rows + seats (+ a stable pod order) → the whole floor plan. Pure. */
export function officeLayout(rows, seats, podRank) {
  const podOf = podKeysFor(rows);
  const byPod = new Map();
  for (const r of rows) {
    const s = seats[r.name];
    if (!s) throw new Error(`office: no seat for ${r.name} — assignSeats must run first`);
    const key = podOf.get(r.name);
    if (!byPod.has(key)) byPod.set(key, []);
    byPod.get(key).push({ name: r.name, i: s.i });
  }
  const rank = podRank ?? ((k) => k);
  const keys = [...byPod.keys()].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra < rb ? -1 : ra > rb ? 1 : a.localeCompare(b);
  });
  const P = keys.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(P)));
  const pods = keys.map((key) => {
    const members = byPod.get(key);
    const n = Math.max(...members.map((m) => m.i)) + 1;
    return { key, label: podLabel(key), members, n, ...podSize(n), rugColor: RUG_COLORS[hashStr(key) % RUG_COLORS.length] };
  });
  const gridRows = Math.ceil(P / cols);
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...pods.filter((_, k) => k % cols === c).map((p) => p.w)));
  const rowD = Array.from({ length: gridRows }, (_, r) => Math.max(0, ...pods.filter((_, k) => Math.floor(k / cols) === r).map((p) => p.d)));
  const gridW = colW.reduce((s, v) => s + v, 0) + AISLE * Math.max(0, cols - 1);
  const minW = 14;
  const W = Math.max(minW, gridW + 2 * AISLE);
  const x0 = (W - gridW) / 2;
  const zGrid = BACK_STRIP + AISLE;
  const gridD = rowD.reduce((s, v) => s + v, 0) + AISLE * Math.max(0, gridRows - 1);
  const D = zGrid + gridD + AISLE + FRONT_STRIP;
  const colX = colW.map((_, c) => x0 + colW.slice(0, c).reduce((s, v) => s + v, 0) + AISLE * c);
  const rowZ = rowD.map((_, r) => zGrid + rowD.slice(0, r).reduce((s, v) => s + v, 0) + AISLE * r);

  const laneX = [x0 - AISLE / 2, ...colX.map((x, c) => x + colW[c] + AISLE / 2)];
  const laneZ = [BACK_STRIP + AISLE / 2, ...rowZ.map((z, r) => z + rowD[r] + AISLE / 2)];

  const outPods = pods.map((p, k) => {
    const c = k % cols, r = Math.floor(k / cols);
    const px = colX[c] + (colW[c] - p.w) / 2;
    const pz = rowZ[r];
    const names = new Map(p.members.map((m) => [m.i, m.name]));
    const desks = [];
    for (let i = 0; i < p.n; i++) {
      const s = deskSlot(i);
      const leftLane = laneX[c], rightLane = laneX[c + 1];
      const x = px + s.x, z = pz + s.z;
      const lane = Math.abs(x - leftLane) <= Math.abs(x - rightLane) ? leftLane : rightLane;
      desks.push({ name: names.get(i) ?? null, i, x, z, yaw: s.yaw, chair: { x, z: pz + s.chairZ }, exit: { x: lane, z: pz + s.chairZ } });
    }
    return { key: p.key, label: p.label, x: px, z: pz, w: p.w, d: p.d, rugColor: p.rugColor, desks };
  });

  const you = { x: W / 2, z: D - FRONT_STRIP / 2 - 0.2, yaw: Math.PI };
  const frontLane = D - FRONT_STRIP - AISLE / 2;
  if (!laneZ.some((z) => Math.abs(z - frontLane) < 1e-6)) laneZ.push(frontLane);
  const stripZ = BACK_STRIP / 2;
  const amenities = [
    { kind: "tv", x: W / 2, z: 0.06, yaw: 0 },
    { kind: "counter", x: 2.6, z: 0.5, yaw: 0 },
    { kind: "fridge", x: 0.55, z: 0.55, yaw: 0 },
    { kind: "coffee", x: 3.6, z: 0.5, yaw: 0 },
    { kind: "stool", x: 2.0, z: 1.55, yaw: Math.PI },
    { kind: "stool", x: 3.0, z: 1.55, yaw: Math.PI },
    { kind: "sofa", x: W - 3, z: 1.0, yaw: 0 },
    { kind: "coffeetable", x: W - 3, z: 2.4, yaw: 0 },
    { kind: "bookshelf", x: W / 2 + 3.4, z: 0.3, yaw: 0 },
    { kind: "vending", x: 0.45, z: stripZ + 1.4, yaw: Math.PI / 2 },
    { kind: "plant", x: W - 0.6, z: 0.6, yaw: 0 },
    { kind: "plant", x: W / 2 - 2.9, z: 0.45, yaw: 0 },
    { kind: "plant", x: 0.6, z: D - 0.6, yaw: 0 },
    { kind: "plant", x: W - 0.6, z: D - 0.6, yaw: 0 },
    { kind: "lamp", x: W - 5.2, z: 0.6, yaw: 0 },
  ];
  const stripLane = laneZ[0];
  const wp = (kind, x, z, yaw, act) => ({ kind, x, z, yaw, act });
  const waypoints = [
    wp("fridge", 0.55, 1.35, Math.PI, "fridge"),
    wp("coffee", 3.6, 1.2, Math.PI, "coffee"),
    wp("stool", 2.0, 1.55, Math.PI, "perch"),
    wp("stool", 3.0, 1.55, Math.PI, "perch"),
    wp("sofa", W - 3.6, 1.15, 0, "lounge"),
    wp("sofa", W - 2.4, 1.15, 0, "lounge"),
    wp("vending", 1.3, stripZ + 1.4, -Math.PI / 2, "vending"),
    wp("window", W * 0.62, 0.9, Math.PI, "gaze"),
    wp("window", W * 0.38, 0.9, Math.PI, "gaze"),
  ].map((w) => ({ ...w, exit: { x: w.x, z: stripLane } }));
  return {
    room: { w: W, d: D },
    pods: outPods,
    you: { ...you, exit: { x: you.x, z: frontLane } },
    amenities,
    waypoints,
    lanes: { x: laneX, z: laneZ },
    door: { x: W - 1.2, z: D - 0.8, exit: { x: W - 1.2, z: frontLane } },
    windows: { back: [W * 0.38, W * 0.62], left: [D * 0.45, D * 0.72] },
  };
}

/** Aisle routing: A → its exit → along lanes → B's exit → B. Exits sit on a vertical (pod-side) or a
 *  horizontal (strip/front/between-rows) lane, and every lane runs wall to wall, so the path never cuts
 *  through a pod. Straight segments only. */
export function route(layout, a, b) {
  const { x: lx, z: lz } = layout.lanes;
  const onX = (p) => lx.some((x) => Math.abs(x - p.x) < 1e-6);
  const onZ = (p) => lz.some((z) => Math.abs(z - p.z) < 1e-6);
  const ea = a.exit ?? a, eb = b.exit ?? b;
  const near = (arr, v) => arr.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), arr[0]);
  const best2 = (arr, u, v) => arr.reduce((best, x) => (Math.abs(x - u) + Math.abs(x - v) < Math.abs(best - u) + Math.abs(best - v) ? x : best), arr[0]);
  const mid = [];
  if (onX(ea) && onX(eb)) {
    if (Math.abs(ea.x - eb.x) > 1e-6) { const z = best2(lz, ea.z, eb.z); mid.push({ x: ea.x, z }, { x: eb.x, z }); }
  } else if (onZ(ea) && onZ(eb)) {
    if (Math.abs(ea.z - eb.z) > 1e-6) { const x = near(lx, (ea.x + eb.x) / 2); mid.push({ x, z: ea.z }, { x, z: eb.z }); }
  } else if (onX(ea)) {
    mid.push({ x: ea.x, z: eb.z });
  } else {
    mid.push({ x: eb.x, z: ea.z });
  }
  const pts = [{ x: a.x, z: a.z }, { x: ea.x, z: ea.z }, ...mid, { x: eb.x, z: eb.z }, { x: b.x, z: b.z }];
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 1e-4);
}

/** Two /api/village snapshots → DM events. No previous snapshot = no events (no burst on first load). */
export function diffEdges(prev, next) {
  if (!prev || !next) return [];
  const before = new Map((prev.edges ?? []).map((e) => [`${e.a}\u0000${e.b}`, e.count]));
  const out = [];
  for (const e of next.edges ?? []) {
    const was = before.get(`${e.a}\u0000${e.b}`) ?? 0;
    if (e.count > was) out.push({ a: e.a, b: e.b, delta: e.count - was, count: e.count, lastTs: e.lastTs });
  }
  return out;
}

/** Edges are undirected (the tracker sorts names), so the sender is whoever spoke last. */
export function senderOf(ev, last) {
  const ta = last?.[ev.a]?.ts ?? -1;
  const tb = last?.[ev.b]?.ts ?? -1;
  return tb > ta ? { from: ev.b, to: ev.a } : { from: ev.a, to: ev.b };
}

export function clip(text, n) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function labelPriority({ selected, pose }) {
  if (selected) return 3;
  if (pose === "typing" || pose === "slumped" || pose === "waiting") return 2;
  return 1;
}

/** Greedy overlap culling: highest priority first (then nearest to the camera), keep a pill only if it
 *  doesn't overlap one already kept. Returns the kept ids. */
export function cullLabels(rects) {
  const sorted = [...rects].sort((a, b) => b.priority - a.priority || (a.depth ?? 0) - (b.depth ?? 0));
  const kept = [];
  for (const r of sorted) {
    const hit = kept.some((k) => r.x < k.x + k.w && r.x + r.w > k.x && r.y < k.y + k.h && r.y + r.h > k.y);
    if (!hit) kept.push(r);
  }
  return new Set(kept.map((r) => r.id));
}

const D2R = Math.PI / 180;
/** Procedural limb angles (radians) for a pose at time t (seconds). Pure. Pivots: legs/arms rotate about
 *  x (forward swing), shins bend back, head turns about y. `hip` = hip height offset for sitting. */
export function limbAngles(pose, t, phase = 0) {
  const a = { legL: 0, legR: 0, shinL: 0, shinR: 0, armL: 0, armR: 0, armLz: 0, armRz: 0, head: 0, headTilt: 0, lean: 0, bob: 0, breathe: 1, seated: false };
  const s = t + phase;
  if (pose === "walk") {
    const w = Math.sin(s * 9);
    a.legL = 35 * D2R * w; a.legR = -35 * D2R * w;
    a.shinL = Math.max(0, -w) * 30 * D2R; a.shinR = Math.max(0, w) * 30 * D2R;
    a.armL = -30 * D2R * w; a.armR = 30 * D2R * w;
    a.bob = Math.abs(Math.cos(s * 9)) * 0.02;
    return a;
  }
  const sit = pose === "typing" || pose === "waiting" || pose === "slumped" || pose === "sit";
  if (sit) {
    a.seated = true;
    a.legL = a.legR = -90 * D2R; a.shinL = a.shinR = 90 * D2R;
    a.breathe = 1 + Math.sin(s * 2) * 0.01;
    if (pose === "typing") {
      a.armL = -60 * D2R + Math.sin(s * 9 * 2 * Math.PI / 4) * 8 * D2R;
      a.armR = -60 * D2R + Math.sin(s * 9 * 2 * Math.PI / 4 + Math.PI) * 8 * D2R;
      a.lean = 8 * D2R;
      a.head = Math.sin(s * 0.4) * 6 * D2R;
    } else if (pose === "waiting") {
      a.armL = -40 * D2R; a.armR = -165 * D2R + Math.sin(s * 3) * 10 * D2R; a.armRz = 10 * D2R;
      a.head = Math.sin(s * 0.8) * 20 * D2R;
    } else if (pose === "slumped") {
      a.armL = a.armR = -80 * D2R; a.lean = 45 * D2R; a.headTilt = 30 * D2R;
    } else {
      a.armL = a.armR = -15 * D2R;
      a.head = Math.sin(s * 0.3) * 25 * D2R;
    }
    return a;
  }
  if (pose === "reach") {
    a.armR = -100 * D2R + Math.sin(s * 2) * 10 * D2R; a.lean = 6 * D2R;
    return a;
  }
  if (pose === "sip") {
    a.armR = -130 * D2R + Math.sin(s * 1.5) * 15 * D2R; a.armRz = 25 * D2R; a.headTilt = -8 * D2R;
    return a;
  }
  if (pose === "wave") {
    a.armR = -170 * D2R; a.armRz = Math.sin(s * 8) * 25 * D2R;
    return a;
  }
  // idle / stand: breathing, a glance now and then
  a.breathe = 1 + Math.sin(s * 2) * 0.01;
  a.head = Math.max(0, Math.sin(s * 0.5) - 0.6) * 60 * D2R * (Math.sin(s * 0.17) > 0 ? 1 : -1);
  return a;
}

/** Stable pod order for a space, reusing the Village placement store under its own namespace. */
export function podOrder(space, keys) {
  return placement(`${space}:office.pods`, keys);
}

/** Relative time, same buckets as the Village tooltip. */
export function relTime(ts, now = Date.now()) {
  const d = now - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.round(d / 60000) + "m";
  if (d < 86400000) return Math.round(d / 3600000) + "h";
  return Math.round(d / 86400000) + "d";
}

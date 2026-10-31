/**
 * The Office view's pure half (web/app/office-model.js): seats, layout, status → pose, DM diffing,
 * label culling, limb angles. Hermetic: no browser, no three.js, a localStorage shim.
 *
 * Run: pnpm check:office
 */
import {
  assignSeats,
  cullLabels,
  diffEdges,
  labelPriority,
  limbAngles,
  lookFor,
  nameHue,
  officeLayout,
  pillDetail,
  podKeysFor,
  podOrder,
  poseFor,
  route,
  seatsFrom,
  senderOf,
  WORKERS,
  type OfficeLayout,
  type OfficeRow,
} from "../web/app/office-model.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

let store: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
} as unknown as Storage;

const H = "/Users/aleks/Github";
const row = (name: string, folder: string | undefined, extra: Partial<OfficeRow> = {}): OfficeRow => ({ name, folder, mesh: "idle", live: true, ...extra });
const base: OfficeRow[] = [
  row("evals", `${H}/team2027/evals`, { git: { repo: "team2027/evals", branch: "main" } }),
  row("evals-wt", "/Users/aleks/.superconductor/worktrees/evals/sc-x", { git: { repo: "team2027/evals", branch: "feat", worktree: true, mainPath: `${H}/team2027/evals` } }),
  row("land", `${H}/caffeinum/vibeos-landing`, { mesh: "working" }),
  row("paw", `${H}/caffeinum/paw`),
  row("codex-1", undefined, { unregistered: { agent: "codex" } }),
];

/* ── poseFor ── */
{
  assert(poseFor(row("a", "/x", { live: false })) === "absent", "!live → absent");
  assert(poseFor(row("a", "/x", { mesh: "offline" })) === "absent", "offline → absent");
  assert(poseFor(row("a", "/x", { mesh: "starting" })) === "arriving", "starting → arriving");
  assert(poseFor(row("a", "/x", { mesh: "working" })) === "typing", "working → typing");
  assert(poseFor(row("a", "/x", { busy: true })) === "typing", "busy → typing");
  assert(poseFor(row("a", "/x", { mesh: "waiting" })) === "waiting", "waiting → waiting");
  assert(poseFor(row("a", "/x", { mesh: "working", failure: { kind: "api" } })) === "slumped", "failure beats working → slumped");
  assert(poseFor(row("a", "/x", { stuck: true })) === "slumped", "stuck → slumped");
  assert(poseFor(row("a", "/x")) === "roam", "live idle → roam");
  assert(poseFor(undefined) === "absent", "no row → absent");
  assert(pillDetail(row("a", "/x", { mesh: "working", tool: { name: "Bash" } }), "typing") === "Bash", "a pending tool name is the pill detail");
  assert(pillDetail(row("a", "/x", { mesh: "working" }), "typing") === "working", "no tool → 'working'");
  assert(pillDetail(row("a", "/x", { stuck: true }), "slumped") === "stuck", "stuck pill says stuck");
}

/* ── lookFor ── */
{
  const a = lookFor("research"), b = lookFor("research");
  assert(JSON.stringify(a) === JSON.stringify(b), "lookFor is deterministic");
  assert(a.hue === nameHue("research"), "no persona hue → the sidebar name hash");
  assert(lookFor("research", row("research", "/x", { hue: 200, emoji: "🦊" })).hue === 200, "persona hue wins");
  assert(lookFor("research", row("research", "/x", { emoji: "🦊" })).emoji === "🦊", "persona emoji rides the look");
}

/* ── pods & seats ── */
{
  const pods = podKeysFor(base);
  assert(pods.get("evals") === pods.get("evals-wt"), "a worktree lands in its repo's pod");
  assert(pods.get("codex-1") === WORKERS, "an unregistered peer lands in · workers");
  assert(pods.get("land") !== pods.get("paw"), "two repos → two pods");

  store = {};
  const s1 = assignSeats("t", base);
  const s1b = assignSeats("t", base);
  assert(JSON.stringify(s1) === JSON.stringify(s1b), "same rows → same seats");
  const plus = [...base, row("evals-2", `${H}/team2027/evals`, { git: { repo: "team2027/evals" } })];
  const s2 = assignSeats("t", plus);
  assert(base.every((r) => s2[r.name].i === s1[r.name].i && s2[r.name].pod === s1[r.name].pod), "adding an agent keeps every existing seat");
  assert(s2["evals-2"].i === 2, "the new agent takes the lowest free index in its pod");
  const minus = plus.filter((r) => r.name !== "evals");
  const s3 = assignSeats("t", minus);
  assert(s3["evals"]?.i === s1["evals"].i, "a removed agent keeps its slot reserved");
  const s4 = assignSeats("t", [...minus, row("evals-3", `${H}/team2027/evals`, { git: { repo: "team2027/evals" } })]);
  assert(s4["evals-3"].i === 3, "a newcomer does not take a removed agent's reserved slot");
  const moved = seatsFrom({ x: { pod: "old", i: 0 } }, new Map([["x", "new"]]));
  assert(moved.x.pod === "new" && moved.x.i === 0, "an agent whose repo changed is re-seated in its new pod");

  store = { "office.seats.c": "}{ not json" };
  let threw = false;
  try { assignSeats("c", base); } catch { threw = true; }
  assert(!threw, "a corrupt seat store reads as empty and never throws");
  store = { "office.seats.c": JSON.stringify({ a: "nope", b: { pod: 1, i: "x" }, evals: { pod: podKeysFor(base).get("evals"), i: 5 } }) };
  assert(assignSeats("c", base).evals.i === 5, "valid entries survive alongside junk ones");
}

/* ── layout ── */
function overlaps(L: OfficeLayout): boolean {
  const boxes = L.pods.flatMap((p) => p.desks.map((d) => ({ x: d.x - 0.7, z: d.z - 0.4, w: 1.4, d: 0.8 })));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6 && a.z < b.z + b.d - 1e-6 && a.z + a.d > b.z + 1e-6) return true;
    }
  return false;
}
function inside(L: OfficeLayout): boolean {
  return L.pods.every((p) => p.x >= 0 && p.z >= 0 && p.x + p.w <= L.room.w && p.z + p.d <= L.room.d && p.desks.every((d) => d.x > p.x && d.x < p.x + p.w && d.z > p.z && d.z < p.z + p.d));
}
{
  store = {};
  const seats = assignSeats("L", base);
  const rank = podOrder("L", [...new Set(podKeysFor(base).values())]);
  const L1 = officeLayout(base, seats, rank);
  const L2 = officeLayout(base, seats, rank);
  assert(JSON.stringify(L1) === JSON.stringify(L2), "same rows → identical layout");
  assert(!overlaps(L1), "no two desks overlap");
  assert(inside(L1), "every desk sits inside its pod and the room");
  const names = L1.pods.flatMap((p) => p.desks.map((d) => d.name)).filter(Boolean);
  assert(names.length === base.length && base.every((r) => names.includes(r.name)), "every row has exactly one desk");
  const big: OfficeRow[] = [];
  for (let k = 0; k < 9; k++) for (let n = 0; n < 11; n++) big.push(row(`a${k}-${n}`, `${H}/org/repo${k}`));
  const bs = assignSeats("big", big);
  const LB = officeLayout(big, bs, podOrder("big", [...new Set(podKeysFor(big).values())]));
  assert(LB.room.w > L1.room.w && LB.room.d > L1.room.d, "the room grows with the pod count");
  assert(!overlaps(LB) && inside(LB), "a 99-agent office still has no overlaps and stays in bounds");
  const rank2 = podOrder("L", [...new Set(podKeysFor([...base, row("z", `${H}/zzz/new`)]).values())]);
  const zKey = podKeysFor([row("z", `${H}/zzz/new`)]).get("z")!;
  const oldMax = Math.max(...[...new Set(podKeysFor(base).values())].map((k) => rank2(k)));
  assert(rank2(zKey) > oldMax, "a new pod is appended after existing ones");
  // routing never leaves the room and starts/ends where asked
  const d0 = L1.pods[0].desks[0], wpt = L1.waypoints[0];
  const path = route(L1, { ...d0.chair, exit: d0.exit }, wpt);
  assert(path[0].x === d0.chair.x && path[path.length - 1].z === wpt.z, "a route starts at the chair and ends at the waypoint");
  assert(path.every((p) => p.x >= 0 && p.x <= L1.room.w && p.z >= 0 && p.z <= L1.room.d), "a route stays inside the room");
  assert(path.every((p, i) => i === 0 || p.x === path[i - 1].x || p.z === path[i - 1].z || i === 1 || i === path.length - 1), "routes walk the aisles axis-aligned between exits");
}

/* ── DM diffing ── */
{
  const s1 = { edges: [{ a: "a", b: "b", count: 2, lastTs: 1 }] };
  const s2 = { edges: [{ a: "a", b: "b", count: 5, lastTs: 2 }, { a: "a", b: "c", count: 1, lastTs: 3 }] };
  assert(diffEdges(undefined, s1).length === 0, "no previous snapshot → no burst of events on first load");
  const ev = diffEdges(s1, s2);
  assert(ev.length === 2 && ev[0].delta === 3, "a bumped edge gives its delta");
  assert(ev[1].delta === 1 && ev[1].b === "c", "a new edge gives delta = count");
  assert(diffEdges(s2, s2).length === 0, "an unchanged edge gives nothing");
  assert(senderOf({ a: "a", b: "b" }, { a: { ts: 1 }, b: { ts: 9 } }).from === "b", "the sender is whoever spoke last");
}

/* ── labels & limbs ── */
{
  const kept = cullLabels([
    { id: "idle", x: 0, y: 0, w: 50, h: 18, priority: labelPriority({ pose: "roam" }) },
    { id: "work", x: 10, y: 5, w: 50, h: 18, priority: labelPriority({ pose: "typing" }) },
    { id: "far", x: 200, y: 0, w: 50, h: 18, priority: 1 },
  ]);
  assert(kept.has("work") && !kept.has("idle") && kept.has("far"), "cullLabels keeps the higher-priority pill and non-overlapping ones");
  assert(labelPriority({ selected: true, pose: "roam" }) > labelPriority({ pose: "typing" }), "the selected agent outranks working ones");
  const w0 = limbAngles("walk", 0.1), w1 = limbAngles("walk", 0.1 + Math.PI / 9);
  assert(Math.sign(w0.legL) === -Math.sign(w1.legL) && w0.legL === -w0.legR, "walk swings legs in counter-phase");
  assert(limbAngles("typing", 1).seated && !limbAngles("roam", 1).seated, "typing is seated, roam is not");
  assert(JSON.stringify(limbAngles("waiting", 2.5)) === JSON.stringify(limbAngles("waiting", 2.5)), "limbAngles is pure");
}

if (failures) {
  console.error(`\n${failures} office check(s) FAILED`);
  process.exit(1);
}
console.log("\n✓ office model");

// Procedural low-poly assets for the Office view: characters with a Skydive-style rig (named pivots
// Torso/Head/ArmL/ArmR/LegL/LegR/ShinL/ShinR), furniture from boxes/cylinders, and CanvasTextures (wood
// floor, windows day/night, wall TV, vending front). No external models. Geometries are shared and
// materials cached, so 20+ characters stay cheap.

import * as THREE from "./vendor/three/three.module.js";

export const CHAR_SCALE = 0.74;
export const HIP_Y = 0.42; // character-local hip height (before CHAR_SCALE)
export const SEAT_Y = 0.36; // world seat height
export const DESK_Y = 0.62; // world desk top

const geo = {};
const G = (key, make) => (geo[key] ??= make());
const mats = new Map();
export function mat(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...opts }));
  return mats.get(key);
}

function mesh(g, m, { cast = true, receive = true } = {}) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = cast;
  o.receiveShadow = receive;
  return o;
}
const box = (w, h, d) => G(`box${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, s = 16) => G(`cyl${rt}|${rb}|${h}|${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s));

/* ── characters ──────────────────────────────────────────────────────────────────────────────── */

const BODY = "#f4f1ec";
const SKIN = "#ebe7e1";

/** A character Group. `parts` holds the named pivots the animator drives. Feet at y=0, facing +z. */
export function buildCharacter(look) {
  const root = new THREE.Group();
  const rig = new THREE.Group();
  rig.scale.setScalar(CHAR_SCALE);
  root.add(rig);
  const body = mat(BODY);
  const skin = mat(SKIN);
  const hair = mat(look.hair, { roughness: 0.6 });
  const dark = mat("#1e1b22", { roughness: 0.4 });
  const white = mat("#ffffff", { roughness: 0.3 });

  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  rig.add(hips);

  const leg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.1, 0, 0);
    const thigh = mesh(G("thigh", () => new THREE.CapsuleGeometry(0.075, 0.12, 4, 10)), body);
    thigh.position.y = -0.1;
    pivot.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.21;
    const shin = mesh(G("shin", () => new THREE.CapsuleGeometry(0.07, 0.1, 4, 10)), body);
    shin.position.y = -0.09;
    knee.add(shin);
    const foot = mesh(G("foot", () => new THREE.SphereGeometry(0.08, 10, 8)), dark);
    foot.scale.set(1, 0.6, 1.4);
    foot.position.set(0, -0.19, 0.03);
    knee.add(foot);
    pivot.add(knee);
    hips.add(pivot);
    return { pivot, knee };
  };
  const L = leg(1), R = leg(-1);

  const torso = new THREE.Group();
  hips.add(torso);
  const trunk = mesh(G("trunk", () => new THREE.CapsuleGeometry(0.2, 0.22, 6, 14)), body);
  trunk.position.y = 0.26;
  torso.add(trunk);

  const head = new THREE.Group();
  head.position.y = 0.62;
  torso.add(head);
  const skull = mesh(G("skull", () => new THREE.SphereGeometry(0.24, 18, 14)), skin);
  skull.position.y = 0.16;
  head.add(skull);
  for (const s of [1, -1]) {
    const eye = mesh(G("eye", () => new THREE.SphereGeometry(0.055, 12, 10)), white, { cast: false });
    eye.position.set(s * 0.085, 0.19, 0.205);
    head.add(eye);
    const pupil = mesh(G("pupil", () => new THREE.SphereGeometry(0.03, 10, 8)), dark, { cast: false });
    pupil.position.set(s * 0.085, 0.19, 0.25);
    head.add(pupil);
  }
  const cap = mesh(G("cap", () => new THREE.SphereGeometry(0.255, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52)), hair);
  cap.position.y = 0.17;
  cap.rotation.x = -0.25;
  head.add(cap);
  addHair(head, look.style, hair);

  const arm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.25, 0.42, 0);
    const a = mesh(G("arm", () => new THREE.CapsuleGeometry(0.06, 0.2, 4, 10)), body);
    a.position.y = -0.15;
    pivot.add(a);
    const hand = mesh(G("hand", () => new THREE.SphereGeometry(0.065, 10, 8)), skin);
    hand.position.y = -0.3;
    pivot.add(hand);
    torso.add(pivot);
    return pivot;
  };
  const armL = arm(1), armR = arm(-1);

  // Picking proxy: an invisible capsule, cheaper and kinder than raycasting every limb.
  const hit = new THREE.Mesh(G("hit", () => new THREE.CapsuleGeometry(0.32, 0.7, 2, 8)), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.55;
  root.add(hit);

  root.userData.parts = { rig, hips, torso, head, armL, armR, legL: L.pivot, legR: R.pivot, shinL: L.knee, shinR: R.knee };
  root.userData.hit = hit;
  return root;
}

function addHair(head, style, m) {
  if (style === "spikes") {
    for (let k = 0; k < 7; k++) {
      const c = mesh(G("spike", () => new THREE.ConeGeometry(0.06, 0.18, 6)), m);
      const a = (k / 7) * Math.PI * 2;
      c.position.set(Math.sin(a) * 0.12, 0.4, Math.cos(a) * 0.12 - 0.02);
      c.rotation.set(Math.cos(a) * 0.6, 0, -Math.sin(a) * 0.6);
      head.add(c);
    }
  } else if (style === "bun") {
    const b = mesh(G("bun", () => new THREE.TorusGeometry(0.08, 0.05, 8, 14)), m);
    b.position.set(0, 0.42, -0.08);
    b.rotation.x = Math.PI / 2.4;
    head.add(b);
  } else if (style === "curls") {
    for (let k = 0; k < 9; k++) {
      const c = mesh(G("curl", () => new THREE.IcosahedronGeometry(0.075, 0)), m);
      const a = (k / 9) * Math.PI * 2;
      c.position.set(Math.sin(a) * 0.2, 0.3 + (k % 2) * 0.06, Math.cos(a) * 0.17 - 0.04);
      head.add(c);
    }
  } else if (style === "beanie") {
    const b = mesh(G("beanie", () => new THREE.CylinderGeometry(0.2, 0.26, 0.12, 16)), m);
    b.position.y = 0.36;
    head.add(b);
    const pom = mesh(G("pom", () => new THREE.SphereGeometry(0.06, 8, 6)), m);
    pom.position.y = 0.46;
    head.add(pom);
  } else {
    // bob: a back/side curtain
    const b = mesh(G("bob", () => new THREE.SphereGeometry(0.27, 16, 10, Math.PI * 0.15, Math.PI * 1.7, Math.PI * 0.3, Math.PI * 0.42)), m);
    b.position.y = 0.15;
    b.rotation.y = Math.PI;
    head.add(b);
  }
}

/** Apply limbAngles() output to a character's pivots. */
export function applyLimbs(ch, a) {
  const p = ch.userData.parts;
  p.legL.rotation.x = a.legL; p.legR.rotation.x = a.legR;
  p.shinL.rotation.x = a.shinL; p.shinR.rotation.x = a.shinR;
  p.armL.rotation.x = a.armL; p.armR.rotation.x = a.armR;
  p.armL.rotation.z = a.armLz; p.armR.rotation.z = -a.armRz;
  p.head.rotation.y = a.head; p.head.rotation.x = a.headTilt;
  p.torso.rotation.x = a.lean;
  p.torso.scale.y = a.breathe;
  p.hips.position.y = a.seated ? SEAT_Y / CHAR_SCALE : HIP_Y + a.bob / CHAR_SCALE;
}

/* ── furniture ───────────────────────────────────────────────────────────────────────────────── */

const DESK_TOP = "#f9f6f1";
const LEG = "#2a2826";
const CHAIR = "#5f7f7a";
export const MONITOR_OFF = "#2a2826";
export const MONITOR_ON = "#a9bce3";

/** Desk + monitor + chair, local frame: sitter at -z facing +z. Returns {group, screen, chair}. */
export function buildDesk() {
  const g = new THREE.Group();
  const top = mesh(box(1.32, 0.05, 0.74), mat(DESK_TOP, { roughness: 0.5 }));
  top.position.y = DESK_Y;
  g.add(top);
  for (const sx of [-0.6, 0.6]) {
    const leg = mesh(box(0.05, DESK_Y, 0.66), mat(LEG));
    leg.position.set(sx, DESK_Y / 2, 0);
    g.add(leg);
  }
  const stand = mesh(box(0.06, 0.14, 0.04), mat(LEG));
  stand.position.set(0, DESK_Y + 0.09, 0.22);
  g.add(stand);
  const bezel = mesh(box(0.62, 0.36, 0.04), mat(LEG));
  bezel.position.set(0, DESK_Y + 0.33, 0.24);
  g.add(bezel);
  const screen = new THREE.Mesh(box(0.56, 0.3, 0.01), new THREE.MeshStandardMaterial({ color: MONITOR_OFF, roughness: 0.4, emissive: "#000000" }));
  screen.position.set(0, DESK_Y + 0.33, 0.215);
  g.add(screen);
  const kb = mesh(box(0.42, 0.02, 0.14), mat("#e6e2dc"), { cast: false });
  kb.position.set(0, DESK_Y + 0.035, -0.08);
  g.add(kb);
  const chair = buildChair();
  chair.position.set(0, 0, -0.75);
  g.add(chair);
  return { group: g, screen, top, chair };
}

export function buildChair() {
  const g = new THREE.Group();
  const m = mat(CHAIR, { roughness: 0.7 });
  const seat = mesh(box(0.46, 0.08, 0.44), m);
  seat.position.y = SEAT_Y - 0.04;
  g.add(seat);
  const back = mesh(box(0.46, 0.44, 0.07), m);
  back.position.set(0, SEAT_Y + 0.24, -0.22);
  g.add(back);
  const post = mesh(cyl(0.03, 0.03, SEAT_Y - 0.08, 8), mat(LEG));
  post.position.y = (SEAT_Y - 0.08) / 2 + 0.04;
  g.add(post);
  const foot = mesh(cyl(0.22, 0.22, 0.04, 10), mat(LEG));
  foot.position.y = 0.03;
  g.add(foot);
  return g;
}

export function buildRug(w, d, color) {
  const r = mesh(G(`rug${w.toFixed(2)}|${d.toFixed(2)}`, () => new THREE.BoxGeometry(w, 0.02, d)), mat(color, { roughness: 1 }), { cast: false });
  r.position.y = 0.01;
  return r;
}

export function buildPlant(scale = 1) {
  const g = new THREE.Group();
  const pot = mesh(cyl(0.18, 0.13, 0.3, 12), mat("#e9e3da"));
  pot.position.y = 0.15;
  g.add(pot);
  const leaves = mat("#7fa36e", { flatShading: true });
  for (const [x, y, z, s] of [[0, 0.5, 0, 0.26], [0.1, 0.68, 0.05, 0.2], [-0.08, 0.62, -0.06, 0.2]]) {
    const l = mesh(G("leaf", () => new THREE.IcosahedronGeometry(1, 0)), leaves);
    l.scale.setScalar(s);
    l.position.set(x, y, z);
    g.add(l);
  }
  g.scale.setScalar(scale);
  return g;
}

export function buildAmenity(kind, textures) {
  const g = new THREE.Group();
  if (kind === "counter") {
    const base = mesh(box(2.6, 0.82, 0.62), mat("#e4dccf"));
    base.position.y = 0.41;
    g.add(base);
    const top = mesh(box(2.7, 0.05, 0.68), mat("#f9f6f1", { roughness: 0.4 }));
    top.position.y = 0.845;
    g.add(top);
    const sink = mesh(box(0.5, 0.02, 0.36), mat("#b9bcc2", { metalness: 0.5, roughness: 0.3 }));
    sink.position.set(-0.4, 0.87, 0);
    g.add(sink);
  } else if (kind === "fridge") {
    const f = mesh(box(0.8, 1.8, 0.7), mat("#d8d8dc", { roughness: 0.35 }));
    f.position.y = 0.9;
    g.add(f);
    const h = mesh(box(0.04, 0.5, 0.04), mat("#9a9aa0", { metalness: 0.6 }));
    h.position.set(0.3, 1.2, 0.37);
    g.add(h);
    const seam = mesh(box(0.8, 0.015, 0.02), mat("#b7b7bc"), { cast: false });
    seam.position.set(0, 1.25, 0.355);
    g.add(seam);
  } else if (kind === "coffee") {
    const m = mesh(box(0.34, 0.4, 0.3), mat("#2a2826", { roughness: 0.4 }));
    m.position.y = 0.87 + 0.2;
    g.add(m);
    const cup = mesh(cyl(0.05, 0.04, 0.09, 10), mat("#ffffff"));
    cup.position.set(0, 0.92, 0.1);
    g.add(cup);
  } else if (kind === "stool") {
    const s = mesh(cyl(0.2, 0.2, 0.06, 12), mat("#5f7f7a"));
    s.position.y = 0.62;
    g.add(s);
    const p = mesh(cyl(0.03, 0.03, 0.6, 8), mat(LEG));
    p.position.y = 0.3;
    g.add(p);
  } else if (kind === "sofa") {
    const m = mat("#4f6a73", { roughness: 0.9 });
    const seat = mesh(box(2.2, 0.36, 0.9), m);
    seat.position.y = 0.18;
    g.add(seat);
    const back = mesh(box(2.2, 0.5, 0.22), m);
    back.position.set(0, 0.55, -0.34);
    g.add(back);
    for (const sx of [-1.02, 1.02]) {
      const arm = mesh(box(0.2, 0.32, 0.9), m);
      arm.position.set(sx, 0.48, 0);
      g.add(arm);
    }
    for (const sx of [-0.5, 0.5]) {
      const c = mesh(box(0.92, 0.1, 0.7), mat("#5c7a84", { roughness: 0.9 }));
      c.position.set(sx, 0.41, 0.06);
      g.add(c);
    }
  } else if (kind === "coffeetable") {
    const t = mesh(box(1.1, 0.05, 0.55), mat("#c9935a"));
    t.position.y = 0.32;
    g.add(t);
    for (const [x, z] of [[-0.48, -0.22], [0.48, -0.22], [-0.48, 0.22], [0.48, 0.22]]) {
      const l = mesh(box(0.04, 0.3, 0.04), mat(LEG));
      l.position.set(x, 0.15, z);
      g.add(l);
    }
  } else if (kind === "bookshelf") {
    const wood = mat("#d8c6a8");
    const frame = mesh(box(1.1, 1.7, 0.34), wood);
    frame.position.y = 0.85;
    g.add(frame);
    const colors = ["#5f83b5", "#e2577a", "#7f9726", "#f08a2e", "#22b2bb", "#3F0E40"];
    for (let s = 0; s < 4; s++) {
      for (let b = 0; b < 7; b++) {
        const h = 0.22 + ((s * 7 + b) % 3) * 0.04;
        const bk = mesh(box(0.11, h, 0.24), mat(colors[(s * 3 + b) % colors.length]), { cast: false });
        bk.position.set(-0.4 + b * 0.13, 0.12 + s * 0.4 + h / 2, 0.06);
        g.add(bk);
      }
    }
  } else if (kind === "vending") {
    const body = mesh(box(0.9, 1.9, 0.8), mat("#f3f0ea", { roughness: 0.5 }));
    body.position.y = 0.95;
    g.add(body);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.7), new THREE.MeshStandardMaterial({ map: textures.vending, roughness: 0.4, emissive: "#ffffff", emissiveIntensity: 0.15, emissiveMap: textures.vending }));
    front.position.set(0, 1.0, 0.401);
    g.add(front);
  } else if (kind === "tv") {
    const frame = mesh(box(1.7, 1.0, 0.06), mat("#1e1b22", { roughness: 0.4 }));
    frame.position.set(0, 1.85, 0.03);
    g.add(frame);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshStandardMaterial({ map: textures.tv, emissive: "#ffffff", emissiveMap: textures.tv, emissiveIntensity: 0.55 }));
    scr.position.set(0, 1.85, 0.065);
    g.add(scr);
  } else if (kind === "plant") {
    g.add(buildPlant(1.4));
  } else if (kind === "lamp") {
    const p = mesh(cyl(0.02, 0.02, 1.5, 8), mat(LEG));
    p.position.y = 0.75;
    g.add(p);
    const shade = mesh(cyl(0.12, 0.22, 0.26, 14), mat("#f6e9d2", { emissive: "#ffc98f", emissiveIntensity: 0.0 }));
    shade.position.y = 1.55;
    shade.userData.lampShade = true;
    g.add(shade);
    const foot = mesh(cyl(0.16, 0.16, 0.03, 12), mat(LEG));
    foot.position.y = 0.015;
    g.add(foot);
  } else {
    throw new Error(`office: no builder for amenity "${kind}"`);
  }
  return g;
}

/** The operator's desk: wider, aubergine accent strip. */
export function buildYouDesk() {
  const g = new THREE.Group();
  const top = mesh(box(2.0, 0.06, 0.95), mat("#f9f6f1", { roughness: 0.5 }));
  top.position.y = DESK_Y;
  g.add(top);
  const front = mesh(box(2.0, DESK_Y - 0.03, 0.05), mat("#3F0E40"));
  front.position.set(0, (DESK_Y - 0.03) / 2, 0.44);
  g.add(front);
  for (const sx of [-0.95, 0.95]) {
    const leg = mesh(box(0.06, DESK_Y, 0.85), mat(LEG));
    leg.position.set(sx, DESK_Y / 2, 0);
    g.add(leg);
  }
  for (const sx of [-0.38, 0.38]) {
    const bezel = mesh(box(0.62, 0.36, 0.04), mat(LEG));
    bezel.position.set(sx, DESK_Y + 0.33, 0.28);
    bezel.rotation.y = -sx * 0.4;
    g.add(bezel);
    const scr = new THREE.Mesh(box(0.56, 0.3, 0.01), new THREE.MeshStandardMaterial({ color: MONITOR_ON, emissive: MONITOR_ON, emissiveIntensity: 0.35 }));
    scr.position.set(sx, DESK_Y + 0.33, 0.255);
    scr.rotation.y = -sx * 0.4;
    g.add(scr);
  }
  const chair = buildChair();
  chair.position.set(0, 0, -0.8);
  g.add(chair);
  return g;
}

/* ── textures ────────────────────────────────────────────────────────────────────────────────── */

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")];
}
function tex(c, { repeat } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

export function woodTexture(roomW, roomD) {
  const [c, x] = canvas(512, 512);
  const boardH = 512 / 8;
  for (let r = 0; r < 8; r++) {
    let off = (r * 173) % 512;
    for (let k = -2; k < 3; k++) {
      x.fillStyle = (r + k + 4) % 2 ? "#c9935a" : "#b98250";
      const bx = off + k * 256;
      x.fillRect(bx, r * boardH, 256, boardH);
      // grain
      x.strokeStyle = "rgba(122,90,58,.18)";
      x.lineWidth = 1;
      for (let gq = 0; gq < 4; gq++) {
        const gy = r * boardH + 10 + gq * 13 + ((r * 7 + k * 3 + gq) % 5);
        x.beginPath(); x.moveTo(bx + 6, gy); x.bezierCurveTo(bx + 90, gy - 3, bx + 170, gy + 3, bx + 250, gy); x.stroke();
      }
      x.fillStyle = "#7a5a3a";
      x.fillRect(bx, r * boardH, 2, boardH);
    }
    x.fillStyle = "#7a5a3a";
    x.fillRect(0, r * boardH, 512, 2);
  }
  return tex(c, { repeat: [roomW / 4, roomD / 4] });
}

export function windowTexture(night) {
  const [c, x] = canvas(256, 192);
  const g = x.createLinearGradient(0, 0, 0, 192);
  if (night) { g.addColorStop(0, "#141a33"); g.addColorStop(1, "#2a3358"); }
  else { g.addColorStop(0, "#9fb8e0"); g.addColorStop(1, "#dbe6f2"); }
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 192);
  // a skyline both ways; lit windows at night
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let bx = 0; bx < 256;) {
    const w = 18 + rnd() * 26, h = 40 + rnd() * 90;
    x.fillStyle = night ? "#1d2540" : "#b8c4d6";
    x.fillRect(bx, 192 - h, w, h);
    if (night) {
      x.fillStyle = "#ffd27a";
      for (let wy = 192 - h + 6; wy < 186; wy += 9) for (let wx = bx + 3; wx < bx + w - 4; wx += 7) if (rnd() > 0.55) x.fillRect(wx, wy, 3, 4);
    }
    bx += w + 2;
  }
  if (!night) { x.fillStyle = "rgba(255,255,255,.7)"; x.beginPath(); x.ellipse(60, 40, 30, 9, 0, 0, Math.PI * 2); x.ellipse(180, 28, 22, 7, 0, 0, Math.PI * 2); x.fill(); }
  return tex(c);
}

export function tvTexture() {
  const [c, x] = canvas(320, 180);
  x.fillStyle = "#3F0E40";
  x.fillRect(0, 0, 320, 180);
  // paw print: pad + four toes
  x.fillStyle = "#f4f1ec";
  x.beginPath(); x.ellipse(160, 108, 30, 24, 0, 0, Math.PI * 2); x.fill();
  for (const [tx, ty] of [[122, 76], [146, 58], [174, 58], [198, 76]]) { x.beginPath(); x.ellipse(tx, ty, 11, 14, 0, 0, Math.PI * 2); x.fill(); }
  x.font = "600 18px Inter, -apple-system, system-ui, sans-serif";
  x.textAlign = "center";
  x.fillText("paw", 160, 162);
  return tex(c);
}

export function vendingTexture(label = "INTEGRATIONS") {
  const [c, x] = canvas(160, 340);
  x.fillStyle = "#2b2f3a";
  x.fillRect(0, 0, 160, 340);
  x.fillStyle = "#f08a2e";
  x.fillRect(0, 0, 160, 40);
  x.fillStyle = "#fff";
  x.font = "700 13px Inter, -apple-system, system-ui, sans-serif";
  x.textAlign = "center";
  x.fillText(label, 80, 26);
  const cols = ["#e2577a", "#5f83b5", "#22b2bb", "#7f9726", "#f08a2e", "#ECB22E"];
  for (let r = 0; r < 6; r++) {
    x.fillStyle = "#3a4050";
    x.fillRect(10, 52 + r * 44, 110, 36);
    for (let k = 0; k < 4; k++) { x.fillStyle = cols[(r + k) % cols.length]; x.fillRect(16 + k * 26, 58 + r * 44, 18, 26); }
  }
  x.fillStyle = "#11141a";
  x.fillRect(128, 60, 22, 120);
  return tex(c);
}

/** A soft round shadow blob texture for the transparent ground under the slab. */
export function shadowBlobTexture() {
  const [c, x] = canvas(128, 128);
  const g = x.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, "rgba(60,40,20,.35)");
  g.addColorStop(1, "rgba(60,40,20,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return tex(c);
}

/** Dispose every geometry/material/texture we own (called when the view closes). */
export function disposeAssets() {
  for (const k in geo) { geo[k].dispose(); delete geo[k]; }
  for (const m of mats.values()) m.dispose();
  mats.clear();
}

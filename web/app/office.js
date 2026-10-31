// The Office view — the paw mesh as a little isometric office (after skydive.com/office): one character
// per live agent at a stable desk grouped by repo, status-driven poses, DM traffic as walks, bubbles and
// glowing arcs. Lazy-loaded by app.js the first time the view opens, so normal boot never fetches three.
//
// Split: office-model.js = pure layout/seats/poses/diffing (tested by check:office); office-assets.js =
// procedural meshes + textures; this file = scene, loop, camera, picking, DOM overlay (pills, bubbles,
// roster, controls). Everything shown is real data from /api/status, /api/village and the inbox; an
// endpoint that fails is SAID in the pane, never papered over.

import * as THREE from "./vendor/three/three.module.js";
import {
  assignSeats, clip, cullLabels, diffEdges, labelPriority, limbAngles, lookFor, officeLayout, pillDetail,
  podKeysFor, podOrder, poseFor, relTime, route, senderOf, statusDot, SEATED_POSES,
} from "./office-model.js";
import {
  applyLimbs, buildAmenity, buildCharacter, buildDesk, buildRug, buildYouDesk, disposeAssets, mat,
  MONITOR_OFF, MONITOR_ON, shadowBlobTexture, tvTexture, vendingTexture, windowTexture, woodTexture,
} from "./office-assets.js";

const D2R = Math.PI / 180;
const ISO_EL = Math.atan(1 / Math.SQRT2); // 35.264° — true isometric
const WALL_H = 2.8;
const WALK_SPEED = 1.5;
const VILLAGE_EVERY = 3000;
const BG = { day: "#f4f1ec", night: "#1b1d2a" };
const YOU = "you";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const rand = (a, b) => a + Math.random() * (b - a);

export function initOffice({ onFocusAgent, avatarColor, avatarGlyph, loadVillage }) {
  const root = document.getElementById("office");
  if (!root) throw new Error("office: #office pane missing from index.html");
  let open = false;
  let S = null; // the live scene; null while closed
  const data = { space: "", rows: [], messages: [], village: null, villageErr: "", prevVillage: null };
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── open / close ────────────────────────────────────────────────────────────────────────── */

  function show() {
    if (open) return;
    open = true;
    root.hidden = false;
    root.innerHTML = `
      <div class="ofc-stage"></div>
      <div class="ofc-labels"></div>
      <aside class="ofc-roster">
        <div class="ofc-search"><span>⌕</span><input type="search" placeholder="Search agents" spellcheck="false"></div>
        <div class="ofc-list"></div>
      </aside>
      <div class="ofc-ctrls">
        <button data-act="theme" title="day / night">◐</button>
        <button data-act="rotate" title="rotate 90°">⟳</button>
        <button data-act="fit" title="recenter">◎</button>
        <button data-act="in" title="zoom in">+</button>
        <button data-act="out" title="zoom out">−</button>
      </div>
      <button class="ofc-link" title="copy a link to this view">copy link</button>
      <div class="ofc-note" hidden></div>
      <div class="ofc-card" hidden></div>
      <div class="ofc-tip" hidden></div>`;
    try {
      S = createScene();
    } catch (e) {
      S = null;
      root.querySelector(".ofc-stage").innerHTML = `<div class="ofc-fatal"><b>The Office needs WebGL.</b><br>${esc(e.message)}<br><span>Village (sidebar) shows the same fleet without 3D.</span></div>`;
      return;
    }
    wireUi();
    if (data.rows.length) sync();
    startVillagePoll();
  }

  function close() {
    if (!open) return;
    open = false;
    stopVillagePoll();
    if (S) S.dispose();
    S = null;
    root.innerHTML = "";
    root.hidden = true;
  }

  /* ── scene ───────────────────────────────────────────────────────────────────────────────── */

  function createScene() {
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) throw new Error("this browser has no WebGL context (disabled, or no GPU).");
    const stage = root.querySelector(".ofc-stage");
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    stage.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    const hemi = new THREE.HemisphereLight("#FFF8ED", "#B4AAA0", 2);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight("#FFE9D1", 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 6;
    scene.add(sun);
    scene.add(sun.target);

    const theme0 = (() => {
      try { const t = localStorage.getItem("office.theme"); if (t === "day" || t === "night") return t; } catch { /* default below */ }
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "dark") return "night";
      if (attr === "light") return "day";
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
    })();

    const textures = { tv: tvTexture(), vending: vendingTexture(), day: windowTexture(false), night: windowTexture(true), blob: shadowBlobTexture() };
    const s = {
      renderer, scene, camera, hemi, sun, textures, stage,
      theme: theme0,
      staticGroup: null, lamps: [], windowMats: [], walls: {},
      layout: null, layoutSig: "",
      agents: new Map(),
      deskByName: new Map(), deskObjs: new Map(),
      youChar: null,
      arcs: [],
      cam: { target: new THREE.Vector3(), h: 8, az: 45, user: false },
      camAnim: null,
      selected: null, hover: null, filter: "",
      raf: 0, frames: 0, lastT: performance.now(), clock: 0,
      raycaster: new THREE.Raycaster(),
      size: { w: 1, h: 1 },
      labelSizes: new Map(),
      dispose: null,
    };

    const ro = new ResizeObserver(() => resize(s));
    ro.observe(root);
    resize(s);
    const onVis = () => { if (!document.hidden) loop(); };
    document.addEventListener("visibilitychange", onVis);

    s.dispose = () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      clearStatic(s);
      for (const a of s.agents.values()) s.scene.remove(a.obj);
      for (const arc of s.arcs) disposeArc(s, arc);
      for (const t of Object.values(textures)) t.dispose();
      disposeAssets();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    S = s;
    applyTheme(s);
    loop();
    return s;
  }

  function resize(s) {
    const r = root.getBoundingClientRect();
    s.size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    s.renderer.setSize(s.size.w, s.size.h, false);
    s.renderer.domElement.style.width = "100%";
    s.renderer.domElement.style.height = "100%";
    if (s.layout && !s.cam.user) Object.assign(s.cam, fitView(s, s.cam.az));
    placeCamera(s);
  }

  function clearStatic(s) {
    if (s.staticGroup) {
      s.scene.remove(s.staticGroup);
      s.staticGroup.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData.ownGeo) o.geometry.dispose();
        if (o.userData.ownMat) for (const m of [].concat(o.material)) m.dispose();
        for (const t of o.userData.textures ?? []) t.dispose();
      });
    }
    s.staticGroup = null;
    s.lamps = [];
    s.lampShades = [];
    s.windowMats = [];
    s.walls = {};
    s.deskObjs = new Map();
  }

  /** Room, furniture and pods — rebuilt only when the floor plan changes. */
  function buildStatic(s, L) {
    clearStatic(s);
    const g = new THREE.Group();
    const { w: W, d: D } = L.room;
    const own = (m) => { m.userData.ownGeo = true; m.userData.ownMat = true; return m; };

    // floor slab: wood top, darker edge
    const wood = woodTexture(W, D);
    const edge = new THREE.MeshStandardMaterial({ color: "#6b4a33", roughness: 0.9 });
    const top = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.75 });
    const slab = own(new THREE.Mesh(new THREE.BoxGeometry(W, 0.25, D), [edge, edge, top, edge, edge, edge]));
    slab.userData.textures = [wood];
    slab.position.set(W / 2, -0.125, D / 2);
    slab.receiveShadow = true;
    g.add(slab);

    // transparent ground: catches the slab's shadow + a soft blob, so the room floats like Skydive's
    const ground = own(new THREE.Mesh(new THREE.PlaneGeometry(W * 4, D * 4), new THREE.ShadowMaterial({ opacity: 0.12 })));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, -0.26, D / 2);
    ground.receiveShadow = true;
    g.add(ground);
    const blob = own(new THREE.Mesh(new THREE.PlaneGeometry(W * 1.5, D * 1.5), new THREE.MeshBasicMaterial({ map: s.textures.blob, transparent: true, depthWrite: false })));
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(W / 2, -0.255, D / 2);
    g.add(blob);

    // four walls; the two facing the camera are hidden every frame (cutaway)
    const wallMat = mat("#f3e6cf", { roughness: 0.95 });
    const trimMat = mat("#e8dfd0");
    const mkWall = (len, along) => {
      const wg = new THREE.Group();
      const wall = own(new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.14), wallMat));
      wall.userData.ownMat = false;
      wall.position.set(len / 2, WALL_H / 2, 0);
      wall.castShadow = true; wall.receiveShadow = true;
      wg.add(wall);
      const skirt = own(new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.04), trimMat));
      skirt.userData.ownMat = false;
      skirt.position.set(len / 2, 0.06, 0.09);
      wg.add(skirt);
      for (const at of along) {
        const frame = own(new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.3, 0.06), mat("#ffffff", { roughness: 0.5 })));
        frame.userData.ownMat = false;
        frame.position.set(at, 1.55, 0.08);
        wg.add(frame);
        const wm = new THREE.MeshStandardMaterial({ map: s.textures.day, emissiveMap: s.textures.day, emissive: "#ffffff", emissiveIntensity: 0.6, roughness: 0.3 });
        const glass = own(new THREE.Mesh(new THREE.PlaneGeometry(1.75, 1.15), wm));
        glass.position.set(at, 1.55, 0.115);
        wg.add(glass);
        s.windowMats.push(wm);
        const mull = own(new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.15, 0.03), mat("#ffffff")));
        mull.userData.ownMat = false;
        mull.position.set(at, 1.55, 0.12);
        wg.add(mull);
      }
      return wg;
    };
    const back = mkWall(W, L.windows.back);
    back.position.set(0, 0, -0.07);
    const front = mkWall(W, L.windows.back);
    front.rotation.y = Math.PI; front.position.set(W, 0, D + 0.07);
    // local +x runs along the wall, local +z faces into the room
    const left = mkWall(D, L.windows.left.map((z) => D - z));
    left.rotation.y = Math.PI / 2; left.position.set(-0.07, 0, D);
    const right = mkWall(D, L.windows.left);
    right.rotation.y = -Math.PI / 2; right.position.set(W + 0.07, 0, 0);
    s.walls = { back, front, left, right };
    g.add(back, front, left, right);

    // amenities; wall-mounted ones ride their wall so they hide with it
    for (const a of L.amenities) {
      const o = buildAmenity(a.kind, s.textures);
      o.position.set(a.x, 0, a.z);
      o.rotation.y = a.yaw;
      if (a.kind === "tv") { o.position.set(a.x, 0, 0.07); back.add(o); continue; }
      if (a.kind === "lamp") o.traverse((m) => { if (m.userData.lampShade) s.lampShades.push(m); });
      g.add(o);
    }

    // pods: rug, label anchor, desks
    for (const p of L.pods) {
      const rug = buildRug(p.w, p.d, p.rugColor);
      rug.position.set(p.x + p.w / 2, 0.01, p.z + p.d / 2);
      g.add(rug);
      for (const d of p.desks) {
        const dk = buildDesk();
        dk.group.position.set(d.x, 0, d.z);
        dk.group.rotation.y = d.yaw;
        dk.screen.material = dk.screen.material.clone();
        dk.screen.userData.ownMat = true;
        g.add(dk.group);
        if (d.name) s.deskObjs.set(d.name, dk);
      }
    }

    // the operator's desk
    const yd = buildYouDesk();
    yd.position.set(L.you.x, 0, L.you.z);
    yd.rotation.y = L.you.yaw;
    g.add(yd);

    // night lamps: a 3×3 grid of warm point lights (off by day)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const pl = new THREE.PointLight("#ffc98f", 0, 0, 1);
      pl.position.set(W * (i + 0.5) / 3, 2.4, D * (j + 0.5) / 3);
      g.add(pl);
      s.lamps.push(pl);
    }

    // sun + shadow frustum fit to the room
    const c = new THREE.Vector3(W / 2, 0, D / 2);
    const R = Math.hypot(W, D) / 2 + 1;
    s.sun.position.copy(c).add(new THREE.Vector3(-50, 360, 300).normalize().multiplyScalar(R * 2.5));
    s.sun.target.position.copy(c);
    const sc = s.sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 0.5; sc.far = R * 5;
    sc.updateProjectionMatrix();

    g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    g.updateMatrixWorld(true);
    s.scene.add(g);
    s.staticGroup = g;
    applyTheme(s);
  }

  function applyTheme(s) {
    const night = s.theme === "night";
    s.scene.background = new THREE.Color(night ? BG.night : BG.day);
    s.hemi.intensity = night ? 0.55 : 2;
    s.sun.intensity = night ? 0.5 : 3.2;
    for (const l of s.lamps) l.intensity = night ? 5 : 0;
    for (const m of s.windowMats) { m.map = m.emissiveMap = night ? s.textures.night : s.textures.day; m.emissiveIntensity = night ? 0.9 : 0.6; m.needsUpdate = true; }
    for (const m of s.lampShades ?? []) m.material = mat("#f6e9d2", { emissive: "#ffc98f", emissiveIntensity: night ? 1.4 : 0 });
    root.classList.toggle("night", night);
  }

  /* ── camera ──────────────────────────────────────────────────────────────────────────────── */

  function basis(az) {
    const a = az * D2R;
    const fwd = new THREE.Vector3(-Math.cos(ISO_EL) * Math.sin(a), -Math.sin(ISO_EL), -Math.cos(ISO_EL) * Math.cos(a));
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    return { fwd, right, up };
  }

  function insets(s) {
    const roster = root.querySelector(".ofc-roster");
    const rr = roster && roster.offsetParent ? roster.getBoundingClientRect() : null;
    const hr = root.getBoundingClientRect();
    return { l: rr ? rr.right - hr.left + 12 : 24, r: 72, t: 24, b: 24 };
  }

  /** Target + frustum that fit the whole room into the area not covered by the roster/buttons. */
  function fitView(s, az) {
    const L = s.layout;
    if (!L) return { target: new THREE.Vector3(), h: 8, az };
    const { right, up } = basis(az);
    const c = new THREE.Vector3(L.room.w / 2, 0, L.room.d / 2);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [0, L.room.w]) for (const z of [0, L.room.d]) for (const y of [-0.25, WALL_H]) {
      const v = new THREE.Vector3(x, y, z).sub(c);
      const px = v.dot(right), py = v.dot(up);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const ins = insets(s);
    const availW = Math.max(100, s.size.w - ins.l - ins.r), availH = Math.max(100, s.size.h - ins.t - ins.b);
    const ppu = Math.min(availW / (maxX - minX), availH / (maxY - minY));
    const h = s.size.h / (2 * ppu);
    const vx = (minX + maxX) / 2 - (ins.l - ins.r) / 2 / ppu;
    const vy = (minY + maxY) / 2 - (ins.b - ins.t) / 2 / ppu;
    return { target: c.clone().addScaledVector(right, vx).addScaledVector(up, vy), h, az };
  }

  function placeCamera(s) {
    const { fwd } = basis(s.cam.az);
    const cam = s.camera;
    cam.position.copy(s.cam.target).addScaledVector(fwd, -120);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.cam.target);
    const aspect = s.size.w / s.size.h;
    cam.left = -s.cam.h * aspect; cam.right = s.cam.h * aspect; cam.top = s.cam.h; cam.bottom = -s.cam.h;
    cam.near = 1; cam.far = 400;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // cutaway: hide the walls between the camera and the room
    const a = s.cam.az * D2R;
    const dx = Math.sin(a), dz = Math.cos(a);
    if (s.walls.back) {
      s.walls.back.visible = dz > 0.01;
      s.walls.front.visible = dz < -0.01;
      s.walls.left.visible = dx > 0.01;
      s.walls.right.visible = dx < -0.01;
    }
  }

  function animateCam(s, to, dur = 700) {
    if (reduced()) { Object.assign(s.cam, { target: to.target.clone(), h: to.h, az: to.az }); placeCamera(s); saveCam(); return; }
    s.camAnim = { from: { target: s.cam.target.clone(), h: s.cam.h, az: s.cam.az }, to, t0: performance.now(), dur };
  }

  function stepCam(s, now) {
    const A = s.camAnim;
    if (!A) return;
    const k = Math.min(1, (now - A.t0) / A.dur);
    const e = ease(k);
    s.cam.target.lerpVectors(A.from.target, A.to.target, e);
    s.cam.h = A.from.h + (A.to.h - A.from.h) * e;
    s.cam.az = A.from.az + (A.to.az - A.from.az) * e;
    if (k >= 1) { s.camAnim = null; s.cam.az = ((A.to.az % 360) + 360) % 360; saveCam(); }
    placeCamera(s);
  }

  function floorAt(s, clientX, clientY) {
    const r = s.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    s.raycaster.setFromCamera(ndc, s.camera);
    const p = new THREE.Vector3();
    return s.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
  }

  function zoomBy(s, factor, clientX, clientY) {
    const before = clientX != null ? floorAt(s, clientX, clientY) : null;
    s.cam.h = Math.min(80, Math.max(1.2, s.cam.h * factor));
    placeCamera(s);
    if (before) {
      const after = floorAt(s, clientX, clientY);
      if (after) { s.cam.target.add(before.sub(after)); placeCamera(s); }
    }
    s.cam.user = true;
    saveCam();
  }

  /** Frame an agent: its head at the centre of the free area, zoomed in to a desk-pod scale. */
  function frameAgent(s, name) {
    const p = name === YOU ? s.youChar?.obj.position : s.agents.get(name)?.obj.position;
    if (!p) return;
    const h = Math.min(s.cam.h, 3.6);
    const ppu = s.size.h / (2 * h);
    const ins = insets(s);
    const { right, up } = basis(s.cam.az);
    const t = p.clone().setY(0.7).addScaledVector(right, -(ins.l - ins.r) / 2 / ppu).addScaledVector(up, -(ins.b - ins.t) / 2 / ppu);
    s.cam.user = true;
    animateCam(s, { target: t, h, az: s.cam.az });
  }

  const camKey = () => `office.cam.${data.space}`;
  function loadCam() {
    try {
      const v = JSON.parse(localStorage.getItem(camKey()) || "null");
      if (!v || !Number.isFinite(v.h) || !Number.isFinite(v.az) || !Array.isArray(v.t)) return null;
      return { target: new THREE.Vector3(v.t[0], v.t[1], v.t[2]), h: v.h, az: v.az, user: !!v.user };
    } catch {
      return null;
    }
  }
  function saveCam() {
    if (!S) return;
    try {
      localStorage.setItem(camKey(), JSON.stringify({ t: S.cam.target.toArray(), h: S.cam.h, az: S.cam.az, user: S.cam.user }));
    } catch { /* quota / private window: camera just isn't remembered */ }
  }

  /* ── data → scene ────────────────────────────────────────────────────────────────────────── */

  function update(space, rows, messages) {
    data.space = space;
    data.rows = rows ?? [];
    data.messages = messages ?? [];
    if (open && S) sync();
  }

  function sync() {
    const s = S;
    const rows = data.rows.filter((r) => r && r.name);
    const seats = assignSeats(data.space, rows);
    const rank = podOrder(data.space, [...new Set(podKeysFor(rows).values())]);
    const L = officeLayout(rows, seats, rank);
    const sig = JSON.stringify([L.room, L.pods.map((p) => [p.key, p.x, p.z, p.w, p.d, p.desks.map((d) => d.name)])]);
    if (sig !== s.layoutSig) {
      const first = !s.layout;
      s.layout = L;
      s.layoutSig = sig;
      s.deskByName = new Map(L.pods.flatMap((p) => p.desks.filter((d) => d.name).map((d) => [d.name, d])));
      buildStatic(s, L);
      if (first) { const c = loadCam(); if (c) s.cam = c; }
      if (!s.cam.user) Object.assign(s.cam, fitView(s, s.cam.az));
      placeCamera(s);
      // seated characters snap to their (possibly moved) desk
      for (const a of s.agents.values()) { a.path = []; if (a.state === "seated") placeAtDesk(a); }
    }
    s.layout = L;

    const byName = new Map(rows.map((r) => [r.name, r]));
    for (const r of rows) {
      const pose = poseFor(r);
      let a = s.agents.get(r.name);
      if (pose === "absent") { if (a) removeAgent(s, a); continue; }
      if (!a) a = addAgent(s, r, pose);
      a.row = r;
      if (a.pose !== pose) { a.pose = pose; onPose(s, a); }
    }
    for (const a of [...s.agents.values()]) if (!byName.has(a.name)) removeAgent(s, a);
    // monitors: lit while typing, dark when the agent is away/offline; absent chairs pushed in
    for (const [name, dk] of s.deskObjs) {
      const r = byName.get(name);
      const pose = poseFor(r);
      dk.screen.material.color.set(pose === "typing" ? MONITOR_ON : MONITOR_OFF);
      dk.screen.material.emissive.set(pose === "typing" ? MONITOR_ON : "#000000");
      dk.screen.material.emissiveIntensity = pose === "typing" ? 0.5 : 0;
      dk.chair.position.z = pose === "absent" ? -0.55 : -0.75;
      dk.chair.updateMatrix();
      dk.chair.traverse((o) => o.updateMatrix());
      dk.top.material = pose === "absent" ? mat("#d6d3ce", { roughness: 0.5 }) : mat("#f9f6f1", { roughness: 0.5 });
    }
    if (!s.youChar) s.youChar = addYou(s);
    else { s.youChar.obj.position.set(s.layout.you.x, 0, s.layout.you.z - 0.8 * Math.cos(s.layout.you.yaw)); }
    renderRoster();
    renderNote();
    if (s.selected) renderCard(s.selected);
  }

  function addYou(s) {
    const L = s.layout;
    const obj = buildCharacter({ hair: "#3F0E40", style: "bob" });
    obj.scale.setScalar(1.08);
    obj.position.set(L.you.x, 0, L.you.z - 0.8 * Math.cos(L.you.yaw));
    obj.rotation.y = L.you.yaw;
    obj.traverse((o) => { if (o.isMesh && o !== obj.userData.hit) o.castShadow = true; });
    obj.userData.hit.userData.agent = YOU;
    s.scene.add(obj);
    const label = makeLabel(YOU);
    return { name: YOU, obj, label, pose: "sit", phase: 0.3, bubbleUntil: 0 };
  }

  function addAgent(s, row, pose) {
    const look = lookFor(row.name, row);
    const obj = buildCharacter(look);
    obj.userData.hit.userData.agent = row.name;
    s.scene.add(obj);
    const a = {
      name: row.name, row, pose, look, obj,
      state: "new", path: [], anim: "idle", act: null, until: 0, onArrive: null,
      yaw: 0, phase: Math.random() * 10, bubbleUntil: 0,
      label: makeLabel(row.name),
      dropY: 0,
    };
    s.agents.set(row.name, a);
    const desk = s.deskByName.get(row.name);
    if (pose === "arriving" && s.layout && !reduced()) {
      obj.position.set(s.layout.door.x, 0, s.layout.door.z);
      a.state = "intro"; a.dropY = 3; a.anim = "idle";
      a.lastExit = s.layout.door.exit;
    } else if (desk) {
      placeAtDesk(a);
      if (pose === "roam") a.until = s.clock + rand(4, 25); // stagger the first wander
    }
    return a;
  }

  function removeAgent(s, a) {
    s.scene.remove(a.obj);
    a.label.pill.remove();
    a.label.bubble.remove();
    s.agents.delete(a.name);
    if (s.selected === a.name) select(null);
  }

  function placeAtDesk(a) {
    const d = S.deskByName.get(a.name);
    if (!d) return;
    a.obj.position.set(d.chair.x, 0, d.chair.z);
    a.yaw = d.yaw;
    a.obj.rotation.y = d.yaw;
    a.state = "seated";
    a.path = [];
    a.anim = SEATED_POSES.has(a.pose) ? a.pose : "sit";
  }

  function deskSpot(name) {
    const d = S.deskByName.get(name);
    return d ? { x: d.chair.x, z: d.chair.z, exit: d.exit, yaw: d.yaw } : null;
  }

  function walkTo(a, spot, then) {
    const here = a.state === "seated" ? deskSpot(a.name) : null;
    const from = here ?? { x: a.obj.position.x, z: a.obj.position.z, exit: a.lastExit };
    if (reduced()) {
      a.obj.position.set(spot.x, 0, spot.z);
      a.path = [];
      a.state = "walk";
      arrive(a, spot, then);
      return;
    }
    a.path = route(S.layout, from.exit ? from : { x: from.x, z: from.z, exit: nearestExit(from) }, spot.exit ? spot : { ...spot, exit: nearestExit(spot) });
    a.path.shift();
    a.state = "walk";
    a.anim = "walk";
    a.dest = spot;
    a.onArrive = then;
  }

  function nearestExit(p) {
    const { x: lx, z: lz } = S.layout.lanes;
    const bx = lx.reduce((b, x) => (Math.abs(x - p.x) < Math.abs(b - p.x) ? x : b), lx[0]);
    const bz = lz.reduce((b, z) => (Math.abs(z - p.z) < Math.abs(b - p.z) ? z : b), lz[0]);
    return Math.abs(bx - p.x) < Math.abs(bz - p.z) ? { x: bx, z: p.z } : { x: p.x, z: bz };
  }

  function arrive(a, spot, then) {
    a.lastExit = spot.exit;
    if (spot.yaw != null) a.yaw = spot.yaw;
    if (then) then(a);
  }

  const sitAtDesk = (a) => {
    placeAtDesk(a);
    if (a.pose === "roam") a.until = S.clock + rand(20, 60);
  };
  const goDesk = (a) => { const d = deskSpot(a.name); if (d) walkTo(a, d, sitAtDesk); };

  const ACTS = { fridge: ["reach", 2.8], coffee: ["sip", 3.4], perch: ["idle", 6], lounge: ["sit", 12], vending: ["reach", 2.5], gaze: ["idle", 6] };
  function wander(a) {
    const wps = S.layout.waypoints;
    const busy = new Set([...S.agents.values()].filter((o) => o !== a && o.dest).map((o) => `${o.dest.x},${o.dest.z}`));
    const free = wps.filter((w) => !busy.has(`${w.x},${w.z}`));
    const w = free[Math.floor(Math.random() * free.length)];
    if (!w) { a.until = S.clock + rand(10, 30); return; }
    walkTo(a, w, (b) => {
      const [anim, dur] = ACTS[w.act] ?? ["idle", 4];
      b.state = "act";
      b.anim = anim;
      b.obj.rotation.y = b.yaw = w.yaw;
      if (w.act === "lounge") b.obj.position.y = 0.06;
      b.until = S.clock + (w.act === "lounge" ? rand(8, 15) : dur);
      b.after = () => { b.obj.position.y = 0; b.dest = null; Math.random() < 0.35 ? wander(b) : goDesk(b); };
    });
  }

  function onPose(s, a) {
    if (a.state === "intro") return; // finishes its drop first, then heads to the desk
    if (SEATED_POSES.has(a.pose) || a.pose === "arriving") {
      if (a.state === "seated") a.anim = SEATED_POSES.has(a.pose) ? a.pose : "sit";
      else { a.obj.position.y = 0; goDesk(a); }
    } else if (a.pose === "roam" && a.state === "seated") {
      a.anim = "sit";
      a.until = s.clock + rand(3, 12);
    }
  }

  /* ── per-frame ───────────────────────────────────────────────────────────────────────────── */

  function loop() {
    const s = S;
    if (!s || !open || document.hidden) return;
    cancelAnimationFrame(s.raf);
    s.raf = requestAnimationFrame(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - s.lastT) / 1000);
      s.lastT = now;
      s.clock += dt;
      stepCam(s, now);
      for (const a of s.agents.values()) stepAgent(s, a, dt);
      if (s.youChar) applyLimbs(s.youChar.obj, limbAngles(s.youChar.pose, reduced() ? 0 : s.clock, s.youChar.phase));
      stepArcs(s, now);
      s.renderer.render(s.scene, s.camera);
      placeLabels(s);
      s.frames++;
      if (s.frames % 30 === 0) root.dataset.frames = String(s.frames);
      loop();
    });
  }

  function stepAgent(s, a, dt) {
    const o = a.obj;
    if (a.state === "intro") {
      a.dropY = Math.max(0, a.dropY - dt * 6);
      o.position.y = a.dropY;
      if (a.dropY === 0) { a.state = "stand"; a.anim = "wave"; a.until = s.clock + 1.2; a.after = goDesk; }
    } else if (a.state === "walk") {
      const tgt = a.path[0];
      if (!tgt) { a.state = "stand"; a.anim = "idle"; const d = a.dest, cb = a.onArrive; a.onArrive = null; arrive(a, d ?? {}, cb); }
      else {
        const dx = tgt.x - o.position.x, dz = tgt.z - o.position.z;
        const dist = Math.hypot(dx, dz);
        const step = WALK_SPEED * dt;
        a.yaw = Math.atan2(dx, dz);
        if (dist <= step) { o.position.x = tgt.x; o.position.z = tgt.z; a.path.shift(); }
        else { o.position.x += (dx / dist) * step; o.position.z += (dz / dist) * step; }
      }
    } else if ((a.state === "act" || a.state === "stand") && a.until && s.clock > a.until) {
      a.until = 0;
      const next = a.after; a.after = null;
      if (next) next(a);
      else if (SEATED_POSES.has(a.pose)) goDesk(a);
      else if (a.pose === "roam") wander(a);
      else goDesk(a);
    } else if (a.state === "seated" && a.pose === "roam" && a.until && s.clock > a.until) {
      a.until = 0;
      if (!reduced()) wander(a);
    }
    // turn smoothly toward the heading
    let dy = a.yaw - o.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    o.rotation.y += dy * Math.min(1, dt * 10);
    applyLimbs(o, limbAngles(a.anim, reduced() ? 0 : s.clock, a.phase));
  }

  /* ── DM traffic: bubbles, visits, arcs ───────────────────────────────────────────────────── */

  function headOf(name) {
    if (name === YOU) return S.youChar ? S.youChar.obj.position.clone().setY(1.0) : null;
    const a = S.agents.get(name);
    return a ? a.obj.position.clone().setY(a.state === "seated" ? 0.95 : 1.15) : null;
  }

  function addArc(s, from, to, count) {
    const A = headOf(from), B = headOf(to);
    if (!A || !B) return;
    const mid = A.clone().add(B).multiplyScalar(0.5);
    mid.y += 1.2 + A.distanceTo(B) * 0.22;
    const curve = new THREE.QuadraticBezierCurve3(A, mid, B);
    const r = 0.018 + Math.min(count ?? 1, 20) * 0.0025;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, r, 6, false), new THREE.MeshBasicMaterial({ color: "#f08a2e", transparent: true, opacity: 0.85, depthWrite: false }));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(r * 3.2, 12, 10), new THREE.MeshBasicMaterial({ color: "#ffd9b0", transparent: true }));
    s.scene.add(tube, dot);
    s.arcs.push({ tube, dot, curve, t0: performance.now(), dur: 4000 });
    if (s.arcs.length > 24) disposeArc(s, s.arcs.shift());
  }
  function disposeArc(s, arc) {
    s.scene.remove(arc.tube, arc.dot);
    arc.tube.geometry.dispose(); arc.tube.material.dispose();
    arc.dot.geometry.dispose(); arc.dot.material.dispose();
  }
  function stepArcs(s, now) {
    s.arcs = s.arcs.filter((arc) => {
      const k = (now - arc.t0) / arc.dur;
      if (k >= 1) { disposeArc(s, arc); return false; }
      arc.tube.material.opacity = 0.85 * (1 - Math.max(0, k - 0.5) * 2);
      arc.dot.material.opacity = 1 - k;
      arc.dot.position.copy(arc.curve.getPoint(((now - arc.t0) / 1300) % 1));
      return true;
    });
  }

  function say(name, text, ms = 6000) {
    const who = name === YOU ? S?.youChar : S?.agents.get(name);
    if (!who || !text) return;
    who.label.bubble.textContent = clip(text, 70);
    who.label.bubble.classList.remove("in");
    void who.label.bubble.offsetWidth;
    who.label.bubble.classList.add("in");
    who.bubbleUntil = performance.now() + ms;
  }

  function onVillageEvents(events, last) {
    const s = S;
    if (!s) return;
    for (const ev of events) {
      const { from, to } = senderOf(ev, last);
      const known = (n) => n === YOU || s.agents.has(n);
      if (!known(from) || !known(to)) continue;
      const line = last?.[from]?.text;
      const sender = s.agents.get(from);
      const visitable = sender && sender.pose === "roam" && sender.state === "seated" && to !== YOU && s.deskByName.has(to) && !reduced();
      if (visitable) {
        const d = s.deskByName.get(to);
        sender.dest = { x: d.exit.x, z: d.exit.z };
        walkTo(sender, { x: d.exit.x, z: d.exit.z, exit: d.exit }, (b) => {
          b.state = "stand"; b.anim = "wave";
          const t = headOf(to);
          if (t) b.yaw = Math.atan2(t.x - b.obj.position.x, t.z - b.obj.position.z);
          if (line) say(from, line);
          b.until = s.clock + 3.5;
          b.after = (c) => { c.dest = null; goDesk(c); };
        });
      } else {
        addArc(s, from, to, ev.count);
        if (line) say(from, line);
      }
    }
  }

  /** A ws `message` frame (you ↔ agent DM or a channel post): immediate bubble/arc, real text only. */
  function onMessage(entry) {
    if (!open || !S || !entry || typeof entry.text !== "string") return;
    const from = entry.dir === "out" ? YOU : entry.from;
    if (!from) return;
    say(from, entry.text);
    if (entry.channel) return;
    const to = entry.dir === "out" ? entry.to : YOU;
    if (to) addArc(S, from, to, 1);
  }

  let vTimer = 0, vBusy = false;
  async function pollVillage() {
    if (!open || vBusy || document.hidden) return;
    vBusy = true;
    try {
      const d = await loadVillage();
      data.villageErr = "";
      const events = diffEdges(data.prevVillage, d);
      data.prevVillage = d;
      data.village = d;
      if (events.length) onVillageEvents(events, d.last);
      renderRoster();
      renderNote();
    } catch (e) {
      // 501 = a server without the tracker: render without wires, but say so (never fake traffic)
      data.villageErr = /501|village tracker/.test(String(e.message)) ? "DM tracker off on this server — no traffic shown" : `village feed failed: ${e.message}`;
      renderNote();
    } finally {
      vBusy = false;
    }
  }
  function startVillagePoll() { stopVillagePoll(); void pollVillage(); vTimer = setInterval(() => void pollVillage(), VILLAGE_EVERY); }
  function stopVillagePoll() { clearInterval(vTimer); vTimer = 0; data.prevVillage = null; }

  /* ── DOM overlay: pills + bubbles ────────────────────────────────────────────────────────── */

  function makeLabel(name) {
    const layer = root.querySelector(".ofc-labels");
    const pill = document.createElement("div");
    pill.className = "ofc-pill";
    pill.dataset.name = name;
    const bubble = document.createElement("div");
    bubble.className = "ofc-bubble";
    layer.append(pill, bubble);
    return { pill, bubble, key: "" };
  }

  const tmpV = new THREE.Vector3();
  function placeLabels(s) {
    const items = [];
    const now = performance.now();
    const all = [...s.agents.values()];
    if (s.youChar) all.push(s.youChar);
    const q = s.filter;
    for (const a of all) {
      const isYou = a.name === YOU;
      const pose = isYou ? "you" : a.pose;
      const dot = isYou ? "you" : statusDot(a.pose);
      const detail = isYou ? "" : pillDetail(a.row, a.pose);
      const emoji = isYou ? "" : a.look.emoji;
      const key = `${dot}|${detail}|${emoji}|${s.selected === a.name}`;
      if (a.label.key !== key) {
        a.label.key = key;
        a.label.pill.innerHTML = `<i class="d ${dot}"></i>${emoji ? `<span class="em">${esc(emoji)}</span>` : ""}<b>${esc(a.name)}</b>${detail ? `<span class="dt">${esc(detail)}</span>` : ""}`;
        a.label.pill.classList.toggle("sel", s.selected === a.name);
        a.label.w = a.label.pill.offsetWidth || 80;
      }
      const matches = !q || a.name.toLowerCase().includes(q);
      tmpV.copy(a.obj.position);
      tmpV.y += (a.state === "seated" || isYou ? 1.0 : 1.2) * (isYou ? 1.08 : 1);
      tmpV.project(s.camera);
      const x = (tmpV.x * 0.5 + 0.5) * s.size.w, y = (-tmpV.y * 0.5 + 0.5) * s.size.h;
      const onScreen = tmpV.z < 1 && x > -50 && x < s.size.w + 50 && y > -20 && y < s.size.h + 20;
      a._sx = x; a._sy = y;
      if (!onScreen || !matches) { a.label.pill.style.display = "none"; a.label.bubble.style.display = "none"; continue; }
      const w = a.label.w ?? 80;
      items.push({ id: a.name, x: x - w / 2, y: y - 22, w, h: 20, priority: isYou ? 2 : labelPriority({ selected: s.selected === a.name, pose }), depth: tmpV.z, a });
      const bubbleOn = a.bubbleUntil > now;
      a.label.bubble.style.display = bubbleOn ? "" : "none";
      if (bubbleOn) a.label.bubble.style.transform = `translate(${x}px, ${y - 28}px) translate(-50%, -100%)`;
    }
    const kept = cullLabels(items);
    for (const it of items) {
      const show = kept.has(it.id);
      it.a.label.pill.style.display = show ? "" : "none";
      if (show) it.a.label.pill.style.transform = `translate(${it.x}px, ${it.y}px)`;
    }
    // dim characters that don't match the roster search
    for (const a of s.agents.values()) {
      const dim = !!q && !a.name.toLowerCase().includes(q);
      if (a.dim !== dim) { a.dim = dim; setDim(a.obj, dim); }
    }
  }

  const dimCache = new Map();
  function setDim(obj, dim) {
    obj.traverse((o) => {
      if (!o.isMesh || o === obj.userData.hit) return;
      if (dim) {
        o.userData.mat0 ??= o.material;
        let m = dimCache.get(o.userData.mat0);
        if (!m) { m = o.userData.mat0.clone(); m.transparent = true; m.opacity = 0.22; dimCache.set(o.userData.mat0, m); }
        o.material = m;
        o.castShadow = false;
      } else if (o.userData.mat0) {
        o.material = o.userData.mat0;
        o.castShadow = true;
      }
    });
  }

  /* ── roster, card, tooltip, note ─────────────────────────────────────────────────────────── */

  function lastFor(name) {
    const v = data.village?.last?.[name];
    const m = [...data.messages].reverse().find((x) => x.from === name && x.dir !== "out");
    if (v && (!m || v.ts >= m.ts)) return { text: v.text, ts: v.ts };
    if (m) return { text: m.text, ts: m.ts };
    return null;
  }

  function renderRoster() {
    const list = root.querySelector(".ofc-list");
    if (!list || !S) return;
    const q = S.filter;
    const rows = data.rows.filter((r) => r.name && (r.live || r.mesh !== "offline"));
    const scored = rows.map((r) => ({ r, last: lastFor(r.name) })).sort((a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0) || a.r.name.localeCompare(b.r.name));
    const shown = scored.filter(({ r }) => !q || r.name.toLowerCase().includes(q));
    if (!rows.length) {
      list.innerHTML = `<div class="ofc-empty">${data.rows.length ? "every agent is offline — their desks are dark" : "no agents in this space yet"}</div>`;
      list.dataset.html = "";
      return;
    }
    const html = shown.map(({ r, last }) => {
      const pose = poseFor(r);
      const preview = last ? esc(last.text.replace(/\s+/g, " ").slice(0, 160)) : `<span class="mut">${esc(pillDetail(r, pose) || "idle")}</span>`;
      return `<div class="ofc-row${S.selected === r.name ? " sel" : ""}" data-name="${esc(r.name)}">
        <div class="av" style="background:${avatarColor(r.name)}">${avatarGlyph(r.name)}<i class="d ${statusDot(pose)}"></i></div>
        <div class="tx"><div class="hd"><b>${esc(r.name)}</b><span>${last ? relTime(last.ts) : ""}</span></div><div class="pv">${preview}</div></div>
      </div>`;
    }).join("") || `<div class="ofc-empty">no agent matches “${esc(q)}”</div>`;
    if (html !== list.dataset.html) { list.innerHTML = html; list.dataset.html = html; } // a 2s re-render must not eat a double-click
  }

  function select(name) {
    if (!S) return;
    S.selected = name;
    renderRoster();
    if (!name) { root.querySelector(".ofc-card").hidden = true; return; }
    renderCard(name);
    frameAgent(S, name);
    const l = lastFor(name);
    if (l) say(name, l.text);
  }

  function renderCard(name) {
    const card = root.querySelector(".ofc-card");
    if (!card) return;
    if (name === YOU) { card.hidden = true; return; }
    const r = data.rows.find((x) => x.name === name);
    if (!r) { card.hidden = true; return; }
    const pose = poseFor(r);
    const l = lastFor(name);
    const branch = r.git?.branch ? ` · ${r.git.worktree ? "⑂ " : ""}${r.git.branch}` : "";
    card.innerHTML = `<div class="hd"><i class="d ${statusDot(pose)}"></i><b>${esc(name)}</b><span>${esc(branch)}</span><button class="x" title="close">✕</button></div>
      <div class="st">${esc(pillDetail(r, pose) || (pose === "roam" ? "idle" : pose))}${r.folder ? ` · <span class="mut">${esc(r.folder.replace(/^\/Users\/[^/]+/, "~"))}</span>` : ""}</div>
      ${l ? `<div class="msg">${esc(l.text.slice(0, 400))}</div><div class="mut">${relTime(l.ts) === "now" ? "just now" : relTime(l.ts) + " ago"}</div>` : `<div class="mut">no messages seen yet</div>`}
      <button class="go">Open chat →</button>`;
    card.hidden = false;
    card.querySelector(".go").addEventListener("click", () => onFocusAgent(name));
    card.querySelector(".x").addEventListener("click", () => select(null));
  }

  function showTip(name, x, y) {
    const tip = root.querySelector(".ofc-tip");
    if (!name) { tip.hidden = true; return; }
    const r = data.rows.find((v) => v.name === name);
    const l = lastFor(name);
    const branch = r?.git?.branch ? ` · ${r.git.branch}` : "";
    const st = r ? pillDetail(r, poseFor(r)) || "idle" : name === YOU ? "the operator" : "";
    tip.innerHTML = `<div class="vh"><b>${esc(name)}${esc(branch)}</b><span>${l ? relTime(l.ts) : ""}</span></div><div class="vst">${esc(st)}</div><div class="vmsg">${l ? esc(l.text.slice(0, 220)) : '<span class="vmuted">no messages seen yet</span>'}</div>${name !== YOU ? '<div class="vft">click to focus · double-click to open the chat</div>' : ""}`;
    tip.hidden = false;
    const hr = root.getBoundingClientRect();
    tip.style.left = Math.min(x - hr.left + 14, hr.width - 300) + "px";
    tip.style.top = Math.min(y - hr.top + 14, hr.height - 140) + "px";
  }

  function renderNote() {
    const n = root.querySelector(".ofc-note");
    if (!n) return;
    n.hidden = !data.villageErr;
    n.textContent = data.villageErr;
    n.classList.toggle("bad", data.villageErr.startsWith("village feed failed"));
  }

  /* ── input ───────────────────────────────────────────────────────────────────────────────── */

  function pick(clientX, clientY) {
    const s = S;
    const r = s.renderer.domElement.getBoundingClientRect();
    s.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), s.camera);
    const hits = [...s.agents.values()].filter((a) => !a.dim).map((a) => a.obj.userData.hit);
    if (s.youChar) hits.push(s.youChar.obj.userData.hit);
    const h = s.raycaster.intersectObjects(hits, false)[0];
    return h ? h.object.userData.agent : null;
  }

  function wireUi() {
    const s = S;
    const cv = s.renderer.domElement;
    let drag = null;
    cv.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, floor: floorAt(s, e.clientX, e.clientY) };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      if (drag) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) drag.moved = true;
        if (drag.moved && drag.floor) {
          const now = floorAt(s, e.clientX, e.clientY);
          if (now) { s.cam.target.add(drag.floor.clone().sub(now)); s.camAnim = null; s.cam.user = true; placeCamera(s); }
        }
        showTip(null);
        return;
      }
      const name = pick(e.clientX, e.clientY);
      cv.style.cursor = name ? "pointer" : "grab";
      showTip(name, e.clientX, e.clientY);
    });
    cv.addEventListener("pointerup", (e) => {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.moved) { saveCam(); return; }
      const name = pick(e.clientX, e.clientY);
      if (name) select(name);
    });
    cv.addEventListener("pointerleave", () => showTip(null));
    cv.addEventListener("dblclick", (e) => {
      const name = pick(e.clientX, e.clientY);
      if (name && name !== YOU) onFocusAgent(name);
    });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const k = e.ctrlKey ? 0.01 : 0.0015;
      zoomBy(s, Math.exp(e.deltaY * k), e.clientX, e.clientY);
    }, { passive: false });

    root.querySelector(".ofc-ctrls").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "in") zoomBy(s, 1 / 1.3);
      else if (act === "out") zoomBy(s, 1.3);
      else if (act === "fit") { s.cam.user = false; animateCam(s, fitView(s, s.cam.az), 500); }
      else if (act === "rotate") {
        const az = s.cam.az + 90;
        const to = s.cam.user ? { target: s.cam.target.clone(), h: s.cam.h, az } : fitView(s, az);
        animateCam(s, to, 400);
      } else if (act === "theme") {
        s.theme = s.theme === "night" ? "day" : "night";
        try { localStorage.setItem("office.theme", s.theme); } catch { /* not remembered */ }
        applyTheme(s);
      }
    });
    root.querySelector(".ofc-link").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(`${location.origin}/?at=office`);
        btn.textContent = "copied";
      } catch (err) {
        btn.textContent = `copy failed: ${err.message}`;
      }
      setTimeout(() => { btn.textContent = "copy link"; }, 1600);
    });
    const input = root.querySelector(".ofc-search input");
    input.addEventListener("input", () => { s.filter = input.value.trim().toLowerCase(); renderRoster(); });
    const list = root.querySelector(".ofc-list");
    list.addEventListener("click", (e) => { const row = e.target.closest(".ofc-row"); if (row) select(row.dataset.name); });
    list.addEventListener("dblclick", (e) => { const row = e.target.closest(".ofc-row"); if (row) onFocusAgent(row.dataset.name); });
  }

  return { open: show, close, isOpen: () => open, update, onMessage };
}

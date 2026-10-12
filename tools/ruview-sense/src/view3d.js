// view3d.js — radar / sonar display (Three.js, vendored) on a dark theme.
//
// Instead of solid voxel blocks the room is rendered as a dense field of tiny
// white points (a holographic dot matrix). The router's emitted waves are
// analysed as radar returns: a rotating sweep and expanding pings cross the
// field, the measured RF shadow lights points, and every tracked moving body is
// a pulsing RED ring target. Refreshes every 200 ms from the live SSE/JSON.

import * as THREE from "/vendor/three.module.min.js";

const canvas = document.getElementById("room-canvas");
if (!canvas) {
  const s = document.createElement("div");
  s.textContent = "3D indisponível: canvas não encontrado";
  document.body.appendChild(s);
  throw new Error("no #room-canvas");
}

// --- scene ---
const scene = new THREE.Scene();
const BG = 0x07090b;
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 16, 40);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 140);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

scene.add(new THREE.HemisphereLight(0xcfe8cf, 0x0a0d0b, 0.75));
const key = new THREE.DirectionalLight(0xffffff, 1.0);
key.position.set(6, 9, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x66aa77, 0.25);
fill.position.set(-5, 3, -6);
scene.add(fill);

// ground (faint)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 7),
  new THREE.MeshStandardMaterial({ color: 0x0a0d0b, roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// --- camera orbit (hand-rolled) ---
const target = new THREE.Vector3(4, 0.8, 2);
const orbit = { yaw: 0.95, pitch: 0.5, dist: 12.5 };
function updateCamera() {
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    target.x + orbit.dist * cp * Math.sin(orbit.yaw),
    target.y + orbit.dist * Math.sin(orbit.pitch),
    target.z + orbit.dist * cp * Math.cos(orbit.yaw)
  );
  camera.lookAt(target);
}
updateCamera();
renderer.setAnimationLoop(renderFrame);

// --- model state ---
let room = { nodes: [], obstacles: [] };
let rfMap = { cells: [] };
let placeMode = null;
let mapMode = false;
let lastPlaced = null;
let lastSense = null;
const clock = new THREE.Clock();
let nodePos = new THREE.Vector3(4, 1.2, 2);

function $get(api) {
  return fetch(api).then((r) => (r.ok ? r.json() : null));
}
const hintEl = document.getElementById("place-hint");
function hint(msg) {
  if (hintEl) {
    hintEl.textContent = msg ?? "";
    setTimeout(() => hintEl && (hintEl.textContent = ""), 2600);
  }
}

// --- dense white point field (the "scenario") ---
const FIELD = { x0: -0.5, x1: 8.5, nx: 46, y0: 0.06, y1: 2.3, ny: 9, z0: -0.5, z1: 4.5, nz: 26 };
let field = null;
function buildField() {
  const count = FIELD.nx * FIELD.ny * FIELD.nz;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let i = 0;
  for (let ix = 0; ix < FIELD.nx; ix++) {
    for (let iy = 0; iy < FIELD.ny; iy++) {
      for (let iz = 0; iz < FIELD.nz; iz++) {
        const x = FIELD.x0 + ((FIELD.x1 - FIELD.x0) * ix) / (FIELD.nx - 1);
        const y = FIELD.y0 + ((FIELD.y1 - FIELD.y0) * iy) / (FIELD.ny - 1);
        const z = FIELD.z0 + ((FIELD.z1 - FIELD.z0) * iz) / (FIELD.nz - 1);
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        // dim white base, brighter near the floor so it reads as a scope
        const b = 0.22 + 0.5 * (1 - iy / FIELD.ny);
        col[i * 3] = b;
        col[i * 3 + 1] = b;
        col[i * 3 + 2] = b;
        i += 1;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.045,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  field = new THREE.Points(geo, mat);
  field.userData.baseColors = col.slice();
  scene.add(field);
}
buildField();

// --- measured RF shadow points (white -> red by dip), replaces voxel blocks ---
let mapPoints = null;
let mapSig = "";
function rebuildMapPoints() {
  const keep = rfMap.cells.filter((c) => c && c.dip > 0.15);
  const sig = `${keep.length}|${keep.reduce((s, c) => s + Math.round(c.dip * 10), 0)}`;
  if (sig === mapSig) return;
  mapSig = sig;
  if (mapPoints) {
    scene.remove(mapPoints);
    mapPoints.geometry.dispose();
    mapPoints.material.dispose();
    mapPoints = null;
  }
  if (!keep.length) return;
  const pos = new Float32Array(keep.length * 3);
  const col = new Float32Array(keep.length * 3);
  const cold = new THREE.Color(0xbfd8c2);
  const hot = new THREE.Color(0xff3038);
  keep.forEach((c, i) => {
    const h = 0.15 + 2.0 * Math.min(1, c.dip / 3);
    pos[i * 3] = c.x;
    pos[i * 3 + 1] = h;
    pos[i * 3 + 2] = c.z;
    const t = Math.min(1, c.dip / 3);
    const cc = cold.clone().lerp(hot, t);
    col[i * 3] = cc.r;
    col[i * 3 + 1] = cc.g;
    col[i * 3 + 2] = cc.b;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.16,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  mapPoints = new THREE.Points(geo, mat);
  scene.add(mapPoints);
}

// --- editable floor plan (kept as subtle wireframe, not solid data blocks) ---
const obstacleMat = new THREE.MeshStandardMaterial({
  color: 0x0e1712,
  roughness: 0.9,
  metalness: 0.1,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
});
let obstacleGroup = null;
function rebuildObstacles() {
  if (obstacleGroup) {
    scene.remove(obstacleGroup);
    obstacleGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
  obstacleGroup = new THREE.Group();
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3a6b3f, transparent: true, opacity: 0.55 });
  for (const o of room.obstacles) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), obstacleMat);
    mesh.position.set(o.x, o.y, o.z);
    obstacleGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMat);
    edges.position.copy(mesh.position);
    obstacleGroup.add(edges);
  }
  scene.add(obstacleGroup);
}

// --- WiFi node core ---
const nodeGroup = new THREE.Group();
scene.add(nodeGroup);
const coreMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.28, 1),
  new THREE.MeshStandardMaterial({ color: 0x07090b, emissive: 0x3dff6e, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.4 })
);
nodeGroup.add(coreMesh);
const nodeLight = new THREE.PointLight(0x3dff6e, 2, 7, 2);
nodeGroup.add(nodeLight);
function makeHalo() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(3.6, 3.6, 1);
  return sp;
}
const halo = makeHalo();
nodeGroup.add(halo);

// --- radar overlay: range rings + rotating sweep + expanding sonar ping ---
const radarGroup = new THREE.Group();
scene.add(radarGroup);
const RING_RADII = [1, 2, 3, 4, 5];
for (const r of RING_RADII) {
  const pts = [];
  for (let a = 0; a <= 64; a++) {
    const th = (a / 64) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.sin(th) * r, 0.05, Math.cos(th) * r));
  }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  radarGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x1f3a24, transparent: true, opacity: 0.8 })));
}
const SWEEP_LEN = 5.2;
const sweep = new THREE.Group();
for (let i = 0; i < 28; i++) {
  const a = -i * 0.028;
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.06, 0),
    new THREE.Vector3(Math.sin(a) * SWEEP_LEN, 0.06, Math.cos(a) * SWEEP_LEN),
  ]);
  sweep.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3dff6e, transparent: true, opacity: 0.45 * (1 - i / 28) })));
}
radarGroup.add(sweep);
const ping = new THREE.Mesh(
  new THREE.RingGeometry(0.94, 1, 72),
  new THREE.MeshBasicMaterial({ color: 0x3dff6e, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
);
ping.rotation.x = -Math.PI / 2;
radarGroup.add(ping);

// --- moving targets: pulsing RED rings on the scope ---
const targetGroup = new THREE.Group();
scene.add(targetGroup);
const targetPool = new Map();
function makeTargetRing() {
  const g = new THREE.Group();
  const flat = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 40),
    new THREE.MeshBasicMaterial({ color: 0xff3038, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
  );
  flat.rotation.x = -Math.PI / 2;
  g.add(flat);
  const beamMat = new THREE.LineBasicMaterial({ color: 0xff3038, transparent: true, opacity: 0.4 });
  const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), beamMat);
  g.add(beam);
  return { group: g, flat, beam, beamMat };
}
function updateTargets(humans) {
  const seen = new Set();
  const node = nodePos;
  for (const hu of humans) {
    seen.add(hu.id);
    let e = targetPool.get(hu.id);
    if (!e) {
      e = makeTargetRing();
      targetGroup.add(e.group);
      targetPool.set(hu.id, e);
    }
    // Bearing proxy: transverse position mapped over a frontal sector; range
    // from the radar's RSSI estimate. Both are honest proxies, not measurements.
    const range = clamp(lastSense && lastSense.radar && lastSense.radar.rangeM ? lastSense.radar.rangeM : 2.4, 0.8, 5.2);
    const bearing = (clamp(hu.pos, 0, 1) - 0.5) * 2.3;
    const x = node.x + Math.sin(bearing) * range;
    const z = node.z - Math.cos(bearing) * range;
    e.group.position.set(x, 0.12, z);
    const moving = hu.state === "moving";
    e.flat.material.color.setHex(hu.stale ? 0x6d7f6d : moving ? 0xff3038 : 0xff8a5a);
    e.beamMat.color.setHex(moving ? 0xff3038 : 0xff8a5a);
    e.beamMat.opacity = 0.15 + 0.5 * (hu.confidence ?? 0.5);
    // beam from the node to the target
    const bp = e.beam.geometry.attributes.position;
    bp.setXYZ(0, node.x, 0.1, node.z);
    bp.setXYZ(1, x, 0.1, z);
    bp.needsUpdate = true;
    e.moving = moving;
    e.conf = hu.confidence ?? 0.5;
  }
  for (const [id, e] of targetPool) {
    if (!seen.has(id)) {
      targetGroup.remove(e.group);
      e.flat.geometry.dispose();
      e.flat.material.dispose();
      targetPool.delete(id);
    }
  }
}

// --- live refresh every 200 ms ---
function applySense(s) {
  lastSense = s;
  window.__lastSense = s;
  const active = !!s.present || !!s.motion || !!s.humanDetected;
  const raw = Number(s.rawDelta ?? 0);
  const high = s.sensitivity === "high";
  const color = active ? 0xff3333 : 0x3dff6e;
  coreMesh.material.emissive.setHex(color);
  coreMesh.material.emissiveIntensity = active ? 1.6 : 0.9;
  nodeLight.color.setHex(color);
  nodeLight.intensity = active ? (high ? 5 : 3.2) : 1.6;
  halo.material.color.setHex(color);
  pulse.active = active;
  pulse.raw = raw;
  pulse.high = !!high;
  updateTargets(Array.isArray(s.humans) ? s.humans : []);
}
const pulse = { active: false, raw: 0, high: false };

async function refresh() {
  const [sense, map] = await Promise.all([$get("/api/v1/sense"), $get("/api/v1/map")]);
  if (sense) applySense(sense);
  if (map) {
    const cells = Array.isArray(map.cells) ? map.cells : [];
    if (cells.length !== rfMap.cells.length || cells.length === 0) {
      rfMap.cells = cells;
      rebuildMapPoints();
    }
    const st = document.getElementById("room-status");
    if (st) st.textContent = map.active ? "varredura RF ativa — clique no chão" : "";
  }
}
refresh();
setInterval(refresh, 200);

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function renderFrame() {
  const t = clock.getElapsedTime();
  const p = pulse;
  const speed = p.high ? 3.2 : 1.6;
  sweep.rotation.y = t * speed;
  // sonar ping: one expanding ring every 2.4 s
  const cyc = (t % 2.4) / 2.4;
  ping.scale.setScalar(0.15 + cyc * 5.4);
  ping.material.opacity = 0.5 * (1 - cyc);
  // field pulse: brightness breathes with live RF energy
  if (field) {
    const e = p.active ? 0.9 + Math.min(1, p.raw * 120) : 0.8;
    field.material.opacity = 0.55 + 0.35 * Math.min(1, e);
    field.rotation.y = Math.sin(t * 0.05) * 0.004;
  }
  halo.scale.setScalar(2.6 + 0.5 * Math.abs(Math.sin(t * speed)));
  coreMesh.rotation.y = t * 0.6;
  for (const e of targetPool.values()) {
    const s = e.moving ? 1 + 0.28 * Math.abs(Math.sin(t * 5)) : 1 + 0.1 * Math.abs(Math.sin(t * 2));
    e.group.scale.setScalar(s);
  }
  renderer.render(scene, camera);
}

function syncNode() {
  const node = room.nodes.find((n) => n.kind === "wifi") ?? { x: 4, y: 1.2, z: 2 };
  nodePos = new THREE.Vector3(node.x, node.y, node.z);
  nodeGroup.position.copy(nodePos);
  radarGroup.position.set(node.x, 0, node.z);
  target.set(node.x, Math.max(0.5, node.y - 0.55), node.z);
  updateCamera();
}
function rebuildAll() {
  rebuildObstacles();
  rebuildMapPoints();
  syncNode();
}

// --- input ---
const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
function groundFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(floorPlane, hit)) {
    hit.x = Math.min(9, Math.max(-1, hit.x));
    hit.z = Math.min(5, Math.max(-1, hit.z));
    return hit;
  }
  return null;
}

let drag = { on: false, btn: -1, lx: 0, ly: 0, moved: false };
canvas.addEventListener("pointerdown", (e) => {
  drag = { on: true, btn: e.button, lx: e.clientX, ly: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag.on) return;
  const dx = e.clientX - drag.lx;
  const dy = e.clientY - drag.ly;
  drag.lx = e.clientX;
  drag.ly = e.clientY;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  if (drag.btn === 2) {
    const k = orbit.dist * 0.0009;
    target.x -= dx * k;
    target.z -= dy * k;
  } else {
    orbit.yaw -= dx * 0.008;
    orbit.pitch = Math.min(1.45, Math.max(0.08, orbit.pitch + dy * 0.006));
  }
  updateCamera();
});
canvas.addEventListener("pointerup", async (e) => {
  if (!drag.on) return;
  const moved = drag.moved;
  drag.on = false;
  if (moved || (!placeMode && !mapMode)) return;
  const gp = groundFromEvent(e);
  if (!gp) return;
  if (mapMode) {
    const now = performance.now();
    if (now - (canvas.__lastSample ?? 0) < 400) return;
    canvas.__lastSample = now;
    await fetch("/api/v1/map/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: Math.round(gp.x * 10) / 10, z: Math.round(gp.z * 10) / 10 }),
    });
    const map = await $get("/api/v1/map");
    if (map) {
      rfMap.cells = Array.isArray(map.cells) ? map.cells : [];
      rebuildMapPoints();
    }
    hint("sombra registrada em " + gp.x.toFixed(1) + " × " + gp.z.toFixed(1));
    return;
  }
  const res = await fetch("/api/v1/room/obstacles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: placeMode, x: Math.round(gp.x * 10) / 10, z: Math.round(gp.z * 10) / 10 }),
  });
  room = await res.json();
  lastPlaced = room.obstacles?.[room.obstacles.length - 1]?.id ?? null;
  placeMode = null;
  rebuildObstacles();
  hint("planta atualizada");
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  orbit.dist = Math.min(40, Math.max(3, orbit.dist * (1 + e.deltaY * 0.001)));
  updateCamera();
});

function setPlace(kind) {
  placeMode = placeMode === kind ? null : kind;
  mapMode = false;
  hint(placeMode ? `modo ${kind}: clique no chão` : "");
}
async function toggleMap() {
  mapMode = !mapMode;
  placeMode = null;
  const btn = document.getElementById("btn-map");
  if (btn) btn.classList.toggle("active", mapMode);
  await fetch(`/api/v1/map?action=${mapMode ? "start" : "stop"}`, { method: "POST" });
  hint(mapMode ? "MAPEANDO: clique no chão onde você está" : "");
  const map = await $get("/api/v1/map");
  if (map) {
    rfMap.cells = Array.isArray(map.cells) ? map.cells : [];
    rebuildMapPoints();
  }
}

document.getElementById("btn-wall")?.addEventListener("click", () => setPlace("wall"));
document.getElementById("btn-box")?.addEventListener("click", () => setPlace("box"));
document.getElementById("btn-map")?.addEventListener("click", () => toggleMap().catch(() => {}));
document.getElementById("btn-map-demo")?.addEventListener("click", async () => {
  await fetch("/api/v1/map/demo", { method: "POST" });
  const map = await $get("/api/v1/map");
  if (map) {
    rfMap.cells = Array.isArray(map.cells) ? map.cells : [];
    rebuildMapPoints();
  }
  hint("demo simulada carregada");
});
document.getElementById("btn-remove")?.addEventListener("click", async () => {
  if (lastPlaced == null) return;
  await fetch(`/api/v1/room/obstacles/${lastPlaced}`, { method: "DELETE" });
  room = await $get("/api/v1/room");
  lastPlaced = null;
  rebuildObstacles();
});
document.getElementById("btn-reset")?.addEventListener("click", async () => {
  await fetch("/api/v1/room/reset", { method: "POST" });
  room = await $get("/api/v1/room");
  rebuildObstacles();
});
document.getElementById("btn-sensitivity")?.addEventListener("click", async () => {
  const cur = await $get("/api/v1/sensitivity");
  const next = cur && cur.sensitivity === "high" ? "normal" : "high";
  await fetch("/api/v1/sensitivity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: next }),
  });
  const btn = document.getElementById("btn-sensitivity");
  if (btn) btn.classList.toggle("active", next === "high");
});

// --- size ---
function resize() {
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 420;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
resize();
new ResizeObserver(resize).observe(canvas);

// --- boot ---
(async () => {
  room = (await $get("/api/v1/room")) ?? room;
  rebuildAll();
  const s = await $get("/api/v1/sensitivity");
  const btn = document.getElementById("btn-sensitivity");
  if (btn && s) btn.classList.toggle("active", s.sensitivity === "high");
})();

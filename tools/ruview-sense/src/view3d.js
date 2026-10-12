// view3d.js — WebGL 3D view (Three.js, vendored) on a dark theme.
// The RF shadow map renders as a dense instanced voxel volume (GPU-side), the
// WiFi node pulses from live sense data, and everything refreshes every 500 ms.

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
scene.fog = new THREE.Fog(BG, 14, 34);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120);
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

scene.add(new THREE.HemisphereLight(0xcfe8cf, 0x0a0d0b, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(6, 9, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x66aa77, 0.3);
fill.position.set(-5, 3, -6);
scene.add(fill);

// ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 7),
  new THREE.MeshStandardMaterial({ color: 0x0c100e, roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(10, 10, 0x2a4a2c, 0x172a1c);
grid.material.transparent = true;
grid.material.opacity = 0.85;
scene.add(grid);

// --- camera orbit (hand-rolled, no addon needed) ---
const target = new THREE.Vector3(4, 0.7, 2);
const orbit = { yaw: 0.95, pitch: 0.55, dist: 11.5 };
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
let volumeSig = "";
let lastSample = 0;

const clock = new THREE.Clock();

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

// --- WiFi node: core + glow ring + point light + soft halo sprite ---
const nodeGroup = new THREE.Group();
scene.add(nodeGroup);
const coreMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.3, 1),
  new THREE.MeshStandardMaterial({ color: 0x07090b, emissive: 0x3dff6e, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.4 })
);
nodeGroup.add(coreMesh);
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.45, 0.6, 48),
  new THREE.MeshBasicMaterial({ color: 0x3dff6e, transparent: true, depthWrite: false, side: THREE.DoubleSide })
);
nodeGroup.add(ring);
const nodeLight = new THREE.PointLight(0x3dff6e, 2, 6, 2);
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
  sp.scale.set(4.4, 4.4, 1);
  return sp;
}
const halo = makeHalo();
nodeGroup.add(halo);

// --- RF shadow volume: instanced boxes = tens of thousands of voxels, GPU-side ---
const voxelGeo = new THREE.BoxGeometry(0.22, 1, 0.22);
const voxMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0xff3038,
  emissiveIntensity: 0.55,
  roughness: 0.6,
});
let voxels = null;
const mat4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3(1, 1, 1);
const RED = new THREE.Color(0x7d3a3a);
const HOT = new THREE.Color(0xff3038);

function rebuildVolume() {
  const keep = rfMap.cells.filter((c) => c && c.dip > 0.15 && c.n >= 1);
  const sig = `${keep.length}|${keep.reduce((s, c) => s + Math.round(c.dip * 10), 0)}`;
  if (sig === volumeSig) return;
  volumeSig = sig;
  if (voxels) scene.remove(voxels);
  if (!keep.length) {
    voxels = null;
    return;
  }
  voxels = new THREE.InstancedMesh(voxelGeo, voxMat, keep.length);
  voxels.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  let i = 0;
  for (const c of keep) {
    const h = 0.08 + 1.25 * Math.min(1, c.dip / 3);
    pos.set(c.x, h / 2, c.z);
    scl.set(0.9 + Math.min(0.3, c.dip / 20), h, 0.9 + Math.min(0.3, c.dip / 20));
    mat4.compose(pos, quat, scl);
    voxels.setMatrixAt(i, mat4);
    voxels.setColorAt(i, HOT.clone().lerp(RED, 1 - Math.min(1, c.dip / 3)));
    i += 1;
  }
  voxels.instanceMatrix.needsUpdate = true;
  if (voxels.instanceColor) voxels.instanceColor.needsUpdate = true;
  scene.add(voxels);
}

// --- obstacles: shaded boxes + crisp edges (solid 3D, not flat squares) ---
const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x16201a, roughness: 0.8, metalness: 0.1 });
let obstacleGroup = null;
function rebuildObstacles() {
  if (obstacleGroup) {
    scene.remove(obstacleGroup);
    obstacleGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  obstacleGroup = new THREE.Group();
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3a6b3f, transparent: true, opacity: 0.7 });
  for (const o of room.obstacles) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), obstacleMat);
    mesh.position.set(o.x, o.y, o.z);
    mesh.castShadow = false;
    obstacleGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMat);
    edges.position.copy(mesh.position);
    obstacleGroup.add(edges);
  }
  syncNode();
  scene.add(obstacleGroup);
}

function syncNode() {
  const node = room.nodes.find((n) => n.kind === "wifi") ?? { x: 4, y: 1.2, z: 2 };
  nodeGroup.position.set(node.x, node.y, node.z);
  target.set(node.x, Math.max(0.5, node.y - 0.55), node.z);
  updateCamera();
}
function rebuildAll() {
  rebuildObstacles();
  rebuildVolume();
}

// --- live refresh every 500 ms ---
function applySense(s) {
  lastSense = s;
  window.__lastSense = s;
  const active = !!s.present || !!s.motion;
  const raw = Number(s.rawDelta ?? 0);
  const high = s.sensitivity === "high";
  const color = active ? 0xff3333 : 0x3dff6e;
  coreMesh.material.color.setHex(0x07090b);
  coreMesh.material.emissive.setHex(color);
  coreMesh.material.emissiveIntensity = active ? 1.6 : 0.9;
  ring.material.color.setHex(color);
  nodeLight.color.setHex(color);
  nodeLight.intensity = active ? (high ? 5 : 3.2) : 1.6;
  halo.material.color.setHex(color);
  pulse.active = active;
  pulse.raw = raw;
  pulse.high = !!high;
  pulse.mult = active ? (high ? 1.5 : 1.15) : 0.8;
}
// keep pulse params on a module-level object
const pulse = { active: false, raw: 0, high: false, mult: 0.8 };

async function refresh() {
  const [sense, map] = await Promise.all([$get("/api/v1/sense"), $get("/api/v1/map")]);
  if (sense) applySense(sense);
  if (map) {
    const cells = Array.isArray(map.cells) ? map.cells : [];
    if (cells.length !== rfMap.cells.length || cells.length === 0) {
      rfMap.cells = cells;
      rebuildVolume();
    }
    const st = document.getElementById("room-status");
    if (st) st.textContent = map.active ? "varredura RF ativa — clique no chão" : "";
  }
}
refresh();
setInterval(refresh, 500);

function renderFrame() {
  const t = clock.getElapsedTime();
  const p = pulse;
  const speed = p.high ? 9 + p.raw * 240 : 2.5 + p.raw * 120;
  const ripple = 0.6 + 0.5 * Math.abs(Math.sin(t * speed));
  const rs = (p.active ? 1.6 : 1) * (1 + ripple);
  ring.scale.set(rs, rs, 1);
  ring.material.opacity = 0.28 + 0.3 * ripple;
  halo.scale.set((p.high ? 1.7 : 1.3) * (2.6 + ripple), (p.high ? 1.7 : 1.3) * (2.6 + ripple), 1);
  coreMesh.rotation.y = t * 0.6;
  if (voxels) voxels.rotation.y = Math.sin(t * 0.12) * 0.01; // near zero, GPU friendly
  renderer.render(scene, camera);
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
    if (now - lastSample < 400) return;
    lastSample = now;
    await fetch("/api/v1/map/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: Math.round(gp.x * 10) / 10, z: Math.round(gp.z * 10) / 10 }),
    });
    const map = await $get("/api/v1/map");
    if (map) {
      rfMap.cells = Array.isArray(map.cells) ? map.cells : [];
      rebuildVolume();
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
  orbit.dist = Math.min(38, Math.max(3, orbit.dist * (1 + e.deltaY * 0.001)));
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
    rebuildVolume();
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
    rebuildVolume();
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
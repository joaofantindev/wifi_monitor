// view3d.js — dependency-free software 3D view of the WiFi node, the editable
// floor plan, and the real RF shadow map measured while the user sweeps the
// room. Loaded as an ES module by monitor.html. Theme: black/white/red.

const canvas = document.getElementById("room-canvas");
if (!canvas) throw new Error("no #room-canvas");

const ctx = canvas.getContext("2d");
const W = (canvas.width = canvas.clientWidth || 640);
const H = (canvas.height = canvas.clientHeight || 420);

const cam = {
  target: { x: 4, y: 0.6, z: 2 },
  dist: 11.5,
  yaw: 0.95,
  pitch: 0.55,
  fov: 55,
};

const RED = "#d00000";
const INK = "#111111";
const PAPER = "#f5f5f5";
const GRAY = "#555555";

let room = { nodes: [], obstacles: [] };
let rf = { active: false, cells: [] };
let placeMode = null; // null | 'wall' | 'box'
let mapMode = false;
let lastPlaced = null;

const api = {
  async getRoom() {
    room = await (await fetch("/api/v1/room")).json();
  },
  async getMap() {
    rf = await (await fetch("/api/v1/map")).json();
  },
  async addObstacle(kind, x, z) {
    const res = await fetch("/api/v1/room/obstacles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }),
    });
    room = await res.json();
    lastPlaced = room.obstacles?.[room.obstacles.length - 1]?.id ?? null;
  },
  async removeLast() {
    if (lastPlaced == null) return;
    await fetch(`/api/v1/room/obstacles/${lastPlaced}`, { method: "DELETE" });
    lastPlaced = null;
    await api.getRoom();
  },
  async reset() {
    await fetch("/api/v1/room/reset", { method: "POST" });
    await api.getRoom();
  },
  async mapSample(x, z) {
    await fetch("/api/v1/map/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }),
    });
    await api.getMap();
  },
};

// --- camera math ---
const EPS = 1e-6;
function basis() {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const toEye = {
    x: cp * Math.sin(cam.yaw),
    y: sp,
    z: cp * Math.cos(cam.yaw),
  };
  const eye = {
    x: cam.target.x + cam.dist * toEye.x,
    y: cam.target.y + cam.dist * toEye.y,
    z: cam.target.z + cam.dist * toEye.z,
  };
  const f = { x: -toEye.x, y: -toEye.y, z: -toEye.z };
  const r = normalize(cross(f, { x: 0, y: 1, z: 0 }));
  const u = cross(r, f);
  return { eye, f, r, u };
}

function normalize(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function project(pt, camB) {
  const vx = pt.x - camB.eye.x;
  const vy = pt.y - camB.eye.y;
  const vz = pt.z - camB.eye.z;
  const cz = vx * camB.f.x + vy * camB.f.y + vz * camB.f.z;
  if (cz < 0.3) return null;
  const cx = vx * camB.r.x + vy * camB.r.y + vz * camB.r.z;
  const cy = vx * camB.u.x + vy * camB.u.y + vz * camB.u.z;
  const f = (H / 2) / Math.tan((cam.fov * Math.PI) / 360);
  return { x: W / 2 + (f * cx) / cz, y: H / 2 - (f * cy) / cz, cz, f };
}

function groundPoint(sx, sy, camB) {
  const f = (H / 2) / Math.tan((cam.fov * Math.PI) / 360);
  const kx = (sx - W / 2) / f;
  const ky = (H / 2 - sy) / f;
  const dir = {
    x: camB.r.x * kx + camB.u.x * ky + camB.f.x,
    y: camB.r.y * kx + camB.u.y * ky + camB.f.y,
    z: camB.r.z * kx + camB.u.z * ky + camB.f.z,
  };
  if (Math.abs(dir.y) < EPS) return null;
  const t = -camB.eye.y / dir.y;
  if (t < 0) return null;
  return {
    x: Math.min(9, Math.max(-1, camB.eye.x + t * dir.x)),
    z: Math.min(5, Math.max(-1, camB.eye.z + t * dir.z)),
  };
}

// --- painting ---
const FACES = [
  { n: { x: 1, y: 0, z: 0 }, make: (x, y, z, w, h, d) => corners(x + w / 2, y, z, w, h, d) },
  { n: { x: -1, y: 0, z: 0 }, make: (x, y, z, w, h, d) => corners(x - w / 2, y, z, w, h, d) },
  { n: { x: 0, y: 1, z: 0 }, make: (x, y, z, w, h, d) => corners(x, y + h / 2, z, w, h, d) },
  { n: { x: 0, y: -1, z: 0 }, make: (x, y, z, w, h, d) => corners(x, y - h / 2, z, w, h, d) },
  { n: { x: 0, y: 0, z: 1 }, make: (x, y, z, w, h, d) => corners(x, y, z + d / 2, w, h, d) },
  { n: { x: 0, y: 0, z: -1 }, make: (x, y, z, w, h, d) => corners(x, y, z - d / 2, w, h, d) },
];

function corners(cx, cy, cz, w, h, d) {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  return [
    { x: cx - hx, y: cy - hy, z: cz - hz },
    { x: cx + hx, y: cy - hy, z: cz - hz },
    { x: cx + hx, y: cy + hy, z: cz - hz },
    { x: cx - hx, y: cy + hy, z: cz - hz },
  ];
}

function draw() {
  const camB = basis();
  ctx.clearRect(0, 0, W, H);

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, PAPER);
  bg.addColorStop(1, "#eaeaea");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // floor grid
  const lines = [];
  for (let x = -1; x <= 9; x++) lines.push({ a: { x, y: 0, z: 5 }, b: { x, y: 0, z: -1 } });
  for (let z = -1; z <= 5; z++) lines.push({ a: { x: 9, y: 0, z }, b: { x: -1, y: 0, z } });
  const proj = lines
    .map((l) => {
      const pa = project(l.a, camB);
      const pb = project(l.b, camB);
      if (!pa || !pb) return null;
      return { ...l, pa, pb, d: (pa.cz + pb.cz) / 2 };
    })
    .filter(Boolean)
    .sort((a, b) => b.d - a.d);
  for (const l of proj) {
    const major = l.a.x === 0 || l.a.z === 0 || l.a.x === 8 || l.a.z === 4 || l.a.x === 4 || l.a.z === 2;
    ctx.strokeStyle = major ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.16)";
    ctx.lineWidth = major ? 1 : 0.7;
    ctx.beginPath();
    ctx.moveTo(l.pa.x, l.pa.y);
    ctx.lineTo(l.pb.x, l.pb.y);
    ctx.stroke();
  }

  // RF shadow volume: one red column per measured cell, height = attenuation.
  const columns = [];
  for (const c of rf.cells) {
    if (!c || !(c.dip > 0.15) || c.n < 1) continue;
    const h = 0.08 + 1.25 * Math.min(1, c.dip / 3);
    columns.push({ x: c.x, z: c.z, h, dip: c.dip });
  }

  // paint obstacles + shadow columns together (painter's algorithm)
  const faces = [];
  for (const o of room.obstacles) {
    for (const fc of FACES) {
      const pts = fc.make(o.x, o.y, o.z, o.w, o.h, o.d);
      pushFace(
        faces,
        pts,
        fc.n,
        camB,
        o.kind === "wall" ? ["rgba(0,0,0,0.05)", "rgba(0,0,0,0.55)"] : ["rgba(0,0,0,0.12)", "rgba(0,0,0,0.45)"]
      );
    }
  }
  for (const c of columns) {
    const dipK = Math.min(1, c.dip / 3);
    const fill = `rgba(208,0,0,${0.16 + 0.28 * dipK})`;
    const edge = `rgba(208,0,0,${0.35 + 0.5 * dipK})`;
    for (const fc of FACES) {
      const pts = fc.make(c.x, c.h / 2, c.z, 0.25, c.h, 0.25);
      pushFace(faces, pts, fc.n, camB, [fill, edge]);
    }
  }
  faces.sort((a, b) => b.d - a.d);
  for (const fa of faces) {
    ctx.fillStyle = fa.fill;
    ctx.strokeStyle = fa.edge;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    fa.pr.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  drawLabels(camB);
  drawWifiNode(camB);
  drawLegend();
}

function pushFace(faces, pts, n, camB, colors) {
  const cx = (pts[0].x + pts[2].x) / 2;
  const cy = (pts[0].y + pts[2].y) / 2;
  const cz = (pts[0].z + pts[2].z) / 2;
  const toEye = { x: camB.eye.x - cx, y: camB.eye.y - cy, z: camB.eye.z - cz };
  if (toEye.x * n.x + toEye.y * n.y + toEye.z * n.z <= 0) return;
  const pr = pts.map((p) => project(p, camB)).filter(Boolean);
  if (pr.length < 3) return;
  const mid = project({ x: cx, y: cy, z: cz }, camB);
  if (!mid) return;
  faces.push({ pr, mid, d: mid.cz, fill: colors[0], edge: colors[1] });
}

function drawLabels(camB) {
  ctx.font = "10px system-ui";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.textAlign = "center";
  for (const o of room.obstacles) {
    const p = project({ x: o.x, y: o.y + o.h / 2 + 0.15, z: o.z }, camB);
    if (p) ctx.fillText(o.label, p.x, p.y);
  }
}

function drawWifiNode(camB) {
  const sense = window.__lastSense ?? {};
  const t = performance.now() / 1000;
  const node = room.nodes.find((n) => n.kind === "wifi") ?? { x: 4, y: 1.2, z: 2, label: "PONTO WIFI" };
  const p0 = project(node, camB);
  if (!p0) return;

  const active = !!sense.present || !!sense.motion;
  const raw = Number(sense.rawDelta ?? 0);
  const high = sense.sensitivity === "high";
  const color = active ? RED : INK;

  const baseR = (p0.f * 0.42) / Math.max(p0.cz, 0.3);
  const speed = high ? 9 + raw * 240 : 2.5 + raw * 120;
  const ripple = 0.55 + 0.8 * Math.abs(Math.sin(t * speed));
  const rippleR = baseR * (1.5 + 1.8 * ripple) * (high ? 1.5 : 1) * (active ? 1.15 : 0.8);

  const glow = ctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, rippleR);
  glow.addColorStop(0, color + "55");
  glow.addColorStop(1, color + "00");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(p0.x, p0.y, rippleR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p0.x, p0.y, baseR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = active ? "rgba(208,0,0,0.5)" : "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.arc(p0.x, p0.y, baseR * 1.4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = "bold 12px system-ui";
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.fillText(node.label ?? "PONTO WIFI", p0.x, p0.y - baseR - 12);
  if (high) {
    ctx.font = "10px system-ui";
    ctx.fillStyle = RED;
    ctx.fillText("SENSIBILIDADE EXTREMA — qualquer variação de RF conta", p0.x, p0.y - baseR - 26);
  }
}

function drawLegend() {
  ctx.font = "10px system-ui";
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.textAlign = "left";
  let line = "🖱 arrastar: orbitar · scroll: zoom · botão direito: mover";
  if (mapMode) line = "MAPEANDO: clique no chão onde você está para registrar a sombra RF";
  if (placeMode) line = `colocar ${placeMode}: clique no chão`;
  ctx.fillText(line, 10, H - 10);
  const mapping = window.__lastSense?.mapping;
  ctx.fillText("volumes vermelhos = sombras RF medidas (atenução vs. linha de base)", 10, H - 24);
  ctx.fillStyle = RED;
  ctx.fillText(mapping ? "MAPA RF ATIVO (varredura)" : "mapa RF: parado", 10, H - 38);
}

// --- input ---
let dragging = { on: false, button: -1, lastX: 0, lastY: 0, moved: false };
let lastSample = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = { on: true, button: e.button, lastX: e.clientX, lastY: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging.on) return;
  const dx = e.clientX - dragging.lastX;
  const dy = e.clientY - dragging.lastY;
  dragging.lastX = e.clientX;
  dragging.lastY = e.clientY;
  if (Math.abs(dx) + Math.abs(dy) > 2) dragging.moved = true;
  if (dragging.button === 2) {
    cam.target.x -= (dx / H) * cam.dist * 2;
    cam.target.z -= (dy / H) * cam.dist * 2;
  } else {
    cam.yaw -= dx * 0.008;
    cam.pitch = Math.min(1.45, Math.max(0.08, cam.pitch + dy * 0.006));
  }
});
canvas.addEventListener("pointerup", async (e) => {
  if (!dragging.on) return;
  const wasMove = dragging.moved;
  dragging.on = false;
  if (wasMove || (!placeMode && !mapMode)) return;
  const rect = canvas.getBoundingClientRect();
  const gp = groundPoint(e.clientX - rect.left, e.clientY - rect.top, basis());
  if (!gp) return;
  if (mapMode) {
    const now = performance.now();
    if (now - lastSample < 400) return; // debounce: keep station at each cell
    lastSample = now;
    await api.mapSample(gp.x, gp.z);
    hint("amostra registrada em " + gp.x + " × " + gp.z);
    return;
  }
  await api.addObstacle(placeMode, gp.x, gp.z);
  placeMode = null;
  hint("planta atualizada");
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  cam.dist = Math.min(40, Math.max(3, cam.dist * (1 + e.deltaY * 0.001)));
});

const hintEl = document.getElementById("place-hint");
function hint(msg) {
  if (hintEl) {
    hintEl.textContent = msg ?? "";
    setTimeout(() => hintEl && (hintEl.textContent = ""), 2500);
  }
}

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
  if (mapMode) {
    await fetch("/api/v1/map/start", { method: "POST" });
    hint("MAPEANDO: clique no chão onde você está");
  } else {
    await fetch("/api/v1/map/stop", { method: "POST" });
  }
  await api.getMap();
}

document.getElementById("btn-wall")?.addEventListener("click", () => setPlace("wall"));
document.getElementById("btn-box")?.addEventListener("click", () => setPlace("box"));
document.getElementById("btn-map")?.addEventListener("click", () => toggleMap().catch(() => {}));
document
  .getElementById("btn-map-demo")
  ?.addEventListener("click", async () => {
    await fetch("/api/v1/map/demo", { method: "POST" });
    await api.getMap();
    hint("demo simulada carregada no mapa RF");
  });
document.getElementById("btn-remove")?.addEventListener("click", () => api.removeLast().catch(() => {}));
document.getElementById("btn-reset")?.addEventListener("click", () => api.reset().catch(() => {}));
document
  .getElementById("btn-sensitivity")
  ?.addEventListener("click", async () => {
    const cur = await (await fetch("/api/v1/sensitivity")).json();
    const next = cur.sensitivity === "high" ? "normal" : "high";
    await fetch("/api/v1/sensitivity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    const btn = document.getElementById("btn-sensitivity");
    btn.textContent = next === "high" ? "Sensibilidade: EXTREMA" : "Sensibilidade: normal";
    btn.classList.toggle("active", next === "high");
  });

// --- loop ---
async function boot() {
  await Promise.all([api.getRoom(), api.getMap()].map((p) => p.catch(() => {})));
  const res = await fetch("/api/v1/sensitivity").catch(() => null);
  if (res) {
    const s = await res.json();
    const btn = document.getElementById("btn-sensitivity");
    siBtn(btn, s.sensitivity === "high");
  }
}
function siBtn(btn, active) {
  if (!btn) return;
  btn.textContent = active ? "Sensibilidade: EXTREMA" : "Sensibilidade: normal";
  btn.classList.toggle("active", active);
}
boot();

function frame() {
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
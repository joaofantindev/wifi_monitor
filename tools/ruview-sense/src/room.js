// Room model for the 3D view: the WiFi node(s) and the obstacles around them.
//
// Honest scope: a single CSI node cannot triangulate where obstacles are;
// the model below is the *editable floor plan* you visualize, not a magic
// reconstruction. Multi-node triangulation is RuVector/fusion territory.

export function defaultRoom() {
  return {
    nodes: [
      {
        id: "ap1",
        kind: "wifi",
        label: "PONTO WIFI",
        x: 4.0,
        y: 1.2,
        z: 2.0,
      },
    ],
    obstacles: [
      // 4 walls, 8 x 4 m room, 2.6 m tall.
      { id: 1, kind: "wall", label: "parede norte", x: 4.0, y: 1.3, z: 0.0, w: 8.0, h: 2.6, d: 0.2 },
      { id: 2, kind: "wall", label: "parede sul", x: 4.0, y: 1.3, z: 4.0, w: 8.0, h: 2.6, d: 0.2 },
      { id: 3, kind: "wall", label: "parede oeste", x: 0.0, y: 1.3, z: 2.0, w: 0.2, h: 2.6, d: 4.0 },
      { id: 4, kind: "wall", label: "parede leste", x: 8.0, y: 1.3, z: 2.0, w: 0.2, h: 2.6, d: 4.0 },
      { id: 5, kind: "box", label: "sofá", x: 2.5, y: 0.4, z: 2.9, w: 2.0, h: 0.8, d: 0.9 },
      { id: 6, kind: "box", label: "mesa", x: 6.4, y: 0.45, z: 1.0, w: 1.4, h: 0.9, d: 0.7 },
    ],
  };
}

export function addObstacle(room, input) {
  if (!room || !Array.isArray(room.obstacles)) {
    throw new TypeError("room.invalid");
  }
  const kind = input.kind === "wall" ? "wall" : "box";
  const numX = Number(input.x);
  const numZ = Number(input.z);
  if (!Number.isFinite(numX) || !Number.isFinite(numZ)) {
    throw new RangeError("x/z.number.required");
  }
  const next = { ...input, id: input.id ?? room.obstacles.length + 1 };
  const obstacle = {
    id: next.id,
    kind,
    label: String(next.label ?? (kind === "wall" ? "parede" : "objeto")),
    x: round1(numX),
    y: Number.isFinite(Number(next.y)) ? Number(next.y) : kind === "wall" ? 1.3 : 0.4,
    z: round1(numZ),
    w: clampDim(Number(next.w), kind === "wall" ? 2.0 : 1.0),
    h: clampDim(Number(next.h), kind === "wall" ? 2.6 : 0.8),
    d: clampDim(Number(next.d), kind === "wall" ? 0.2 : 0.8),
  };
  room.obstacles.push(obstacle);
  return obstacle;
}

export function removeObstacle(room, id) {
  if (!room || !Array.isArray(room.obstacles)) return false;
  const n = room.obstacles.length;
  room.obstacles = room.obstacles.filter((o) => o.id !== Number(id));
  return room.obstacles.length !== n;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function clampDim(x, fallback) {
  const v = Number(x);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return round1(Math.min(v, 20));
}
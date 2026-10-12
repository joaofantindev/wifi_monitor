// Minimal monitor server: UDP intake, sensing pipeline, HTTP + SSE.
// Dependency-free on purpose (matches the repo's Node harness style).

import dgram from "node:dgram";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parsePacket } from "./parse.js";
import { SensePipeline } from "./pipeline.js";
import { RssiPoller } from "./rssi.js";
import { defaultRoom, addObstacle, removeObstacle } from "./room.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR = join(HERE, "monitor.html");

const MODULE_DEFAULTS = Object.freeze({
  presence: true,
  motion: true,
  count: true,
  vitals: true,
  envChange: true,
});

// Detection modules shown as toggles in the dashboard. Disabled ones are
// zeroed out of the published state (the pipeline still computes them, but
// the monitor/3D stop reporting them).
function applyModules(raw, active) {
  const out = { ...raw, modules: { ...active } };
  if (!active.presence) {
    out.present = false;
    out.presenceScore = 0;
  }
  if (!active.motion) {
    out.motion = false;
    out.motionEnergy = 0;
  }
  if (!active.count) {
    out.persons = null;
    out.personsGrade = null;
  }
  if (!active.vitals) out.vitals = null;
  if (!active.envChange) out.environmentChanged = false;
  return out;
}

// RF shadow map constants: real measured attenuation of the WiFi signal across
// the room. One 802.11 node cannot triangulate obstacle positions, but while
// the user walks the room and clicks their position on the floor, each sample
// records how much the live signal dips vs. the idle baseline — furniture and
// bodies cast measurable RF shadows that render as a detailed 3D volume.
const MAP_STEP = 0.25;
const MAP_COLS = Math.round(8 / MAP_STEP);
const MAP_ROWS = Math.round(4 / MAP_STEP);

function round1(x) {
  return Math.round(x * 10) / 10;
}

export function startServer(opts = {}) {
  const source = opts.source ?? "auto";
  const udpPort = opts.udpPort ?? 5005;
  const httpPort = opts.httpPort ?? 8080;
  const host = opts.host ?? "127.0.0.1";
  const fallbackMs = opts.fallbackMs ?? 8000;
  const log = opts.log ?? false;

  const pipeline = new SensePipeline(opts.pipeline ?? {});
  let room = defaultRoom();

  // Per-server RF shadow map session (startServer is reusable in tests).
  const mapSession = {
    active: false,
    step: MAP_STEP,
    cols: MAP_COLS,
    rows: MAP_ROWS,
    rssiBaseline: null,
    cells: new Map(), // "cx,cz" -> { x, z, dip, n }
  };

  function mapSample(x, z) {
    const cx = Math.round(x / MAP_STEP);
    const cz = Math.round(z / MAP_STEP);
    if (cx < 0 || cx >= MAP_COLS || cz < 0 || cz >= MAP_ROWS) return null;
    const key = `${cx},${cz}`;
    const now = rawLast.rssiDbm;
    const rssiDip = Number.isFinite(now) ? Math.max(0, (mapSession.rssiBaseline ?? now) - now) : 0;
    const activity = Number.isFinite(rawLast.rawDelta) ? Math.min(3, rawLast.rawDelta * 40) : 0;
    const shadow = rssiDip + activity;
    const prev = mapSession.cells.get(key);
    const cell = prev
      ? { ...prev, dip: Math.max(prev.dip, shadow), n: prev.n + 1 }
      : { x: round1(cx * MAP_STEP), z: round1(cz * MAP_STEP), dip: round1(shadow * 2) / 2, n: 1 };
    mapSession.cells.set(key, cell);
    return cell;
  }

  function mapList() {
    return {
      active: mapSession.active,
      step: mapSession.step,
      cols: mapSession.cols,
      rows: mapSession.rows,
      rssiBaseline: mapSession.rssiBaseline,
      cells: [...mapSession.cells.values()],
    };
  }

  function seedDemoMap() {
    mapSession.active = true;
    mapSession.cells.clear();
    const put = (x, z, dip) => {
      const cx = Math.round(x / MAP_STEP);
      const cz = Math.round(z / MAP_STEP);
      mapSession.cells.set(`${cx},${cz}`, { x: round1(x), z: round1(z), dip, n: 8 });
    };
    for (let x = 1.5; x <= 3.6; x += 0.25) for (let z = 2.4; z <= 3.4; z += 0.25) put(x, z, 2.2 + ((x - 1.5) % 0.75) * 0.3);
    for (let x = 5.9; x <= 7.0; x += 0.25) for (let z = 0.6; z <= 1.4; z += 0.3) put(x, z, 1.7);
    for (let x = 0.25; x < 7.9; x += 0.25) put(x, 0.15, 2.8);
    mapSession.rssiBaseline = -54;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  function json(res, code, value) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
  const clients = new Set();
  let activeModules = { ...MODULE_DEFAULTS };
  let rawLast = {
    source,
    status: "starting",
    present: false,
    motion: false,
    messages: [],
  };
  let last = applyModules(rawLast, activeModules);
  let csiPackets = 0;
  let gotEsp32 = false;
  let activeSource = source;

  function note(message) {
    rawLast.messages = [message, ...rawLast.messages].slice(0, 40);
    last.messages = rawLast.messages;
    if (log) console.log(`[ruview-sense] ${message}`);
  }

  function publish(state) {
    rawLast = { ...rawLast, ...state, status: activeSource };
    if (mapSession.active && Number.isFinite(rawLast.rssiDbm) && rawLast.motion === false) {
      // Keep an idle RSSI baseline while a sweep map session is active.
      const b = mapSession.rssiBaseline;
      mapSession.rssiBaseline = b == null ? rawLast.rssiDbm : b * 0.95 + rawLast.rssiDbm * 0.05;
    }
    last = applyModules(rawLast, activeModules);
  }

  // --- UDP intake (ESP32 ADR-018) ---
  let udp = null;
  if (source === "auto" || source === "esp32") {
    udp = dgram.createSocket("udp4");
    udp.on("message", (buf) => {
      try {
        const frame = parsePacket(buf);
        if (frame.kind === "csi") {
          gotEsp32 = true;
          activeSource = "esp32";
          csiPackets += 1;
          publish(pipeline.ingestCsi(frame));
        } else if (frame.kind === "vitals") {
          gotEsp32 = true;
          activeSource = "esp32";
          const v = pipeline.ingestVitals(frame);
          note(`vitals packet: RR ${v.breathingBpm ?? "?"} HR ${v.heartBpm ?? "?"}`);
          publish({ vitals: v });
        }
      } catch (err) {
        note(`drop: ${err.code ?? err.message}`);
      }
    });
    udp.on("error", (err) => note(`udp error: ${err.message}`));
    udp.bind(udpPort, () => note(`listening for ESP32 CSI on udp/${udpPort}`));
  }

  // --- RSSI fallback ---
  let rssiPoller = null;
  const startRssi = () => {
    if (rssiPoller) return;
    activeSource = "rssi";
    rssiPoller = new RssiPoller((tracked, all) => {
      publish({ ...pipeline.ingestRssi(tracked), bssids: all.length });
    }).start();
    note("fallback: RSSI presence/motion (no CST available)");
  };

  if (source === "rssi") startRssi();
  if (source === "auto") {
    setTimeout(() => {
      if (!gotEsp32) startRssi();
    }, fallbackMs);
  }

  // --- Simulated source ---
  // A deterministic-ish occupant choreography so the monitor visibly flips
  // SIM/NÃO: 14 s "person present" (offset + walking bursts + breathing) then
  // 10 s empty room. Clearly labelled simulated.
  let simTimer = null;
  if (source === "simulated") {
    activeSource = "simulated";
    const nSc = 64;
    const period = 24;
    const base = new Float64Array(nSc);
    for (let k = 0; k < nSc; k++) base[k] = 8 + 3 * Math.sin(k / 5);
    let t = 0;
    let nextStep = 0;
    simTimer = setInterval(() => {
      t += 1 / 20;
      const cyc = t % period;
      const occupant = cyc < 14;
      const walking = (cyc > 4 && cyc < 6) || (cyc > 9 && cyc < 11);
      const amp = new Float64Array(nSc);
      for (let k = 0; k < nSc; k++) {
        let v = base[k] + (Math.random() - 0.5) * 0.6;
        if (occupant) {
          v += 5 + 2 * Math.sin(k / 4); // body offset + body shape
          v += 2.2 * Math.sin(2 * Math.PI * 0.26 * t); // breathing ~15.6 BPM
        }
        amp[k] = Math.max(0.001, v);
      }
      if (walking && t >= nextStep) {
        const start = Math.floor(Math.random() * (nSc - 16));
        const shift = (Math.random() - 0.5) * 7;
        for (let k = start; k < start + 16; k++) amp[k] = Math.max(0.001, amp[k] + shift);
        nextStep = t + 0.12;
      }
      const frame = { nodeId: 1, rssiDbm: -55, amplitude: amp };
      publish(pipeline.ingestCsi(frame));
    }, 50);
    note("simulated CSI source (no hardware)");
  }

  // --- HTTP + SSE ---
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, source: activeSource, frames: pipeline.frameCount }));
      return;
    }
    if (url.pathname === "/api/v1/room") {
      json(res, 200, room);
      return;
    }
    if (url.pathname === "/api/v1/room/obstacles" && req.method === "POST") {
      try {
        const body = await readBody(req);
        addObstacle(room, body);
        json(res, 201, room);
      } catch (err) {
        json(res, 400, { error: err instanceof RangeError ? err.message : "body.invalid-json" });
      }
      return;
    }
    if (url.pathname.startsWith("/api/v1/room/obstacles/") && req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const removed = removeObstacle(room, id);
      json(res, removed ? 200 : 404, removed ? room : { error: "not-found" });
      return;
    }
    if (url.pathname === "/api/v1/room/reset" && req.method === "POST") {
      room = defaultRoom();
      json(res, 200, room);
      return;
    }
    if (url.pathname === "/api/v1/sensitivity") {
      if (req.method === "POST") {
        try {
          const body = await readBody(req);
          pipeline.setSensitivity(body.mode === "high" ? "high" : "normal");
        } catch {
          /* keep current sensitivity on malformed JSON */
        }
      }
      json(res, 200, {
        sensitivity: pipeline.sensitivity,
        thresholds: {
          presence: pipeline.presenceThreshold,
          motion: pipeline.motionThreshold,
          environmentChange: pipeline.envChangeThreshold,
          activeSigma: pipeline.activeSigma,
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/modules") {
      if (req.method === "POST") {
        try {
          const body = await readBody(req);
          for (const k of Object.keys(MODULE_DEFAULTS)) {
            if (typeof body[k] === "boolean") activeModules[k] = body[k];
          }
        } catch {
          /* malformed JSON: keep current modules */
        }
        publish({});
      }
      json(res, 200, { ...last.modules });
      return;
    }
    if (url.pathname === "/api/v1/map") {
      const action = url.searchParams.get("action");
      if (req.method === "POST" && action === "start") {
        mapSession.active = true;
        mapSession.cells.clear();
        mapSession.rssiBaseline = null;
        note("RF shadow map: ande pela sala e clique, no chão, onde você estiver");
      } else if (req.method === "POST" && action === "stop") {
        mapSession.active = false;
        note("RF shadow map stopped");
      } else if (req.method === "POST" && action === "clear") {
        mapSession.cells.clear();
      }
      publish({ mapping: mapSession.active });
      json(res, 200, mapList());
      return;
    }
    if (url.pathname === "/api/v1/map/sample" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const cell = mapSample(Number(body.x), Number(body.z));
        publish({});
        json(res, cell ? 200 : 400, cell ?? { error: "out-of-room" });
      } catch {
        json(res, 400, { error: "body.invalid-json" });
      }
      return;
    }
    if (url.pathname === "/api/v1/map/demo" && req.method === "POST") {
      if (activeSource !== "simulated") {
        json(res, 403, { error: "demo-only-on-simulated" });
        return;
      }
      seedDemoMap();
      publish({ mapping: true });
      json(res, 200, mapList());
      return;
    }
    if (url.pathname === "/api/v1/sense") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(last));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      res.write(`data: ${JSON.stringify(last)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = await readFile(MONITOR);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("monitor.html missing");
      }
      return;
    }
    if (url.pathname === "/vendor/three.module.min.js") {
      try {
        const js = await readFile(join(HERE, "vendor", "three.module.min.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(js);
      } catch {
        res.writeHead(500);
        res.end("vendor missing");
      }
      return;
    }
    if (url.pathname === "/view3d.js") {
      try {
        const js = await readFile(join(HERE, "view3d.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(js);
      } catch {
        res.writeHead(500);
        res.end("view3d.js missing");
      }
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const broadcast = setInterval(() => {
    if (!clients.size) return;
    const payload = `data: ${JSON.stringify(last)}\n\n`;
    for (const c of clients) c.write(payload);
  }, 100);

  server.listen(httpPort, host, () => {
    note(`monitor: http://${host}:${httpPort}`);
  });

  function close() {
    if (udp) udp.close();
    if (rssiPoller) rssiPoller.stop();
    if (simTimer) clearInterval(simTimer);
    clearInterval(broadcast);
    server.close();
  }

  return {
    server,
    pipeline,
    close,
    getState: () => last,
    get csiPackets() {
      return csiPackets;
    },
  };
}

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

export function startServer(opts = {}) {
  const source = opts.source ?? "auto";
  const udpPort = opts.udpPort ?? 5005;
  const httpPort = opts.httpPort ?? 8080;
  const host = opts.host ?? "127.0.0.1";
  const fallbackMs = opts.fallbackMs ?? 8000;
  const log = opts.log ?? false;

  const pipeline = new SensePipeline(opts.pipeline ?? {});
  let room = defaultRoom();

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
  let last = {
    source,
    status: "starting",
    present: false,
    motion: false,
    messages: [],
  };
  let csiPackets = 0;
  let gotEsp32 = false;
  let activeSource = source;

  function note(message) {
    last.messages = [message, ...last.messages].slice(0, 40);
    if (log) console.log(`[ruview-sense] ${message}`);
  }

  function publish(state) {
    last = { ...last, ...state, status: activeSource };
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

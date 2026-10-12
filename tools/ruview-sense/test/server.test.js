import { test } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../src/server.js";

async function boot() {
  const app = startServer({ source: "simulated", httpPort: 0, log: false });
  const server = app.server;
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { app, base: `http://127.0.0.1:${port}` };
}

async function cleanup(app) {
  app.close();
  await new Promise((resolve) => app.server.close(resolve));
}

test("room endpoints: default, add, bad-input, delete, reset", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const room0 = await (await fetch(`${base}/api/v1/room`)).json();
  assert.equal(room0.nodes[0].kind, "wifi");
  assert.ok(room0.obstacles.length >= 6, `default obstacles=${room0.obstacles.length}`);

  const add = await (
    await fetch(`${base}/api/v1/room/obstacles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "box", x: 1.2, z: 3 }),
    })
  ).json();
  assert.equal(add.obstacles.length, room0.obstacles.length + 1);
  const last = add.obstacles[add.obstacles.length - 1];
  assert.equal(last.kind, "box");
  assert.equal(last.x, 1.2);

  const bad = await fetch(`${base}/api/v1/room/obstacles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "wall" }),
  });
  assert.equal(bad.status, 400);

  const del = await fetch(`${base}/api/v1/room/obstacles/${last.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const room1 = await (await fetch(`${base}/api/v1/room`)).json();
  assert.equal(room1.obstacles.length, room0.obstacles.length);

  const reset = await (
    await fetch(`${base}/api/v1/room/reset`, { method: "POST" })
  ).json();
  assert.deepEqual(reset.obstacles.map((o) => o.id), room0.obstacles.map((o) => o.id));
});

test("sensitivity toggle sharpens the thresholds", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const post = await (
    await fetch(`${base}/api/v1/sensitivity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "high" }),
    })
  ).json();
  assert.equal(post.sensitivity, "high");
  assert.equal(post.thresholds.motion, 0.0015);
  assert.equal(post.thresholds.environmentChange, 0.1);
  assert.equal(post.thresholds.activeSigma, 2);

  const cur = await (await fetch(`${base}/api/v1/sensitivity`)).json();
  assert.equal(cur.sensitivity, "high");

  await fetch(`${base}/api/v1/sensitivity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "normal" }),
  });
  const normal = await (await fetch(`${base}/api/v1/sensitivity`)).json();
  assert.equal(normal.thresholds.motion, 0.01);
});

test("view3d.js and vendored three.js are served", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const v3d = await fetch(`${base}/view3d.js`);
  assert.equal(v3d.status, 200);
  assert.match(v3d.headers.get("content-type"), /javascript/);
  assert.match(await v3d.text(), /room-canvas/);

  const three = await fetch(`${base}/vendor/three.module.min.js`);
  assert.equal(three.status, 200);
  const head = await three.text();
  assert.match(head, /WebGLRenderer/);
});

test("detection modules can be turned off per signal", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const def = await (await fetch(`${base}/api/v1/modules`)).json();
  assert.deepEqual(def, { presence: true, motion: true, count: true, vitals: true, envChange: true, size: true, track: true, radar: true });

  const off = await (
    await fetch(`${base}/api/v1/modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: false, envChange: false }),
    })
  ).json();
  assert.equal(off.count, false);
  assert.equal(off.presence, true);

  const sense = await (await fetch(`${base}/api/v1/sense`)).json();
  assert.equal(sense.persons, null);
  assert.equal(sense.environmentChanged, false);
  assert.equal(sense.modules.count, false);
  assert.equal(sense.modules.presence, true);
  // wait for a simulated frame to carry rawDelta through the modules gate
  const deadline = Date.now() + 1500;
  let withRaw = sense;
  while (!Number.isFinite(withRaw.rawDelta) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    withRaw = await (await fetch(`${base}/api/v1/sense`)).json();
  }
  assert.ok(Number.isFinite(withRaw.rawDelta), "rawDelta always reported");

  const on = await (
    await fetch(`${base}/api/v1/modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: true, envChange: true }),
    })
  ).json();
  assert.equal(on.count, true);
});

test("deformation endpoint and size module gating", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const info = await (await fetch(`${base}/api/v1/deformation`)).json();
  assert.equal(typeof info.humanDetected, "boolean");
  assert.ok(info.deformation === null || typeof info.deformation.sizeClass === "string");

  // Disabling the size module zeros the deformation out of the published state.
  const off = await (
    await fetch(`${base}/api/v1/modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: false }),
    })
  ).json();
  assert.equal(off.size, false);
  const senseOff = await (await fetch(`${base}/api/v1/sense`)).json();
  assert.equal(senseOff.deformation, null);
  assert.equal(senseOff.humanDetected, false);

  // Simulated source emits a body-sized deformation once calibrated.
  await fetch(`${base}/api/v1/modules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size: true }),
  });
  const deadline = Date.now() + 8000;
  let sense = await (await fetch(`${base}/api/v1/sense`)).json();
  while (!sense.humanDetected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    sense = await (await fetch(`${base}/api/v1/sense`)).json();
  }
  assert.equal(sense.humanDetected, true, "simulated body should register as human-sized");
  assert.equal(sense.deformation.sizeClass, "human");
});

test("humans endpoint reports moving candidates and honours the track module", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const info = await (await fetch(`${base}/api/v1/humans`)).json();
  assert.equal(info.grade, "track-heuristic");
  assert.ok(Array.isArray(info.humans));
  assert.equal(typeof info.moving, "number");

  // The simulated body walks, so at some point a human track appears.
  const deadline = Date.now() + 10000;
  let humans = info;
  while (humans.humans.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    humans = await (await fetch(`${base}/api/v1/humans`)).json();
  }
  assert.ok(humans.humans.length >= 1, "expected a tracked human candidate");
  assert.equal(humans.humans[0].grade, "track-heuristic");

  await fetch(`${base}/api/v1/modules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track: false }),
  });
  const sense = await (await fetch(`${base}/api/v1/sense`)).json();
  assert.deepEqual(sense.humans, []);
});

test("radar endpoint reports a delay profile and honours the radar module", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const info = await (await fetch(`${base}/api/v1/radar`)).json();
  assert.equal(info.grade, "delay-profile-measured");
  assert.ok(Array.isArray(info.humans));

  // Once calibrated the simulated CSI carries a delay profile.
  const deadline = Date.now() + 8000;
  let radar = info.radar;
  while (!radar && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    radar = (await (await fetch(`${base}/api/v1/radar`)).json()).radar;
  }
  assert.ok(radar, "radar should appear after calibration");
  assert.equal(radar.grade, "delay-profile-measured");
  assert.equal(radar.rangeGrade, "range-heuristic");
  assert.ok(radar.profile.length > 0 && radar.rangeM > 0);

  await fetch(`${base}/api/v1/modules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ radar: false }),
  });
  const sense = await (await fetch(`${base}/api/v1/sense`)).json();
  assert.equal(sense.radar, null);
});

test("RF shadow map: start/sample/get/demo/out-of-room", async (t) => {
  const { app, base } = await boot();
  t.after(() => cleanup(app));

  const started = await (
    await fetch(`${base}/api/v1/map?action=start`, { method: "POST" })
  ).json();
  assert.equal(started.active, true);
  assert.equal(started.cells.length, 0);

  const sample = await (
    await fetch(`${base}/api/v1/map/sample`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 2, z: 2.2 }),
    })
  ).json();
  assert.ok(sample.n >= 1, "sample registered a cell");
  assert.equal(typeof sample.dip, "number");
  assert.ok(Number.isFinite(sample.dip));

  const map = await (await fetch(`${base}/api/v1/map`)).json();
  assert.equal(map.active, true);
  assert.ok(map.cells.length >= 1);

  const out = await fetch(`${base}/api/v1/map/sample`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x: 99, z: 99 }),
  });
  assert.equal(out.status, 400);

  const demo = await (
    await fetch(`${base}/api/v1/map/demo`, { method: "POST" })
  ).json();
  assert.ok(demo.cells.length > 30, `simulated demo seeded ${demo.cells.length} cells`);

  const stopped = await (
    await fetch(`${base}/api/v1/map?action=stop`, { method: "POST" })
  ).json();
  assert.equal(stopped.active, false);
});
import { test } from "node:test";
import assert from "node:assert/strict";

import { SensePipeline } from "../src/pipeline.js";

const nSc = 64;
const base = Array.from({ length: nSc }, (_, k) => 8 + 3 * Math.sin(k / 5));

function frame(ampOffset, jitter = 0.4) {
  const amplifier = Float64Array.from(base, (b, k) => {
    const j = (Math.random() - 0.5) * jitter;
    let v = b + j;
    if (ampOffset) v += ampOffset(k);
    return Math.max(0.001, v);
  });
  return { nodeId: 1, rssiDbm: -55, amplitude: amplifier };
}

function feedQuiet(p, n = 100, jitter = 0.3) {
  for (let i = 0; i < n; i++) p.ingestCsi(frame(0, jitter));
}

test("silence + strong localized perturbation -> presence flips to true", () => {
  const p = new SensePipeline({ warmFrames: 30 });
  feedQuiet(p);
  const quiet = p.ingestCsi(frame(0));
  assert.equal(quiet.present, false);

  const moved = p.ingestCsi(frame(() => 12));
  assert.equal(moved.present, true, `presenceScore=${moved.presenceScore}`);
  assert.ok(moved.presenceScore > 0.5);
});

test("motion energy rises when a body physically moves between frames", () => {
  const p = new SensePipeline({ warmFrames: 30 });
  feedQuiet(p);
  const still = p.ingestCsi(frame(0));
  assert.equal(still.motion, false);

  // Big frame-to-frame shift across most subcarriers.
  const a = frame(() => 10);
  const b = frame(() => 10);
  for (let k = 0; k < nSc; k++) b.amplitude[k] = a.amplitude[k] + 6;
  const moving = p.ingestCsi(a);
  const moved = p.ingestCsi(b);
  assert.equal(moved.motion, true, `motionEnergy=${moved.motionEnergy}`);
  assert.ok(moved.motionEnergy > still.motionEnergy);
});

test("a persistent shift in the static signature flags environment change", () => {
  const p = new SensePipeline({ warmFrames: 40, envChangeThreshold: 0.3 });
  feedQuiet(p, 60);
  assert.equal(p.ingestCsi(frame(0)).environmentChanged, false);

  for (let i = 0; i < 30; i++) p.ingestCsi(frame(() => 9));
  assert.equal(p.ingestCsi(frame(() => 9)).environmentChanged, true);
});

test("slot-capacity heuristic reports a person only while a band is active", () => {
  const p = new SensePipeline({ warmFrames: 30 });
  feedQuiet(p);
  const calm = frame(0);
  p.ingestCsi(calm); // absorb the transition from the quiet feed
  assert.equal(p.ingestCsi(calm).persons, 0);
  assert.equal(p.ingestCsi(calm).persons, 0);

  // Persistent active band while "walking" one step per frame.
  let hot = frame(() => 11);
  for (let k = 16; k < 40; k++) hot.amplitude[k] += 8;
  let seen;
  for (let i = 0; i < 3; i++) seen = p.ingestCsi(hot);
  assert.ok(seen.persons >= 1, `persons=${seen.persons}`);
  assert.equal(seen.personsGrade, "slot-capacity-heuristic");
});

test("vitals packet is exposed as device-reported-unvalidated", () => {
  const p = new SensePipeline();
  const v = p.ingestVitals({
    flags: { presence: true, fall: false, motion: false },
    breathingBpm: 14.2,
    heartBpm: 71.0,
  });
  assert.equal(v.grade, "device-reported-unvalidated");
  assert.equal(v.breathingBpm, 14.2);
  const state = p.ingestCsi(frame(0));
  assert.equal(state.vitals.heartBpm, 71.0);
});

test("RSSI input yields coarse presence without count or vitals", () => {
  const p = new SensePipeline();
  const s1 = p.ingestRssi({ rssiDbm: -60 });
  assert.equal(s1.present, false);
  assert.equal(s1.persons, null);
  assert.equal(s1.vitals, null);
  assert.equal(s1.personsGrade, "unavailable-from-rssi");

  let spiky;
  for (let i = 0; i < 40; i++) {
    spiky = p.ingestRssi({ rssiDbm: i % 2 === 0 ? -60 : -70 });
  }
  assert.equal(spiky.motion, true, `motionEnergy=${spiky.motionEnergy}`);
});
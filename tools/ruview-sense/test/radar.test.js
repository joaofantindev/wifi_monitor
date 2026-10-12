import { test } from "node:test";
import assert from "node:assert/strict";

import { fftInPlace, delayProfile, estimateRangeM, RadarProcessor } from "../src/radar.js";

test("fft of a constant signal concentrates all energy at bin 0", () => {
  const n = 8;
  const re = new Float64Array(n).fill(1);
  const im = new Float64Array(n);
  fftInPlace(re, im);
  assert.ok(Math.hypot(re[0], im[0]) > 7.9, `bin0=${re[0]}`);
  for (let k = 1; k < n; k++) assert.ok(Math.hypot(re[k], im[k]) < 1e-9, `leak at ${k}`);
});

test("fft of a single impulse is flat", () => {
  const n = 8;
  const re = new Float64Array(n);
  re[0] = 1;
  const im = new Float64Array(n);
  fftInPlace(re, im);
  for (let k = 0; k < n; k++) assert.ok(Math.abs(Math.hypot(re[k], im[k]) - 1) < 1e-9);
});

test("delayProfile of a constant deviation peaks at bin 0", () => {
  const p = delayProfile(new Float64Array(64).fill(2), { profileBins: 16 });
  assert.equal(p.peakBin, 0);
  assert.equal(p.profile.length, 16);
  assert.ok(p.profile[0] > 0.9, `p0=${p.profile[0]}`);
  assert.ok(p.energy > 0);
});

test("delayProfile handles empty input", () => {
  const p = delayProfile(new Float64Array(0));
  assert.equal(p.bins, 0);
  assert.deepEqual(p.profile, []);
});

test("estimateRangeM shrinks as RSSI strengthens and stays bounded", () => {
  const far = estimateRangeM(-75);
  const near = estimateRangeM(-45);
  assert.ok(near < far, `${near} < ${far}`);
  assert.ok(near >= 0.5 && far <= 12, `${near}..${far}`);
  assert.equal(estimateRangeM(NaN), null);
});

test("RadarProcessor reports a resolution-limited delay profile and range", () => {
  const rp = new RadarProcessor();
  const dev = new Float64Array(64);
  for (let k = 0; k < 64; k++) dev[k] = 3 * Math.sin(k / 3);
  const out = rp.update({ dev, rssiDbm: -55, bandwidthMhz: 20 });
  assert.equal(out.grade, "delay-profile-measured");
  // 20 MHz -> c/(2*BW) = 7.5 m resolution (the honest limit).
  assert.ok(Math.abs(out.resolutionM - 7.49) < 0.05, `res=${out.resolutionM}`);
  assert.ok(out.rangeM > 0.5 && out.rangeM <= 12, `range=${out.rangeM}`);
  assert.equal(out.rangeGrade, "range-heuristic");
  assert.equal(out.bearingGrade, "bearing-proxy");
  assert.equal(out.profile.length, 16);
});

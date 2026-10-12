import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deformationMetrics,
  classifySize,
  fresnelRadius1,
  rangeResolutionCm,
  wavelengthM,
} from "../src/deform.js";

const nSc = 64;
const mu = Float64Array.from({ length: nSc }, (_, k) => 8 + 3 * Math.sin(k / 5));
const sd = Float64Array.from({ length: nSc }, () => 0.5);

function ampWith(ranges, delta = 12) {
  const a = Float64Array.from(mu);
  for (const [lo, hi] of ranges) for (let k = lo; k <= hi; k++) a[k] += delta;
  return a;
}

test("a wide coherent band classifies as human-sized", () => {
  const m = deformationMetrics({ amplitude: ampWith([[20, 46]]), mu, sd }, {});
  assert.equal(m.sizeClass, "human");
  assert.equal(m.humanSized, true);
  assert.ok(m.crossSectionCm >= 20 && m.crossSectionCm < 55, `cs=${m.crossSectionCm}`);
  assert.ok(m.spanSubcarriers >= 25, `span=${m.spanSubcarriers}`);
  assert.ok(m.depthDb > 3, `depth=${m.depthDb}`);
});

test("a narrow shallow perturbation is not human-sized", () => {
  const m = deformationMetrics({ amplitude: ampWith([[30, 31]], 3), mu, sd }, {});
  assert.notEqual(m.sizeClass, "human");
  assert.equal(m.humanSized, false);
  assert.ok(m.crossSectionCm < 20, `cs=${m.crossSectionCm}`);
});

test("silence yields size none with no cross-section", () => {
  const m = deformationMetrics({ amplitude: Float64Array.from(mu), mu, sd }, {});
  assert.equal(m.sizeClass, "none");
  assert.equal(m.crossSectionCm, 0);
  assert.equal(m.humanSized, false);
});

test("a full-band perturbation reads as large", () => {
  const m = deformationMetrics({ amplitude: ampWith([[0, nSc - 1]]), mu, sd }, {});
  assert.equal(m.sizeClass, "large");
  assert.ok(m.crossSectionCm >= 55, `cs=${m.crossSectionCm}`);
});

test("spanCenter is a monotonic proxy for the band position", () => {
  const left = deformationMetrics({ amplitude: ampWith([[4, 20]]), mu, sd }, {});
  const right = deformationMetrics({ amplitude: ampWith([[44, 60]]), mu, sd }, {});
  assert.ok(left.spanCenter < 0.3, `left=${left.spanCenter}`);
  assert.ok(right.spanCenter > 0.7, `right=${right.spanCenter}`);
  assert.ok(right.spanCenter > left.spanCenter);
});

test("fresnel radius and range resolution are physically sane", () => {
  // 2.4 GHz over 4 m -> ~35 cm first Fresnel radius.
  const r1 = fresnelRadius1(2437, 4);
  assert.ok(r1 > 0.3 && r1 < 0.4, `r1=${r1}`);
  assert.ok(wavelengthM(2437) > 0.12 && wavelengthM(2437) < 0.13);
  // 20 MHz CSI cannot resolve along-path size (resolution floor ~7.5 m).
  assert.ok(rangeResolutionCm(20) > 700, `range=${rangeResolutionCm(20)}`);
});

test("classifySize thresholds are monotonic and labelled", () => {
  assert.equal(classifySize(0), "none");
  assert.equal(classifySize(5), "tiny");
  assert.equal(classifySize(15), "small");
  assert.equal(classifySize(35), "human");
  assert.equal(classifySize(90), "large");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { HumanTracker } from "../src/tracker.js";

// Feed a body drifting from pos 0.2 -> 0.6 over one second (20 frames).
function drift(tracker, { from, to, frames, startT, evidence = true, motion = true }) {
  let out = [];
  for (let i = 0; i < frames; i++) {
    const pos = from + (to - from) * (i / (frames - 1));
    out = tracker.update({
      t: startT + i * 50,
      pos,
      humanSized: evidence,
      humanStable: evidence,
      motion,
      presence: true,
      crossSectionCm: 45,
      sizeClass: "human",
    });
  }
  return out;
}

test("a moving human-sized body produces one moving track", () => {
  const tr = new HumanTracker();
  const humans = drift(tr, { from: 0.2, to: 0.7, frames: 20, startT: 1000 });
  assert.equal(humans.length, 1, `humans=${humans.length}`);
  const h = humans[0];
  assert.equal(h.grade, "track-heuristic");
  assert.equal(h.state, "moving");
  assert.ok(h.confidence > 0.5, `conf=${h.confidence}`);
  assert.ok(h.pos > 0.2 && h.pos < 0.7, `pos=${h.pos}`);
  assert.equal(h.sizeClass, "human");
  assert.ok(h.sizeCm >= 40 && h.sizeCm <= 50, `sizeCm=${h.sizeCm}`);
});

test("a body that jumps beyond the association gate starts a new track", () => {
  const tr = new HumanTracker();
  let out = [];
  for (let i = 0; i < 10; i++) {
    out = tr.update({ t: 1000 + i * 50, pos: 0.1, humanSized: true, motion: false, presence: true });
  }
  assert.equal(out.length, 1);
  // Appears far to the right in a single step: too far to be the same track.
  out = tr.update({ t: 1600, pos: 0.9, humanSized: true, motion: true, presence: true });
  assert.ok(out.length >= 2, `expected a new track, got ${out.length}`);
  assert.ok(out.some((h) => h.pos > 0.7));
  assert.ok(out.some((h) => h.pos < 0.3));
});

test("non-human-sized activity does not create a human track", () => {
  const tr = new HumanTracker();
  let out = [];
  for (let i = 0; i < 20; i++) {
    out = tr.update({
      t: 1000 + i * 50,
      pos: 0.4 + i * 0.01,
      humanSized: false,
      humanStable: false,
      motion: true,
      presence: false,
    });
  }
  assert.equal(out.length, 0);
});

test("a stopped body ages out and is pruned", () => {
  const tr = new HumanTracker();
  drift(tr, { from: 0.3, to: 0.5, frames: 12, startT: 1000 });
  // then the room goes quiet for several seconds
  let out = [];
  for (let i = 0; i < 100; i++) out = tr.update({ t: 1600 + i * 50, pos: null, motion: false, presence: false });
  assert.equal(out.length, 0, `tracks should be pruned, got ${out.length}`);
});

test("confidence is bounded and reset starts clean", () => {
  const tr = new HumanTracker();
  const humans = drift(tr, { from: 0.2, to: 0.8, frames: 60, startT: 1000 });
  for (const h of humans) assert.ok(h.confidence >= 0 && h.confidence <= 1);
  tr.reset();
  assert.equal(tr.count, 0);
});

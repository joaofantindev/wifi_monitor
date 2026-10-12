// Moving-human tracker.
//
// A single CSI link cannot locate a person in 2D, but the *centroid of the
// active subcarrier band* is a monotonic proxy for the body's transverse
// position on the link (see deform.js `spanCenter`). As a body walks, that
// centroid slides, so we can associate successive detections into tracks and
// report "possible moving humans" with a confidence and a 1-D position.
//
// HONESTY: these are `track-heuristic` candidates, not identified people.
// Position is a unitless transverse proxy (direction is ambiguous), there is no
// range, and one link cannot separate two people at the same spot. Movement is
// inferred from position drift plus motion energy.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export const TRACK_DEFAULTS = Object.freeze({
  maxTracks: 6,
  maxJumpPerSec: 0.9, // gate: fraction of link a body may move per second
  minPosSeparation: 0.1,
  moveConfidence: 0.08, // gain per frame while moving + human-sized
  stillConfidence: 0.02, // gain per frame while present but still
  decayPerFrame: 0.03, // confidence lost per frame a track is not seen
  minConfidence: 0.15, // below this (after a grace) a track is dropped
  graceMissed: 2, // missed frames tolerated before the confidence cut applies
  pruneMs: 4000, // drop after this long unseen
  emaAlpha: 0.45,
  movingSpeed: 0.03, // |velocity| (link-fraction per second) counts as moving
  maxAgeSinceSeenMs: 1500, // stale tracks still shown, faded
});

function round(x, d) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

export class HumanTracker {
  constructor(opts = {}) {
    this.opts = { ...TRACK_DEFAULTS, ...opts };
    this.tracks = new Map();
    this.nextId = 1;
    this.lastT = null;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
    this.lastT = null;
  }

  // ev: { t, pos, humanSized, humanStable, motion, presence, crossSectionCm,
  //       sizeClass }
  update(ev = {}) {
    const o = this.opts;
    const t = Number.isFinite(ev.t) ? ev.t : Date.now();
    const dt = this.lastT == null ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;

    const pos = Number.isFinite(ev.pos) ? clamp(ev.pos, 0, 1) : null;
    const evidence = !!(ev.humanSized || ev.humanStable);
    const moving = !!ev.motion;
    const active = evidence || !!ev.presence;

    if (pos != null && active) {
      let best = null;
      let bestD = Infinity;
      for (const tr of this.tracks.values()) {
        const d = Math.abs(tr.pos - pos);
        const gate = Math.max(o.minPosSeparation, o.maxJumpPerSec * Math.max(dt, 0.05));
        if (d < bestD && d <= gate) {
          bestD = d;
          best = tr;
        }
      }
      const step = Math.max(dt, 0.05);
      if (!best) {
        best = {
          id: this.nextId++,
          pos,
          vel: 0,
          born: t,
          lastSeen: t,
          missed: 0,
          confidence: o.minConfidence + 0.05,
          evidence,
          moving: false,
          sizeCm: null,
          sizeClass: ev.sizeClass ?? "none",
        };
        this.tracks.set(best.id, best);
      } else {
        best.vel = best.vel * o.emaAlpha + ((pos - best.pos) / step) * (1 - o.emaAlpha);
        best.pos = best.pos * o.emaAlpha + pos * (1 - o.emaAlpha);
        best.lastSeen = t;
        best.missed = 0;
        best.evidence = evidence;
      }
      const gain = evidence ? (moving ? o.moveConfidence : o.stillConfidence) : o.stillConfidence * 0.5;
      best.confidence = clamp(best.confidence + gain, 0, 1);
      if (Number.isFinite(ev.crossSectionCm) && ev.crossSectionCm > 0) {
        best.sizeCm =
          best.sizeCm == null ? ev.crossSectionCm : best.sizeCm * o.emaAlpha + ev.crossSectionCm * (1 - o.emaAlpha);
      }
      if (ev.sizeClass) best.sizeClass = ev.sizeClass;
      best.moving = moving || Math.abs(best.vel) > o.movingSpeed;
    }

    for (const tr of this.tracks.values()) {
      if (tr.lastSeen !== t) {
        tr.missed += 1;
        tr.confidence = clamp(tr.confidence - o.decayPerFrame, 0, 1);
        tr.moving = false;
      }
    }

    for (const [id, tr] of this.tracks) {
      const stale = t - tr.lastSeen > o.pruneMs;
      const faded = tr.missed > o.graceMissed && tr.confidence < o.minConfidence;
      if (stale || faded) this.tracks.delete(id);
    }

    return this.list();
  }

  list() {
    const now = this.lastT ?? Date.now();
    const out = [...this.tracks.values()].map((tr) => ({
      id: tr.id,
      grade: "track-heuristic",
      pos: round(tr.pos, 3),
      vel: round(tr.vel, 3),
      confidence: round(tr.confidence, 2),
      state: tr.moving ? "moving" : "present",
      sizeCm: tr.sizeCm == null ? null : Math.round(tr.sizeCm),
      sizeClass: tr.sizeClass,
      trackedMs: Math.round(now - tr.born),
      seenMs: Math.round(now - tr.lastSeen),
      stale: now - tr.lastSeen > this.opts.maxAgeSinceSeenMs,
    }));
    out.sort((a, b) => b.confidence - a.confidence);
    return out.slice(0, this.opts.maxTracks);
  }

  get count() {
    return this.tracks.size;
  }
}

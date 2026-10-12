// Deformation-size estimator.
//
// The premise: a body in the WiFi field "deforms" the channel — it does not
// change every subcarrier equally. The *shape* of that deformation (how many
// adjacent subcarriers it touches, how deep it is, how coherent it is) carries
// the body's electrical size. This module turns the per-subcarrier deviation
// into a size estimate so presence can require a human-sized deformation
// instead of any deviation at all.
//
// Physics anchor: the first Fresnel zone of the link. A scatterer of transverse
// half-width `a` at the link midpoint blocks a fraction of the zone; the
// fraction of subcarriers knocked out of the baseline grows with the body's
// cross-section relative to the Fresnel radius
//     r1 = sqrt(lambda * D / 4)          (symmetric link, midpoint)
// so we invert it into an estimated cross-section
//     crossSection ≈ 2 * r1 * sqrt(spanFraction)
//
// HONESTY: this is a `estimated-heuristic` number. A 20 MHz CSI capture cannot
// resolve a body along the propagation path (the range resolution floor is
// c / (2 * BW) ≈ 7.5 m), so only the *transverse* size is estimated, and a
// moved object of similar size can read as "human-sized". It is a size class,
// never an identity, pose or a clinical measurement.

const EPS = 1e-9;
const C = 299792458; // m/s

export const DEFORM_DEFAULTS = Object.freeze({
  activeSigma: 3,
  minSpanFraction: 0.03, // below this the deformation is noise
  minDepthDb: 1.5, // below this the deformation is too shallow
  minCoherence: 0.2,
  tinySizeCm: 8, // < this: noise / hand / small object
  humanSizeCm: 20, // >= this: human-torso sized
  largeSizeCm: 55, // >= this: multiple people / large object
  freqMhz: 2437, // default 2.4 GHz channel
  linkLengthM: 4, // assumed node<->peer distance for the Fresnel model
  persistenceFrames: 3, // frames a human-sized deformation must persist
});

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x, d) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

export function wavelengthM(freqMhz = DEFORM_DEFAULTS.freqMhz) {
  const f = Number.isFinite(freqMhz) && freqMhz > 0 ? freqMhz : DEFORM_DEFAULTS.freqMhz;
  return C / (f * 1e6);
}

// First Fresnel zone radius (metres) at the midpoint of a link of length D.
export function fresnelRadius1(freqMhz, linkLengthM) {
  const lambda = wavelengthM(freqMhz);
  const D = Number.isFinite(linkLengthM) && linkLengthM > 0 ? linkLengthM : DEFORM_DEFAULTS.linkLengthM;
  return Math.sqrt((lambda * D) / 4);
}

// Range resolution floor (cm) for a bandwidth — the honest limit on any
// along-path size claim. 20 MHz -> ~750 cm, i.e. you cannot size a body in the
// range direction with commodity WiFi CSI.
export function rangeResolutionCm(bandwidthMhz) {
  const bw = Number.isFinite(bandwidthMhz) && bandwidthMhz > 0 ? bandwidthMhz : 20;
  return (C / (2 * bw * 1e6)) * 100;
}

// Classify an estimated cross-section (cm) into a size class.
export function classifySize(crossSectionCm, opts = {}) {
  const o = { ...DEFORM_DEFAULTS, ...opts };
  if (!Number.isFinite(crossSectionCm) || crossSectionCm <= 0) return "none";
  if (crossSectionCm >= o.largeSizeCm) return "large";
  if (crossSectionCm >= o.humanSizeCm) return "human";
  if (crossSectionCm >= o.tinySizeCm) return "small";
  return "tiny";
}

// Core, frame-local estimate. `mu`/`sd` are the frozen empty-room baseline and
// its per-subcarrier std; `amplitude` is the current frame.
export function deformationMetrics({ amplitude, mu, sd }, opts = {}) {
  const o = { ...DEFORM_DEFAULTS, ...opts };
  const n = amplitude ? amplitude.length : 0;
  if (!n || !mu || mu.length !== n) {
    return emptyMetrics(o);
  }

  const dev = new Float64Array(n);
  const z = new Float64Array(n);
  let activeCount = 0;
  let sumAmp = 0;
  for (let k = 0; k < n; k++) {
    const s = sd && sd[k] > EPS ? sd[k] : 1;
    dev[k] = amplitude[k] - mu[k];
    z[k] = Math.abs(dev[k]) / s;
    sumAmp += amplitude[k];
    if (z[k] > o.activeSigma) activeCount += 1;
  }

  // Largest contiguous active run = the deformation's frequency footprint.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let k = 0; k < n; k++) {
    if (z[k] > o.activeSigma) {
      if (curLen === 0) curStart = k;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curLen = 0;
    }
  }

  const spanFraction = bestLen / n;
  // Transverse position proxy: the centroid of the active band on the
  // subcarrier axis, normalized to 0..1. As a body crosses the link its
  // footprint slides along the subcarriers, so this centroid is a monotonic
  // proxy for where on the link the body is (direction is ambiguous).
  const spanCenterSc = bestLen > 0 ? bestStart + (bestLen - 1) / 2 : 0;
  const spanCenter = n > 1 ? clamp(spanCenterSc / (n - 1), 0, 1) : 0;

  // Depth: relative amplitude change across the active run (dB).
  let sumDev = 0;
  let sumMu = 0;
  for (let k = bestStart; k < bestStart + bestLen; k++) {
    sumDev += Math.abs(dev[k]);
    sumMu += Math.abs(mu[k]);
  }
  const meanDev = bestLen > 0 ? sumDev / bestLen : 0;
  const meanMu = bestLen > 0 ? sumMu / bestLen : 1;
  const depthDb = bestLen > 0 ? 20 * Math.log10((meanMu + meanDev + EPS) / (meanMu + EPS)) : 0;

  // Coherence: lag-1 autocorrelation of the signed deviation inside the run.
  // A body leaves a smooth (coherent) footprint; noise is spiky.
  let coherence = 1;
  if (bestLen >= 3) {
    let num = 0;
    let den = 0;
    for (let k = bestStart; k < bestStart + bestLen - 1; k++) {
      num += dev[k] * dev[k + 1];
      den += dev[k] * dev[k];
    }
    coherence = den > EPS ? clamp(num / den, 0, 1) : 0;
  } else if (bestLen > 0) {
    coherence = 0.5;
  } else {
    coherence = 0;
  }

  const r1 = fresnelRadius1(o.freqMhz, o.linkLengthM);
  const crossSectionCm = clamp(2 * r1 * Math.sqrt(Math.max(0, spanFraction)) * 100, 0, 200);

  const tooWeak = spanFraction < o.minSpanFraction || depthDb < o.minDepthDb;
  const sizeClass = tooWeak ? (activeCount > 0 ? "tiny" : "none") : classifySize(crossSectionCm, o);
  const humanSized = (sizeClass === "human" || sizeClass === "large") && coherence >= o.minCoherence;

  return {
    grade: "estimated-heuristic",
    sizeClass,
    humanSized,
    activeSubcarriers: activeCount,
    spanSubcarriers: bestLen,
    spanCenter: round(spanCenter, 4),
    spanCenterSc: round(spanCenterSc, 2),
    spanFraction: round(spanFraction, 4),
    spanMhz: round(bestLen * (o.bandwidthMhz > 0 ? o.bandwidthMhz / n : 0), 3),
    crossSectionCm: Math.round(crossSectionCm),
    coherence: round(coherence, 3),
    depthDb: round(depthDb, 2),
    meanAmp: round(sumAmp / n, 3),
    fresnelRadiusCm: Math.round(r1 * 100),
    rangeResolutionCm: Math.round(rangeResolutionCm(o.bandwidthMhz)),
    axis: "transverse",
    profile: buildProfile(z, o.activeSigma),
  };
}

function emptyMetrics(o) {
  return {
    grade: "estimated-heuristic",
    sizeClass: "none",
    humanSized: false,
    activeSubcarriers: 0,
    spanSubcarriers: 0,
    spanCenter: 0,
    spanCenterSc: 0,
    spanFraction: 0,
    spanMhz: 0,
    crossSectionCm: 0,
    coherence: 0,
    depthDb: 0,
    meanAmp: 0,
    fresnelRadiusCm: Math.round(fresnelRadius1(o.freqMhz, o.linkLengthM) * 100),
    rangeResolutionCm: Math.round(rangeResolutionCm(o.bandwidthMhz)),
    axis: "transverse",
    profile: [],
  };
}

// Compact, normalized per-subcarrier activation profile for the UI (<=64 bars).
function buildProfile(z, activeSigma) {
  const n = z.length;
  if (!n) return [];
  const bars = Math.min(64, n);
  const stride = n / bars;
  const out = [];
  const scale = Math.max(1, activeSigma * 3);
  for (let b = 0; b < bars; b++) {
    const lo = Math.floor(b * stride);
    const hi = Math.max(lo + 1, Math.floor((b + 1) * stride));
    let v = 0;
    for (let k = lo; k < hi && k < n; k++) v = Math.max(v, z[k]);
    out.push(round(clamp(v / scale, 0, 1), 2));
  }
  return out;
}

// Stateful wrapper: smooths the size over frames and requires a human-sized
// deformation to persist before flagging `humanStable` (false-positive guard).
export class DeformationEstimator {
  constructor(opts = {}) {
    this.opts = { ...DEFORM_DEFAULTS, ...opts };
    this.bandwidthMhz = opts.bandwidthMhz ?? 20;
    this.freqMhz = opts.freqMhz ?? DEFORM_DEFAULTS.freqMhz;
    this.humanRun = 0;
    this.last = null;
    this.peakSpanFraction = 0;
  }

  setSensitivity(mode) {
    this.opts.activeSigma = mode === "high" ? 2 : 3;
  }

  // amplitude/mu/sd: Float64Arrays; bandwidthMhz/freqMhz optional per frame.
  update({ amplitude, mu, sd, bandwidthMhz, freqMhz } = {}) {
    if (Number.isFinite(bandwidthMhz) && bandwidthMhz > 0) this.bandwidthMhz = bandwidthMhz;
    if (Number.isFinite(freqMhz) && freqMhz > 0) this.freqMhz = freqMhz;
    const raw = deformationMetrics(
      { amplitude, mu, sd },
      { ...this.opts, bandwidthMhz: this.bandwidthMhz, freqMhz: this.freqMhz }
    );
    if (raw.humanSized) this.humanRun += 1;
    else this.humanRun = 0;
    raw.persistence = this.humanRun;
    raw.humanStable = this.humanRun >= this.opts.persistenceFrames;
    this.last = raw;
    return raw;
  }

  get state() {
    return this.last;
  }
}

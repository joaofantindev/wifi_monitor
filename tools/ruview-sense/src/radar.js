// Radar / sonar processing of the CSI the router actually emits.
//
// OFDM CSI is a sampled frequency response of the channel. An inverse FFT over
// the subcarriers turns it into a *delay profile*: how much energy comes back at
// each path delay. Static clutter (walls, furniture) is cancelled by taking the
// IFFT of the deviation from the empty-room baseline, so what remains is the
// moving target indication (MTI) — the moving body's returns.
//
// Added to that, a coarse range comes from the RSSI path-loss model and the
// bearing from the 1-D link proxy. HONESTY: with 20 MHz the delay resolution is
// c/(2*BW) ≈ 7.5 m, so the delay profile cannot resolve a person's range — the
// scope range comes from RSSI (`range-heuristic`) and the bearing is a proxy,
// not a measured angle. Displayed like a radar, but labelled for what it is.

const C = 299792458;
const EPS = 1e-9;

export const RADAR_DEFAULTS = Object.freeze({
  txPowerDbm: -40, // assumed RSSI at 1 m
  pathLossN: 2.2, // assumed path-loss exponent
  minRangeM: 0.5,
  maxRangeM: 12,
  rangeAlpha: 0.25, // EMA on the RSSI range
  profileBins: 16, // downsampled delay profile exposed to the UI
});

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x, d) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// In-place iterative radix-2 FFT. re/im length must be a power of two.
export function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

// Delay profile (magnitude) of a real deviation vector. Returns the linear
// magnitudes, the peak bin and the total returned energy.
export function delayProfile(dev, opts = {}) {
  const o = { ...RADAR_DEFAULTS, ...opts };
  const n = dev ? dev.length : 0;
  if (!n) return { profile: [], peakBin: 0, energy: 0, bins: 0 };
  const N = nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 0; k < n; k++) re[k] = dev[k];
  fftInPlace(re, im);
  const half = N / 2;
  let peak = 0;
  let peakBin = 0;
  let energy = 0;
  const mags = new Float64Array(half);
  for (let b = 0; b < half; b++) {
    const m = Math.hypot(re[b], im[b]);
    mags[b] = m;
    energy += m * m;
    if (m > peak) {
      peak = m;
      peakBin = b;
    }
  }
  // Downsample to `profileBins` for the UI, normalized to [0,1].
  const bins = Math.min(o.profileBins, half);
  const profile = [];
  const stride = half / bins;
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor(b * stride);
    const hi = Math.max(lo + 1, Math.floor((b + 1) * stride));
    let v = 0;
    for (let k = lo; k < hi && k < half; k++) v = Math.max(v, mags[k]);
    profile.push(peak > EPS ? round(v / peak, 3) : 0);
  }
  return { profile, peakBin, energy, bins: half, peak };
}

// Coarse range from RSSI (log-distance path loss). Reported as `heuristic`.
export function estimateRangeM(rssiDbm, opts = {}) {
  const o = { ...RADAR_DEFAULTS, ...opts };
  if (!Number.isFinite(rssiDbm)) return null;
  const d = 10 ** ((o.txPowerDbm - rssiDbm) / (10 * o.pathLossN));
  return clamp(d, o.minRangeM, o.maxRangeM);
}

export class RadarProcessor {
  constructor(opts = {}) {
    this.opts = { ...RADAR_DEFAULTS, ...opts };
    this.rangeEma = null;
    this.last = null;
    this.energyEma = 0;
  }

  reset() {
    this.rangeEma = null;
    this.last = null;
    this.energyEma = 0;
  }

  // dev: per-subcarrier signed deviation (amp - baseline); rssiDbm: this frame.
  update({ dev, rssiDbm, bandwidthMhz = 20, subcarrierSpacingMhz } = {}) {
    const o = this.opts;
    const { profile, peakBin, energy, bins } = delayProfile(dev, o);
    const resolutionM = C / (2 * bandwidthMhz * 1e6);
    const peakRangeM = peakBin * resolutionM;
    const rssiRangeM = estimateRangeM(rssiDbm, o);
    if (rssiRangeM != null) {
      this.rangeEma = this.rangeEma == null ? rssiRangeM : this.rangeEma * (1 - o.rangeAlpha) + rssiRangeM * o.rangeAlpha;
    }
    this.energyEma = this.energyEma * 0.8 + energy * 0.2;
    const returnDb = energy > EPS ? round(10 * Math.log10(energy + EPS), 1) : -60;
    const out = {
      grade: "delay-profile-measured",
      bins,
      resolutionM: round(resolutionM, 2),
      peakBin,
      peakRangeM: round(peakRangeM, 2),
      rangeM: this.rangeEma == null ? null : round(this.rangeEma, 2),
      rangeGrade: "range-heuristic",
      bearingGrade: "bearing-proxy",
      returnDb,
      energy: round(energy, 3),
      spaceMhz: Number.isFinite(subcarrierSpacingMhz) ? round(subcarrierSpacingMhz, 4) : null,
      profile,
    };
    this.last = out;
    return out;
  }

  get state() {
    return this.last;
  }
}

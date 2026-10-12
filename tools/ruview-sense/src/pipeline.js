// Focused presence / motion / count / vitals pipeline.
//
// Everything here operates on the amplitude (and phase) time series that a
// person's body perturbs as it moves through the WiFi field. It is honest
// about what each number is:
//   - presence / motion / environment change: signal-derived (MEASURED on input)
//   - persons: slot-capacity HEURISTIC, not a learned counter (mirrors the
//     firmware caveat in firmware/esp32-csi-node/README.md)
//   - vitals: taken from the ESP32 vitals packet when available
//     (device-reported-unvalidated), otherwise a spectral estimate from CSI
//     amplitude (estimated-heuristic). Never presented as clinical.

const EPS = 1e-9;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export class SensePipeline {
  constructor(opts = {}) {
    this.presenceThreshold = opts.presenceThreshold ?? 0.5;
    this.motionThreshold = opts.motionThreshold ?? 0.01;
    this.envChangeThreshold = opts.envChangeThreshold ?? 0.35;
    this.baselineAlpha = opts.baselineAlpha ?? 0.02;
    this.motionAlpha = opts.motionAlpha ?? 0.2;
    this.vitalHz = opts.vitalHz ?? 20;
    this.minVitalSeconds = opts.minVitalSeconds ?? 20;
    this.activeSigma = opts.activeSigma ?? 3;
    this.sensitivity = "normal";
    this.lastRawDelta = 0;

    this.stats = new Map(); // key -> { n, mean, m2 }
    this.curMean = new Map(); // key -> { mean } slow EMA, post-calibration
    this.prev = null; // previous amplitude vector
    this.calibrated = false;
    this.refMean = null; // frozen empty-room baseline (calibration)
    this.refStd = null;
    this.referenceMean = null; // env-change reference
    this.warmed = 0;
    this.warmFrames = opts.warmFrames ?? 60;

    this.motionEnergy = 0;
    this.presenceScore = 0;
    this.envChanged = false;

    this.ampHistory = []; // mean amplitude per frame (for vitals)
    this.lastVitals = null;
    this.frameCount = 0;
    this.nodeId = null;
    this.rssiDbm = null;
  }

  #updateStats(key, x) {
    let s = this.stats.get(key);
    if (!s) {
      s = { n: 0, mean: 0, m2: 0 };
      this.stats.set(key, s);
    }
    s.n += 1;
    const d = x - s.mean;
    s.mean += d / s.n;
    s.m2 += d * (x - s.mean);
    return s;
  }

  #std(s) {
    return s.n > 1 ? Math.sqrt(s.m2 / (s.n - 1)) : 0;
  }

  setSensitivity(mode) {
    if (mode === "high") {
      this.sensitivity = "high";
      this.presenceThreshold = 0.3;
      this.motionThreshold = 0.0015;
      this.envChangeThreshold = 0.1;
      this.motionAlpha = 0.4;
      this.baselineAlpha = 0.08;
      this.activeSigma = 2;
      if (this.warmFrames > 20) this.warmFrames = 20;
    } else {
      this.sensitivity = "normal";
      this.presenceThreshold = 0.5;
      this.motionThreshold = 0.01;
      this.envChangeThreshold = 0.35;
      this.motionAlpha = 0.2;
      this.baselineAlpha = 0.02;
      this.activeSigma = 3;
    }
    return this.sensitivity;
  }

  ingestCsi(frame, nowMs = Date.now()) {
    this.frameCount += 1;
    this.nodeId = frame.nodeId;
    this.rssiDbm = frame.rssiDbm;
    const amp = frame.amplitude;
    const n = amp.length;
    const key = (k) => `${frame.nodeId}:${k}`;

    let diffEnergy = 0;
    let meanAmp = 0;
    const active = new Uint8Array(n);

    // Calibration: assume an empty room for the first warmFrames and freeze
    // that signature as the reference (same model as the firmware's 60 s
    // ambient learning). After calibration the baseline no longer moves, so a
    // person shows up as a large deviation while a persistent object becomes a
    // slow environment change below.
    if (!this.calibrated) {
      for (let k = 0; k < n; k++) {
        this.#updateStats(key(k), amp[k]);
        this.#setCurMean(key(k), amp[k], 1 / (this.warmed + 1));
      }
      if (this.warmed + 1 >= this.warmFrames) {
        const { mu, sd } = this.#freezeBaseline(frame.nodeId, n);
        this.calibrated = true;
        this.refMean = mu;
        this.refStd = sd;
        this.referenceMean = this.#snapshotMeans(frame.nodeId, n);
      }
    } else {
      for (let k = 0; k < n; k++) this.#setCurMean(key(k), amp[k], this.baselineAlpha);
    }
    this.warmed += 1;

    for (let k = 0; k < n; k++) {
      const mu = this.refMean ? this.refMean[k] : 0;
      const sd = this.refStd ? this.refStd[k] : 1;
      const z = sd > EPS ? Math.abs(amp[k] - mu) / sd : 0;
      meanAmp += amp[k];
      // Subcarrier "active" when it deviates by >`activeSigma` sigma from the
      // calibrated empty-room baseline — a body perturbs it far more than
      // ambient noise (high sensitivity mode lowers the sigma cut).
      active[k] = z > this.activeSigma ? 1 : 0;
      if (this.prev && this.prev.length === n) {
        const d = amp[k] - this.prev[k];
        diffEnergy += d * d;
      }
    }
    meanAmp /= n;
    // Presence = fraction of subcarriers deviating >3 sigma from baseline
    // (scaled: 20% of the array beyond 3 sigma saturates the score to 1).
    let activeCount = 0;
    for (let k = 0; k < n; k++) activeCount += active[k];
    this.presenceScore = clamp((activeCount / n) * 5, 0, 1);

    const motionRaw = diffEnergy / n / (meanAmp * meanAmp + EPS);
    this.lastRawDelta = motionRaw;
    this.motionEnergy = this.motionEnergy * (1 - this.motionAlpha) + motionRaw * this.motionAlpha;

    this.prev = Float64Array.from(amp);

    // Environment change: how far the current (slow EMA) per-subcarrier mean
    // drifted from the calibrated baseline. A moved/added object perturbs the
    // static RF signature; this flags the change, it does NOT classify it.
    if (this.referenceMean) {
      const cur = this.#snapshotMeans(frame.nodeId, n);
      let num = 0;
      let den = 0;
      for (let k = 0; k < n; k++) {
        num += Math.abs(cur[k] - this.referenceMean[k]);
        den += Math.abs(this.referenceMean[k]) + EPS;
      }
      this.envChanged = den > 0 && num / den > this.envChangeThreshold;
    }

    // Person count: slot-capacity heuristic over active subcarrier groups.
    const persons = this.#slotCount(active);

    // Vitals from amplitude history.
    this.ampHistory.push({ t: nowMs, a: meanAmp });
    const cutoff = nowMs - (this.minVitalSeconds + 5) * 1000;
    while (this.ampHistory.length && this.ampHistory[0].t < cutoff) this.ampHistory.shift();
    const estimated = this.#estimateBreathing();

    return {
      source: "csi",
      nodeId: frame.nodeId,
      present: this.presenceScore >= this.presenceThreshold,
      presenceScore: round(this.presenceScore, 3),
      motion: this.motionEnergy >= this.motionThreshold,
      motionEnergy: round(this.motionEnergy, 4),
      persons,
      personsGrade: "slot-capacity-heuristic",
      environmentChanged: this.envChanged,
      rssiDbm: frame.rssiDbm,
      vitals: this.lastVitals ?? estimated,
      frames: this.frameCount,
      sensitivity: this.sensitivity,
      rawDelta: round(this.lastRawDelta, 5),
    };
  }

  ingestVitals(pkt) {
    this.lastVitals = {
      source: "esp32",
      grade: "device-reported-unvalidated",
      breathingBpm: round(pkt.breathingBpm, 1),
      heartBpm: round(pkt.heartBpm, 1),
      presence: pkt.flags.presence,
      fall: pkt.flags.fall,
    };
    return this.lastVitals;
  }

  ingestRssi(sample, nowMs = Date.now()) {
    this.frameCount += 1;
    const x = sample.rssiDbm;
    const s = this.#updateStats("rssi", x);
    const sd = this.#std(s);
    const z = sd > EPS ? Math.abs(x - s.mean) / sd : 0;
    this.presenceScore = clamp(Math.tanh(z), 0, 1);

    if (this.prev != null) {
      const d = x - this.prev;
      const motionRaw = (d * d) / (Math.abs(s.mean) + EPS);
      this.motionEnergy = this.motionEnergy * (1 - this.motionAlpha) + motionRaw * this.motionAlpha;
    }
    this.prev = x;

    return {
      source: "rssi",
      nodeId: sample.bssid ?? null,
      present: this.presenceScore >= this.presenceThreshold,
      presenceScore: round(this.presenceScore, 3),
      motion: this.motionEnergy >= this.motionThreshold,
      motionEnergy: round(this.motionEnergy, 4),
      persons: null,
      personsGrade: "unavailable-from-rssi",
      environmentChanged: false,
      rssiDbm: sample.rssiDbm,
      vitals: null,
      frames: this.frameCount,
      sensitivity: this.sensitivity,
      rawDelta: round(this.lastRawDelta, 5),
    };
  }

  #slotCount(active) {
    let groups = 0;
    let run = 0;
    for (let k = 0; k < active.length; k++) {
      if (active[k]) {
        run += 1;
      } else if (run > 0) {
        groups += 1;
        run = 0;
      }
    }
    if (run > 0) groups += 1;
    return clamp(Math.ceil(groups / 2), 0, 8);
  }

  #setCurMean(key, x, alpha) {
    let c = this.curMean.get(key);
    if (!c) {
      c = { mean: x };
      this.curMean.set(key, c);
    } else {
      c.mean = c.mean * (1 - alpha) + x * alpha;
    }
  }

  #freezeBaseline(nodeId, n) {
    const mu = new Float64Array(n);
    const sd = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const s = this.stats.get(`${nodeId}:${k}`);
      mu[k] = s ? s.mean : 0;
      sd[k] = s ? this.#std(s) : 1;
      if (!(sd[k] > 0)) sd[k] = 1;
    }
    return { mu, sd };
  }

  #snapshotMeans(nodeId, n) {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const c = this.curMean.get(`${nodeId}:${k}`);
      out[k] = c ? c.mean : 0;
    }
    return out;
  }

  // Spectral estimate of breathing rate from the mean-amplitude series.
  #estimateBreathing() {
    const h = this.ampHistory;
    if (h.length < this.minVitalSeconds * this.vitalHz * 0.5) return null;
    const span = (h[h.length - 1].t - h[0].t) / 1000;
    if (span < this.minVitalSeconds) return null;
    const fs = (h.length - 1) / span;
    let mean = 0;
    for (const p of h) mean += p.a;
    mean /= h.length;

    let bestF = 0;
    let bestP = 0;
    for (let bpm = 6; bpm <= 30; bpm += 0.5) {
      const f = bpm / 60;
      let re = 0;
      let im = 0;
      for (let i = 0; i < h.length; i++) {
        const a = h[i].a - mean;
        const th = 2 * Math.PI * f * (i / fs);
        re += a * Math.cos(th);
        im += a * Math.sin(th);
      }
      const p = re * re + im * im;
      if (p > bestP) {
        bestP = p;
        bestF = bpm;
      }
    }
    this.ampHistory = this.ampHistory.slice(-Math.round(this.vitalHz * 30));
    return {
      source: "csi",
      grade: "estimated-heuristic",
      breathingBpm: round(bestF, 1),
      heartBpm: null,
    };
  }
}

function round(x, d) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

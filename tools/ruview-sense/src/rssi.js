// RSSI fallback source. Coarse on purpose: a normal WiFi adapter exposes
// received signal strength only, never Channel State Information. Presence and
// gross motion are detectable; counting, vitals and object changes are not.
//
// Linux: uses nmcli (no root). Best-effort; returns [] when unavailable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Convert an nmcli SIGNAL quality (0-100) to an approximate dBm value.
export function qualityToDbm(quality) {
  const q = Math.max(0, Math.min(100, Number(quality)));
  return Math.round(q / 2 - 100);
}

// Pick the RSSI column to track: the strongest currently-visible BSSID.
export function pickTracked(observations) {
  if (!observations.length) return null;
  return observations.reduce((a, b) => (b.rssiDbm > a.rssiDbm ? b : a));
}

export function parseNmcli(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const bssid = parts[0].trim();
    const signal = parts[1].trim();
    if (!/^\d+$/.test(signal)) continue;
    out.push({
      bssid,
      ssid: parts.slice(2).join(":").trim(),
      rssiDbm: qualityToDbm(signal),
      quality: Number(signal),
    });
  }
  return out;
}

export async function scanWithNmcli() {
  try {
    const { stdout } = await run(
      "nmcli",
      ["-t", "-f", "BSSID,SIGNAL,SSID", "dev", "wifi"],
      { timeout: 5000 },
    );
    return parseNmcli(stdout);
  } catch {
    return [];
  }
}

export async function scanRssi() {
  const obs = await scanWithNmcli();
  return obs;
}

export class RssiPoller {
  constructor(onSample, { intervalMs = 1000 } = {}) {
    this.onSample = onSample;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    const tick = async () => {
      const obs = await scanRssi();
      const tracked = pickTracked(obs);
      if (tracked) this.onSample(tracked, obs);
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

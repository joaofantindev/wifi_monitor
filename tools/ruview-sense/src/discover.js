// Device discovery for the "watch-dogs" style map.
//
// HONESTY: a single WiFi node cannot locate devices in 2-D. What we can do is
// enumerate who is on the LAN (`ip neigh`, `nmap -sn`), attach a MAC/vendor, and
// measure a round-trip time per host (`ping`). The RTT is a *latency proxy* —
// it is dominated by MAC retransmission and power-save, NOT by distance — so it
// is labelled `latency-proxy`, never "position". Bluetooth LE advertisements are
// enumerated too (best effort) as mere proximity/identity hints.
//
// Everything here is read-only and bounded: fixed commands, no user-supplied
// targets, per-command timeouts, small output buffers.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
const OUI_FILE = "/usr/share/nmap/nmap-mac-prefixes";

export const DISCOVER_DEFAULTS = Object.freeze({
  subnet: null, // e.g. "192.168.2.0/24"; deep discovery is skipped when null
  deep: true, // `nmap -sn` host sweep
  ping: true, // per-host RTT proxy
  ble: false, // `bluetoothctl` scan (off: needs a moment and BlueZ)
  bleSeconds: 5,
  pingCount: 2,
  cmdTimeoutMs: 8000,
});

// Load the nmap OUI -> vendor table (best effort; empty map when absent).
export async function loadOui(path = OUI_FILE) {
  const table = new Map();
  try {
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const sp = t.indexOf(" ");
      if (sp < 0) continue;
      const prefix = t.slice(0, sp).toUpperCase();
      if (prefix.length === 6) table.set(prefix, t.slice(sp + 1).trim());
    }
  } catch {
    /* no OUI database: vendor stays unknown */
  }
  return table;
}

export function vendorFor(mac, table) {
  if (!mac || !table || !table.size) return null;
  const prefix = mac.replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase();
  return table.get(prefix) ?? null;
}

// `ip neigh show` -> [{ip, mac, state, online}]
export function parseNeighbors(text) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const ip = parts[0];
    const li = parts.indexOf("lladdr");
    if (li < 0 || !parts[li + 1]) continue;
    const mac = parts[li + 1].toUpperCase();
    const state = parts[parts.length - 1];
    out.set(ip, { ip, mac, state, online: state !== "FAILED" && state !== "INCOMPLETE" });
  }
  return [...out.values()];
}

// `nmap -sn` -> [{ip, host, mac, vendor, rttMs, online}]
export function parseNmap(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    let m = line.match(/^Nmap scan report for (.+)$/);
    if (m) {
      const name = m[1];
      const pm = name.match(/\(([\d.]+)\)/);
      const ip = pm ? pm[1] : name;
      cur = { ip, host: pm ? name.replace(/\s*\(.*\)/, "") : null, mac: null, vendor: null, rttMs: null, online: true };
      out.set(ip, cur);
      continue;
    }
    if (!cur) continue;
    m = line.match(/^Host is up \(([\d.]+)s latency\)/);
    if (m) {
      cur.rttMs = Math.round(Number(m[1]) * 1000 * 10) / 10;
      cur.online = true;
      continue;
    }
    m = line.match(/^MAC Address: ([0-9A-Fa-f:]{17})(?: \((.+)\))?/);
    if (m) {
      cur.mac = m[1].toUpperCase();
      cur.vendor = m[2] ?? null;
      continue;
    }
    if (/^Host seems down/.test(line)) cur.online = false;
  }
  return [...out.values()];
}

// `ping` output -> {rttMs (median), jitterMs (stddev), samples}
export function parsePing(text) {
  const times = [];
  const re = /time[=<]([\d.]+)\s*ms/gi;
  let m;
  while ((m = re.exec(String(text)))) times.push(Number(m[1]));
  if (!times.length) return { rttMs: null, jitterMs: null, samples: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const mean = times.reduce((s, x) => s + x, 0) / times.length;
  const varr = times.reduce((s, x) => s + (x - mean) ** 2, 0) / times.length;
  return { rttMs: Math.round(med * 10) / 10, jitterMs: Math.round(Math.sqrt(varr) * 10) / 10, samples: times.length };
}

// `bluetoothctl` output -> [{mac, name}]
export function parseBle(text) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    const m = line.match(/Device ([0-9A-Fa-f:]{17})\s+(.*)$/);
    if (!m) continue;
    const mac = m[1].toUpperCase();
    out.set(mac, { mac, name: m[2].replace(/\s+/g, " ").trim() || null });
  }
  return [...out.values()];
}

async function run(exec, cmd, args, timeout) {
  try {
    const { stdout } = await exec(cmd, args, { timeout, maxBuffer: 1 << 20, windowsHide: true });
    return stdout ?? "";
  } catch (err) {
    // execFile rejects on non-zero exit but may still carry partial stdout.
    return err && typeof err.stdout === "string" ? err.stdout : "";
  }
}

export class DeviceScanner {
  constructor(opts = {}) {
    this.opts = { ...DISCOVER_DEFAULTS, ...opts };
    this.exec = opts.exec ?? pExecFile;
    this.oui = opts.oui ?? null;
  }

  async scan(nowMs = Date.now()) {
    const o = this.opts;
    const byKey = new Map();

    for (const d of parseNeighbors(await run(this.exec, "ip", ["neigh", "show"], o.cmdTimeoutMs))) {
      byKey.set(d.ip, { ...d, kind: "lan", vendor: null, host: null, rttMs: null, jitterMs: null, lastSeen: nowMs, grade: "presence-measured" });
    }

    if (o.deep && o.subnet) {
      const nmap = parseNmap(await run(this.exec, "nmap", ["-sn", o.subnet], Math.max(o.cmdTimeoutMs, 45000)));
      for (const d of nmap) {
        const prev = byKey.get(d.ip) ?? {};
        byKey.set(d.ip, {
          ip: d.ip,
          kind: "lan",
          mac: d.mac ?? prev.mac ?? null,
          vendor: d.vendor ?? prev.vendor ?? null,
          host: d.host ?? prev.host ?? null,
          state: prev.state ?? (d.online ? "UP" : "DOWN"),
          online: d.online !== false,
          rttMs: prev.rttMs ?? null,
          jitterMs: prev.jitterMs ?? null,
          lastSeen: nowMs,
          grade: "presence-measured",
        });
      }
    }

    if (o.ping) {
      const pings = await Promise.all(
        [...byKey.keys()].map((ip) =>
          run(this.exec, "ping", ["-c", String(o.pingCount), "-W", "1", "-i", "0.2", ip], o.cmdTimeoutMs).then((out) => ({
            ip,
            ...parsePing(out),
          }))
        )
      );
      for (const p of pings) {
        const d = byKey.get(p.ip);
        if (d && p.rttMs != null) {
          d.rttMs = p.rttMs;
          d.jitterMs = p.jitterMs;
          d.rttGrade = "latency-proxy";
        }
      }
    }

    if (o.ble) {
      const ble = parseBle(await run(this.exec, "bluetoothctl", ["--timeout", String(o.bleSeconds), "scan", "on"], (o.bleSeconds + 4) * 1000));
      for (const b of ble) {
        byKey.set(`ble:${b.mac}`, {
          ip: null,
          kind: "ble",
          mac: b.mac,
          name: b.name,
          vendor: b.name,
          online: true,
          rttMs: null,
          jitterMs: null,
          lastSeen: nowMs,
          grade: "presence-measured",
        });
      }
    }

    const devices = [...byKey.values()].map((d) => ({ ...d, vendor: d.vendor ?? vendorFor(d.mac, this.oui) }));
    return { ts: nowMs, devices, count: devices.length, grade: "device-discovery", rttGrade: "latency-proxy" };
  }
}

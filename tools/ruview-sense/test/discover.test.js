import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseNeighbors,
  parseNmap,
  parsePing,
  parseBle,
  vendorFor,
  DeviceScanner,
} from "../src/discover.js";

test("parseNeighbors keeps resolved hosts and drops unresolved ones", () => {
  const text = [
    "192.168.2.189 dev wlp2s0 lladdr cc:a1:2b:3d:ee:f0 REACHABLE",
    "192.168.2.1 dev wlp2s0 lladdr 14:36:0e:70:6e:00 STALE",
    "192.168.2.50 dev wlp2s0 FAILED",
    "",
  ].join("\n");
  const devs = parseNeighbors(text);
  assert.equal(devs.length, 2);
  assert.equal(devs[0].ip, "192.168.2.189");
  assert.equal(devs[0].mac, "CC:A1:2B:3D:EE:F0");
  assert.equal(devs[0].online, true);
  assert.equal(devs[1].ip, "192.168.2.1");
});

test("parseNmap extracts ip, latency, mac and vendor", () => {
  const text = [
    "Nmap scan report for _gateway (192.168.2.1)",
    "Host is up (0.0065s latency).",
    "MAC Address: 14:36:0E:70:6E:00 (Zyxel Communications)",
    "Nmap scan report for 192.168.2.191",
    "Host is up (2.2000s latency).",
  ].join("\n");
  const devs = parseNmap(text);
  assert.equal(devs.length, 2);
  assert.equal(devs[0].ip, "192.168.2.1");
  assert.equal(devs[0].host, "_gateway");
  assert.equal(devs[0].rttMs, 6.5);
  assert.equal(devs[0].mac, "14:36:0E:70:6E:00");
  assert.equal(devs[0].vendor, "Zyxel Communications");
  assert.equal(devs[1].rttMs, 2200);
});

test("parsePing reports median rtt and jitter", () => {
  const text = [
    "64 bytes from 192.168.2.1: icmp_seq=1 ttl=64 time=2.10 ms",
    "64 bytes from 192.168.2.1: icmp_seq=2 ttl=64 time=4.10 ms",
    "64 bytes from 192.168.2.1: icmp_seq=3 ttl=64 time=3.10 ms",
  ].join("\n");
  const p = parsePing(text);
  assert.equal(p.samples, 3);
  assert.equal(p.rttMs, 3.1);
  assert.ok(p.jitterMs > 0 && p.jitterMs < 2);
  assert.deepEqual(parsePing("no hosts"), { rttMs: null, jitterMs: null, samples: 0 });
});

test("parseBle extracts advertising devices", () => {
  const text = [
    "[NEW] Device 10:3D:0A:C3:E5:BE Realtek Bluetooth",
    "Device AA:BB:CC:DD:EE:FF Some Speaker",
  ].join("\n");
  const devs = parseBle(text);
  assert.equal(devs.length, 2);
  assert.equal(devs[0].mac, "10:3D:0A:C3:E5:BE");
  assert.equal(devs[0].name, "Realtek Bluetooth");
});

test("vendorFor resolves an OUI prefix", () => {
  const table = new Map([["14360E", "Zyxel Communications"]]);
  assert.equal(vendorFor("14:36:0e:70:6e:00", table), "Zyxel Communications");
  assert.equal(vendorFor("00:00:00:00:00:00", table), null);
  assert.equal(vendorFor(null, table), null);
});

test("DeviceScanner merges neighbors, nmap, ping and labels rtt as latency-proxy", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "ip") return { stdout: "192.168.2.1 dev wlp2s0 lladdr 14:36:0e:70:6e:00 REACHABLE\n" };
    if (cmd === "nmap")
      return {
        stdout: [
          "Nmap scan report for _gateway (192.168.2.1)",
          "Host is up (0.005s latency).",
          "MAC Address: 14:36:0E:70:6E:00 (Zyxel Communications)",
          "Nmap scan report for 192.168.2.189",
          "Host is up (0.002s latency).",
        ].join("\n"),
      };
    if (cmd === "ping") return { stdout: `64 bytes from ${args.at(-1)}: time=1.50 ms` };
    return { stdout: "" };
  };
  const scanner = new DeviceScanner({ exec, subnet: "192.168.2.0/24", oui: new Map([["14360E", "Zyxel Communications"]]) });
  const res = await scanner.scan(1000);
  assert.equal(res.grade, "device-discovery");
  assert.equal(res.rttGrade, "latency-proxy");
  const gateway = res.devices.find((d) => d.ip === "192.168.2.1");
  assert.equal(gateway.vendor, "Zyxel Communications");
  assert.equal(gateway.rttMs, 1.5);
  assert.equal(gateway.rttGrade, "latency-proxy");
  const extra = res.devices.find((d) => d.ip === "192.168.2.189");
  assert.ok(extra, "nmap-only host is kept");
  assert.ok(calls.some((c) => c.startsWith("nmap -sn")), "ran the host sweep");
  assert.ok(calls.some((c) => c.startsWith("ping ")), "measured rtt");
});

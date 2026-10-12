import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCsiFrame,
  parseVitalsPacket,
  parsePacket,
  packetKind,
  ParseError,
  ESP32_CSI_MAGIC,
  RUVIEW_VITALS_MAGIC,
  HEADER_SIZE,
} from "../src/parse.js";
import { buildCsiBuffer, buildVitalsBuffer } from "./helpers.js";

test("magic numbers match the Rust constants", () => {
  assert.equal(ESP32_CSI_MAGIC, 0xc5110001);
  assert.equal(RUVIEW_VITALS_MAGIC, 0xc5110002);
});

test("packetKind routes csi / vitals / unknown / short", () => {
  assert.equal(packetKind(buildCsiBuffer()), "csi");
  assert.equal(packetKind(buildVitalsBuffer()), "vitals");
  assert.equal(packetKind(Buffer.alloc(4)), "unknown");
  assert.equal(packetKind(Buffer.alloc(2)), "short");
});

test("parses a minimal CSI frame with the expected geometry", () => {
  const nSc = 64;
  const buf = buildCsiBuffer({
    nodeId: 7,
    nAntennas: 1,
    nSubcarriers: nSc,
    freqMhz: 5180,
    sequence: 42,
    rssiDbm: -63,
    noiseFloorDbm: -92,
    values: (_a, s) => ({ i: s % 128, q: 0 }),
  });

  const f = parseCsiFrame(buf);
  assert.equal(f.kind, "csi");
  assert.equal(f.nodeId, 7);
  assert.equal(f.nAntennas, 1);
  assert.equal(f.nSubcarriers, 64);
  assert.equal(f.freqMhz, 5180);
  assert.equal(f.sequence, 42);
  assert.equal(f.rssiDbm, -63);
  assert.equal(f.noiseFloorDbm, -92);
  assert.equal(f.amplitude.length, 64);
  // subcarrier index mapping: half = 32 -> [-32..-1, 1..32]
  assert.equal(f.subcarrierIndex[0], -32);
  assert.equal(f.subcarrierIndex[31], -1);
  assert.equal(f.subcarrierIndex[32], 1);
  assert.equal(f.subcarrierIndex[63], 32);
  // amplitude = |i| when q = 0
  assert.equal(f.amplitude[0], 0);
  assert.equal(f.amplitude[5], 5);
  assert.equal(f.amplitude[63], 63);
});

test("multi-antenna layout interleaves [ant0_all_sc, ant1_all_sc, ...]", () => {
  const nSc = 4;
  const buf = buildCsiBuffer({
    nAntennas: 2,
    nSubcarriers: nSc,
    values: (a, s) => ({ i: a * 100 + s, q: 0 }),
  });
  const f = parseCsiFrame(buf);
  assert.equal(f.amplitude.length, 8);
  assert.deepEqual(Array.from(f.amplitude), [0, 1, 2, 3, 100, 101, 102, 103]);
});

test("parses the vitals packet fields", () => {
  const v = parseVitalsPacket(
    buildVitalsBuffer({
      flags: 0x01,
      breathingBpm: 16.5,
      heartBpm: 72.5,
      persons: 3,
      presenceScore: 0.87,
    }),
  );
  assert.equal(v.kind, "vitals");
  assert.equal(v.flags.presence, true);
  assert.equal(v.flags.fall, false);
  assert.equal(v.breathingBpm, 16.5);
  assert.equal(v.heartBpm, 72.5);
  assert.equal(v.persons, 3);
  assert.ok(Math.abs(v.presenceScore - 0.87) < 1e-6, `presenceScore=${v.presenceScore}`);
  assert.equal(v.grade, "device-reported-unvalidated");
});

test("parsePacket dispatches both kinds", () => {
  assert.equal(parsePacket(buildCsiBuffer()).kind, "csi");
  assert.equal(parsePacket(buildVitalsBuffer()).kind, "vitals");
});

test("rejects malformed frames with typed errors", () => {
  assert.throws(() => parseCsiFrame(Buffer.alloc(HEADER_SIZE - 1)), (e) => e.code === "insufficient_data");
  const empty = Buffer.alloc(HEADER_SIZE + 4);
  assert.throws(() => parseCsiFrame(empty), (e) => e.code === "invalid_magic");
  const badAnt = buildCsiBuffer({ nAntennas: 0 });
  badAnt[5] = 0;
  assert.throws(() => parseCsiFrame(badAnt), (e) => e.code === "invalid_antennas");
  const shortIQ = buildCsiBuffer({ nSubcarriers: 64 }).subarray(0, HEADER_SIZE + 10);
  assert.throws(() => parseCsiFrame(shortIQ), (e) => e.code === "insufficient_data");
  assert.throws(() => parseVitalsPacket(Buffer.alloc(31)), (e) => e.code === "insufficient_data");
  assert.ok(parseCsiFrame instanceof Function);
  assert.ok(ParseError instanceof Error.constructor);
});
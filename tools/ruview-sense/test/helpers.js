// Builds valid ADR-018 buffers for tests. Wire format mirrors src/parse.js.

import { ESP32_CSI_MAGIC, RUVIEW_VITALS_MAGIC, HEADER_SIZE } from "../src/parse.js";

export function buildCsiBuffer({
  nodeId = 1,
  nAntennas = 1,
  nSubcarriers = 64,
  freqMhz = 2437,
  sequence = 1,
  rssiDbm = -55,
  noiseFloorDbm = -90,
  ppduType = 0,
  flags = 0,
  // fn(ant, scIdx) -> { i, q }
  values = () => ({ i: 0, q: 0 }),
} = {}) {
  const bufSize = HEADER_SIZE + nAntennas * nSubcarriers * 2;
  const buf = Buffer.alloc(bufSize);
  buf.writeUInt32LE(ESP32_CSI_MAGIC >>> 0, 0);
  buf[4] = nodeId;
  buf[5] = nAntennas;
  buf.writeUInt16LE(nSubcarriers, 6);
  buf.writeUInt32LE(freqMhz >>> 0, 8);
  buf.writeUInt32LE(sequence >>> 0, 12);
  buf.writeInt8(rssiDbm, 16);
  buf.writeInt8(noiseFloorDbm, 17);
  buf[18] = ppduType;
  buf[19] = flags;
  let off = HEADER_SIZE;
  for (let a = 0; a < nAntennas; a++) {
    for (let s = 0; s < nSubcarriers; s++) {
      const { i, q } = values(a, s);
      buf.writeInt8(i & 0xff, off++);
      buf.writeInt8(q & 0xff, off++);
    }
  }
  return buf;
}

export function buildVitalsBuffer({
  nodeId = 1,
  flags = 0,
  breathingBpm = 16.5,
  heartBpm = 72.5,
  rssiDbm = -55,
  persons = 1,
  motionEnergy = 0.5,
  presenceScore = 0.9,
  timestampMs = 1000,
} = {}) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(RUVIEW_VITALS_MAGIC >>> 0, 0);
  buf[4] = nodeId;
  buf[5] = flags;
  buf.writeUInt16LE(Math.round(breathingBpm * 100), 6);
  buf.writeUInt32LE(Math.round(heartBpm * 10000), 8);
  buf.writeInt8(rssiDbm, 12);
  buf[13] = persons;
  buf.writeFloatLE(motionEnergy, 16);
  buf.writeFloatLE(presenceScore, 20);
  buf.writeUInt32LE(timestampMs >>> 0, 24);
  return buf;
}
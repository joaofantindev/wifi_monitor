// Parser for the ADR-018 ESP32 CSI wire format and sibling packets.
// Field layout mirrors v2/crates/wifi-densepose-hardware/src/esp32_parser.rs.
//
// ADR-018 CSI frame (magic 0xC5110001):
//   0  4  magic (LE u32)
//   4  1  node id
//   5  1  antenna count
//   6  2  subcarrier count (LE u16)
//   8  4  frequency MHz (LE u32)
//   12 4  sequence (LE u32)
//   16 1  RSSI (i8)
//   17 1  noise floor (i8)
//   18 1  PPDU type
//   19 1  flags
//   20 N*2 I/Q pairs, order [ant0_sc0_I, ant0_sc0_Q, ant0_sc1_I, ...]

export const ESP32_CSI_MAGIC = 0xc5110001;
export const RUVIEW_VITALS_MAGIC = 0xc5110002;
export const RUVIEW_FUSED_VITALS_MAGIC = 0xc5110004;

export const HEADER_SIZE = 20;
export const MAX_ANTENNAS = 8;
export const MAX_IQ_PAIRS = 8192;

export class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

function readMagic(buf) {
  return (
    (buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)) >>> 0
  );
}

export function packetKind(buf) {
  if (buf.length < 4) return "short";
  switch (readMagic(buf)) {
    case ESP32_CSI_MAGIC:
      return "csi";
    case RUVIEW_VITALS_MAGIC:
      return "vitals";
    case RUVIEW_FUSED_VITALS_MAGIC:
      return "fused_vitals";
    default:
      return "unknown";
  }
}

export function parseCsiFrame(buf) {
  if (buf.length < HEADER_SIZE) {
    throw new ParseError("insufficient_data", `need ${HEADER_SIZE}, got ${buf.length}`);
  }
  const magic = readMagic(buf);
  if (magic !== ESP32_CSI_MAGIC) {
    throw new ParseError("invalid_magic", `expected 0x${ESP32_CSI_MAGIC.toString(16)}, got 0x${magic.toString(16)}`);
  }

  const nodeId = buf[4];
  const nAntennas = buf[5];
  if (nAntennas === 0 || nAntennas > MAX_ANTENNAS) {
    throw new ParseError("invalid_antennas", `antenna count ${nAntennas}`);
  }
  const nSubcarriers = buf[6] | (buf[7] << 8);
  if (nSubcarriers === 0 || nSubcarriers > MAX_IQ_PAIRS / nAntennas) {
    throw new ParseError("invalid_subcarriers", `subcarrier count ${nSubcarriers}`);
  }
  const freqMhz = (buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24)) >>> 0;
  const sequence = (buf[12] | (buf[13] << 8) | (buf[14] << 16) | (buf[15] << 24)) >>> 0;
  const rssiDbm = (buf[16] << 24) >> 24;
  const noiseFloorDbm = (buf[17] << 24) >> 24;
  const ppduType = buf[18];
  const flagsByte = buf[19];

  const pairCount = nAntennas * nSubcarriers;
  const totalSize = HEADER_SIZE + pairCount * 2;
  if (buf.length < totalSize) {
    throw new ParseError("insufficient_data", `need ${totalSize}, got ${buf.length}`);
  }

  const half = Math.trunc(nSubcarriers / 2);
  // Interleave antennas: index = antenna * nSubcarriers + subcarrier.
  const amplitude = new Float64Array(pairCount);
  const phase = new Float64Array(pairCount);
  const index = new Int16Array(nSubcarriers);
  for (let sc = 0; sc < nSubcarriers; sc++) {
    index[sc] = sc < half ? -(half - sc) : sc - half + 1;
  }

  let off = HEADER_SIZE;
  for (let ant = 0; ant < nAntennas; ant++) {
    for (let sc = 0; sc < nSubcarriers; sc++) {
      const iVal = (buf[off++] << 24) >> 24;
      const qVal = (buf[off++] << 24) >> 24;
      const k = ant * nSubcarriers + sc;
      amplitude[k] = Math.hypot(iVal, qVal);
      phase[k] = Math.atan2(qVal, iVal);
    }
  }

  return {
    kind: "csi",
    nodeId,
    nAntennas,
    nSubcarriers,
    freqMhz,
    sequence,
    rssiDbm,
    noiseFloorDbm,
    ppduType,
    flags: {
      bw40: (flagsByte & 0x01) !== 0,
      stbc: (flagsByte & 0x04) !== 0,
      syncValid: (flagsByte & 0x10) !== 0,
      firstWordInvalid: (flagsByte & 0x20) !== 0,
    },
    subcarrierIndex: index,
    amplitude,
    phase,
  };
}

export function parseVitalsPacket(buf) {
  if (buf.length < 32) {
    throw new ParseError("insufficient_data", `need 32, got ${buf.length}`);
  }
  const magic = readMagic(buf);
  if (magic !== RUVIEW_VITALS_MAGIC) {
    throw new ParseError("invalid_magic", `expected 0x${RUVIEW_VITALS_MAGIC.toString(16)}`);
  }
  const flags = buf[5];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    kind: "vitals",
    nodeId: buf[4],
    flags: {
      presence: (flags & 0x01) !== 0,
      fall: (flags & 0x02) !== 0,
      motion: (flags & 0x04) !== 0,
    },
    breathingBpm: (buf[6] | (buf[7] << 8)) / 100,
    heartBpm: (view.getUint32(8, true)) / 10000,
    rssiDbm: (buf[12] << 24) >> 24,
    persons: buf[13],
    motionEnergy: view.getFloat32(16, true),
    presenceScore: view.getFloat32(20, true),
    timestampMs: view.getUint32(24, true),
    grade: "device-reported-unvalidated",
  };
}

export function parsePacket(buf) {
  switch (packetKind(buf)) {
    case "csi":
      return parseCsiFrame(buf);
    case "vitals":
      return parseVitalsPacket(buf);
    default:
      return { kind: packetKind(buf) };
  }
}

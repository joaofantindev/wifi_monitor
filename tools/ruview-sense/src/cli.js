#!/usr/bin/env node
// ruview-sense — focused presence/motion monitor for ESP32 CSI or WiFi RSSI.
// Dependency-free Node implementation. Usage:
//   node src/cli.js --source auto|esp32|rssi|simulated [--http-port P] [--udp-port P]

import { startServer } from "./server.js";

function usage() {
  console.log(`ruview-sense — presença/movimento via CSI (ESP32) ou RSSI (WiFi)

uso:
  node src/cli.js [--source auto|esp32|rssi|simulated]
                  [--host 127.0.0.1] [--http-port 8080] [--udp-port 5005]

fontes:
  auto       (padrão) tenta ESP32 (UDP 5005); cai para RSSI após ~8s sem pacotes
  esp32      exige CSI do ESP32 (formato ADR-018, magic 0xC5110001)
  rssi       usa nmcli (Linux) — presença/movimento grosseiros, sem contagem/vitais
  simulated  gera CSI sintética para demonstração (rotulado simulated)

abrir: http://<host>:<http-port>/  (monitor via SSE em /events, JSON em /api/v1/sense)
`);
}

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1];
}

if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const source = flag("--source", "auto");
if (!["auto", "esp32", "rssi", "simulated"].includes(source)) {
  console.error(`fonte inválida: ${source}`);
  usage();
  process.exit(2);
}

const server = startServer({
  source,
  host: flag("--host", "127.0.0.1"),
  httpPort: Number(flag("--http-port", "8080")),
  udpPort: Number(flag("--udp-port", "5005")),
  log: true,
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    console.log("\npor hoje não — ruview-sense parado.");
    process.exit(0);
  });
}
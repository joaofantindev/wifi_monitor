# ruview-sense

Monitor focado de **presença e movimento** para o RuView, sem dependências
(busca `node` >= 18). É um recorte mínimo do projeto: ingere CSI do ESP32
(formato ADR-018), ou **cai para RSSI** quando não há ESP32, e mostra tudo num
monitor web simples.

> Não altera nada do resto do repositório — vive em `tools/ruview-sense/`.

## Como usar

```bash
node tools/ruview-sense/src/cli.js --source auto
# abra http://localhost:8080
```

Fontes:

| `--source` | O que faz |
|---|---|
| `auto` (padrão) | escuta UDP 5005 por CSI do ESP32; após ~8 s sem pacotes cai para RSSI |
| `esp32` | exige ESP32-S3/C6 com firmware `esp32-csi-node` (UDP 5005) |
| `rssi` | usa `nmcli` (Linux) — presença/movimento **grosseiros**, sem contagem/vitais |
| `simulated` | gera CSI sintética para demonstração |

Flags: `--host 127.0.0.1` · `--http-port 8080` · `--udp-port 5005`

## Endpoints

- `GET /` — monitor web (SSE em `/events`, JSON em `/api/v1/sense`, health em `/health`)

## Testes

```bash
cd tools/ruview-sense && node --test
```

Hoje: 14 testes cobrindo o parser ADR-018 (magic, geometria, multi-antena,
packet de vitais, erros) e o pipeline (presença, movimento, mudança de
ambiente, heurística de contagem, vitais, RSSI).

## O que cada número é — honestidade (contrato AGENTS.md)

| Valor | Grade real | Explicação |
|---|---|---|
| Presença / movimento | signal-derived | desvio > 3σ da linha de base calibrada por subportadora |
| Pessoas | `slot-capacity-heuristic` | diversidade de subportadoras ativas / 2; **não** é contagem real (mesma ressalva do firmware, `firmware/esp32-csi-node/README.md:262`) |
| Vitais do ESP32 | `device-reported-unvalidated` | vem do pacote de vitais do firmware (magic `0xC5110002`); não é medida clínica |
| Respiração estimada | `estimated-heuristic` | pico espectral local no CSI, rótulo separado |
| Mudança no ambiente | signal-derived | assinatura RF desviou vs. baseline de calibração (móvel movido/objeto novo); **não classifica o objeto** |
| RSSI (sem ESP32) | grosseiro | só RSSI existe em placa normal (a sua RTL8821CE não expõe CSI) |

Não há identidade de pessoa, pose ou contagem confiável — e nenhuma claim disso.

## Hardware

- **ESP32-S3/C6** com `firmware/esp32-csi-node` → CSI real (UDP 5005). É o caminho bom.
- **Roteador/PC/celular comum** → só RSSI via `nmcli`. Sem CSI, sem contagem/vitais.
- A sua placa atual (Realtek RTL8821CE, `wlp2s0`) **não expõe CSI** — use o
  modo `rssi` ou plugue um ESP32 e use `auto`/`esp32`.

## Estrutura

```
src/
  parse.js      parser ADR-018 (CSI) + packet de vitais (espelha esp32_parser.rs)
  pipeline.js   presença/movimento/contagem/vitais/mudança de ambiente
  rssi.js       fallback RSSI via nmcli
  server.js     UDP + HTTP + SSE
  cli.js        CLI (bin: ruview-sense)
  monitor.html  página do monitor
test/           node:test
```
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
- `GET/POST /api/v1/sensitivity` — leitura/alteração do modo (`{mode:"high"|"normal"}`)
- `GET/POST /api/v1/modules` — liga/desliga módulos de detecção
  (`{presence,motion,count,vitals,envChange}`; desligado ⇒ zero no estado publicado)
- `GET /api/v1/room` — planta 3D (nós WiFi + obstáculos)
- `POST /api/v1/room/obstacles` — adiciona `{kind:"wall"|"box",x,z}`
- `DELETE /api/v1/room/obstacles/:id` — remove um obstáculo
- `POST /api/v1/room/reset` — volta à planta padrão
- `GET /api/v1/map` — mapa de sombras RF (células medidas + baseline)
- `POST /api/v1/map?action=start|stop|clear` — controla a sessão de varredura
- `POST /api/v1/map/sample` — `{x,z}`: grava a sombra RF viva na célula
- `POST /api/v1/map/demo` — só em fonte `simulated`; carrega um mapa sintético
- `GET /view3d.js` — renderer 3D do monitor (sem dependências, sem WebGL)

## Tela 3D

Monitor em tema **branco/preto/vermelho** com vista 3D em canvas (software —
sem WebGL). Três camadas:

1. **Ponto WiFi** — halo preto/vermelho que pulsa conforme presença/movimento e
   acelera no modo EXTREMA.
2. **Planta editável** — paredes e objetos que você adiciona clicando no chão
   (arraste para orbitar, scroll para zoom, botão direito move a câmera).
3. **Mapa de sombras RF** — o único dado que é o ambiente **real**: aperte
   **"Mapear (sombra RF real)"**, ande pela sala e clique, no chão, onde você
   está. A cada clique a ferramenta grava a atenução atual do WiFi vs. a linha
   de base ociosa e renderiza colunas vermelhas proporcionais à sombra —
   móveis e corpos escurecem o enlace e viram volume no 3D.

Honestidade: um único nó CSI **não** triangula obstáculos — a obra 3D é
varredura de sombras + a planta que você desenha, não reconstrução de objetos.

## Modo de sensibilidade

`POST /api/v1/sensitivity {"mode":"high"}` liga a **sensibilidade extrema**: o
motor reage a qualquer variação de RF (σ ativo 2 em vez de 3, limiares de
presença/movimento/ambiente bem menores, baseline de calibração mais rápida). O
sinal `rawDelta` no estado indica a mudança **bruta** por frame — qualquer
coisa no ambiente, inclusive interferência, muda o valor. Honestidade: alta
reação também significa mais **falsos positivos** (respiração, chuva, celular
combinando canal, etc.).

## Testes

```bash
cd tools/ruview-sense && node --test
```

Hoje: 19 testes cobrindo o parser ADR-018 (magic, geometria, multi-antena,
packet de vitais, erros), o pipeline (presença, movimento, mudança de
ambiente, heurística de contagem, vitais, RSSI), os endpoints HTTP de
planta/sensibilidade/modulos e o mapa de sombras RF.

## O que cada número é — honestidade (contrato AGENTS.md)

| Valor | Grade real | Explicação |
|---|---|---|
| Presença / movimento | signal-derived | desvio > `activeSigma` σ da linha de base calibrada por subportadora (3 normal, 2 extremo) |
| Pessoas | `slot-capacity-heuristic` | diversidade de subportadoras ativas / 2; **não** é contagem real (mesma ressalva do firmware, `firmware/esp32-csi-node/README.md:262`) |
| `rawDelta` | signal-derived | mudança **bruta** de energia RF entre frames consecutivos; em sensibilidade extrema reage a qualquer variação, inclusive interferência |
| Sombra RF (mapa) | signal-derived | atenução do `rssiDbm` vs. baseline ocioso + atividade; colunas vermelhas no 3D mostram onde o sinal cair — **não identifica** o que causa a sombra (móvel, corpo, interferência) |
| Vitais do ESP32 | `device-reported-unvalidated` | vem do pacote de vitais do firmware (magic `0xC5110002`); não é medida clínica |
| Respiração estimada | `estimated-heuristic` | pico espectral local no CSI, rótulo separado |
| Mudança no ambiente | signal-derived | assinatura RF desviou vs. baseline de calibração (móvel movido/objeto novo); **não classifica o objeto** |
| RSSI (sem ESP32) | grosseiro | só RSSI existe em placa normal (a sua RTL8821CE não expõe CSI) |

Não há identidade de pessoa, pose ou contagem confiável — e nenhuma claim disso.

Enquanto não há botão físico: para ligar rapidamente o modo extremo na demo,
`curl -X POST -H 'content-type: application/json' -d '{"mode":"high"}' http://localhost:8080/api/v1/sensitivity`
(ou clique no botão "Sensibilidade" no monitor).

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
  room.js       planta 3D (nós WiFi, obstáculos, validação)
  server.js     UDP + HTTP + SSE
  cli.js        CLI (bin: ruview-sense)
  monitor.html  página do monitor
  view3d.js     renderer 3D software (sem WebGL/dependências)
test/           node:test
```
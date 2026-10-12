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
  (`{presence,motion,count,vitals,envChange,size,track,radar}`; desligado ⇒ zero no estado publicado)
- `GET /api/v1/deformation` — detalhe da deformidade: classe de tamanho, seção
  reta estimada (cm), span ativo, profundidade (dB), coerência e perfil por
  subportadora
- `GET /api/v1/humans` — candidatos humanos rastreados: `{humans, count, moving,
  grade}` com posição transversal, velocidade, confiança e tamanho
- `GET /api/v1/radar` — perfil de atraso (IFFT da onda CSI, MTI cancela o
  clutter estático), resolução de alcance, pico, retorno (dB) e alcance
  grosseiro por RSSI (`{radar, humans, grade}`)
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

Dashboard em **tema dark retro** (verde/vermelho/branco, monoespaçado, efeito
CRT) com vista 3D **WebGL via Three.js vendored** (offline, alta performance).
O 3D é atualizado a cada **200 ms** a partir dos dados vivos. O cenário é
renderizado como **nuvem de mini-pontos brancos** (matriz holográfica), não mais
como blocos sólidos, sobre a qual roda a varredura tipo radar:

1. **Nuvem de pontos** — milhares de pontos brancos preenchendo a sala; a
   opacidade "respira" com a energia RF viva (efeito sonar).
2. **Varredura + sonar** — anéis de alcance concêntricos no piso do nó, um feixe
   giratório com rastro e um "ping" que se expande a cada ~2,4 s.
3. **Alvos** — cada humano rastreado é um **anel vermelho pulsante** no escopo,
   com um feixe ligando-o ao nó (vermelho = em movimento, laranja = parado).
4. **Planta editável** — paredes/objetos que você adiciona clicando no chão
   (arraste orbita, scroll dá zoom, botão direito move a câmera).
5. **Mapa de sombras RF** — o único dado do ambiente **real**: aperte
   **"Mapear (sombra RF real)"**, ande pela sala e clique, no chão, onde você
   está. A cada clique a ferramenta grava a atenuação atual vs. a linha de base
   ociosa e acende pontos brancos→vermelhos proporcionais à sombra.

Abaixo do 3D há também um **escopo PPI 2-D** (anéis de alcance, varredura e os
mesmos alvos vermelhos).

Honestidade: um único nó CSI **não** triangula obstáculos **nem** localiza um
corpo em 2-D — a obra 3D é nuvem + varredura de sombras sobre a planta que você
desenha, não reconstrução de objetos. O alcance é grosseiro (RSSI) e o ângulo é
proxy 1-D (direção ambígua).

## Tamanho da deformidade (detecção humano-tamanho)

O corpo não muda todas as subportadoras igual: ele "deforma" o canal numa
**faixa contígua**. O motor mede o formato dessa deformação — extensão
(subportadoras), profundidade (dB), coerência (autocorrelação) — e estima a
**seção reta transversal** pelo modelo da 1ª zona de Fresnel:

```
r1 = sqrt(lambda * D / 4)          (enlace simétrico, D = 4 m por padrão)
seção ≈ 2 * r1 * sqrt(fração_ativa)
```

Classes: `none` → `tiny` (< 8 cm) → `small` (8–20 cm) → `human` (20–55 cm) →
`large` (≥ 55 cm). `humanDetected` só vira `SIM` quando a deformação é
humano-tamanho, profunda o suficiente, coerente e **persiste** alguns frames
(guarda contra falso positivo). A tela mostra o cartão "Tamanho da deformidade",
o perfil por subportadora e um elipsoide do tamanho estimado no 3D.

Honestidade:
- É **transversal**, não ao longo do caminho: com 20 MHz a resolução de alcance é
  `c/(2·BW) ≈ 7,5 m` — não dá para medir o tamanho na direção de propagação.
- Um **objeto movido do mesmo tamanho** (sofá, caixa grande) também lê
  humano-tamanho. É tamanho de sinal, não identidade/pose/contagem confiável.

## Possíveis humanos em movimento (rastreio em tempo real)

O **centro da faixa ativa** de subportadoras é um proxy monótono de onde o corpo
está no enlace. Conforme a pessoa anda, esse centro desliza; o rastreador
(`src/tracker.js`) associa as detecções frame a frame, estima velocidade e
confiança e publica uma lista de **candidatos humanos**. `motion` eleva a
confiança; sem evidência a confiança decai e o candidato é podado.

Aparecem em tempo real no monitor (lista + pista 1-D) e no 3D (blips na "pista
de sensoriamento", vermelho = em movimento), atualizados a cada ~200 ms sobre o
stream SSE de 100 ms. Endpoint: `GET /api/v1/humans`. Módulo `track` liga/desliga.

Honestidade (`track-heuristic`):
- A posição é um **proxy transversal 1-D** (0..1 no enlace); a **direção é
  ambígua** e **não há alcance** — um único nó não localiza em 2-D.
- Um enlace **não separa** duas pessoas no mesmo ponto; quando o corpo "salta"
  além do portão de associação, um novo candidato nasce (fragmentação honesta).
- É candidato, **não** identidade. Um objeto movido do tamanho de um corpo
  também pode rastrear como humano-tamanho.

## Radar / sonar (perfil de atraso do CSI)

O CSI de OFDM é uma resposta de canal amostrada em frequência: a **IFFT** sobre
as subportadoras (`src/radar.js`) dá um **perfil de atraso** — quanta energia
volta em cada atraso de caminho. Como a linha de base da sala vazia é conhecida,
o radar faz **MTI**: aplica a IFFT sobre o **desvio** `amp - baseline`, o que
cancela o clutter estático (paredes, móveis) e deixa só os retornos do alvo em
movimento. O módulo `radar` liga/desliga; endpoint `GET /api/v1/radar`.

No monitor isso anima a varredura e os "pings" do 3D e o escopo PPI 2-D.

Honestidade:
- **Resolução de alcance** = `c/(2·BW)`; com 20 MHz são `≈ 7,5 m` — o perfil
  **não** resolve a distância de uma pessoa. O pico do perfil (`peakRangeM`) é
  reportado como está, sem fingir precisão.
- O **alcance** mostrado no escopo vem do **RSSI** (modelo de perda de percurso)
  ⇒ `range-heuristic`, com EMA e limitado a 0,5–12 m.
- O **ângulo** é a posição 1-D no enlace ⇒ `bearing-proxy`; a direção é ambígua.
- Portanto é um radar **de aparência**: mede o perfil de atraso de verdade, mas
  distância e direção são heurística/proxy, não localização 2-D.

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

Hoje: 44 testes cobrindo o parser ADR-018 (magic, geometria, multi-antena,
packet de vitais, erros), o pipeline (presença, movimento, mudança de
ambiente, heurística de contagem, vitais, RSSI), o estimador de deformidade
(Fresnel, classes de tamanho, coerência, posição, resolução de alcance), o
rastreador de humanos (associação, confiança, movimento, poda), o radar (FFT,
perfil de atraso, alcance por RSSI, resolução) e os endpoints HTTP de
planta/sensibilidade/modulos/deformidade/humanos/radar e o mapa de sombras RF.

## O que cada número é — honestidade (contrato AGENTS.md)

| Valor | Grade real | Explicação |
|---|---|---|
| Presença / movimento | signal-derived | desvio > `activeSigma` σ da linha de base calibrada por subportadora (3 normal, 2 extremo) |
| Tamanho da deformidade | `estimated-heuristic` | seção reta transversal pelo modelo da 1ª zona de Fresnel a partir da faixa ativa; **não** resolve o tamanho ao longo do caminho (20 MHz ⇒ ~7,5 m) e um objeto do mesmo tamanho lê igual |
| `humanDetected` | `estimated-heuristic` | deformação humano-tamanho + profundidade + coerência, persistente por alguns frames — **não** é identidade nem contagem |
| Humanos em movimento | `track-heuristic` | candidatos rastreados 1-D pela posição da faixa ativa no enlace; posição é proxy transversal (direção ambígua), sem alcance; um nó não separa pessoas no mesmo ponto |
| Perfil de atraso (radar) | `delay-profile-measured` | IFFT real da onda CSI com MTI (desvio vs. baseline); resolução de alcance 20 MHz ⇒ ~7,5 m, então **não** resolve a distância de uma pessoa |
| Alcance (radar) | `range-heuristic` | distância estimada de `rssiDbm` por modelo de perda de percurso (EMA, 0,5–12 m) — grosseira, não é medição radar |
| Ângulo (radar) | `bearing-proxy` | posição 1-D no enlace; direção ambígua, sem azimute real |
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
  deform.js     tamanho da deformidade (modelo Fresnel) + detector humano-tamanho
  tracker.js    rastreio 1-D de candidatos humanos (associação, confiança, movimento)
  radar.js      perfil de atraso (IFFT/MTI do CSI) + alcance por RSSI
  rssi.js       fallback RSSI via nmcli
  room.js       planta 3D (nós WiFi, obstáculos, validação)
  server.js     UDP + HTTP + SSE
  cli.js        CLI (bin: ruview-sense)
  monitor.html  página do monitor (tema dark retro)
  view3d.js     renderer WebGL (Three.js vendored)
  vendor/       three.module.min.js (r160, MIT, offline)
test/           node:test
```
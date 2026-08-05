# ARGOS Porangatu

Malha cognitiva de dois clusters sobre a rede de distribuição e a conectividade
agro de Porangatu / GO (IBGE 5218003). Node.js, zero dependências externas.

## Tese

A fibra do agro sobe no poste da distribuidora — compartilhamento regulado por
resolução conjunta ANEEL/Anatel. Mesmo corredor físico, mesma falha. Modelar as
duas camadas separadamente esconde o modo de falha que importa.

## Arquitetura

    L0  relé / FPGA        µs–ms    nunca implementado aqui — atuação não é IA
    L1  solver + Polo V    ms–s     determinístico
    L2  malha de 24 células s–min    quantificação, gossip, atribuição de causa

Nenhuma célula calcula fluxo de potência.

### Cluster REDE (C01–C16)
Demanda, geração, rede e cenário. Alimenta o solver de varredura
backward/forward — escolhido no lugar de Newton-Raphson porque a relação R/X
alta da distribuição deixa a jacobiana mal condicionada.

### Cluster AGRO (G01–G08)
Backhaul de fibra em cadeia daisy-chain, PoPs, ERBs, pivôs centrais,
estado de carga dos bancos de bateria.

### Acoplamento (telegramas URB1, CRC16-CCITT)
    REDE → AGRO   barra < 0,90 pu tira o retificador do PoP da faixa de
                  entrada CA e joga o site para bateria
    AGRO → REDE   pivô sem telemetria perde o agendamento remoto, volta ao
                  temporizador local e deixa de fugir do horário de ponta

O gossip itera até o conjunto de ativos afetados estabilizar (Jaccard = 1).

## Invariantes verificados

    I = conj(S/V)                    não conj(S)/V
    I_primário = t · I_secundário    o tap não cria potência
    P_fonte = P_entregue + perdas    resíduo < 1e-5 MW em todos os casos
    CRC16-CCITT("123456789") = 0x29B1

## Base cartográfica

Web Mercator implementado direto — sem Leaflet, sem npm. O overlay SVG usa a
mesma função de projeção dos tiles, então alinha em qualquer zoom. Validado:
SE → ponta de AL-04 dá 30,01 km pela projeção contra 30,03 km pela topologia.

Os pivôs são desenhados com **raio real no terreno** (√(A/π); 100 ha = 564 m),
então no modo satélite os círculos do overlay caem sobre os círculos de
irrigação visíveis na imagem.

    Escuro     CARTO dark_all      © OpenStreetMap · © CARTO
    Satélite   Esri World Imagery  © Esri, Maxar, Earthstar Geographics
    Sem base   só o overlay

A CSP libera apenas esses dois hosts em `img-src`. Trocar de provedor exige
editar a CSP em `server.js` — é intencional.

## Rodar

    node teste.js        29 asserções
    node preflight.js    checagem de produção
    node server.js       http://0.0.0.0:3000

## Rotas

    GET  /api/saude
    GET  /api/topologia
    POST /api/simular      cenário instantâneo
    POST /api/dia          varredura de 24 h com SoC das baterias
    GET  /api/stream       SSE dos telegramas URB1

## Subir o sistema

### 1. Local, no Termux

    pkg install nodejs-lts git
    cd argos-porangatu
    node teste.js        # 29 asserções
    node preflight.js    # checagem de produção
    node server.js       # http://localhost:3000

Sem `npm install` — não há o que instalar.

### 2. GitHub

    git init && git add -A
    git commit -m "ARGOS Porangatu"
    git branch -M main
    git remote add origin git@github.com:USUARIO/argos-porangatu.git
    git push -u origin main

### 3. Render — via Blueprint

O `render.yaml` já está pronto. No painel: **New → Blueprint**, aponte para o
repositório, confirme. Ele lê o arquivo e cria o serviço com tudo configurado.

### 3-alt. Render — manual

    New → Web Service → conectar o repositório
    Runtime         Node
    Build Command   (vazio, ou: echo sem dependencias)
    Start Command   node server.js
    Health Check    /api/saude
    Environment     HOST=0.0.0.0
                    NODE_ENV=production

**`HOST=0.0.0.0` não é opcional.** Sem isso o Node escuta em `127.0.0.1`, o
proxy do Render não alcança o processo e o deploy fica em "port scan timeout".
Não defina `PORT` — o Render injeta a dele e o `server.js` já lê de `process.env`.

### Depois de subir

    curl https://SEU-APP.onrender.com/api/saude

Se responder `{"ok":true,...}`, está no ar.

### Notas de operação

- **Sem disco persistente.** Todo o estado é derivado do cenário a cada
  requisição. Não configure disco — o free tier fica mais simples.
- **Free tier hiberna** após ~15 min sem tráfego. A primeira requisição depois
  disso leva 30–50 s. O health check do Render mantém o serviço acordado
  enquanto ele estiver ativo, mas não impede a hibernação no plano gratuito.
- **CPU.** A varredura de 24 h leva ~120 ms local. No free tier conte com 3–5×
  isso. Se ficar pesado, reduza `MAX_RODADAS` em `nucleo/malha.js`.
- **Tiles.** São buscados pelo navegador do usuário, não pelo servidor. Não
  consomem banda nem CPU do Render.

## Limites honestos

- O traçado dos alimentadores é **sintético**, com o esquema de campos da BDGD
  (CTMT, SSDMT, UNTRMT, EQRE, UGBT). Não é a rede real da Equatorial Goiás.
  Trocar pela base da ANEEL é mapeamento de campo, não reescrita.
- Solver monofásico equivalente. Desequilíbrio entre fases exige formulação
  trifásica.
- A camada de conectividade é um modelo de topologia e energia, não medição.

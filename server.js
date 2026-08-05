'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   ARGOS PORANGATU · arquivo único · zero dependências

   Malha de 24 células em dois clusters sobre a rede de distribuição 13,8 kV
   e a conectividade agro de Porangatu / GO (IBGE 5218003).

   Render:   Build Command  echo ok
             Start Command  node server.js
             Environment    HOST=0.0.0.0

   Local:    node server.js            sobe em http://localhost:3000
             node server.js --teste    roda o autoteste e sai
   ═══════════════════════════════════════════════════════════════════════════ */

const http = require('http');
const { URL } = require('url');


/* ═══════════════ ARITMÉTICA COMPLEXA ═══════════════ */
const C = (function () {
  // Aritmetica complexa minima. Sem dependencias.
  return {
    add:  (a,b) => ({ re:a.re+b.re, im:a.im+b.im }),
    sub:  (a,b) => ({ re:a.re-b.re, im:a.im-b.im }),
    mul:  (a,b) => ({ re:a.re*b.re - a.im*b.im, im:a.re*b.im + a.im*b.re }),
    esc:  (a,k) => ({ re:a.re*k, im:a.im*k }),
    div:  (a,b) => { const d=b.re*b.re+b.im*b.im;
                     return { re:(a.re*b.re+a.im*b.im)/d, im:(a.im*b.re-a.re*b.im)/d }; },
    conj: (a)   => ({ re:a.re, im:-a.im }),
    abs:  (a)   => Math.hypot(a.re,a.im)
  };
})();


/* ═══════════════ PROTOCOLO URB1 ═══════════════ */
const U = (function () {
  /* Protocolo URB1 — telegrama hexadecimal entre clusters.
     MAGIC(4) | ORIGEM(1) | DESTINO(1) | TIPO(1) | SEQ(2) | LEN(2) | PAYLOAD | CRC16(2)
     MAGIC = 0x55524231 ("URB1") · CRC16-CCITT poly 0x1021 init 0xFFFF                   */
  const MAGIC = 0x55524231;

  const CLUSTER = { REDE: 0x01, AGRO: 0x02, VERIFICADOR: 0x0F };

  const TIPO = {
    INTERRUPCAO : 0x11,   // REDE -> AGRO : barras sem tensao adequada e duracao estimada
    TELEMETRIA  : 0x21,   // AGRO -> REDE : pivos que perderam telemetria
    CONVERGENCIA: 0x31,   // fecho de rodada de gossip
    VERIFICACAO : 0x41    // resultado do Polo V
  };

  function crc16ccitt(buf) {
    let crc = 0xFFFF;
    for (const b of buf) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++)
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc & 0xFFFF;
  }

  function montar(origem, destino, tipo, seq, objeto) {
    const payload = Buffer.from(JSON.stringify(objeto), 'utf8');
    const cab = Buffer.alloc(11);
    cab.writeUInt32BE(MAGIC, 0);
    cab.writeUInt8(origem, 4);
    cab.writeUInt8(destino, 5);
    cab.writeUInt8(tipo, 6);
    cab.writeUInt16BE(seq & 0xFFFF, 7);
    cab.writeUInt16BE(payload.length, 9);
    const corpo = Buffer.concat([cab, payload]);
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(crc16ccitt(corpo), 0);
    return Buffer.concat([corpo, crc]);
  }

  function ler(quadro) {
    if (quadro.length < 13)                 throw new Error('URB1: quadro curto');
    if (quadro.readUInt32BE(0) !== MAGIC)   throw new Error('URB1: magic invalido');
    const len = quadro.readUInt16BE(9);
    if (quadro.length !== 11 + len + 2)     throw new Error('URB1: comprimento inconsistente');
    const crcLido = quadro.readUInt16BE(11 + len);
    const crcCalc = crc16ccitt(quadro.subarray(0, 11 + len));
    if (crcLido !== crcCalc)                throw new Error('URB1: CRC16 divergente');
    return {
      origem : quadro.readUInt8(4),
      destino: quadro.readUInt8(5),
      tipo   : quadro.readUInt8(6),
      seq    : quadro.readUInt16BE(7),
      objeto : JSON.parse(quadro.subarray(11, 11 + len).toString('utf8')),
      bytes  : quadro.length,
      hex    : quadro.toString('hex').toUpperCase()
    };
  }

  // Indice de Jaccard — criterio de convergencia do gossip entre clusters
  function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    if (A.size === 0 && B.size === 0) return 1;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
  }

  return { MAGIC, CLUSTER, TIPO, crc16ccitt, montar, ler, jaccard };
})();


/* ═══════════════ TOPOLOGIA DE PORANGATU ═══════════════ */
const D = (function () {
  /* Topologia de Porangatu / GO — duas camadas sobre a MESMA infraestrutura de postes.
     Camada 1: rede de distribuicao 13,8 kV (esquema de campos BDGD)
     Camada 2: backhaul de fibra e ERBs do agro, fixados nos postes da distribuidora
               (Resolucao Conjunta ANEEL/Anatel — compartilhamento de postes)
     Tracado sintetico e geograficamente plausivel. NAO e a rede real. */

  const SE = { lat: -13.4585, lon: -49.1705, nome: 'SE PORANGATU', at: '138/69/13,8 kV' };
  const IBGE = '5218003';

  // Condutores CAA — R, X em ohm/km e ampacidade
  const COND = {
    linnet : { r: 0.190, x: 0.400, amp: 530, nome: 'CAA 336,4 MCM' },
    penguin: { r: 0.367, x: 0.420, amp: 340, nome: 'CAA 4/0 AWG'  },
    raven  : { r: 0.583, x: 0.440, amp: 240, nome: 'CAA 1/0 AWG'  }
  };

  // CTMT — circuitos de media tensao
  const CTMT = [
    { id:'AL-01', nome:'Centro',            classe:'comercial',   kva:6200, cond:'linnet',  nb: 9, regs:[],
      wp:[[-13.4585,-49.1705],[-13.4506,-49.1602],[-13.4432,-49.1521],[-13.4372,-49.1447],[-13.4338,-49.1389]] },
    { id:'AL-02', nome:'Setor Leste',       classe:'residencial', kva:5000, cond:'penguin', nb:10, regs:[],
      wp:[[-13.4585,-49.1705],[-13.4529,-49.1571],[-13.4463,-49.1436],[-13.4419,-49.1330],[-13.4402,-49.1236]] },
    { id:'AL-03', nome:'Industrial BR-153', classe:'industrial',  kva:8000, cond:'linnet',  nb: 8, regs:[],
      wp:[[-13.4585,-49.1705],[-13.4668,-49.1682],[-13.4771,-49.1651],[-13.4884,-49.1607],[-13.4996,-49.1558]] },
    { id:'AL-04', nome:'Rural Norte',       classe:'rural',       kva:3400, cond:'penguin', nb:14, regs:[5,10],
      wp:[[-13.4585,-49.1705],[-13.4243,-49.1789],[-13.3792,-49.1863],[-13.3204,-49.1918],[-13.2561,-49.1974],[-13.1908,-49.2043]] },
    { id:'AL-05', nome:'Rural Sul',         classe:'rural',       kva:2400, cond:'raven',   nb:12, regs:[4,8],
      wp:[[-13.4585,-49.1705],[-13.4869,-49.1932],[-13.5241,-49.2226],[-13.5688,-49.2559],[-13.6142,-49.2901]] }
  ];

  const R_TERRA = 6371, D2R = Math.PI / 180;

  function distKm(a, b) {
    const dLat = (b[0]-a[0]) * D2R;
    const dLon = (b[1]-a[1]) * D2R * Math.cos(((a[0]+b[0])/2) * D2R);
    return Math.hypot(dLat, dLon) * R_TERRA;
  }
  const interp = (a,b,t) => [ a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t ];

  function construirEletrica() {
    const buses = [{ id:'SE', ctmt:null, pos:[SE.lat,SE.lon], km:0, kva:0, classe:'fonte', reg:false }];
    const branches = [];
    for (const al of CTMT) {
      const segs = []; let total = 0;
      for (let i = 1; i < al.wp.length; i++) { const d = distKm(al.wp[i-1], al.wp[i]); segs.push(d); total += d; }
      al.kmTotal = total; al.busIdx = [];
      let prev = 0;
      for (let n = 1; n <= al.nb; n++) {
        const t = n/al.nb, alvo = t*total;
        let acc = 0, pos = al.wp[al.wp.length-1];
        for (let i = 0; i < segs.length; i++) {
          if (acc + segs[i] >= alvo) { pos = interp(al.wp[i], al.wp[i+1], (alvo-acc)/segs[i]); break; }
          acc += segs[i];
        }
        // urbano concentra carga perto da SE; rural concentra na ponta (pivos)
        const w = al.classe === 'rural' ? (0.55 + 0.90*t) : (1.45 - 0.75*t);
        const idx = buses.length;
        buses.push({ id:`${al.id}-${String(n).padStart(2,'0')}`, ctmt:al.id, pos, km:alvo,
                     kva:al.kva*w, classe:al.classe, ordem:n, reg:(al.regs||[]).includes(n) });
        const c = COND[al.cond], dl = total/al.nb;
        branches.push({ from:prev, to:idx, r:c.r*dl, x:c.x*dl, km:dl, cond:al.cond, ctmt:al.id });
        al.busIdx.push(idx); prev = idx;
      }
      const soma = al.busIdx.reduce((s,i) => s + buses[i].kva, 0);
      al.busIdx.forEach(i => { buses[i].kva *= al.kva / soma; });
    }
    return { buses, branches };
  }

  const ELET = construirEletrica();
  const S_BASE = 10, V_BASE = 13.8, Z_BASE = V_BASE*V_BASE / S_BASE;
  ELET.branches.forEach(b => { b.rpu = b.r / Z_BASE; b.xpu = b.x / Z_BASE; });

  const idxDe = id => ELET.buses.findIndex(b => b.id === id);

  /* ---------------------------------------------------------------
     CAMADA 2 — conectividade
     A fibra sobe no poste da distribuidora e segue o mesmo tracado.
     Cada PoP e alimentado por uma barra de MT. Cadeia daisy-chain:
     perder um PoP a montante derruba todos os de jusante.
     --------------------------------------------------------------- */
  const POPS = [
    { id:'POP-00', nome:'Headend Centro',  barra:'AL-01-01', montante:null,     autonomiaH:8.0, uplinkMbps:10000, assinantes:4200, satelite:true  },
    { id:'POP-IND',nome:'Industrial',      barra:'AL-03-06', montante:'POP-00', autonomiaH:6.0, uplinkMbps: 2000, assinantes: 180, satelite:true  },
    { id:'POP-N1', nome:'Rural Norte 1',   barra:'AL-04-05', montante:'POP-00', autonomiaH:4.0, uplinkMbps: 1000, assinantes: 310, satelite:false },
    { id:'POP-N2', nome:'Rural Norte 2',   barra:'AL-04-10', montante:'POP-N1', autonomiaH:3.0, uplinkMbps:  600, assinantes: 190, satelite:false },
    { id:'POP-N3', nome:'Rural Norte 3',   barra:'AL-04-14', montante:'POP-N2', autonomiaH:2.0, uplinkMbps:  300, assinantes:  95, satelite:false },
    { id:'POP-S1', nome:'Rural Sul 1',     barra:'AL-05-04', montante:'POP-00', autonomiaH:4.0, uplinkMbps: 1000, assinantes: 240, satelite:false },
    { id:'POP-S2', nome:'Rural Sul 2',     barra:'AL-05-08', montante:'POP-S1', autonomiaH:2.5, uplinkMbps:  400, assinantes: 130, satelite:true  }
  ];
  POPS.forEach(p => { const i = idxDe(p.barra); p.busIdx = i; p.pos = ELET.buses[i].pos; });

  // ERBs 4G/5G — tambem alimentadas pela rede de distribuicao
  const ERBS = [
    { id:'ERB-URB', nome:'Porangatu urbana', barra:'AL-02-03', autonomiaH:4.0, raioKm: 6, tec:'5G' },
    { id:'ERB-N',   nome:'Torre Norte',      barra:'AL-04-08', autonomiaH:3.0, raioKm: 8, tec:'4G' },
    { id:'ERB-S',   nome:'Torre Sul',        barra:'AL-05-06', autonomiaH:2.5, raioKm: 7, tec:'4G' }
  ];
  ERBS.forEach(e => { const i = idxDe(e.barra); e.busIdx = i; e.pos = ELET.buses[i].pos; });

  // Pivos centrais e talhoes — gerados ao longo dos alimentadores rurais
  function construirPivos() {
    const pivos = []; let n = 0;
    for (const al of CTMT.filter(a => a.classe === 'rural')) {
      for (const bi of al.busIdx) {
        const b = ELET.buses[bi];
        if (b.ordem % 2 !== 0) continue;                      // um par de pivos a cada 2 barras
        for (let k = 0; k < 2; k++) {
          n++;
          const desvio = (k === 0 ? 1 : -1) * 0.011;
          const pos = [ b.pos[0] + desvio*0.6, b.pos[1] + desvio ];
          const areaHa = 78 + ((n * 37) % 60);                // 78-137 ha por pivo
          pivos.push({ id:`PIV-${String(n).padStart(2,'0')}`, pos, areaHa, barra:b.id, busIdx:bi,
                       ctmt:al.id, kwBomba: Math.round(areaHa * 1.35) });
        }
      }
    }
    return pivos;
  }
  const PIVOS = construirPivos();

  // Cada pivo se liga ao PoP e a ERB mais proximos
  for (const p of PIVOS) {
    let melhorPop = null, dp = Infinity;
    for (const q of POPS) { const d = distKm(p.pos, q.pos); if (d < dp) { dp = d; melhorPop = q.id; } }
    let melhorErb = null, de = Infinity;
    for (const e of ERBS) { const d = distKm(p.pos, e.pos); if (d < de && d <= e.raioKm) { de = d; melhorErb = e.id; } }
    p.pop = melhorPop; p.kmPop = dp;
    p.erb = melhorErb; p.kmErb = melhorErb ? de : null;
  }

  const AREA_AGRICOLA_HA = PIVOS.reduce((s,p) => s + p.areaHa, 0);
  const FIBRA_KM = POPS.filter(p => p.montante)
    .reduce((s,p) => s + distKm(p.pos, POPS.find(q => q.id === p.montante).pos), 0);

  return {
    SE, IBGE, COND, CTMT, ELET, POPS, ERBS, PIVOS,
    S_BASE, V_BASE, Z_BASE, AREA_AGRICOLA_HA, FIBRA_KM,
    distKm, idxDe
  };
})();


/* ═══════════════ FLUXO DE POTÊNCIA ═══════════════ */
const F = (function () {
  /* Fluxo de potencia radial — varredura backward/forward.
     Escolhido no lugar de Newton-Raphson porque redes de distribuicao tem
     relacao R/X alta e a jacobiana fica mal condicionada.

     Invariantes garantidos e verificados em teste.js:
       (a) I = conj(S/V)                      — nao conj(S)/V
       (b) autotrafo ideal: Iprim = t * Isec   — o tap nao cria potencia
       (c) P_fonte = P_entregue + perdas       — residuo ~ 0 */


  // EQRE: +-10% em 32 degraus de 0,625%, setpoint 1,025 pu, banda morta +-0,0125
  const EQRE = { passo: 0.00625, min: 0.90, max: 1.10, alvo: 1.025, banda: 0.0125 };
  const FP = 0.92;                                  // fator de potencia das cargas
  const ZIP = { z: 0.40, i: 0.20, p: 0.40 };        // modelo de carga

  function resolver(net, opc) {
    const { vsrc, cargasKVA, injMW, capMVAr, regAtivo, sBase } = opc;
    const eps = opc.eps || 1e-9, maxit = opc.maxit || 200;
    const n = net.buses.length;

    const filhos = net.buses.map(() => []);
    const brDe = new Array(n).fill(-1);
    net.branches.forEach((b, k) => { filhos[b.from].push(b.to); brDe[b.to] = k; });

    const ordem = [0];
    for (let i = 0; i < ordem.length; i++) filhos[ordem[i]].forEach(c => ordem.push(c));

    const regs = net.buses.map((b, i) => b.reg ? i : -1).filter(i => i > 0);
    const taps = new Array(n).fill(1);
    const I = net.branches.map(() => ({ re: 0, im: 0 }));
    const V = new Array(n).fill(0).map(() => ({ re: vsrc, im: 0 }));
    const tg = Math.tan(Math.acos(FP));
    let itTot = 0, err = 1, passesTap = 0;

    const varrer = () => {
      let it = 0; err = 1;
      while (err > eps && it < maxit) {
        const Vold = V.map(v => ({ ...v }));

        const Ibus = net.buses.map((b, i) => {
          if (i === 0) return { re: 0, im: 0 };
          const P = (cargasKVA[i] / 1000) / sBase;
          const Q = P * tg - ((capMVAr[i] || 0) / sBase);
          const Pl = P - ((injMW[i] || 0) / sBase);
          const m = C.abs(V[i]);
          const f = ZIP.z * m * m + ZIP.i * m + ZIP.p;
          return C.conj(C.div({ re: Pl * f, im: Q * f }, V[i]));   // (a) I = conj(S/V)
        });

        for (let i = ordem.length - 1; i >= 1; i--) {               // backward
          const b = ordem[i];
          let acc = { ...Ibus[b] };
          for (const c of filhos[b]) {                              // (b) Iprim = t * Isec
            const t = taps[c], Ic = I[brDe[c]];
            acc = C.add(acc, t === 1 ? Ic : C.esc(Ic, t));
          }
          I[brDe[b]] = acc;
        }

        for (let i = 1; i < ordem.length; i++) {                    // forward
          const b = ordem[i], k = brDe[b], br = net.branches[k];
          let vp = V[br.from];
          if (taps[b] !== 1) vp = C.esc(vp, taps[b]);
          V[b] = C.sub(vp, C.mul({ re: br.rpu, im: br.xpu }, I[k]));
        }

        err = 0;
        for (let i = 0; i < n; i++) err = Math.max(err, C.abs(C.sub(V[i], Vold[i])));
        it++;
      }
      itTot += it;
    };

    varrer();

    if (regAtivo) {                                                 // controle discreto de tap
      for (let p = 0; p < 16; p++) {
        let mudou = false;
        for (const i of regs) {
          const d = EQRE.alvo - C.abs(V[i]);
          if (Math.abs(d) > EQRE.banda) {
            const dg = Math.trunc(d / EQRE.passo);
            if (dg !== 0) {
              const novo = Math.min(EQRE.max, Math.max(EQRE.min, taps[i] + dg * EQRE.passo));
              if (Math.abs(novo - taps[i]) > 1e-9) { taps[i] = novo; mudou = true; }
            }
          }
        }
        passesTap = p + 1;
        if (!mudou) break;
        varrer();
      }
    }

    let perdas = 0;
    net.branches.forEach((br, k) => { const m = C.abs(I[k]); perdas += m * m * br.rpu; });

    let Sfonte = { re: 0, im: 0 };
    net.branches.forEach((br, k) => {
      if (br.from !== 0) return;
      const t = taps[br.to];
      Sfonte = C.add(Sfonte, C.mul(V[0], C.conj(t === 1 ? I[k] : C.esc(I[k], t))));
    });

    // (c) potencia efetivamente entregue, com ZIP avaliado na tensao final
    let entregueMW = 0;
    net.buses.forEach((b, i) => {
      if (i === 0) return;
      const m = C.abs(V[i]);
      const f = ZIP.z * m * m + ZIP.i * m + ZIP.p;
      entregueMW += ((cargasKVA[i] / 1000) - (injMW[i] || 0)) * f;
    });

    const perdasMW = perdas * sBase;
    const tapMedio = regs.length ? regs.reduce((a, i) => a + taps[i], 0) / regs.length : 1;

    return {
      V: V.map(C.abs), Vcomplexo: V, I, taps, tapMedio, regs,
      iteracoes: itTot, passesTap, erro: err, convergiu: err <= eps,
      perdasMW, entregueMW, PfonteMW: Sfonte.re * sBase,
      residuoMW: Sfonte.re * sBase - (entregueMW + perdasMW)
    };
  }

  return { resolver, EQRE, FP, ZIP };
})();

const { resolver, EQRE, FP, ZIP } = F;


/* ═══════════════ MALHA DE 24 CÉLULAS ═══════════════ */
const M = (function () {
  /* Malha cognitiva de dois clusters.

     Cluster REDE (C01..C16)  — variaveis eletricas
     Cluster AGRO (G01..G08)  — variaveis de conectividade

     Nenhuma celula calcula fluxo de potencia. Elas quantificam variaveis;
     o solver decide tensao e o Polo V decide conformidade.

     O acoplamento e fisico, nao decorativo:
       REDE -> AGRO : barras com tensao abaixo da faixa de entrada dos
                      retificadores dos PoPs (0,90 pu) jogam o PoP para bateria.
       AGRO -> REDE : pivo sem telemetria perde o agendamento remoto e volta
                      ao temporizador local, deixando de fugir do horario de ponta.
     O gossip itera ate o conjunto de ativos afetados estabilizar (Jaccard = 1). */


  const LIMIAR_RETIFICADOR = 0.90;   // faixa de entrada CA dos retificadores de telecom
  const MAX_RODADAS = 8;

  /* --------------------------------------------------------------- curvas */
  function irradiancia(s) {
    if (s.hora < 6 || s.hora > 18) return 0;
    const base = Math.pow(Math.sin(Math.PI * (s.hora - 6) / 12), 1.22);
    return Math.max(0, base * (1 - 0.34 * (1 - s.seca)));
  }
  function foraDePonta(h) {                       // pivo agendado foge da ponta 18h-21h
    if (h >= 21 || h < 6) return 1.00;
    if (h >= 18 && h < 21) return 0.18;
    return 0.55;
  }
  const gauss = (x, mu, sig) => Math.exp(-Math.pow((x - mu) / sig, 2));
  const curvaResidencial = s =>
    (0.42 + 0.30*gauss(s.hora,19.5,2.6) + 0.16*gauss(s.hora,7.5,2.2) + 0.10*gauss(s.hora,12.5,2.4))
    * (1 + 0.14*Math.max(0, Math.cos((s.mes-9)/12*2*Math.PI))) * s.cresc;
  const curvaComercial = s =>
    (s.hora>=8 && s.hora<=18 ? 0.92 : (s.hora>=19 && s.hora<=21 ? 0.62 : 0.24)) * s.cresc;
  const curvaFrigorifico = s => {
    const t = (s.hora>=5 && s.hora<15) ? 1.0 : ((s.hora>=15 && s.hora<23) ? 0.86 : 0.44);
    return (0.46 + 0.54*t) * (0.88 + 0.24*s.safra) * s.cresc;
  };

  /* =============================================================== CLUSTER REDE */
  function avaliarRede(s, pivosSemTelemetria) {
    const semTel = new Set(pivosSemTelemetria || []);
    const N = D.ELET;

    // fracao de bombeamento por barra rural, ponderada pelos pivos que ela atende
    const fatorRural = new Map();
    for (const p of D.PIVOS) {
      const f = semTel.has(p.id) ? 1.00 : foraDePonta(s.hora);   // sem telemetria = temporizador local
      const a = fatorRural.get(p.barra) || { kw: 0, kwEfetivo: 0 };
      a.kw += p.kwBomba; a.kwEfetivo += p.kwBomba * f;
      fatorRural.set(p.barra, a);
    }

    const mult = {
      residencial: curvaResidencial(s),
      comercial  : curvaComercial(s),
      industrial : curvaFrigorifico(s),
      rural      : 0   // resolvido por barra abaixo
    };

    const cargas = new Array(N.buses.length).fill(0);
    const inj    = new Array(N.buses.length).fill(0);
    const cap    = new Array(N.buses.length).fill(0);
    let somaKVA = 0, kwPivoTotal = 0, kwPivoEfetivo = 0;

    N.buses.forEach((b, i) => {
      if (i === 0) return;
      let m;
      if (b.classe === 'rural') {
        const a = fatorRural.get(b.id);
        const razao = a && a.kw > 0 ? a.kwEfetivo / a.kw : foraDePonta(s.hora);
        if (a) { kwPivoTotal += a.kw; kwPivoEfetivo += a.kwEfetivo; }
        m = s.seca * razao * 1.45;
      } else {
        m = mult[b.classe];
      }
      cargas[i] = b.kva * m;
      somaKVA += cargas[i];
    });

    const gdMW = s.gdMW * irradiancia(s);
    const peso = N.buses.map((b, i) => i === 0 ? 0 : (b.classe === 'rural' ? 0.7 : 1.0) * b.kva);
    const somaPeso = peso.reduce((a, b) => a + b, 0);
    N.buses.forEach((b, i) => { if (i > 0) inj[i] = gdMW * peso[i] / somaPeso; });

    const capTotal = s.cap ? 1.2 : 0;
    const alvosCap = N.buses.map((b, i) => b.reg ? i : -1).filter(i => i > 0);
    if (capTotal > 0 && alvosCap.length) alvosCap.forEach(i => { cap[i] = capTotal / alvosCap.length; });

    const vsrc = s.n1 ? 0.928 : 1.022;
    const r = resolver(N, { vsrc, cargasKVA: cargas, injMW: inj, capMVAr: cap,
                            regAtivo: s.reg, sBase: D.S_BASE });

    const cargaMW = somaKVA / 1000;
    const perdasPct = cargaMW > 0 ? 100 * r.perdasMW / cargaMW : 0;
    const Qliq = r.entregueMW * Math.tan(Math.acos(FP)) - capTotal;
    const carregPct = 100 * Math.hypot(r.entregueMW + r.perdasMW, Qliq) / 40;

    const celulas = [
      { dom:'Demanda', id:'C01', nome:'Residencial',       un:'×',     v: mult.residencial },
      { dom:'Demanda', id:'C02', nome:'Comercial',         un:'×',     v: mult.comercial },
      { dom:'Demanda', id:'C03', nome:'Frigorífico',       un:'×',     v: mult.industrial },
      { dom:'Demanda', id:'C04', nome:'Irrigação pivô',    un:'MW',    v: kwPivoEfetivo/1000 * s.seca * 1.45 },
      { dom:'Geração', id:'C05', nome:'GD fotovoltaica',   un:'MW',    v: gdMW },
      { dom:'Geração', id:'C06', nome:'Irradiância',       un:'pu',    v: irradiancia(s) },
      { dom:'Geração', id:'C07', nome:'Autoconsumo',       un:'%',     v: cargaMW>0 ? 100*Math.min(1, gdMW/Math.max(cargaMW,1e-6)) : 0 },
      { dom:'Geração', id:'C08', nome:'Injeção reversa',   un:'MW',    v: Math.max(0, gdMW - cargaMW*0.34) },
      { dom:'Rede',    id:'C09', nome:'Topologia MT',      un:'km',    v: N.branches.reduce((a,b)=>a+b.km,0) },
      { dom:'Rede',    id:'C10', nome:'Regulação EQRE',    un:'tap',   v: r.tapMedio },
      { dom:'Rede',    id:'C11', nome:'Banco capacitor',   un:'MVAr',  v: capTotal },
      { dom:'Rede',    id:'C12', nome:'Perdas técnicas',   un:'%',     v: perdasPct },
      { dom:'Cenário', id:'C13', nome:'Sazonalidade',      un:'seca',  v: s.seca },
      { dom:'Cenário', id:'C14', nome:'Safra',             un:'idx',   v: s.safra },
      { dom:'Cenário', id:'C15', nome:'Crescimento',       un:'×',     v: s.cresc },
      { dom:'Cenário', id:'C16', nome:'Contingência N-1',  un:'Vf pu', v: vsrc }
    ];

    const subtensao = N.buses
      .map((b, i) => ({ b, v: r.V[i] }))
      .filter(x => x.b.ctmt && x.v < LIMIAR_RETIFICADOR)
      .map(x => x.b.id);

    return { solver:r, celulas, cargas, inj, cargaMW, gdMW, perdasPct, carregPct,
             subtensao, kwPivoTotal, kwPivoEfetivo };
  }

  /* =============================================================== CLUSTER AGRO */
  /* Estado de carga do banco de baterias.
     Descarrega em autonomiaH horas; recarrega em ~3x esse tempo (retificador
     de telecom prioriza a carga util). Banco vazio = site fora. */
  const RECARGA = 3;
  function passoSoC(soc, autonomiaH, emBateria, dt) {
    const d = emBateria ? -dt/autonomiaH : +dt/(autonomiaH*RECARGA);
    return Math.max(0, Math.min(1, soc + d));
  }

  function avaliarAgro(s, subtensao, soc) {
    const semTensao = new Set(subtensao || []);
    const SOC = soc || new Map();
    const socDe = (id, autonomiaH) => {
      if (SOC.has(id)) return SOC.get(id);
      const dec = (s.decorridoH !== undefined && s.decorridoH !== null) ? s.decorridoH : s.duracaoH;
      return Math.max(0, 1 - dec/autonomiaH);      // modo instantaneo
    };

    // 1. PoP entra em bateria quando a barra que o alimenta sai da faixa do retificador
    const estado = new Map();
    for (const p of D.POPS) {
      const emBateria = semTensao.has(p.barra);
      const sc = socDe(p.id, p.autonomiaH);
      estado.set(p.id, { pop:p, emBateria, soc:sc, esgotado: emBateria && sc <= 0,
                         vivoPorSatelite:false, vivo:true });
    }
    // 2. cascata pela cadeia de fibra: perder o montante derruba o jusante
    const resolverVivo = (id, visitados = new Set()) => {
      if (visitados.has(id)) return false;
      visitados.add(id);
      const e = estado.get(id);
      if (e.esgotado) return false;
      if (!e.pop.montante) return true;
      const up = resolverVivo(e.pop.montante, visitados);
      if (up) return true;
      if (e.pop.satelite && s.satelite) { e.vivoPorSatelite = true; return true; }  // contingencia LEO
      return false;
    };
    for (const p of D.POPS) estado.get(p.id).vivo = resolverVivo(p.id);

    // 3. ERBs
    const erbs = D.ERBS.map(e => {
      const emBateria = semTensao.has(e.barra);
      const sc = socDe(e.id, e.autonomiaH);
      return { ...e, emBateria, soc:sc, vivo: !(emBateria && sc <= 0) };
    });
    const erbViva = new Map(erbs.map(e => [e.id, e.vivo]));

    // 4. pivos: telemetria por fibra OU por ERB
    const pivos = D.PIVOS.map(p => {
      const viaFibra = estado.get(p.pop).vivo;
      const viaErb   = p.erb ? erbViva.get(p.erb) : false;
      return { ...p, viaFibra, viaErb, telemetria: viaFibra || viaErb };
    });
    const semTelemetria = pivos.filter(p => !p.telemetria).map(p => p.id);

    // 5. metricas
    const popsVivos = [...estado.values()].filter(e => e.vivo);
    const fibraAtivaKm = D.POPS.filter(p => p.montante && estado.get(p.id).vivo && !estado.get(p.id).vivoPorSatelite)
      .reduce((sum, p) => sum + D.distKm(p.pos, D.POPS.find(q => q.id === p.montante).pos), 0);

    const emRisco = [...[...estado.values()].filter(e => e.emBateria).map(e => e.soc*e.pop.autonomiaH),
                     ...erbs.filter(e => e.emBateria).map(e => e.soc*e.autonomiaH)];
    const autonomiaCritica = emRisco.length ? Math.min(...emRisco) : Infinity;

    const haConectada = pivos.filter(p => p.telemetria).reduce((a, p) => a + p.areaHa, 0);
    const coberturaMovel = 100 * pivos.filter(p => p.erb && erbViva.get(p.erb)).length / pivos.length;

    // latencia: 3 ms de base + 1,8 ms por salto de PoP + 0,01 ms/km; satelite LEO ~ 42 ms
    const saltos = id => { let n = 0, c = D.POPS.find(p => p.id === id);
                           while (c && c.montante) { n++; c = D.POPS.find(p => p.id === c.montante); } return n; };
    const latencias = pivos.filter(p => p.telemetria).map(p => {
      const e = estado.get(p.pop);
      if (e.vivoPorSatelite) return 42;
      return 3 + 1.8 * saltos(p.pop) + 0.01 * (p.kmPop + 30);
    });
    const latMedia = latencias.length ? latencias.reduce((a,b)=>a+b,0)/latencias.length : 0;

    const celulas = [
      { dom:'Enlace',    id:'G01', nome:'Backhaul de fibra',   un:'km', v: fibraAtivaKm },
      { dom:'Enlace',    id:'G02', nome:'PoPs operacionais',   un:'n',  v: popsVivos.length },
      { dom:'Enlace',    id:'G03', nome:'Autonomia crítica',   un:'h',  v: Number.isFinite(autonomiaCritica) ? autonomiaCritica : 0 },
      { dom:'Enlace',    id:'G04', nome:'Enlace satelital',    un:'n',  v: [...estado.values()].filter(e => e.vivoPorSatelite).length },
      { dom:'Cobertura', id:'G05', nome:'Cobertura móvel',     un:'%',  v: coberturaMovel },
      { dom:'Cobertura', id:'G06', nome:'Latência ao headend', un:'ms', v: latMedia },
      { dom:'Cobertura', id:'G07', nome:'Pivôs telemetrados',  un:'n',  v: pivos.filter(p=>p.telemetria).length },
      { dom:'Cobertura', id:'G08', nome:'Área conectada',      un:'ha', v: haConectada }
    ];

    // SoC do proximo passo
    const socProx = new Map();
    for (const e of estado.values()) socProx.set(e.pop.id, passoSoC(e.soc, e.pop.autonomiaH, e.emBateria, s.dtH || 0));
    for (const e of erbs)            socProx.set(e.id,     passoSoC(e.soc, e.autonomiaH,     e.emBateria, s.dtH || 0));

    return { celulas, pops:[...estado.values()], erbs, pivos, semTelemetria,
             haConectada, coberturaMovel, latMedia, fibraAtivaKm, socProx };
  }

  /* =============================================================== GOSSIP */
  function executar(entrada) {
    const s = Object.assign({
      hora: 19, mes: 8, gdMW: 6, cresc: 1.0, seca: 1, safra: 1,
      n1: false, reg: true, cap: true, satelite: true, duracaoH: 4
    }, entrada || {});
    if (s.decorridoH === undefined) s.decorridoH = s.duracaoH;

    const telegramas = [];
    let semTelemetria = [], afetadosAnterior = [], rede = null, agro = null;
    let rodada = 0, jac = 0, seq = 0;

    while (rodada < MAX_RODADAS) {
      rodada++;
      rede = avaliarRede(s, semTelemetria);

      const tA = U.montar(U.CLUSTER.REDE, U.CLUSTER.AGRO, U.TIPO.INTERRUPCAO, ++seq,
        { barras: rede.subtensao, decorridoH: s.decorridoH });
      telegramas.push({ rodada, ...U.ler(tA) });

      agro = avaliarAgro(s, rede.subtensao);

      const tB = U.montar(U.CLUSTER.AGRO, U.CLUSTER.REDE, U.TIPO.TELEMETRIA, ++seq,
        { pivos: agro.semTelemetria, popsMortos: agro.pops.filter(p=>!p.vivo).map(p=>p.pop.id) });
      telegramas.push({ rodada, ...U.ler(tB) });

      const afetados = [...rede.subtensao, ...agro.semTelemetria,
                        ...agro.pops.filter(p => !p.vivo).map(p => p.pop.id)];
      jac = U.jaccard(afetados, afetadosAnterior);

      const estabilizou = jac === 1 && rodada > 1;
      telegramas.push({ rodada, tipoNome:'CONVERGENCIA', jaccard: jac,
                        afetados: afetados.length, estabilizou });

      semTelemetria = agro.semTelemetria;
      afetadosAnterior = afetados;
      if (estabilizou) break;
    }

    return { estado: s, rodadas: rodada, jaccard: jac, convergiu: jac === 1,
             rede, agro, telegramas };
  }

  /* =============================================================== DIA COMPLETO
     O acoplamento entre clusters e sequencial, nao instantaneo:
     um disturbio que comeca de madrugada esgota a bateria dos PoPs, e as
     18h os pivos ja estao sem agendamento remoto — deixam de fugir da ponta
     exatamente quando a rede menos suporta. Isso so aparece varrendo o dia. */
  function executarDia(entrada) {
    const s = Object.assign({
      hora: 19, mes: 8, gdMW: 6, cresc: 1.0, seca: 1, safra: 1,
      n1: false, reg: true, cap: true, satelite: true,
      inicioH: 2, duracaoH: 8
    }, entrada || {});

    const ativoEm = h => {
      if (!s.n1 || s.duracaoH <= 0) return -1;
      const d = (h - s.inicioH + 24) % 24;
      return d < s.duracaoH ? d : -1;
    };

    let semTelemetria = [];
    let soc = new Map();
    for (const p of D.POPS) soc.set(p.id, 1);
    for (const e of D.ERBS) soc.set(e.id, 1);
    const horas = [];

    for (let h = 0; h < 24; h++) {
      const decorrido = ativoEm(h);
      const ativo = decorrido >= 0;
      const sh = Object.assign({}, s, { hora: h, n1: ativo, decorridoH: ativo ? decorrido : 0 });

      sh.dtH = 1;
      let rede = null, agro = null, jac = 0, rodada = 0;
      let anterior = [];
      while (rodada < MAX_RODADAS) {
        rodada++;
        rede = avaliarRede(sh, semTelemetria);
        agro = avaliarAgro(sh, rede.subtensao, soc);
        const afetados = [...rede.subtensao, ...agro.semTelemetria,
                          ...agro.pops.filter(p => !p.vivo).map(p => p.pop.id)];
        jac = U.jaccard(afetados, anterior);
        const novoSemTel = agro.semTelemetria;
        const estavel = jac === 1 && rodada > 1;
        anterior = afetados;
        semTelemetria = novoSemTel;
        if (estavel) break;
      }

      soc = agro.socProx;
      horas.push({
        hora: h, disturbio: ativo, decorridoH: ativo ? decorrido : null,
        soc: Object.fromEntries([...agro.pops.map(p=>[p.pop.id,p.soc]), ...agro.erbs.map(e=>[e.id,e.soc])]),
        erbsMortas: agro.erbs.filter(e=>!e.vivo).map(e=>e.id),
        rodadas: rodada, jaccard: jac,
        vmin: Math.min(...rede.solver.V.slice(1)),
        vmax: Math.max(...rede.solver.V.slice(1)),
        cargaMW: rede.cargaMW, perdasPct: rede.perdasPct, carregPct: rede.carregPct,
        pivoMW: rede.kwPivoEfetivo / 1000,
        popsMortos: agro.pops.filter(p => !p.vivo).map(p => p.pop.id),
        semTelemetria: agro.semTelemetria.length,
        haConectada: agro.haConectada,
        latMedia: agro.latMedia
      });
    }

    const pico = horas.reduce((a, b) => b.cargaMW > a.cargaMW ? b : a);
    const pior = horas.reduce((a, b) => b.vmin < a.vmin ? b : a);
    return { estado: s, horas, pico, pior,
             energiaNaoAgendadaMWh: horas.filter(h => h.semTelemetria > 0)
                                         .reduce((a, h) => a + h.pivoMW, 0) };
  }

  return { executar, executarDia, avaliarRede, avaliarAgro, LIMIAR_RETIFICADOR, irradiancia, foraDePonta };
})();


/* ═══════════════ POLO V ═══════════════ */
const P = (function () {
  /* Polo V — verificacao deterministica. Nenhuma inferencia, so regra.
     Camada eletrica : PRODIST Modulo 8 (faixas do Anexo 8.A, DRP <= 3%, DRC <= 0,5%)
     Camada de dados : disponibilidade conjunta e autonomia de PoP
     Invariantes     : balanco de potencia e convergencia */

  const FAIXA = { adeqMin: 0.93, adeqMax: 1.05, precMin: 0.90 };   // 1 kV < V < 69 kV
  const LIM = { drp: 3.0, drc: 0.5, perdas: 8.0, trafoMVA: 40 };

  const classificar = v =>
    (v > FAIXA.adeqMax || v < FAIXA.precMin) ? 'critica'
    : (v < FAIXA.adeqMin ? 'precaria' : 'adequada');

  function verificar(res) {
    const { rede, agro, estado } = res;
    const r = rede.solver;
    const V = r.V.slice(1);
    const nTot = V.length;
    const nPrec = V.filter(v => classificar(v) === 'precaria').length;
    const nCrit = V.filter(v => classificar(v) === 'critica').length;
    const vmin = Math.min(...V), vmax = Math.max(...V);
    const drp = 100 * nPrec / nTot, drc = 100 * nCrit / nTot;

    const popsMortos = agro.pops.filter(p => !p.vivo).length;
    const popsBateria = agro.pops.filter(p => p.emBateria).length;
    const pctArea = 100 * agro.haConectada / D.AREA_AGRICOLA_HA;

    const linhas = [
      { camada:'invariante', ds:'Convergência da varredura',
        vr:`${r.iteracoes} iter · ε=${r.erro.toExponential(1)}`,
        st: r.convergiu ? 'ok' : 'er' },
      { camada:'invariante', ds:'Balanço ΣP fonte = ΣP carga + perdas',
        vr:`resíduo ${(r.residuoMW*1e6).toFixed(1)} W`,
        st: Math.abs(r.residuoMW) < 1e-5 ? 'ok' : 'wr' },
      { camada:'invariante', ds:'Convergência do gossip entre clusters',
        vr:`${res.rodadas} rodadas · Jaccard ${res.jaccard.toFixed(4)}`,
        st: res.convergiu ? 'ok' : 'wr' },

      { camada:'eletrica', ds:'Tensão mínima da rede', vr:`${vmin.toFixed(4)} pu`,
        st: vmin >= FAIXA.adeqMin ? 'ok' : (vmin >= FAIXA.precMin ? 'wr' : 'er') },
      { camada:'eletrica', ds:'Tensão máxima da rede', vr:`${vmax.toFixed(4)} pu`,
        st: vmax <= FAIXA.adeqMax ? 'ok' : 'er' },
      { camada:'eletrica', ds:'Barras em faixa precária (DRP)',
        vr:`${nPrec}/${nTot} · ${drp.toFixed(1)}%`, st: drp <= LIM.drp ? 'ok' : 'wr' },
      { camada:'eletrica', ds:'Barras em faixa crítica (DRC)',
        vr:`${nCrit}/${nTot} · ${drc.toFixed(1)}%`, st: drc <= LIM.drc ? 'ok' : 'er' },
      { camada:'eletrica', ds:'Perdas técnicas sobre a carga',
        vr:`${rede.perdasPct.toFixed(2)}%`, st: rede.perdasPct <= LIM.perdas ? 'ok' : 'wr' },
      { camada:'eletrica', ds:`Carregamento do trafo ${LIM.trafoMVA} MVA`,
        vr:`${rede.carregPct.toFixed(1)}%`, st: rede.carregPct <= 100 ? 'ok' : 'er' },

      { camada:'dados', ds:'PoPs fora de operação',
        vr:`${popsMortos} de ${agro.pops.length}`, st: popsMortos === 0 ? 'ok' : 'er' },
      { camada:'dados', ds:'PoPs operando em bateria',
        vr:`${popsBateria} · autonomia crítica ${agro.celulas.find(c=>c.id==='G03').v.toFixed(1)} h`,
        st: popsBateria === 0 ? 'ok' : 'wr' },
      { camada:'dados', ds:'Autonomia cobre a duração do distúrbio',
        vr:`${estado.duracaoH.toFixed(1)} h de distúrbio`,
        st: popsMortos === 0 ? 'ok' : 'er' },
      { camada:'dados', ds:'Área agricultável com telemetria',
        vr:`${agro.haConectada.toFixed(0)} ha · ${pctArea.toFixed(1)}%`,
        st: pctArea >= 95 ? 'ok' : (pctArea >= 60 ? 'wr' : 'er') },
      { camada:'dados', ds:'Latência média ao headend',
        vr:`${agro.latMedia.toFixed(1)} ms`, st: agro.latMedia <= 30 ? 'ok' : 'wr' }
    ];

    const falhas = linhas.filter(l => l.st === 'er').length;
    const alertas = linhas.filter(l => l.st === 'wr').length;
    return { linhas, falhas, alertas, vmin, vmax, drp, drc, nPrec, nCrit, pctArea };
  }

  return { verificar, classificar, FAIXA, LIM };
})();


/* ═══════════════ INTERFACE ═══════════════ */
const INDEX = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARGOS Porangatu — rede elétrica e conectividade agro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --terra:#17100C;--terra2:#1F1712;--terra3:#2A201A;--linha:#3D2E24;--linha2:#54402F;
  --osso:#EDE3D6;--osso-d:#A69582;--osso-dd:#6E6154;
  --fosforo:#79C2D0;--fosforo-d:#2E5C66;--fibra:#C77DBB;--erb:#C9A227;
  --adeq:#6FBF73;--prec:#E3A130;--crit:#E05A4F;
  --mono:'IBM Plex Mono',ui-monospace,monospace;--sans:'IBM Plex Sans',system-ui,sans-serif;
  --cond:'Barlow Condensed',var(--sans);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--terra);color:var(--osso);font-family:var(--sans);font-size:14px;
  line-height:1.5;padding-bottom:44px;
  background-image:linear-gradient(var(--linha) .5px,transparent .5px),linear-gradient(90deg,var(--linha) .5px,transparent .5px);
  background-size:44px 44px;background-position:-1px -1px}
.wrap{max-width:1420px;margin:0 auto;padding:0 14px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.eyebrow{font-family:var(--cond);text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:600;color:var(--osso-dd)}
header{border-bottom:1px solid var(--linha2);background:linear-gradient(180deg,#1B130E,#17100C);padding:16px 0 0;margin-bottom:16px}
.hd{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;padding-bottom:12px}
h1{font-family:var(--cond);font-weight:600;font-size:29px;line-height:1}
h1 span{color:var(--fosforo)}
.sub{font-size:12.5px;color:var(--osso-d);margin-top:4px;max-width:70ch}
.badge{font-family:var(--mono);font-size:10.5px;border:1px solid var(--linha2);padding:3px 8px;color:var(--osso-dd);white-space:nowrap}
.readout{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));border-top:1px solid var(--linha2);border-bottom:1px solid var(--linha2);background:#140E0A}
.ro{padding:8px 11px;border-right:1px solid var(--linha)}
.ro b{display:block;font-family:var(--mono);font-size:18px;font-weight:500;line-height:1.2}
.ro i{display:block;font-family:var(--cond);font-style:normal;text-transform:uppercase;letter-spacing:.13em;font-size:9.5px;color:var(--osso-dd);margin-top:2px}
.grid{display:grid;grid-template-columns:288px 1fr;gap:13px}
@media(max-width:960px){.grid{grid-template-columns:1fr}}
.col{display:flex;flex-direction:column;gap:13px;min-width:0}
.panel{background:var(--terra2);border:1px solid var(--linha)}
.panel>h2{font-family:var(--cond);text-transform:uppercase;letter-spacing:.14em;font-size:11.5px;font-weight:600;
  color:var(--osso-d);padding:8px 12px;border-bottom:1px solid var(--linha);display:flex;justify-content:space-between;gap:8px}
.panel>h2 em{font-style:normal;font-family:var(--mono);font-size:10px;color:var(--osso-dd);letter-spacing:0}
.clu{border-bottom:2px solid var(--linha2)}
.clu-h{font-family:var(--cond);text-transform:uppercase;letter-spacing:.15em;font-size:10.5px;padding:7px 12px 2px;display:flex;justify-content:space-between}
.dom-h{font-family:var(--cond);text-transform:uppercase;letter-spacing:.14em;font-size:9.5px;color:var(--fosforo-d);padding:6px 12px 2px}
.cell{display:grid;grid-template-columns:32px 1fr auto;gap:7px;align-items:baseline;padding:3px 12px 4px}
.cell:hover{background:var(--terra3)}
.cell code{font-family:var(--mono);font-size:9.5px;color:var(--osso-dd)}
.cell .nm{font-size:11.5px}
.cell .vl{font-family:var(--mono);font-size:11.5px;font-weight:500;text-align:right}
.cell .bar{grid-column:2/4;height:2px;background:var(--linha);margin-top:1px}
.cell .bar i{display:block;height:100%;background:var(--fosforo);transition:width .2s}
.clu.agro .cell .bar i{background:var(--fibra)}
svg{display:block;width:100%;height:auto}
#mapbox{position:relative;width:100%;height:0;padding-bottom:62%;overflow:hidden;background:#0F0B08;touch-action:none;cursor:grab}
#mapbox.arrastando{cursor:grabbing}
#tiles{position:absolute;inset:0;overflow:hidden}
#tiles img{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none;
  filter:saturate(.55) brightness(.62) contrast(1.08)}
#tiles.satelite img{filter:saturate(.72) brightness(.68) contrast(1.05)}
#map{position:absolute;inset:0;width:100%;height:100%}
.mapctl{position:absolute;top:9px;right:9px;display:flex;flex-direction:column;gap:5px;z-index:3}
.mapctl .lin{display:flex;gap:4px}
.mapctl button{font-family:var(--cond);text-transform:uppercase;letter-spacing:.1em;font-size:9.5px;
  background:rgba(23,16,12,.88);color:var(--osso-d);border:1px solid var(--linha2);padding:4px 7px;cursor:pointer;backdrop-filter:blur(3px)}
.mapctl button[aria-pressed=true]{background:var(--fosforo);color:#0E1416;border-color:var(--fosforo)}
.mapctl button:focus-visible{outline:1px solid var(--fosforo);outline-offset:2px}
.attr{position:absolute;bottom:5px;left:8px;font-family:var(--mono);font-size:8.5px;color:var(--osso-dd);
  background:rgba(23,16,12,.7);padding:2px 6px;z-index:3;pointer-events:none}
.leg{display:flex;flex-wrap:wrap;gap:12px;padding:7px 12px;border-top:1px solid var(--linha);font-family:var(--mono);font-size:9.5px;color:var(--osso-dd)}
.leg s{text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.ctl{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.c{padding:9px 12px;border-right:1px solid var(--linha);border-bottom:1px solid var(--linha)}
.c label{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--cond);
  text-transform:uppercase;letter-spacing:.12em;font-size:9.5px;color:var(--osso-dd);margin-bottom:6px}
.c label b{font-family:var(--mono);font-size:12px;color:var(--osso);letter-spacing:0;font-weight:500}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:2px;background:var(--linha2);outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;background:var(--fosforo);cursor:pointer;transform:rotate(45deg)}
input[type=range]::-moz-range-thumb{width:13px;height:13px;background:var(--fosforo);border:none;cursor:pointer}
input[type=range]:focus-visible{outline:1px solid var(--fosforo);outline-offset:4px}
.sw{display:flex;gap:5px;flex-wrap:wrap}
.sw button{font-family:var(--cond);text-transform:uppercase;letter-spacing:.1em;font-size:10px;background:transparent;
  color:var(--osso-dd);border:1px solid var(--linha2);padding:5px 8px;cursor:pointer}
.sw button[aria-pressed=true]{background:var(--fosforo);color:#0E1416;border-color:var(--fosforo)}
.sw button.danger[aria-pressed=true]{background:var(--crit);color:#1A0A08;border-color:var(--crit)}
.sw button:focus-visible{outline:1px solid var(--fosforo);outline-offset:2px}
.pvrow{display:grid;grid-template-columns:14px 60px 1fr auto;gap:8px;align-items:baseline;padding:5px 12px;border-bottom:1px solid var(--linha);font-size:11.5px}
.pvrow .st{font-family:var(--mono);font-size:11px;font-weight:600}
.pvrow .cm{font-family:var(--cond);text-transform:uppercase;letter-spacing:.1em;font-size:9px;color:var(--osso-dd)}
.pvrow .ds{color:var(--osso-d)}
.pvrow .vr{font-family:var(--mono);font-size:11px;text-align:right;white-space:nowrap}
.ok{color:var(--adeq)}.wr{color:var(--prec)}.er{color:var(--crit)}
#log{max-height:190px;overflow-y:auto;font-family:var(--mono);font-size:10px;padding:6px 12px}
#log div{padding:2px 0;border-bottom:1px solid #241B15;color:var(--osso-dd);word-break:break-all}
#log b{color:var(--fosforo);font-weight:500}
#log .agro b{color:var(--fibra)}
#log .conv b{color:var(--adeq)}
footer{margin-top:20px;padding-top:13px;border-top:1px solid var(--linha);font-size:11.5px;color:var(--osso-dd);line-height:1.65}
footer b{color:var(--osso-d);font-weight:500}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header>
 <div class="wrap">
  <div class="hd">
   <div>
    <div class="eyebrow">ARGOS · 2 clusters · 24 células · protocolo URB1</div>
    <h1>Porangatu <span>rede elétrica × conectividade agro</span></h1>
    <p class="sub">A fibra do agro sobe no poste da distribuidora. Mesmo corredor, mesma falha. O cluster REDE resolve o fluxo de potência; o cluster AGRO resolve backhaul e telemetria; os dois trocam telegramas até o conjunto de ativos afetados estabilizar.</p>
   </div>
   <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
    <div class="badge">IBGE 5218003 · 13°26′S 49°09′W</div>
    <div class="badge" id="bdg">—</div>
   </div>
  </div>
 </div>
 <div class="wrap" style="padding:0"><div class="readout" id="ro"></div></div>
</header>

<div class="wrap">
 <div class="grid">
  <section class="panel"><h2>Malha <em id="clk">—</em></h2><div id="cells"></div></section>
  <div class="col">
   <section class="panel">
    <h2>Duas camadas sobre os mesmos postes <em>13,8 kV · fibra · ERB</em></h2>
    <div id="mapbox">
      <div id="tiles"></div>
      <svg id="map" role="img" aria-label="Mapa das camadas elétrica e de conectividade"></svg>
      <div class="mapctl">
        <div class="lin">
          <button id="bs_escuro"   aria-pressed="true">Escuro</button>
          <button id="bs_satelite" aria-pressed="false">Satélite</button>
          <button id="bs_nenhum"   aria-pressed="false">Sem base</button>
        </div>
        <div class="lin" style="justify-content:flex-end">
          <button id="z_mais" aria-label="Aproximar">+</button>
          <button id="z_menos" aria-label="Afastar">−</button>
          <button id="z_fit">Enquadrar</button>
        </div>
      </div>
      <div class="attr" id="attr"></div>
    </div>
    <div class="leg">
     <s><i class="dot" style="background:var(--adeq)"></i>≥0,93 pu</s>
     <s><i class="dot" style="background:var(--prec)"></i>0,90–0,93</s>
     <s><i class="dot" style="background:var(--crit)"></i>&lt;0,90</s>
     <s style="color:var(--fibra)">━ fibra · ⬢ PoP</s>
     <s style="color:var(--erb)">△ ERB · ○ raio</s>
     <s style="color:var(--osso-dd)">◦ pivô central</s>
    </div>
   </section>
   <section class="panel">
    <h2>Dia completo <em>estado de carga das baterias hora a hora</em></h2>
    <svg id="dia" viewBox="0 0 900 300" role="img" aria-label="Linha do tempo de 24 horas"></svg>
   </section>
   <section class="panel"><h2>Cenário</h2><div class="ctl" id="ctl"></div></section>
   <section class="panel"><h2>Polo V — verificação determinística</h2><div id="pv"></div></section>
   <section class="panel"><h2>Telegramas URB1 <em id="jac">—</em></h2><div id="log"></div></section>
  </div>
 </div>
 <footer>
  <b>Fronteira.</b> Nenhuma célula calcula fluxo de potência. O solver decide tensão, o Polo V decide conformidade, as células quantificam variáveis e trocam telegramas.<br>
  <b>Acoplamento.</b> REDE→AGRO: barra abaixo de 0,90 pu tira o retificador do PoP da faixa e joga o site para bateria. AGRO→REDE: pivô sem telemetria perde o agendamento remoto e volta ao temporizador local, deixando de fugir do horário de ponta.<br>
  <b>Dados.</b> Traçado sintético com esquema de campos da BDGD. Não é a rede real da Equatorial Goiás.
 </footer>
</div>

<script>
"use strict";
const COR={adequada:"#6FBF73",precaria:"#E3A130",critica:"#E05A4F"};
const MES=["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
let TOPO=null, R=null, DIA=null;
const S={hora:19,mes:8,gdMW:6,cresc:1,seca:1,safra:1,n1:false,reg:true,cap:true,satelite:true,
         duracaoH:8,inicioH:2};
const classificar=v=>(v>1.05||v<0.90)?"critica":(v<0.93?"precaria":"adequada");
const $=i=>document.getElementById(i);

const CTLS=[
 {k:"hora",min:0,max:23,step:1,rot:"Hora",fmt:v=>String(v).padStart(2,"0")+":00"},
 {k:"mes",min:1,max:12,step:1,rot:"Mês",fmt:v=>MES[v-1]},
 {k:"gdMW",min:0,max:30,step:0.5,rot:"GD instalada",fmt:v=>v.toFixed(1)+" MWp"},
 {k:"cresc",min:1,max:1.6,step:0.02,rot:"Crescimento",fmt:v=>"+"+((v-1)*100).toFixed(0)+"%"},
 {k:"inicioH",min:0,max:23,step:1,rot:"Início do distúrbio",fmt:v=>String(v).padStart(2,"0")+"h"},
 {k:"duracaoH",min:0,max:24,step:1,rot:"Duração",fmt:v=>v+" h"}
];

function montarCtl(){
 $("ctl").innerHTML=CTLS.map(c=>\`<div class="c"><label>\${c.rot}<b id="lb_\${c.k}">\${c.fmt(S[c.k])}</b></label>
   <input type="range" id="in_\${c.k}" min="\${c.min}" max="\${c.max}" step="\${c.step}" value="\${S[c.k]}" aria-label="\${c.rot}"></div>\`).join("")
  +\`<div class="c"><label>Chaves</label><div class="sw">
     <button id="sw_seca" aria-pressed="\${S.seca===1}">Seca</button>
     <button id="sw_reg" aria-pressed="\${S.reg}">Regulador</button>
     <button id="sw_cap" aria-pressed="\${S.cap}">Capacitor</button>
     <button id="sw_satelite" aria-pressed="\${S.satelite}">Satélite</button>
     <button id="sw_n1" class="danger" aria-pressed="\${S.n1}">Contingência N-1</button></div></div>\`;
 CTLS.forEach(c=>$("in_"+c.k).addEventListener("input",e=>{
   S[c.k]=parseFloat(e.target.value);$("lb_"+c.k).textContent=c.fmt(S[c.k]);rodar();}));
 [["sw_seca","seca"],["sw_reg","reg"],["sw_cap","cap"],["sw_satelite","satelite"],["sw_n1","n1"]]
  .forEach(([id,k])=>$(id).addEventListener("click",e=>{
    S[k]=(k==="seca")?(S.seca===1?0:1):!S[k];
    e.target.setAttribute("aria-pressed",String(S[k]===1||S[k]===true));rodar();}));
}

async function rodar(){
 const [a,b]=await Promise.all([
  fetch("/api/simular",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(S)}).then(r=>r.json()),
  fetch("/api/dia",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(S)}).then(r=>r.json())
 ]);
 R=a;DIA=b;desenhar();
}

/* ---------------- render ---------------- */
function desenhar(){
 const s=R.solver, vmin=Math.min(...s.V.slice(1));
 const popsMortos=R.pops.filter(p=>!p.vivo).length;
 $("ro").innerHTML=[
  ["Demanda",R.cargaMW.toFixed(2)+" MW",""],
  ["Geração dist.",R.gdMW.toFixed(2)+" MW","color:var(--erb)"],
  ["Perdas",R.perdasPct.toFixed(2)+"%",""],
  ["Pior tensão",vmin.toFixed(4)+" pu","color:"+COR[classificar(vmin)]],
  ["Trafo 40 MVA",R.carregPct.toFixed(1)+"%","color:"+(R.carregPct>100?COR.critica:"inherit")],
  ["PoPs fora",popsMortos+" / "+R.pops.length,"color:"+(popsMortos?COR.critica:COR.adequada)],
  ["Área c/ telemetria",(R.haConectada).toFixed(0)+" ha","color:var(--fibra)"],
  ["Latência",R.latMedia.toFixed(1)+" ms",""]
 ].map(([i,b,st])=>\`<div class="ro"><b style="\${st}">\${b}</b><i>\${i}</i></div>\`).join("");
 $("bdg").textContent=\`\${s.iteracoes} iter · \${R.rodadas} rodadas · Jaccard \${R.jaccard.toFixed(3)}\`;
 $("bdg").style.color=R.convergiu?"var(--osso-dd)":"var(--crit)";
 $("clk").textContent=String(S.hora).padStart(2,"0")+":00 · "+MES[S.mes-1];
 $("jac").textContent=\`\${R.telegramas.length} quadros · \${R.rodadas} rodadas\`;

 const esc={C01:1.4,C02:1.2,C03:1.6,C04:5,C05:30,C06:1,C07:100,C08:10,C09:120,C10:1.1,C11:2,
            C12:12,C13:1,C14:1,C15:1.6,C16:1.06,
            G01:60,G02:7,G03:8,G04:3,G05:100,G06:60,G07:26,G08:3000};
 const bloco=(titulo,cor,cs,cl)=>{
  const doms=[...new Set(cs.map(c=>c.dom))];
  return \`<div class="clu \${cl}"><div class="clu-h"><span style="color:\${cor}">\${titulo}</span>
    <span style="color:var(--osso-dd);font-family:var(--mono);font-size:10px">\${cs.length} células</span></div>\`
   +doms.map(d=>\`<div class="dom-h">\${d}</div>\`+cs.filter(c=>c.dom===d).map(c=>{
     const pct=Math.max(0,Math.min(100,100*c.v/(esc[c.id]||1)));
     const dec=Math.abs(c.v)>=100?0:(Math.abs(c.v)>=10?1:3);
     return \`<div class="cell"><code>\${c.id}</code><span class="nm">\${c.nome}</span>
       <span class="vl">\${c.v.toFixed(dec)} <span style="color:var(--osso-dd)">\${c.un}</span></span>
       <div class="bar"><i style="width:\${pct}%"></i></div></div>\`;}).join("")).join("")+\`</div>\`;
 };
 $("cells").innerHTML=bloco("Cluster REDE","var(--fosforo)",R.celulasRede,"rede")
                     +bloco("Cluster AGRO","var(--fibra)",R.celulasAgro,"agro");

 $("pv").innerHTML=R.polov.linhas.map(l=>
  \`<div class="pvrow"><span class="st \${l.st}">\${l.st==="ok"?"✓":(l.st==="wr"?"!":"✕")}</span>
   <span class="cm">\${l.camada}</span><span class="ds">\${l.ds}</span>
   <span class="vr \${l.st}">\${l.vr}</span></div>\`).join("");

 $("log").innerHTML=R.telegramas.map(t=>{
  if(t.jaccard!==undefined) return \`<div class="conv"><b>CONVERGENCIA</b> rodada \${t.rodada} · Jaccard \${t.jaccard.toFixed(4)} · \${t.estabilizou?"estabilizou":"nova rodada"}</div>\`;
  const agro=t.tipo===0x21;
  return \`<div class="\${agro?"agro":""}"><b>\${agro?"AGRO→REDE":"REDE→AGRO"}</b> seq \${t.seq} · \${t.bytes} B · \${t.hex}…<br>\${JSON.stringify(t.objeto).slice(0,150)}</div>\`;
 }).join("");

 mapa();linhaDoTempo();
}

/* ---------------- base cartografica: Web Mercator sem biblioteca ----------------
   Projecao esferica de Mercator, a mesma dos tiles z/x/y. O overlay SVG usa
   exatamente esta funcao, entao alinha com a imagem em qualquer zoom.        */
const TAM=256;
const BASES={
 escuro  :{url:(z,x,y)=>\`https://a.basemaps.cartocdn.com/dark_all/\${z}/\${x}/\${y}.png\`,
           attr:"© OpenStreetMap · © CARTO", zmax:19, cls:""},
 satelite:{url:(z,x,y)=>\`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/\${z}/\${y}/\${x}\`,
           attr:"Imagery © Esri, Maxar, Earthstar Geographics", zmax:18, cls:"satelite"},
 nenhum  :{url:null, attr:"", zmax:19, cls:""}
};
const VISTA={z:12,cx:0,cy:0,base:"escuro",pronto:false};

function mundo(lat,lon,z){
 const s=TAM*Math.pow(2,z);
 const sy=Math.min(0.9999,Math.max(-0.9999,Math.sin(lat*Math.PI/180)));
 return { x:(lon+180)/360*s, y:(0.5-Math.log((1+sy)/(1-sy))/(4*Math.PI))*s };
}
function dims(){const b=document.getElementById("mapbox");return {W:b.clientWidth||900,H:b.clientHeight||560};}

function enquadrar(){
 const {W,H}=dims();
 const pts=TOPO.barras.map(b=>b.pos).concat(TOPO.pivos.map(p=>p.pos));
 const la=pts.map(p=>p[0]),lo=pts.map(p=>p[1]);
 const la0=Math.min(...la),la1=Math.max(...la),lo0=Math.min(...lo),lo1=Math.max(...lo);
 let z=BASES[VISTA.base].zmax;
 for(;z>2;z--){
  const a=mundo(la1,lo0,z),b=mundo(la0,lo1,z);
  if((b.x-a.x)<=W-70 && (b.y-a.y)<=H-70) break;
 }
 VISTA.z=z;
 const c=mundo((la0+la1)/2,(lo0+lo1)/2,z);
 VISTA.cx=c.x; VISTA.cy=c.y; VISTA.pronto=true;
}

function desenharTiles(){
 const cont=document.getElementById("tiles");
 const base=BASES[VISTA.base];
 cont.className=base.cls;
 document.getElementById("attr").textContent=base.attr;
 if(!base.url){cont.innerHTML="";return;}
 const {W,H}=dims(), z=VISTA.z, n=Math.pow(2,z);
 const ox=VISTA.cx-W/2, oy=VISTA.cy-H/2;
 const tx0=Math.floor(ox/TAM), tx1=Math.floor((ox+W)/TAM);
 const ty0=Math.max(0,Math.floor(oy/TAM)), ty1=Math.min(n-1,Math.floor((oy+H)/TAM));
 let html="";
 for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++){
  const wx=((tx%n)+n)%n;
  html+=\`<img src="\${base.url(z,wx,ty)}" alt="" loading="lazy" draggable="false"
    style="left:\${(tx*TAM-ox).toFixed(0)}px;top:\${(ty*TAM-oy).toFixed(0)}px">\`;
 }
 cont.innerHTML=html;
}

function mapa(){
 if(!VISTA.pronto)enquadrar();
 desenharTiles();
 const {W,H}=dims(), z=VISTA.z;
 const ox=VISTA.cx-W/2, oy=VISTA.cy-H/2;
 document.getElementById("map").setAttribute("viewBox",\`0 0 \${W} \${H}\`);
 const proj=p=>{const m=mundo(p[0],p[1],z);return {x:m.x-ox,y:m.y-oy};};
 const X=p=>proj(p).x, Y=p=>proj(p).y;
 // metros por pixel no paralelo local, para os raios de ERB e a escala grafica
 const mppx=156543.03392*Math.cos(TOPO.se.lat*Math.PI/180)/Math.pow(2,z);
 const kmPx=1000/mppx;
 const PAD=46;
 const pop=id=>TOPO.pops.find(p=>p.id===id);
 const estPop=id=>R.pops.find(p=>p.id===id);
 let s=\`<defs><filter id="gl"><feGaussianBlur stdDeviation="2.2" result="b"/>
  <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>\`;

 // raios de ERB
 TOPO.erbs.forEach(er=>{const st=R.erbs.find(x=>x.id===er.id);
  s+=\`<circle cx="\${X(er.pos).toFixed(1)}" cy="\${Y(er.pos).toFixed(1)}" r="\${(er.raioKm*kmPx).toFixed(1)}"
   fill="\${st.vivo?"#C9A227":"#E05A4F"}" fill-opacity=".045" stroke="\${st.vivo?"#C9A227":"#E05A4F"}"
   stroke-opacity=".28" stroke-width=".9" stroke-dasharray="4 4"/>\`;});

 // troncos de MT
 TOPO.ctmt.forEach(al=>{
  const bs=TOPO.barras.filter(b=>b.ctmt===al.id).sort((a,b)=>a.km-b.km);
  const d=[TOPO.barras[0],...bs].map((b,i)=>(i?"L":"M")+X(b.pos).toFixed(1)+" "+Y(b.pos).toFixed(1)).join(" ");
  s+=\`<path d="\${d}" fill="none" stroke="#2E5C66" stroke-width="1.5" opacity=".7"/>\`;
  const u=bs[bs.length-1];
  s+=\`<text x="\${X(u.pos)+6}" y="\${Y(u.pos)+3}" fill="#6E6154" font-family="Barlow Condensed" font-size="11.5" letter-spacing="1">\${al.id}</text>\`;});

 // pivos
 TOPO.pivos.forEach(p=>{const t=R.pivos.find(x=>x.id===p.id);
  const rM=Math.sqrt(p.areaHa*10000/Math.PI);           // raio real do pivo central, em metros
  const r=Math.max(2.2,rM/mppx);
  s+=\`<circle cx="\${X(p.pos).toFixed(1)}" cy="\${Y(p.pos).toFixed(1)}" r="\${r.toFixed(1)}"
   fill="\${t.telemetria?"none":"#E05A4F"}" fill-opacity=".10"
   stroke="\${t.telemetria?(t.viaFibra?"#C77DBB":"#C9A227"):"#E05A4F"}"
   stroke-width="\${t.telemetria?1:1.6}" opacity="\${t.telemetria?.6:.95}">
   <title>\${p.id} · \${p.areaHa} ha · raio \${rM.toFixed(0)} m · \${t.telemetria?(t.viaFibra?"fibra":"ERB"):"SEM TELEMETRIA"}</title></circle>\`;});

 // fibra
 TOPO.pops.filter(p=>p.montante).forEach(p=>{
  const up=pop(p.montante),st=estPop(p.id);
  s+=\`<path d="M\${X(up.pos).toFixed(1)} \${Y(up.pos).toFixed(1)} L\${X(p.pos).toFixed(1)} \${Y(p.pos).toFixed(1)}"
   stroke="\${st.vivo?(st.satelite?"#C9A227":"#C77DBB"):"#E05A4F"}" stroke-width="1.9"
   stroke-dasharray="\${st.vivo?"":"5 4"}" fill="none" opacity=".85"/>\`;});

 // barras
 TOPO.barras.forEach((b,i)=>{if(i===0)return;
  const c=COR[classificar(R.solver.V[i])];
  s+=\`<circle cx="\${X(b.pos).toFixed(1)}" cy="\${Y(b.pos).toFixed(1)}" r="\${(2.2+Math.sqrt(R.cargas[i])/26).toFixed(2)}"
   fill="\${c}" opacity=".9"><title>\${b.id} · \${R.solver.V[i].toFixed(4)} pu · \${R.cargas[i]} kVA</title></circle>\`;
  if(b.reg)s+=\`<rect x="\${(X(b.pos)-4.5).toFixed(1)}" y="\${(Y(b.pos)-4.5).toFixed(1)}" width="9" height="9"
   fill="none" stroke="#79C2D0" stroke-width="1.1" transform="rotate(45 \${X(b.pos).toFixed(1)} \${Y(b.pos).toFixed(1)})"/>\`;});

 // ERBs
 TOPO.erbs.forEach(er=>{const st=R.erbs.find(x=>x.id===er.id),c=st.vivo?"#C9A227":"#E05A4F";
  const x=X(er.pos),y=Y(er.pos);
  s+=\`<path d="M\${x.toFixed(1)} \${(y-7).toFixed(1)} L\${(x+6).toFixed(1)} \${(y+4).toFixed(1)} L\${(x-6).toFixed(1)} \${(y+4).toFixed(1)} Z"
   fill="none" stroke="\${c}" stroke-width="1.6"><title>\${er.id} · \${er.tec} · SoC \${(st.soc*100).toFixed(0)}%</title></path>\`;});

 // PoPs
 TOPO.pops.forEach(p=>{const st=estPop(p.id),c=st.vivo?(st.satelite?"#C9A227":"#C77DBB"):"#E05A4F";
  const x=X(p.pos),y=Y(p.pos),r=5.5;
  const hex=[...Array(6)].map((_,k)=>{const a=Math.PI/6+k*Math.PI/3;
   return \`\${(x+r*Math.cos(a)).toFixed(1)},\${(y+r*Math.sin(a)).toFixed(1)}\`;}).join(" ");
  s+=\`<polygon points="\${hex}" fill="\${st.vivo?"#1F1712":c}" stroke="\${c}" stroke-width="1.6">
   <title>\${p.id} — \${p.nome} · SoC \${(st.soc*100).toFixed(0)}%\${st.emBateria?" · EM BATERIA":""}\${st.vivo?"":" · FORA"}</title></polygon>\`;
  if(st.emBateria)s+=\`<rect x="\${(x-6).toFixed(1)}" y="\${(y+8).toFixed(1)}" width="12" height="2.6" fill="#3D2E24"/>
   <rect x="\${(x-6).toFixed(1)}" y="\${(y+8).toFixed(1)}" width="\${(12*st.soc).toFixed(1)}" height="2.6" fill="\${st.soc>.34?"#E3A130":"#E05A4F"}"/>\`;});

 const p0=TOPO.barras[0].pos;
 s+=\`<g filter="url(#gl)"><rect x="\${(X(p0)-8).toFixed(1)}" y="\${(Y(p0)-8).toFixed(1)}" width="16" height="16"
  fill="none" stroke="\${S.n1?"#E05A4F":"#79C2D0"}" stroke-width="2"/></g>
  <text x="\${(X(p0)+13).toFixed(1)}" y="\${(Y(p0)-9).toFixed(1)}" fill="#79C2D0" font-family="Barlow Condensed" font-size="12.5" letter-spacing="1.3">SE PORANGATU</text>\`;
 if(S.n1)s+=\`<text x="\${W-PAD}" y="\${PAD}" text-anchor="end" fill="#E05A4F" font-family="Barlow Condensed"
  font-size="14" letter-spacing="1.5">LD 138 kV SERRA DA MESA–PORANGATU C1 INDISPONÍVEL</text>\`;
 s+=\`<g opacity=".5"><line x1="\${PAD}" y1="\${H-22}" x2="\${PAD+10*kmPx}" y2="\${H-22}" stroke="#54402F" stroke-width="1.5"/>
  <text x="\${PAD}" y="\${H-28}" fill="#6E6154" font-family="IBM Plex Mono" font-size="9">10 km</text></g>\`;
 $("map").innerHTML=s;
}

function linhaDoTempo(){
 const W=900,H=300,L=48,Rr=118,T=14,B=32;
 const hs=DIA.horas, X=h=>L+(h/23)*(W-L-Rr);
 const vLo=Math.min(0.74,Math.min(...hs.map(h=>h.vmin))-0.01), vHi=1.02;
 const Yv=v=>T+(vHi-v)/(vHi-vLo)*(H-T-B);
 const pMax=Math.max(...hs.map(h=>h.cargaMW))*1.12;
 const Yp=p=>H-B-(p/pMax)*(H-T-B)*0.92;
 let s="";
 hs.forEach(h=>{if(h.disturbio)s+=\`<rect x="\${(X(h.hora)-((W-L-Rr)/46)).toFixed(1)}" y="\${T}"
   width="\${((W-L-Rr)/23).toFixed(1)}" height="\${H-T-B}" fill="#E05A4F" opacity=".07"/>\`;});
 [[0.93,"#6FBF73","adequada"],[0.90,"#E3A130","precária"]].forEach(([v,c,n])=>{
  s+=\`<line x1="\${L}" y1="\${Yv(v).toFixed(1)}" x2="\${W-Rr}" y2="\${Yv(v).toFixed(1)}" stroke="\${c}" stroke-opacity=".45" stroke-width=".9" stroke-dasharray="3 3"/>
   <text x="\${W-Rr+7}" y="\${(Yv(v)+3).toFixed(1)}" fill="\${c}" opacity=".75" font-family="Barlow Condensed" font-size="10.5" letter-spacing=".8">\${n.toUpperCase()} \${v.toFixed(2)}</text>\`;});
 for(let h=0;h<24;h+=3){s+=\`<text x="\${X(h).toFixed(1)}" y="\${H-B+14}" text-anchor="middle" fill="#6E6154" font-family="IBM Plex Mono" font-size="9.5">\${String(h).padStart(2,"0")}</text>\`;}
 // carga
 s+=\`<path d="\${hs.map((h,i)=>(i?"L":"M")+X(h.hora).toFixed(1)+" "+Yp(h.cargaMW).toFixed(1)).join(" ")}"
  fill="none" stroke="#54402F" stroke-width="1.4"/>\`;
 s+=\`<text x="\${W-Rr+7}" y="\${Yp(hs[23].cargaMW).toFixed(1)}" fill="#A69582" font-family="IBM Plex Mono" font-size="9.5">carga MW</text>\`;
 // tensao minima
 s+=\`<path d="\${hs.map((h,i)=>(i?"L":"M")+X(h.hora).toFixed(1)+" "+Yv(h.vmin).toFixed(1)).join(" ")}"
  fill="none" stroke="#79C2D0" stroke-width="1.9"/>\`;
 hs.forEach(h=>{s+=\`<circle cx="\${X(h.hora).toFixed(1)}" cy="\${Yv(h.vmin).toFixed(1)}" r="2.4"
  fill="\${COR[classificar(h.vmin)]}"><title>\${String(h.hora).padStart(2,"0")}h · \${h.vmin.toFixed(4)} pu · \${h.cargaMW.toFixed(1)} MW · \${h.semTelemetria} pivôs sem telemetria</title></circle>\`;});
 // sites fora
 hs.forEach(h=>{const n=h.popsMortos.length+h.erbsMortas.length;
  if(n)s+=\`<rect x="\${(X(h.hora)-3).toFixed(1)}" y="\${H-B-6}" width="6" height="\${(n*4).toFixed(0)}" fill="#E05A4F" opacity=".8" transform="translate(0,\${-(n*4)})">
   <title>\${String(h.hora).padStart(2,"0")}h · fora: \${[...h.popsMortos,...h.erbsMortas].join(", ")}</title></rect>\`;});
 s+=\`<text x="\${W-Rr+7}" y="\${(Yv(hs[23].vmin)-8).toFixed(1)}" fill="#79C2D0" font-family="IBM Plex Mono" font-size="9.5">V mín pu</text>
  <text x="\${W-Rr+7}" y="\${H-B-4}" fill="#E05A4F" font-family="IBM Plex Mono" font-size="9.5">sites fora</text>
  <text x="\${L}" y="\${H-6}" fill="#6E6154" font-family="Barlow Condensed" font-size="10.5" letter-spacing="1.3">
  PICO \${DIA.pico.cargaMW.toFixed(1)} MW ÀS \${String(DIA.pico.hora).padStart(2,"0")}H · PIOR TENSÃO \${DIA.pior.vmin.toFixed(4)} PU ÀS \${String(DIA.pior.hora).padStart(2,"0")}H</text>\`;
 $("dia").innerHTML=s;
}

/* ---------------- interacao do mapa ---------------- */
function montarMapa(){
 const box=document.getElementById("mapbox");
 let arrastando=false,px=0,py=0,movimentou=false;
 const inicio=e=>{arrastando=true;movimentou=false;px=e.clientX;py=e.clientY;
   box.classList.add("arrastando");box.setPointerCapture(e.pointerId);};
 const move=e=>{if(!arrastando)return;
   const dx=e.clientX-px,dy=e.clientY-py;
   if(Math.abs(dx)+Math.abs(dy)>2)movimentou=true;
   px=e.clientX;py=e.clientY;VISTA.cx-=dx;VISTA.cy-=dy;mapa();};
 const fim=e=>{arrastando=false;box.classList.remove("arrastando");
   try{box.releasePointerCapture(e.pointerId)}catch{}};
 box.addEventListener("pointerdown",inicio);
 box.addEventListener("pointermove",move);
 box.addEventListener("pointerup",fim);
 box.addEventListener("pointercancel",fim);

 box.addEventListener("wheel",e=>{
   e.preventDefault();
   const r=box.getBoundingClientRect();
   zoomEm(e.deltaY<0?1:-1, e.clientX-r.left, e.clientY-r.top);
 },{passive:false});

 // pinca de dois dedos
 let d0=null;
 box.addEventListener("touchmove",e=>{
   if(e.touches.length!==2)return;
   e.preventDefault();
   const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,
                      e.touches[0].clientY-e.touches[1].clientY);
   if(d0===null){d0=d;return;}
   if(d/d0>1.35){zoomEm(1);d0=d;} else if(d/d0<0.74){zoomEm(-1);d0=d;}
 },{passive:false});
 box.addEventListener("touchend",()=>{d0=null;});

 document.getElementById("z_mais").addEventListener("click",()=>zoomEm(1));
 document.getElementById("z_menos").addEventListener("click",()=>zoomEm(-1));
 document.getElementById("z_fit").addEventListener("click",()=>{enquadrar();mapa();});
 ["escuro","satelite","nenhum"].forEach(b=>{
  document.getElementById("bs_"+b).addEventListener("click",()=>{
   VISTA.base=b;
   ["escuro","satelite","nenhum"].forEach(o=>
     document.getElementById("bs_"+o).setAttribute("aria-pressed",String(o===b)));
   if(VISTA.z>BASES[b].zmax){VISTA.cx/=Math.pow(2,VISTA.z-BASES[b].zmax);
     VISTA.cy/=Math.pow(2,VISTA.z-BASES[b].zmax);VISTA.z=BASES[b].zmax;}
   mapa();});
 });

 if(window.ResizeObserver){
  let t=null;
  new ResizeObserver(()=>{clearTimeout(t);t=setTimeout(()=>{if(R)mapa();},120);}).observe(box);
 }
}
function zoomEm(d,ax,ay){
 const {W,H}=dims();
 const z2=Math.min(BASES[VISTA.base].zmax,Math.max(3,VISTA.z+d));
 if(z2===VISTA.z)return;
 const k=Math.pow(2,z2-VISTA.z);
 const px=(ax===undefined?W/2:ax), py=(ay===undefined?H/2:ay);
 // mantem o ponto sob o cursor fixo na tela
 const mx=VISTA.cx-W/2+px, my=VISTA.cy-H/2+py;
 VISTA.cx=mx*k-px+W/2; VISTA.cy=my*k-py+H/2; VISTA.z=z2;
 mapa();
}

(async()=>{TOPO=await fetch("/api/topologia").then(r=>r.json());montarCtl();montarMapa();await rodar();})();
</script>
</body>
</html>
`;


/* ═══════════════ SERVIDOR ═══════════════ */
/* ARGOS Porangatu — servidor HTTP sem dependencias externas.
   Rotas:
     GET  /                    interface
     GET  /api/topologia       rede eletrica + camada de conectividade
     POST /api/simular         cenario instantaneo, com gossip entre clusters
     POST /api/dia             varredura de 24 h com estado de carga das baterias
     GET  /api/stream?...      SSE: rodadas de gossip e telegramas URB1
     GET  /api/saude           liveness                                        */



const HOST = process.env.HOST || '0.0.0.0';       // Render exige 0.0.0.0
const PORT = parseInt(process.env.PORT || '3000', 10);
const LIMITE_CORPO = 16 * 1024;
const JANELA_MS = 60_000, TETO_REQ = 240;

/* ------------------------------------------------ limitacao de taxa */
const balde = new Map();
function permitido(ip) {
  const agora = Date.now();
  const b = balde.get(ip);
  if (!b || agora - b.t0 > JANELA_MS) { balde.set(ip, { t0: agora, n: 1 }); return true; }
  b.n++;
  return b.n <= TETO_REQ;
}
setInterval(() => {
  const corte = Date.now() - JANELA_MS;
  for (const [ip, b] of balde) if (b.t0 < corte) balde.delete(ip);
}, JANELA_MS).unref();

/* ------------------------------------------------ cabecalhos */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://*.tile.openstreetmap.org",
  "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ');

function blindar(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const json = (res, code, obj) => {
  const corpo = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': Buffer.byteLength(corpo), 'Cache-Control': 'no-store' });
  res.end(corpo);
};

/* ------------------------------------------------ saneamento de cenario */
const num = (v, min, max, pad) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : pad;
};
function sanear(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    hora     : Math.round(num(c.hora, 0, 23, 19)),
    mes      : Math.round(num(c.mes, 1, 12, 8)),
    gdMW     : num(c.gdMW, 0, 60, 6),
    cresc    : num(c.cresc, 1, 2, 1),
    seca     : num(c.seca, 0, 1, 1),
    safra    : num(c.safra, 0, 1, 1),
    duracaoH : num(c.duracaoH, 0, 48, 4),
    inicioH  : Math.round(num(c.inicioH, 0, 23, 2)),
    n1       : !!c.n1, reg: c.reg !== false, cap: c.cap !== false, satelite: c.satelite !== false
  };
}

function lerCorpo(req) {
  return new Promise((ok, erro) => {
    let n = 0; const partes = [];
    req.on('data', d => {
      n += d.length;
      if (n > LIMITE_CORPO) { erro(new Error('corpo grande demais')); req.destroy(); return; }
      partes.push(d);
    });
    req.on('end', () => {
      try { ok(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); }
      catch { erro(new Error('JSON invalido')); }
    });
    req.on('error', erro);
  });
}

/* ------------------------------------------------ payload da topologia */
const TOPOLOGIA = {
  se: D.SE, ibge: D.IBGE,
  ctmt: D.CTMT.map(a => ({ id:a.id, nome:a.nome, classe:a.classe, kva:a.kva,
                           cond:D.COND[a.cond].nome, kmTotal:a.kmTotal, regs:a.regs })),
  barras: D.ELET.buses.map((b,i) => ({ i, id:b.id, ctmt:b.ctmt, pos:b.pos, km:b.km,
                                       kva:Math.round(b.kva), classe:b.classe, reg:b.reg })),
  ramos: D.ELET.branches.map(b => ({ from:b.from, to:b.to, km:b.km, ctmt:b.ctmt })),
  pops : D.POPS.map(p => ({ id:p.id, nome:p.nome, barra:p.barra, montante:p.montante,
                            pos:p.pos, autonomiaH:p.autonomiaH, assinantes:p.assinantes, satelite:p.satelite })),
  erbs : D.ERBS.map(e => ({ id:e.id, nome:e.nome, barra:e.barra, pos:e.pos,
                            autonomiaH:e.autonomiaH, raioKm:e.raioKm, tec:e.tec })),
  pivos: D.PIVOS.map(p => ({ id:p.id, pos:p.pos, areaHa:p.areaHa, barra:p.barra,
                             pop:p.pop, erb:p.erb, kwBomba:p.kwBomba })),
  areaHa: D.AREA_AGRICOLA_HA, fibraKm: D.FIBRA_KM
};

function resumo(r) {
  const v = P.verificar(r);
  return {
    estado: r.estado, rodadas: r.rodadas, jaccard: r.jaccard, convergiu: r.convergiu,
    solver: { V: r.rede.solver.V, iteracoes: r.rede.solver.iteracoes, taps: r.rede.solver.taps,
              tapMedio: r.rede.solver.tapMedio, convergiu: r.rede.solver.convergiu,
              residuoMW: r.rede.solver.residuoMW, perdasMW: r.rede.solver.perdasMW,
              PfonteMW: r.rede.solver.PfonteMW },
    cargas: r.rede.cargas.map(x => Math.round(x)),
    cargaMW: r.rede.cargaMW, gdMW: r.rede.gdMW,
    perdasPct: r.rede.perdasPct, carregPct: r.rede.carregPct,
    celulasRede: r.rede.celulas, celulasAgro: r.agro.celulas,
    pops: r.agro.pops.map(p => ({ id:p.pop.id, vivo:p.vivo, emBateria:p.emBateria,
                                  soc:p.soc, satelite:p.vivoPorSatelite })),
    erbs: r.agro.erbs.map(e => ({ id:e.id, vivo:e.vivo, emBateria:e.emBateria, soc:e.soc })),
    pivos: r.agro.pivos.map(p => ({ id:p.id, telemetria:p.telemetria, viaFibra:p.viaFibra, viaErb:p.viaErb })),
    haConectada: r.agro.haConectada, coberturaMovel: r.agro.coberturaMovel, latMedia: r.agro.latMedia,
    telegramas: r.telegramas.map(t => ({ rodada:t.rodada, tipo:t.tipo, seq:t.seq, bytes:t.bytes,
                                         hex:t.hex ? t.hex.slice(0,64) : null, objeto:t.objeto,
                                         jaccard:t.jaccard, estabilizou:t.estabilizou })),
    polov: v
  };
}


/* ------------------------------------------------ servidor */
const servidor = http.createServer(async (req, res) => {
  blindar(res);
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  if (!permitido(ip)) return json(res, 429, { erro: 'limite de requisicoes excedido' });

  let u;
  try { u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { erro: 'URL invalida' }); }
  const rota = u.pathname;

  try {
    if (rota === '/api/saude')
      return json(res, 200, { ok:true, versao:'1.0.0', barras:D.ELET.buses.length,
                              pops:D.POPS.length, pivos:D.PIVOS.length, uptime:process.uptime() });

    if (rota === '/api/topologia' && req.method === 'GET')
      return json(res, 200, TOPOLOGIA);

    if (rota === '/api/simular' && req.method === 'POST')
      return json(res, 200, resumo(M.executar(sanear(await lerCorpo(req)))));

    if (rota === '/api/dia' && req.method === 'POST') {
      const c = sanear(await lerCorpo(req));
      const d = M.executarDia(c);
      return json(res, 200, { estado:d.estado, horas:d.horas, pico:d.pico, pior:d.pior });
    }

    if (rota === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8',
                           'Cache-Control':'no-cache, no-transform', 'Connection':'keep-alive',
                           'X-Accel-Buffering':'no' });
      const c = sanear(Object.fromEntries([...u.searchParams].map(([k,v]) =>
        [k, v === 'true' ? true : (v === 'false' ? false : v)])));
      const env = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
      const r = M.executar(c);
      env('inicio', { estado: r.estado });
      let i = 0;
      const pulso = setInterval(() => {
        if (i >= r.telegramas.length) {
          clearInterval(pulso);
          env('fim', resumo(r));
          res.end();
          return;
        }
        const t = r.telegramas[i++];
        env('telegrama', { rodada:t.rodada, tipo:t.tipo, seq:t.seq, bytes:t.bytes,
                           hex:t.hex ? t.hex.slice(0,48) : null, objeto:t.objeto,
                           jaccard:t.jaccard, estabilizou:t.estabilizou });
      }, 90);
      req.on('close', () => clearInterval(pulso));
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (rota === '/' || rota === '/index.html')) {
      const buf = Buffer.from(INDEX, 'utf8');
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8',
                           'Content-Length': buf.length, 'Cache-Control':'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    if (req.method === 'GET') return json(res, 404, { erro:'nao encontrado' });
    return json(res, 405, { erro: 'metodo nao permitido' });

  } catch (e) {
    return json(res, 400, { erro: e.message });
  }
});

servidor.headersTimeout = 20_000;
servidor.requestTimeout = 30_000;

/* ═══════════════ AUTOTESTE ═══════════════ */
function autoteste() {
  let ok = 0, falha = 0;
  const t = (nome, cond, det = '') => { cond ? ok++ : falha++;
    console.log((cond ? '  ok    ' : '  FALHA ') + nome.padEnd(46) + det); };

  console.log('\nARGOS Porangatu — autoteste\n');
  const [maj] = process.versions.node.split('.').map(Number);
  t('Node >= 18', maj >= 18, process.versions.node);
  t('HOST = 0.0.0.0', HOST === '0.0.0.0', HOST);
  t('CRC16-CCITT("123456789") = 0x29B1', U.crc16ccitt(Buffer.from('123456789')) === 0x29B1);
  const q = U.montar(1, 2, U.TIPO.INTERRUPCAO, 1, { a: 1 });
  t('quadro URB1 fecha ida e volta', U.ler(q).objeto.a === 1);
  const q2 = Buffer.from(q); q2[15] ^= 0x01;
  t('CRC detecta bit invertido', (() => { try { U.ler(q2); return false; } catch { return true; } })());
  t('Jaccard idêntico = 1', U.jaccard(['a','b'], ['b','a']) === 1);
  t('topologia radial', D.ELET.branches.length === D.ELET.buses.length - 1, D.ELET.buses.length + ' barras');
  t('PoPs ancorados em barras reais', D.POPS.every(p => p.busIdx > 0), D.POPS.length + ' PoPs');
  t('interface embutida', INDEX.length > 10000, (INDEX.length / 1024).toFixed(0) + ' KB');

  let piorResiduo = 0, todasConv = true;
  for (const c of [{hora:19}, {hora:3,n1:true,duracaoH:8}, {hora:12,gdMW:20},
                   {hora:19,n1:true,duracaoH:12,cresc:1.4}]) {
    const r = M.executar(c); P.verificar(r);
    piorResiduo = Math.max(piorResiduo, Math.abs(r.rede.solver.residuoMW));
    if (!r.rede.solver.convergiu || !r.convergiu) todasConv = false;
  }
  t('solver e gossip convergem', todasConv);
  t('balanço ΣP fonte = ΣP carga + perdas', piorResiduo < 1e-5, (piorResiduo * 1e6).toFixed(2) + ' W');
  const t0 = Date.now(); M.executarDia({ n1: true, duracaoH: 18 });
  t('varredura de 24 h', true, (Date.now() - t0) + ' ms');

  console.log(`\n${ok} passaram, ${falha} falharam\n`);
  return falha;
}

if (require.main === module && process.argv.includes('--teste')) {
  process.exit(autoteste());
} else if (require.main === module) {
  servidor.listen(PORT, HOST, () => {
    console.log(`ARGOS Porangatu · http://${HOST}:${PORT}`);
    console.log(`  ${D.ELET.buses.length} barras · ${D.POPS.length} PoPs · ${D.ERBS.length} ERBs · ${D.PIVOS.length} pivos · ${D.AREA_AGRICOLA_HA} ha`);
  });
}
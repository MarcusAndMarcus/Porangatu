'use strict';
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

const D = require('../dados/porangatu');
const { resolver, FP } = require('./fluxo');
const U = require('./urb1');

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

module.exports = { executar, executarDia, avaliarRede, avaliarAgro, LIMIAR_RETIFICADOR, irradiancia, foraDePonta };

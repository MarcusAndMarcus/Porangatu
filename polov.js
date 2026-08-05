'use strict';
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
  const pctArea = 100 * agro.haConectada / require('../dados/porangatu').AREA_AGRICOLA_HA;

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

module.exports = { verificar, classificar, FAIXA, LIM };

'use strict';
const D = require('./dados/porangatu');
const M = require('./nucleo/malha');
const P = require('./nucleo/polov');
const U = require('./nucleo/urb1');

let ok = 0, falha = 0;
const t = (nome, cond, det='') => { (cond ? ok++ : falha++);
  console.log((cond?'  ok  ':'FALHA ') + nome.padEnd(52) + det); };

console.log('\n=== URB1 ===');
t('CRC16-CCITT vetor 123456789 = 0x29B1', U.crc16ccitt(Buffer.from('123456789')) === 0x29B1);
const q = U.montar(1,2,U.TIPO.INTERRUPCAO,1,{a:1});
t('quadro fecha ida e volta', U.ler(q).objeto.a === 1);
const q2 = Buffer.from(q); q2[15] ^= 0x01;
t('CRC detecta bit invertido', (()=>{try{U.ler(q2);return false}catch{return true}})());
t('Jaccard identico = 1', U.jaccard(['a','b'],['b','a']) === 1);
t('Jaccard disjunto = 0', U.jaccard(['a'],['b']) === 0);

console.log('\n=== TOPOLOGIA ===');
t('barras eletricas', D.ELET.buses.length === 54, `${D.ELET.buses.length}`);
t('ramos = barras - 1 (radial)', D.ELET.branches.length === D.ELET.buses.length-1);
t('PoPs mapeados a barras reais', D.POPS.every(p => p.busIdx > 0));
t('ERBs mapeadas a barras reais', D.ERBS.every(e => e.busIdx > 0));
t('pivos com PoP atribuido', D.PIVOS.every(p => p.pop));
t('area agricola', D.AREA_AGRICOLA_HA > 1000, `${D.AREA_AGRICOLA_HA} ha em ${D.PIVOS.length} pivos`);

console.log('\n=== INVARIANTES DO SOLVER ===');
const casos = [
  ['ponta 19h base',        {hora:19}],
  ['madrugada 03h pivo',    {hora:3}],
  ['N-1 4h',                {hora:19, n1:true, duracaoH:4}],
  ['N-1 8h madrugada',      {hora:3, n1:true, duracaoH:8}],
  ['N-1 8h + cresc 40%',    {hora:3, n1:true, duracaoH:8, cresc:1.4}],
  ['meio-dia GD 20 MWp',    {hora:12, gdMW:20}],
  ['sem satelite N-1 8h',   {hora:3, n1:true, duracaoH:8, satelite:false}]
];
const saida = [];
for (const [nome, cen] of casos) {
  const r = M.executar(cen);
  const v = P.verificar(r);
  t(`balanco fecha · ${nome}`, Math.abs(r.rede.solver.residuoMW) < 1e-5,
    `${(r.rede.solver.residuoMW*1e6).toFixed(2)} W`);
  t(`gossip converge · ${nome}`, r.convergiu, `${r.rodadas} rodadas`);
  saida.push({nome, r, v});
}

console.log('\n=== ACOPLAMENTO ENTRE CLUSTERS ===');
const base = M.executar({hora:3, n1:false, duracaoH:8});
const sob  = M.executar({hora:3, n1:true,  duracaoH:8});
t('N-1 derruba PoPs', sob.agro.pops.filter(p=>!p.vivo).length > base.agro.pops.filter(p=>!p.vivo).length,
  `${base.agro.pops.filter(p=>!p.vivo).length} -> ${sob.agro.pops.filter(p=>!p.vivo).length}`);
t('perda de telemetria realimenta a demanda',
  sob.rede.kwPivoEfetivo >= base.rede.kwPivoEfetivo,
  `${(base.rede.kwPivoEfetivo/1000).toFixed(2)} -> ${(sob.rede.kwPivoEfetivo/1000).toFixed(2)} MW`);
const semSat = M.executar({hora:3, n1:true, duracaoH:8, satelite:false});
t('satelite salva PoPs na cascata',
  semSat.agro.pops.filter(p=>!p.vivo).length >= sob.agro.pops.filter(p=>!p.vivo).length,
  `sem sat ${semSat.agro.pops.filter(p=>!p.vivo).length} · com sat ${sob.agro.pops.filter(p=>!p.vivo).length}`);
t('gossip roda mais de 1 rodada quando ha acoplamento', sob.rodadas >= 2, `${sob.rodadas}`);

console.log('\n=== RESUMO DOS CENARIOS ===');
console.log('cenario'.padEnd(22),'Vmin'.padEnd(7),'prec crit','  perd%','  PoP†','  pivo†','  ha conect','  lat ms',' rod');
for (const {nome, r, v} of saida) {
  console.log(
    nome.padEnd(22),
    v.vmin.toFixed(4).padEnd(7),
    String(v.nPrec).padStart(4), String(v.nCrit).padStart(4),
    r.rede.perdasPct.toFixed(2).padStart(7),
    String(r.agro.pops.filter(p=>!p.vivo).length).padStart(6),
    String(r.agro.semTelemetria.length).padStart(7),
    r.agro.haConectada.toFixed(0).padStart(11),
    r.agro.latMedia.toFixed(1).padStart(9),
    String(r.rodadas).padStart(4));
}
console.log(`\n${ok} passaram, ${falha} falharam`);
process.exit(falha ? 1 : 0);

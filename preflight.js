'use strict';
/* Preflight de producao. Sai com codigo != 0 se algo impedir o deploy. */
const fs = require('fs'), path = require('path');
let erros = 0, avisos = 0;
const ok  = m => console.log('  ok    ' + m);
const err = m => { console.log('  ERRO  ' + m); erros++; };
const av  = m => { console.log('  aviso ' + m); avisos++; };

console.log('\nARGOS Porangatu — preflight\n');

const [maj] = process.versions.node.split('.').map(Number);
maj >= 18 ? ok(`Node ${process.versions.node}`) : err(`Node ${process.versions.node} — exige >= 18`);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
Object.keys(pkg.dependencies || {}).length === 0
  ? ok('zero dependencias externas') : err('package.json declara dependencias');
fs.existsSync('node_modules') ? av('node_modules presente (desnecessario)') : ok('sem node_modules');

for (const f of ['server.js','nucleo/complexo.js','nucleo/urb1.js','nucleo/fluxo.js',
                 'nucleo/malha.js','nucleo/polov.js','dados/porangatu.js','publico/index.html'])
  fs.existsSync(f) ? ok(`arquivo ${f}`) : err(`faltando ${f}`);

const HOST = process.env.HOST || '0.0.0.0';
HOST === '0.0.0.0' ? ok('HOST = 0.0.0.0 (exigido pelo Render)')
                   : err(`HOST = ${HOST} — o Render nao consegue rotear; defina 0.0.0.0`);
ok(`PORT = ${process.env.PORT || '3000 (padrao local)'}`);
process.env.NODE_ENV === 'production' ? ok('NODE_ENV = production')
                                      : av('NODE_ENV nao e production — HSTS fica desligado');

try {
  const U = require('./nucleo/urb1');
  U.crc16ccitt(Buffer.from('123456789')) === 0x29B1
    ? ok('CRC16-CCITT confere com o vetor de referencia (0x29B1)')
    : err('CRC16-CCITT divergente do vetor de referencia');

  const D = require('./dados/porangatu');
  D.ELET.branches.length === D.ELET.buses.length - 1
    ? ok(`topologia radial · ${D.ELET.buses.length} barras`) : err('topologia nao e radial');
  D.POPS.every(p => p.busIdx > 0) ? ok(`${D.POPS.length} PoPs ancorados em barras reais`)
                                  : err('PoP sem barra correspondente');

  const M = require('./nucleo/malha');
  const P = require('./nucleo/polov');
  const casos = [{hora:19},{hora:3,n1:true,duracaoH:8},{hora:12,gdMW:20},{hora:19,n1:true,duracaoH:12,cresc:1.4}];
  let piorResiduo = 0, todasConv = true;
  for (const c of casos) {
    const r = M.executar(c); P.verificar(r);
    piorResiduo = Math.max(piorResiduo, Math.abs(r.rede.solver.residuoMW));
    if (!r.rede.solver.convergiu || !r.convergiu) todasConv = false;
  }
  todasConv ? ok('solver e gossip convergem em todos os casos') : err('algum caso nao convergiu');
  piorResiduo < 1e-5 ? ok(`balanco de potencia fecha · pior residuo ${(piorResiduo*1e6).toFixed(2)} W`)
                     : err(`balanco nao fecha · residuo ${(piorResiduo*1e6).toFixed(1)} W`);

  const t0 = Date.now(); M.executarDia({n1:true,duracaoH:18});
  const ms = Date.now() - t0;
  ms < 3000 ? ok(`varredura de 24 h em ${ms} ms`) : av(`varredura de 24 h levou ${ms} ms`);
} catch (e) { err('nucleo lancou excecao: ' + e.message); }

const html = fs.readFileSync(path.join('publico','index.html'), 'utf8');
/localStorage|sessionStorage/.test(html) ? err('interface usa storage do navegador') : ok('interface sem browser storage');

console.log(`\n${erros} erro(s), ${avisos} aviso(s)\n`);
process.exit(erros ? 1 : 0);

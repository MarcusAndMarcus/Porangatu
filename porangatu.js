'use strict';
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

module.exports = {
  SE, IBGE, COND, CTMT, ELET, POPS, ERBS, PIVOS,
  S_BASE, V_BASE, Z_BASE, AREA_AGRICOLA_HA, FIBRA_KM,
  distKm, idxDe
};

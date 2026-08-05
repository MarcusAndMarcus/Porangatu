'use strict';
/* Fluxo de potencia radial — varredura backward/forward.
   Escolhido no lugar de Newton-Raphson porque redes de distribuicao tem
   relacao R/X alta e a jacobiana fica mal condicionada.

   Invariantes garantidos e verificados em teste.js:
     (a) I = conj(S/V)                      — nao conj(S)/V
     (b) autotrafo ideal: Iprim = t * Isec   — o tap nao cria potencia
     (c) P_fonte = P_entregue + perdas       — residuo ~ 0 */

const C = require('./complexo');

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

module.exports = { resolver, EQRE, FP, ZIP };

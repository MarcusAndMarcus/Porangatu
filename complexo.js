'use strict';
// Aritmetica complexa minima. Sem dependencias.
module.exports = {
  add:  (a,b) => ({ re:a.re+b.re, im:a.im+b.im }),
  sub:  (a,b) => ({ re:a.re-b.re, im:a.im-b.im }),
  mul:  (a,b) => ({ re:a.re*b.re - a.im*b.im, im:a.re*b.im + a.im*b.re }),
  esc:  (a,k) => ({ re:a.re*k, im:a.im*k }),
  div:  (a,b) => { const d=b.re*b.re+b.im*b.im;
                   return { re:(a.re*b.re+a.im*b.im)/d, im:(a.im*b.re-a.re*b.im)/d }; },
  conj: (a)   => ({ re:a.re, im:-a.im }),
  abs:  (a)   => Math.hypot(a.re,a.im)
};

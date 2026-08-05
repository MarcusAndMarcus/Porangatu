'use strict';
/* ARGOS Porangatu — servidor HTTP sem dependencias externas.
   Rotas:
     GET  /                    interface
     GET  /api/topologia       rede eletrica + camada de conectividade
     POST /api/simular         cenario instantaneo, com gossip entre clusters
     POST /api/dia             varredura de 24 h com estado de carga das baterias
     GET  /api/stream?...      SSE: rodadas de gossip e telegramas URB1
     GET  /api/saude           liveness                                        */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const D = require('./dados/porangatu');
const M = require('./nucleo/malha');
const P = require('./nucleo/polov');

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

/* ------------------------------------------------ estaticos */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
               '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const RAIZ = path.join(__dirname, 'publico');

function estatico(res, rel, soCabecalho) {
  const alvo = path.join(RAIZ, rel === '/' ? 'index.html' : rel);
  if (!alvo.startsWith(RAIZ)) { res.writeHead(403).end('proibido'); return; }
  fs.readFile(alvo, (e, buf) => {
    if (e) { res.writeHead(404, {'Content-Type':'text/plain'}).end('nao encontrado'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(alvo)] || 'application/octet-stream',
                         'Content-Length': buf.length, 'Cache-Control': 'public, max-age=300' });
    res.end(soCabecalho ? undefined : buf);
  });
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

    if (req.method === 'GET' || req.method === 'HEAD') return estatico(res, rota, req.method === 'HEAD');
    return json(res, 405, { erro: 'metodo nao permitido' });

  } catch (e) {
    return json(res, 400, { erro: e.message });
  }
});

servidor.headersTimeout = 20_000;
servidor.requestTimeout = 30_000;

if (require.main === module) {
  servidor.listen(PORT, HOST, () => {
    console.log(`ARGOS Porangatu · http://${HOST}:${PORT}`);
    console.log(`  ${D.ELET.buses.length} barras · ${D.POPS.length} PoPs · ${D.ERBS.length} ERBs · ${D.PIVOS.length} pivos · ${D.AREA_AGRICOLA_HA} ha`);
  });
}

module.exports = servidor;

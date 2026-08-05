'use strict';
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

module.exports = { MAGIC, CLUSTER, TIPO, crc16ccitt, montar, ler, jaccard };

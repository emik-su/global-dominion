// =====================================================================
//  GLOBAL DOMINION — сервер сетевой игры на Node.js (без зависимостей).
//  Раздаёт игру (index.html рядом) и держит комнаты по WebSocket: /ws/<КОД>.
//  Запуск:  node server.js        (порт 8787, или PORT=…)
//  Ссылка на мини-приложение Telegram для приглашений: TG_LINK=https://t.me/<бот>/<приложение>
//  Для интернета удобнее Cloudflare (worker.js) — этот сервер для своей
//  машины, локальной сети, VPS и проверки.
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Room } from './room.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(process.env.PUBLIC_DIR || DIR);
const SERVE = new Set(['/index.html', '/favicon.ico']); // наружу — только игра
const PORT = +process.env.PORT || 8787;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const rooms = new Map();

// ---------- статика ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ tgLink: process.env.TG_LINK || '' }));
    return;
  }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + rooms.size); return; }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.resolve(PUBLIC, '.' + p);
  if (!SERVE.has(p) || !file.startsWith(PUBLIC)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- WebSocket (RFC 6455): только текст, сообщения до 64 КБ ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}
function makeConn(socket, onText, onClose) {
  let buf = Buffer.alloc(0), frags = [], closed = false, alive = Date.now();
  const conn = {
    send(s) { if (!closed) socket.write(frame(1, Buffer.from(s, 'utf8'))); },
    close(code = 1000, reason = '') {
      if (closed) return;
      const r = Buffer.from(String(reason).slice(0, 60), 'utf8'), p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0); r.copy(p, 2);
      try { socket.write(frame(8, p)); } catch (e) { /* уже */ }
      finish();
      setTimeout(() => socket.destroy(), 100);
    },
  };
  const finish = () => { if (closed) return; closed = true; clearInterval(ka); onClose(conn); };
  // проверка связи: ping раз в 20 с, молчание 60 с — обрыв
  const ka = setInterval(() => {
    if (Date.now() - alive > 60000) { socket.destroy(); return; }
    try { socket.write(frame(9, Buffer.alloc(0))); } catch (e) { /* уже */ }
  }, 20000);
  socket.on('data', (d) => {
    alive = Date.now();
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > 65536n) { socket.destroy(); return; } len = Number(big); off = 10; }
      if (len > 65536 || !masked) { socket.destroy(); return; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { conn.close(1000); return; }
      if (op === 9) { try { socket.write(frame(10, data)); } catch (e) { /* уже */ } continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        frags.push(data);
        if (frags.reduce((s, b) => s + b.length, 0) > 65536) { socket.destroy(); return; }
        if (fin) { const text = Buffer.concat(frags).toString('utf8'); frags = []; onText(text); }
      }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return conn;
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/ws\/([A-Za-z0-9]{4,8})$/.exec(url.pathname);
  const key = req.headers['sec-websocket-key'];
  if (!m || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const code = m[1].toUpperCase();
  let room = rooms.get(code);
  if (!room) {
    // GD_FAST=1 — короткие сроки обрывов (для проверок)
    const timing = process.env.GD_FAST ? { DROP_AFTER: 3000, LOBBY_GRACE: 3000, SILENT_MS: 2000, LOAD_WAIT: 8000, EMPTY_END: 4000 } : undefined;
    room = new Room(code, { setInterval, clearInterval, now: () => Date.now(), timing, onEmpty: () => { if (rooms.get(code) === room) rooms.delete(code); } });
    rooms.set(code, room);
  }
  const conn = makeConn(socket, (t) => room.message(conn, t), (c) => room.closed(c));
  room.open(conn);
});

server.listen(PORT, () => {
  console.log('GLOBAL DOMINION: http://localhost:' + PORT + '  (игра: ' + PUBLIC + ')');
});

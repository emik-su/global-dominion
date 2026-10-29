// =====================================================================
//  GLOBAL DOMINION — сервер сетевой игры на Cloudflare Workers.
//  Игра (index.html) встроена в код сервера и отдаётся по адресу «/»;
//  каждая комната — отдельный Durable Object (RoomDO) с комнатой из
//  room.js: wss://<адрес>/ws/<КОД>. Бесплатного тарифа хватает на игры
//  с друзьями. Ссылка на мини-приложение Telegram — переменная TG_LINK.
// =====================================================================
import { Room } from './room.js';
import PAGE from './index.html';

// Страница в байтах (кодируется один раз, а не на каждый запрос) и метка её версии:
// повторный запуск в Telegram не качает игру заново, пока она не обновилась.
// Метка «слабая» (W/): Cloudflare при сжатии всё равно делает её такой.
let page = null;
function pageData() {
  if (!page) {
    const bytes = new TextEncoder().encode(PAGE);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 7) h = Math.imul(h ^ bytes[i], 0x01000193);
    page = { bytes, tag: 'W/"' + (h >>> 0).toString(36) + bytes.length.toString(36) + '"' };
  }
  return page;
}
const sameTag = (inm, tag) => !!inm && inm.split(',').some((x) => { x = x.trim(); return x === '*' || x.replace(/^W\//, '') === tag.replace(/^W\//, ''); });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const p = pageData();
      if (sameTag(req.headers.get('If-None-Match'), p.tag)) return new Response(null, { status: 304, headers: { etag: p.tag, 'cache-control': 'no-cache' } });
      return new Response(p.bytes, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: p.tag } });
    }
    if (url.pathname === '/config.json') {
      return new Response(JSON.stringify({ tgLink: env.TG_LINK || '' }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const m = /^\/ws\/([A-Za-z0-9]{4,8})$/.exec(url.pathname);
    if (m) {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Нужен WebSocket', { status: 426 });
      const code = m[1].toUpperCase();
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request('https://room/ws/' + code, req));
    }
    // общий список открытых комнат — в отдельном объекте того же класса (имя «__dir__» не бывает кодом комнаты)
    if (url.pathname === '/rooms') {
      const r = await env.ROOMS.get(env.ROOMS.idFromName(DIR_NAME)).fetch('https://dir/dir/list');
      return new Response(await r.text(), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response('Не найдено', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};

const DIR_NAME = '__dir__';
// Комната: живёт, пока в ней есть участники (соединения держат объект в памяти).
// Объект с именем DIR_NAME — общий список открытых комнат (в памяти: комнаты сами
// присылают о себе запись раз в 2–20 с, устаревшие через минуту не показываются)
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.dir = null;
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/dir/')) return this.directory(req, path);
    const code = path.split('/').pop();
    if (!this.room) {
      const env = this.env;
      const room = new Room(code, {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t),
        now: () => Date.now(),
        publish: (c, info) => {
          env.ROOMS.get(env.ROOMS.idFromName(DIR_NAME)).fetch('https://dir/dir/put', { method: 'POST', body: JSON.stringify({ code: c, info }) }).catch(() => {});
        },
        onEmpty: () => { if (this.room === room) this.room = null; },
      });
      this.room = room;
    }
    const room = this.room;
    const pair = new WebSocketPair();
    const client = pair[0], ws = pair[1];
    ws.accept();
    const conn = {
      send: (s) => { try { ws.send(s); } catch (e) { /* закрыто */ } },
      close: (c, r) => { try { ws.close(c || 1000, r || ''); } catch (e) { /* уже */ } },
    };
    room.open(conn);
    ws.addEventListener('message', (e) => room.message(conn, typeof e.data === 'string' ? e.data : ''));
    const done = () => { room.closed(conn); try { ws.close(1000, ''); } catch (e) { /* уже */ } };
    ws.addEventListener('close', done);
    ws.addEventListener('error', done);
    return new Response(null, { status: 101, webSocket: client });
  }
  async directory(req, path) {
    if (!this.dir) this.dir = new Map();
    if (path === '/dir/put' && req.method === 'POST') {
      try {
        const { code, info } = await req.json();
        if (typeof code === 'string' && /^[A-Z0-9]{4,8}$/.test(code)) { if (info && typeof info === 'object') this.dir.set(code, Object.assign({}, info, { t: Date.now() })); else this.dir.delete(code); }
      } catch (e) { /* плохой запрос */ }
      return new Response('ok');
    }
    const now = Date.now(), list = [];
    for (const [k, v] of this.dir) { if (now - v.t > 60000) this.dir.delete(k); else list.push(v); }
    list.sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1) || b.t - a.t);
    return new Response(JSON.stringify({ rooms: list.slice(0, 50) }), { headers: { 'content-type': 'application/json' } });
  }
}

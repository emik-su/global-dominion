// =====================================================================
//  GLOBAL DOMINION — сервер сетевой игры на Cloudflare Workers.
//  Игра (index.html) встроена в код сервера и отдаётся по адресу «/»;
//  каждая комната — отдельный Durable Object (RoomDO) с комнатой из
//  room.js: wss://<адрес>/ws/<КОД>. Бесплатного тарифа хватает на игры
//  с друзьями. Ссылка на мини-приложение Telegram — переменная TG_LINK.
// =====================================================================
import { Room } from './room.js';
import PAGE from './index.html';

// метка версии страницы: повторный запуск в Telegram не качает игру заново, пока она не обновилась
let etag = '';
function pageTag() {
  if (!etag) { let h = 0x811c9dc5; for (let i = 0; i < PAGE.length; i += 7) h = Math.imul(h ^ PAGE.charCodeAt(i), 0x01000193); etag = '"' + (h >>> 0).toString(36) + PAGE.length.toString(36) + '"'; }
  return etag;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const tag = pageTag();
      if (req.headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers: { etag: tag } });
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: tag } });
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
    if (url.pathname === '/health') return new Response('ok');
    return new Response('Не найдено', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};

// Комната: живёт, пока в ней есть участники (соединения держат объект в памяти)
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.room = null;
  }
  async fetch(req) {
    const code = new URL(req.url).pathname.split('/').pop();
    if (!this.room) {
      const room = new Room(code, {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t),
        now: () => Date.now(),
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
}

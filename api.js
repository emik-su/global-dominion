// =====================================================================
//  HTTP-запросы к аккаунтам (ТЗ v8). Один код для Cloudflare (AccountsDO) и Node-сервера.
//   GET  /api/me           — профиль по входу Telegram (заголовок «Authorization: tma <initData>»)
//   GET  /api/avatar/<uid> — фото игрока (сервер забирает его у Telegram и кэширует)
//   GET  /api/top?mode=duel|multi&limit=20 — лучшие игроки режима (после калибровки)
//   GET  /api/profile/<uid> — карточка игрока: рейтинги, место, последние бои
//   POST /internal/login   — вход при подключении к комнате (только для комнат сервера; снаружи не доступен:
//                            главный Worker пересылает в AccountsDO только пути /api/…)
//   POST /internal/report  — итог боя от комнаты: запись, рейтинг, штрафы за ранний выход
//   POST /internal/rankcheck — перед рейтинговым боем: рейтинги и паузы после ухода у списка игроков
//   POST /internal/replay?id=<бой> — запись боя от комнаты (тело — байты в хранимом виде, pack.js); после итога боя
//   GET  /api/matches?uid=<игрок>&limit=10&after=<время>:<бой> — бои игрока постранично, у боя — признак «запись есть»
//   GET  /api/replay/<бой> — запись боя (JSON того же вида, что повтор в игре); хранится 30 суток
//   GET  /api/selfcheck    — самопроверка сервера после установки (номер бота, подпись Ed25519, сжатие, база); без секретов
// =====================================================================
import { verifyInitData, authOptions, authConfigured, photoOk, selfTest } from './auth.js';
import { AVATAR_MAX } from './accounts.js';
import { MODES } from './rating.js';
import { pack, unpack } from './pack.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400' };
export const json = (obj, status = 200, extra) => new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS, extra) });
const IMG = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']);

// Проверка данных входа и запись профиля. Результат: { ok: true, uid, name, av, … } или { ok: false, why }.
export async function loginInit(acc, env, init, now = Date.now()) {
  const v = await verifyInitData(init, Object.assign(authOptions(env), { now }));
  if (!v.ok) return { ok: false, why: v.why, configured: authConfigured(env) };
  const p = acc.login(v, now);
  return { ok: true, uid: p.uid, name: p.name, username: p.username, av: p.av, method: v.method, rt: acc.ratings(p.uid) };
}

// ---------- итог боя от комнаты ----------
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const str = (v, n) => typeof v === 'string' && v.length >= 1 && v.length <= n;
const OUTCOMES = new Set(['win', 'loss', 'draw', 'quit', 'early', 'void']);
// Проверка и приведение итога боя (комната — свой, но база не должна ломаться от кривых данных). Возвращает объект или null.
export function cleanMatch(raw) {
  if (!raw || typeof raw !== 'object' || !str(raw.id, 40) || !/^[A-Za-z0-9_-]+$/.test(raw.id)) return null;
  if (!Number.isFinite(raw.t) || !isInt(raw.dur, 0, 86400) || !str(raw.map, 24) || !MODES.includes(raw.mode) || (raw.status !== 'ok' && raw.status !== 'void')) return null;
  if (!Array.isArray(raw.players) || raw.players.length > 8 || !raw.teams || typeof raw.teams !== 'object') return null;
  const players = [];
  for (const p of raw.players) {
    if (!p || !isInt(p.pid, 0, 7) || !isInt(p.uid, 0, 1e15) || !str(p.name, 40) || !str(p.tk, 8) || !isInt(p.faction | 0, 0, 63) || !OUTCOMES.has(p.outcome) || !isInt(p.place | 0, 0, 8)) return null;
    players.push({ pid: p.pid, uid: p.uid, name: p.name, tk: p.tk, faction: p.faction | 0, outcome: p.outcome, place: p.place | 0, quit: !!p.quit });
  }
  if (new Set(players.map((p) => p.pid)).size !== players.length) return null;
  const teams = {};
  for (const k of Object.keys(raw.teams)) { if (!str(k, 8) || !isInt(raw.teams[k], 1, 8)) return null; teams[k] = raw.teams[k]; }
  if (raw.status === 'ok' && players.some((p) => !(p.tk in teams))) return null;
  const penalties = Array.isArray(raw.penalties) ? raw.penalties.filter((u) => isInt(u, 1, 1e15)).slice(0, 8) : [];
  return { id: raw.id, t: Math.floor(raw.t), dur: raw.dur, map: raw.map, mode: raw.mode, ranked: !!raw.ranked, status: raw.status, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 20) : '',
    ticks: isInt(raw.ticks, 0, 1e9) ? raw.ticks : 0, hash: isInt(raw.hash, 0, 0xffffffff) ? raw.hash : 0, players, teams, penalties };
}
export function reportMatch(acc, raw, now = Date.now()) {
  const m = cleanMatch(raw);
  if (!m) return { ok: false, why: 'bad' };
  return Object.assign({ ok: true }, acc.applyMatch(m, now));
}
// запись боя от комнаты: id — номер боя (тот же, что в итоге), bytes — запись в хранимом виде
export function saveReplay(acc, id, bytes, now = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, why: 'bad' };
  return acc.putReplay(id, bytes instanceof Uint8Array ? bytes : null, now);
}
// перед рейтинговым боем: рейтинги и паузы игроков
export function rankInfo(acc, raw, now = Date.now()) {
  const uids = Array.isArray(raw) ? raw.filter((u) => isInt(u, 1, 1e15)).slice(0, 8) : [];
  return acc.rankCheck(uids, now);
}

// Забирает фото по ссылке Telegram: только с адресов Telegram, переходы проверяются, размер и тип ограничены.
async function fetchPhoto(url, env) {
  const doFetch = (env && env.__fetch) || fetch;
  for (let hop = 0; hop < 3; hop++) {
    if (!photoOk(url)) return null;
    let r;
    try { r = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { accept: 'image/*' } }); } catch (e) { return null; }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return null;
      try { url = new URL(loc, url).href; } catch (e) { return null; }
      continue;
    }
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMG.has(type)) return null;
    const len = +r.headers.get('content-length') || 0;
    if (len > AVATAR_MAX) return null;
    let buf;
    try { buf = new Uint8Array(await r.arrayBuffer()); } catch (e) { return null; }
    if (!buf.length || buf.length > AVATAR_MAX) return null;
    return { type, data: buf };
  }
  return null;
}

async function avatar(acc, env, uid, now) {
  const p = Number.isSafeInteger(uid) && uid > 0 ? acc.profile(uid) : null;
  const none = () => new Response('', { status: 404, headers: Object.assign({ 'cache-control': 'public, max-age=300' }, CORS) });
  if (!p || !p.photo) return none();
  let a = acc.avatar(uid);
  if (!acc.avatarFresh(a, p.photo, now)) {
    const got = await fetchPhoto(p.photo, env);
    if (got) { acc.setAvatar(uid, p.photo, got.type, got.data, now); a = { url: p.photo, type: got.type, t: now, data: got.data }; }
    else if (!a) return none();
  }
  // фото — чужой файл: открыть его как страницу нельзя (песочница), браузер не угадывает тип
  return new Response(a.data, { headers: Object.assign({ 'content-type': a.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }, CORS) });
}

const tma = (req) => { const h = req.headers.get('authorization') || ''; return /^tma /i.test(h) ? h.slice(4).trim() : ''; };

// ---------- самопроверка сервера ----------
// Открыть в браузере: <адрес сайта>/api/selfcheck. Показывает то, что нельзя проверить из тестов в другой среде: настроен ли номер бота,
// работают ли подпись Ed25519 и сжатие именно здесь (на Cloudflare — внутри AccountsDO), отвечает ли база. Секретов нет: токена — только «есть/нет».
// Ответ запоминается на 30 с: страницу нельзя использовать, чтобы без конца нагружать базу.
let selfMemo = null;
export async function selfCheck(acc, env, now = Date.now()) {
  if (selfMemo && selfMemo.acc === acc && selfMemo.env === env && now - selfMemo.t < 30000) return selfMemo.v;
  const o = authOptions(env || {}), problems = [];
  const mode = o.botId && o.botToken ? 'ed25519+hmac' : o.botId ? 'ed25519' : o.botToken ? 'hmac' : 'none';
  const ed = await selfTest();
  let gz;
  try {
    const sample = 'GLOBAL DOMINION ' + 'сжатие '.repeat(200), b = await pack(sample), back = await unpack(b);
    gz = back !== sample ? 'fail: после сжатия текст не совпал' : b[0] === 0x47 ? 'ok' : 'нет сжатия (записи хранятся как есть)';
  } catch (e) { gz = 'fail: ' + String(e && e.message || e).slice(0, 80); }
  let db;
  try { db = acc.stats(); } catch (e) { db = { error: String(e && e.message || e).slice(0, 80) }; }
  if (mode === 'none') problems.push('Не задан номер бота TG_BOT_ID (и нет секрета BOT_TOKEN): вход через Telegram не подтверждается, все игроки — гости, рейтинговые бои недоступны.');
  if (env && env.TG_PUBKEY) problems.push('Задана переменная TG_PUBKEY — она нужна только для проверок. Удалите её, иначе вход настоящих игроков не подтвердится.');
  if (ed.startsWith('fail') && (mode === 'ed25519' || mode === 'ed25519+hmac')) problems.push('Подпись Ed25519 в этой среде не работает (' + ed + ')' + (o.botToken ? '.' : ' — добавьте секрет BOT_TOKEN: тогда вход проверяется по токену.'));
  if (gz.startsWith('fail')) problems.push('Сжатие записей боёв не работает (' + gz + ').');
  if (db.error) problems.push('База аккаунтов не отвечает (' + db.error + ').');
  const nav = globalThis.navigator && globalThis.navigator.userAgent;
  const v = {
    ok: !problems.length,
    runtime: String(nav || 'unknown').slice(0, 40),
    tg: { botId: o.botId, token: !!o.botToken, pubKeyOverride: !!(env && env.TG_PUBKEY), mode },
    crypto: { ed25519: ed, gzip: gz },
    db,
    problems,
  };
  selfMemo = { acc, env, t: now, v };
  return v;
}

// Главный обработчик: возвращает Response (для чужих путей — 404).
export async function handleApi(acc, env, req, now = Date.now()) {
  const url = new URL(req.url), path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/internal/login' && req.method === 'POST') return json(await loginInit(acc, env, await req.text(), now));
  if (path === '/internal/report' && req.method === 'POST') {
    let body = null;
    try { body = JSON.parse(await req.text()); } catch (e) { /* не JSON */ }
    return json(reportMatch(acc, body, now));
  }
  if (path === '/internal/replay' && req.method === 'POST') {
    let bytes = null;
    try { bytes = new Uint8Array(await req.arrayBuffer()); } catch (e) { /* нет тела */ }
    return json(saveReplay(acc, url.searchParams.get('id') || '', bytes, now));
  }
  if (path === '/internal/rankcheck' && req.method === 'POST') {
    let body = null;
    try { body = JSON.parse(await req.text()); } catch (e) { /* не JSON */ }
    return json(rankInfo(acc, body, now));
  }
  if (path === '/api/top' && req.method === 'GET') {
    const mode = url.searchParams.get('mode') === 'multi' ? 'multi' : 'duel', limit = Math.max(1, Math.min(50, +url.searchParams.get('limit') || 20));
    return json({ ok: true, mode, top: acc.top(mode, limit) }, 200, { 'cache-control': 'public, max-age=15' });
  }
  if (path === '/api/selfcheck' && req.method === 'GET') return json(await selfCheck(acc, env, now));
  if (path === '/api/me' && req.method === 'GET') {
    const init = tma(req);
    if (!init) return json({ ok: false, why: 'empty', configured: authConfigured(env) });
    return json(await loginInit(acc, env, init, now));
  }
  if (path === '/api/matches' && req.method === 'GET') {
    const uid = +url.searchParams.get('uid'), limit = Math.max(1, Math.min(30, +url.searchParams.get('limit') || 10));
    if (!Number.isSafeInteger(uid) || uid < 1) return json({ ok: false, why: 'bad' }, 400);
    const c = /^(\d{1,16}):([A-Za-z0-9_-]{1,40})$/.exec(url.searchParams.get('after') || '');
    const pg = acc.matchPage(uid, limit, c ? { t: +c[1], id: c[2] } : null);
    return json({ ok: true, list: pg.list, more: pg.more }, 200, { 'cache-control': 'public, max-age=15' });
  }
  let m;
  if ((m = /^\/api\/avatar\/(\d{1,15})$/.exec(path)) && req.method === 'GET') return avatar(acc, env, +m[1], now);
  if ((m = /^\/api\/replay\/([A-Za-z0-9_-]{1,40})$/.exec(path)) && req.method === 'GET') {
    const bytes = acc.getReplay(m[1]), text = bytes ? await unpack(bytes) : null;
    if (!text) return json({ ok: false, why: 'notfound' }, 404);
    // запись не меняется после боя — браузер может хранить её час; JSON отдаём как есть (сжатие — на стороне сайта)
    return new Response(text, { headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' }, CORS) });
  }
  if ((m = /^\/api\/profile\/(\d{1,15})$/.exec(path)) && req.method === 'GET') {
    const card = acc.card(+m[1]);
    return card ? json({ ok: true, card }, 200, { 'cache-control': 'public, max-age=15' }) : json({ ok: false, why: 'notfound' }, 404);
  }
  return json({ ok: false, why: 'notfound' }, 404);
}

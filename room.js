// =====================================================================
//  Комната сетевой игры GLOBAL DOMINION — общий код сервера
//  (одинаково работает в Node.js и в Cloudflare Durable Object).
//
//  Лобби: участники (по постоянному токену браузера), места на карте
//  (игрок / ИИ / свободно / закрыто), фракции, цвета, союзы, правила.
//  Бой (lockstep): сервер не считает бой — он отсчитывает ходы по 100 мс
//  и рассылает всем одинаковые списки приказов. Игры участников считают
//  одно и то же и раз в 5 ходов присылают хеш состояния — сервер сверяет.
//  Обрыв связи: 30 с — войсками командует ИИ (приказ «drop» в ходе);
//  вернувшийся получает пропущенные ходы и снова командует («back»).
//  Бой никого не ждёт: игрок с плохой связью или медленным телефоном
//  видит бой с задержкой и догоняет его ускоренно; отстал больше чем
//  на 15 с — войсками временно командует ИИ, догнал — снова командует сам.
//  Хост нужен только в комнате (правила, «В бой»); в бою его уход ничего
//  не останавливает, а в комнате хостом становится другой участник.
//  Зрители (участники без места) мест не занимают; бой они видят без
//  тумана войны, но с задержкой 1 мин (ходы приходят на 600 позже) —
//  подсказать игрокам «со второго телефона» нельзя. Открытая комната
//  (с названием) попадает в общий список комнат (io.publish).
// =====================================================================
import { judge, tkey, TICKS_PER_TURN, TICKS_PER_SEC } from './judge.js';
import { pack } from './pack.js';

export const PROTO = 1;
const TURN_MS = 100;
const MAX_MEMBERS = 16;   // игроки (до 8 мест) и зрители
const MAX_SLOTS = 8;
const KINDS = ['open', 'easy', 'normal', 'hard', 'closed'];
const FACTIONS = ['random', 'usa', 'rus', 'ger', 'irn', 'isr', 'chn', 'ind', 'ukr'];
const COLORS = 10;
const CREDITS = [2500, 5000, 10000];
const POI_VALUES = ['off', 'refinery', 'comms', 'arsenal', 'random']; // «Точка интереса» (ТЗ v7)
// Рейтинговые бои (ТЗ v8): только на картах, где у всех одинаковые условия (Переправа 1×1 и 12 симметричных карт на 3, 5 и 7 игроков;
// число — сколько мест на карте, и все они должны быть заняты людьми), и только с фиксированными правилами
export const RANKED_MAPS = { crossing: 2, trefoil: 3, oases: 3, icecrown: 3, passes3: 3, fiverivers: 5, star5: 5, tundra5: 5, works5: 5, sevenhills: 7, selva7: 7, sundial7: 7, ruins7: 7 };
export const RANK_RULES = { credits: 5000, sw: true, fog: true, par: true, dyn: true, cyc: true, poi: 'off', dbg: false };
// сроки (мс); для проверок их можно сократить: io.timing
const TIMING = {
  DROP_AFTER: 30000,  // нет связи 30 с — войсками командует ИИ
  LAG_DROP: 15000,    // отстал от боя больше чем на 15 с (свернул приложение, связь «висит») — временно командует ИИ
  LOBBY_GRACE: 45000, // в лобби место держится 45 с после обрыва
  HOST_GRACE: 10000,  // хост без связи 10 с, а в комнате есть кто-то на связи — хостом становится он
  LOAD_WAIT: 60000,   // ждём загрузки карты у всех не дольше минуты
  EMPTY_END: 60000,   // в бою никого на связи — через минуту бой закрывается
  PRES_GAP: 8000,     // сообщения «потерял связь / снова на связи» — не чаще раза в 8 с на участника
  SPEC_DELAY: 60000,  // зрители видят бой с задержкой 1 мин
  PUB_GAP: 2000,      // открытая комната обновляет общий список не чаще раза в 2 с (и раз в 20 с — «я жива»)
  AUTH_WAIT: 5000,    // проверка входа через Telegram (io.auth) не дольше 5 с — иначе заходим гостем
  RANK_WAIT: 6000,    // ответ сервера рейтинга (io.rankCheck, io.report) не дольше 6 с
  REC_WAIT: 20000,    // сервер аккаунтов принимает запись боя (io.saveRec) не дольше 20 с
  EARLY_MS: 180000,   // выход (или сдача) до 3-й минуты боя — «ранний»: бой остальным не засчитывается, ушедшему штраф
  RETURN_WINDOW: 240000, // вылетевший может вернуться в бой в течение 4 минут; в рейтинговом бою позже вылет — выход из боя
  CATCH_GRACE: 90000, // вернувшемуся в последний момент даётся ещё до 90 с, чтобы догнать бой (пересчёт идёт быстрее реального времени)
};
const LAG_RESUME = 12;      // догнал бой (отставание ≤ 12 ходов) — снова командует сам
const MAX_MSG = 16384;

const clean = (s, n = 16) => Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, n).join('').trim();

// ---------- запись боя (ТЗ v8, этап 5) ----------
// Запись — того же вида, что повтор в игре (src/21c_replay.js, Rec): параметры боя с зерном, приказы [такт, игрок, приказ], контрольные хеши
// и хеш в конце. Собирает её сам сервер из приказов, которые разослал, и хешей игр участников — подделать запись с телефона нельзя.
// Приказы хода n исполняются в такте n·6. Игра присылает отчёт внутри последнего такта боя (rep.tk — сколько тактов уже посчитано до него),
// поэтому в бою tk + 1 тактов, а хеш отчёта — хеш состояния в конце этого такта. Контрольные хеши — раз в 300 тактов (ход 49, 99, …).
export const REC_V = 1, REC_MAX_EV = 150000, REC_MAX_TICKS = 60 * 60 * 180;
export function buildRecord(g, rep, id) {
  const ticks = (rep.tk | 0) + 1;
  if (!(ticks > 1) || ticks > REC_MAX_TICKS || !Array.isArray(g.log)) return null;
  const ev = [];
  for (let n = 0; n < g.log.length; n++) {
    const tick = n * TICKS_PER_TURN;
    if (tick >= ticks) break;
    const c = g.log[n];
    if (!c) continue;
    for (const x of c) {
      if (!Array.isArray(x)) continue;
      ev.push([tick, x[0] | 0, JSON.stringify(x[1])]);
      if (ev.length > REC_MAX_EV) return null;
    }
  }
  const hs = [];
  if (g.cp) for (const [n, h] of [...g.cp].sort((a, b) => a[0] - b[0])) { const t = (n + 1) * TICKS_PER_TURN; if (t <= ticks) hs.push([t, h >>> 0]); }
  const cfg = JSON.parse(JSON.stringify(g.cfg));
  return { v: REC_V, b: g.build || '', id, t: g.wall, cfg, mp: true, human: 0, fog0: cfg.fog !== false, map: '', ev, hs, ticks, dur: Math.round(ticks / TICKS_PER_SEC), end: rep.h >>> 0 };
}

export class Room {
  // io: { setInterval, clearInterval, now(), onEmpty() }
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.members = [];
    this.nextId = 1;
    this.host = 0;
    this.created = false;
    this.state = 'lobby';
    this.s = { map: 'crossing', credits: 5000, sw: true, fog: true, par: true, dyn: true, cyc: true, poi: 'off', dbg: false, pub: false, name: '', rank: false };
    this.pubT = -1e12; this.pubDirty = false; this.pubOn = false;
    this.starting = false; // идёт проверка перед рейтинговым боем (сервер рейтинга отвечает не сразу)
    this.lastRes = null;   // последний итог боя (его получит и тот, кто вернулся в комнату уже после конца боя)
    this.slots = [];
    this.game = null;
    this.timer = null;
    this.houseT = 0;
    this.conns = new Set();
    this.T = Object.assign({}, TIMING, io.timing || {});
  }
  now() { return this.io.now(); }

  // ---------- соединения ----------
  open(conn) {
    conn.member = null; conn.rate = 0; conn.rateT = this.now(); conn.chatT = 0;
    this.conns.add(conn);
    this.ensureTimer();
  }
  closed(conn) {
    this.conns.delete(conn);
    const m = conn.member;
    conn.member = null;
    if (!m || m.conn !== conn) return;
    m.conn = null; m.on = false; m.offT = this.now();
    if (this.game && m.pid >= 0 && !m.over && !m.dropped) this.presence(m, m.name + ' потерял связь — бой продолжается', 'warn');
    this.broadcastRoom();
  }
  // всплывающие сообщения о связи участников боя (не чаще раза в PRES_GAP на участника)
  presence(m, text, k) {
    const t = this.now();
    if (t - (m.presT || -1e12) < this.T.PRES_GAP) return;
    m.presT = t;
    this.chat(null, text, k);
  }
  message(conn, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    // не больше ~60 сообщений в секунду с соединения
    const t = this.now();
    if (t - conn.rateT > 1000) { conn.rateT = t; conn.rate = 0; }
    if (++conn.rate > 60) { if (conn.rate > 400) conn.close(4008, 'flood'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') { this.hello(conn, msg); return; }
    if (msg.t === 'ping') { if (conn.member) conn.member.lastMsg = t; this.send(conn, { t: 'pong', k: msg.k }); return; }
    // идёт проверка входа (hello ещё не завершён): сообщения подождут и обработаются сразу после него
    if (conn.helloing) { if (conn.queue && conn.queue.length < 60) conn.queue.push(raw); return; }
    const m = conn.member;
    if (m) m.lastMsg = t; // любое сообщение — участник на связи (свёрнутое приложение молчит)
    if (!m) return;
    const h = this['on_' + msg.t];
    if (typeof h === 'function') h.call(this, m, msg);
  }
  send(conn, obj) { if (conn) { try { conn.send(JSON.stringify(obj)); } catch (e) { /* закрыто */ } } }
  sendM(m, obj) { if (m.conn) this.send(m.conn, obj); }
  broadcast(obj) { const s = JSON.stringify(obj); for (const m of this.members) if (m.conn) { try { m.conn.send(s); } catch (e) { /* закрыто */ } } }
  err(conn, code, text, close) { this.send(conn, { t: 'err', code, m: text }); if (close) setTimeout(() => { try { conn.close(4000, code); } catch (e) { /* уже */ } }, 50); }

  hello(conn, msg) {
    if (conn.member || conn.helloing) return;
    if (msg.v !== PROTO) { this.err(conn, 'version', 'Версия игры отличается от сервера — обновите страницу', true); return; }
    const tok = String(msg.tok || '').slice(0, 40);
    if (!/^[A-Za-z0-9]{12,40}$/.test(tok)) { this.err(conn, 'tok', 'Ошибка входа', true); return; }
    // вход через Telegram (ТЗ v8): подпись данных проверяет io.auth (сервер аккаунтов) — это занимает время,
    // поэтому остальные сообщения соединения ждут в очереди. Нет данных, нет сервера аккаунтов, подпись не
    // подошла или проверка затянулась (AUTH_WAIT) — участник заходит гостем, как раньше
    if (typeof msg.init === 'string' && msg.init && this.io.auth) {
      conn.helloing = true; conn.queue = [];
      let timer = 0;
      const wait = new Promise((res) => { timer = setTimeout(() => res({ ok: false, why: 'timeout' }), this.T.AUTH_WAIT); });
      const auth = Promise.resolve().then(() => this.io.auth(msg.init)).catch(() => ({ ok: false, why: 'error' }));
      Promise.race([auth, wait]).then((acc) => {
        clearTimeout(timer);
        const q = conn.queue || [];
        conn.helloing = false; conn.queue = null;
        if (!this.conns.has(conn)) return; // пока проверяли, соединение закрылось
        this.helloDone(conn, msg, tok, acc && typeof acc === 'object' ? acc : { ok: false, why: 'error' });
        for (const raw of q) this.message(conn, raw);
      });
      return;
    }
    this.helloDone(conn, msg, tok, null);
  }
  // acc: результат проверки входа { ok, uid, name, av } | { ok: false, why } | null (данных входа не было)
  helloDone(conn, msg, tok, acc) {
    const uid = acc && acc.ok ? acc.uid | 0 : 0, why = acc && !acc.ok ? String(acc.why || 'error').slice(0, 20) : '';
    // тот же аккаунт на другом устройстве занимает своё прежнее место (вернуться в бой можно с любого телефона)
    let m = uid ? this.members.find((x) => x.uid === uid) : null;
    const mt = this.members.find((x) => x.tok === tok);
    if (m && mt && m !== mt) { this.err(conn, 'dup', 'Этот аккаунт уже участвует в комнате с другого устройства', true); return; }
    if (!m && mt && mt.uid && uid && mt.uid !== uid) { this.err(conn, 'dup', 'Это устройство в комнате занято другим аккаунтом', true); return; }
    if (!m) m = mt || null;
    if (m) {
      // переподключение: старое соединение закрываем
      if (m.conn && m.conn !== conn) { const old = m.conn; old.member = null; try { old.close(4001, 'replaced'); } catch (e) { /* уже */ } }
      if (uid) { m.uid = uid; m.tok = tok; }
    } else {
      if (!this.created) {
        if (!msg.create) { this.err(conn, 'notfound', 'Комната не найдена: проверьте код или создайте новую', true); return; }
        this.created = true;
        const n = Math.max(2, Math.min(MAX_SLOTS, msg.n | 0 || 2));
        if (typeof msg.map === 'string' && /^[a-z0-9_-]{1,24}$/.test(msg.map)) this.s.map = msg.map;
        for (let i = 0; i < n; i++) this.slots.push({ k: 'open', m: 0, f: 'random', c: i % COLORS, t: 0 });
      } else if (msg.create) { this.err(conn, 'exists', 'Такая комната уже есть', true); return; }
      if (this.members.length >= MAX_MEMBERS) { this.err(conn, 'full', 'Комната заполнена', true); return; }
      m = { id: this.nextId++, tok, uid, av: 0, rt: null, build: '', name: uid ? acc.name : clean(msg.name) || 'Игрок', conn: null, on: false, offT: 0, slot: -1, lastMsg: this.now(), ack: -1, loaded: false, over: false, pid: -1, dropped: false };
      this.members.push(m);
      if (!this.host) this.host = m.id;
      // новичок — на первое свободное место (во время боя — зритель до следующего)
      // зритель (вход «Смотреть» из списка комнат) место не занимает
      if (this.state === 'lobby' && !msg.spec) {
        const i = this.slots.findIndex((s) => s.k === 'open');
        if (i >= 0) this.seat(m, i);
      }
      if (this.members.length > 1) this.chat(null, m.name + ' в комнате');
    }
    const back = !m.on && !!this.game && m.pid >= 0 && !m.over;
    m.conn = conn; m.on = true; m.lastMsg = this.now();
    // ник игрока с аккаунтом — только из Telegram (выдать себя за другого нельзя); гость вводит ник сам
    if (uid) { m.name = acc.name; m.av = acc.av ? 1 : 0; m.rt = acc.rt && typeof acc.rt === 'object' ? acc.rt : m.rt; } else if (msg.name && !m.uid) m.name = clean(msg.name) || m.name;
    m.authWhy = why;
    if (back && !m.dropped) this.presence(m, m.name + ' снова на связи', 'ok');
    conn.member = m;
    if (typeof msg.b === 'string' && /^[0-9a-f]{6,16}$/.test(msg.b)) m.build = msg.b; // версия игры — в записи боя (повтор в другой версии может идти иначе)
    this.broadcastRoom();
    // вернулся уже после конца боя: показываем итог, который пропустил
    const lr = this.lastRes;
    if (lr && this.state === 'lobby' && m.uid && m.resSeen !== lr.id && lr.rows.some((x) => x.u === m.uid)) { m.resSeen = lr.id; this.sendM(m, lr); }
  }
  seat(m, i) {
    if (m.slot >= 0 && this.slots[m.slot] && this.slots[m.slot].m === m.id) { const o = this.slots[m.slot]; o.k = 'open'; o.m = 0; }
    m.slot = i;
    if (i >= 0) { const s = this.slots[i]; s.k = 'human'; s.m = m.id; }
  }
  removeMember(m) {
    const i = this.members.indexOf(m);
    if (i < 0) return;
    this.members.splice(i, 1);
    if (this.game && m.pid >= 0 && !m.dropped && !m.over) this.dropPid(m, 'leave');
    this.leftFinal(m);
    if (this.state === 'lobby' && m.slot >= 0) this.seat(m, -1);
    if (this.host === m.id) {
      const h = this.members.find((x) => x.on) || this.members[0];
      this.host = h ? h.id : 0;
      if (h) this.chat(null, h.name + ' — теперь хост комнаты');
    }
    if (this.members.length) { this.chat(null, m.name + ' вышел'); this.broadcastRoom(); }
    this.checkEnd();
  }

  // ---------- состояние комнаты ----------
  roomFor(m) {
    return {
      t: 'room', code: this.code, me: m.id, host: this.host, state: this.state, s: this.s, gid: this.game ? this.game.id : '', delay: this.T.SPEC_DELAY,
      playing: !!this.game && m.pid >= 0 && !m.over && !m.away,
      ret: this.retInfo(m),
      slots: this.slots.map((s) => ({ k: s.k, m: s.m, f: s.f, c: s.c, t: s.t })),
      mem: this.members.map((x) => ({ id: x.id, name: x.name, on: x.on, slot: x.slot, u: x.uid || 0, av: x.av ? 1 : 0, rt: this.rtShow(x) })),
      // вход Telegram не подтвердился (данные были, но сервер их не принял) — игра покажет причину; гость — поля нет
      aw: m.authWhy || undefined,
    };
  }
  broadcastRoom() { for (const m of this.members) if (m.conn) this.send(m.conn, this.roomFor(m)); this.pubDirty = true; }
  // k — вид системного сообщения для всплывающего окна в бою: warn (обрыв, ИИ командует), ok (вернулся)
  chat(m, text, k) { this.broadcast(Object.assign({ t: 'chat', n: m ? m.name : '', m: text, sys: !m }, k ? { k } : {})); }

  // ---------- лобби ----------
  on_name(m, msg) { if (m.uid) return; const n = clean(msg.name); if (n) { m.name = n; this.broadcastRoom(); } }
  // чат: «Все» — всем; «Команда» — только союзникам (союз места в комнате, в бою — союз игрока в бою);
  // зрители во время боя пишут только зрителям — подсказывать игрокам нельзя
  on_chat(m, msg) {
    const t = this.now();
    if (t - (m.chatT || 0) < 400) return;
    m.chatT = t;
    const text = clean(msg.m, 140);
    if (!text) return;
    if (this.game && m.pid < 0) { this.chatTo(this.members.filter((x) => x.pid < 0), m, text, 'spec'); return; }
    if (msg.ch === 'team') {
      const tm = this.teamOf(m);
      const list = tm > 0 ? this.members.filter((x) => this.teamOf(x) === tm && (this.game ? x.pid >= 0 : x.slot >= 0)) : [m];
      this.chatTo(list, m, text, 'team');
      return;
    }
    this.chat(m, text);
  }
  teamOf(m) {
    if (this.game) { const p = m.pid >= 0 ? this.game.cfg.players[m.pid] : null; return p ? p.team | 0 : 0; }
    const s = m.slot >= 0 ? this.slots[m.slot] : null;
    return s ? s.t | 0 : 0;
  }
  chatTo(list, m, text, ch) { const s = JSON.stringify({ t: 'chat', n: m.name, m: text, ch }); for (const x of list) if (x.conn) { try { x.conn.send(s); } catch (e) { /* закрыто */ } } }
  on_set(m, msg) {
    if (m.id !== this.host || this.state !== 'lobby' || !msg.s || typeof msg.s !== 'object') return;
    const s = msg.s;
    // рейтинговый бой (ТЗ v8): включает хост, вошедший через Telegram; правила тогда фиксированы, карта — из списка, места — только для людей
    if (s.rank === true && !this.s.rank) {
      const why = this.rankWhy();
      if (why) { this.sendM(m, { t: 'err', code: 'rank', m: why }); this.broadcastRoom(); return; }
      this.s.rank = true; this.applyRankRules();
    } else if (s.rank === false && this.s.rank) this.s.rank = false;
    if (this.s.rank) {
      if (typeof s.map === 'string' && RANKED_MAPS[s.map] && s.map !== this.s.map) { this.s.map = s.map; this.resize(RANKED_MAPS[s.map]); this.openSeats(); }
      if (typeof s.pub === 'boolean') this.s.pub = s.pub;
      if (typeof s.name === 'string') this.s.name = clean(s.name, 28);
      this.broadcastRoom();
      return;
    }
    if (typeof s.map === 'string' && /^[a-z0-9_-]{1,24}$/.test(s.map)) this.s.map = s.map;
    if (CREDITS.includes(s.credits)) this.s.credits = s.credits;
    for (const k of ['sw', 'fog', 'par', 'dyn', 'cyc', 'pub']) if (typeof s[k] === 'boolean') this.s[k] = s[k];
    // ТЗ v7, этап 8: «Точка интереса» — объект в центре карты
    if (POI_VALUES.includes(s.poi)) this.s.poi = s.poi;
    // «Режим проверки» убран из сетевой игры (29.10); принимается только локальным тестовым сервером (GD_TEST_DBG=1)
    if (typeof s.dbg === 'boolean' && this.io.allowDbg) this.s.dbg = s.dbg;
    if (typeof s.name === 'string') this.s.name = clean(s.name, 28);
    if (msg.n !== undefined) this.resize(Math.max(2, Math.min(MAX_SLOTS, msg.n | 0)));
    this.broadcastRoom();
  }
  resize(n) {
    while (this.slots.length < n) {
      const used = new Set(this.slots.map((s) => s.c));
      let c = 0; while (used.has(c) && c < COLORS - 1) c++;
      this.slots.push({ k: 'open', m: 0, f: 'random', c, t: 0 });
    }
    if (this.slots.length > n) {
      const cut = this.slots.splice(n);
      for (const s of cut) {
        if (s.k !== 'human') continue;
        const mm = this.members.find((x) => x.id === s.m);
        if (!mm) continue;
        mm.slot = -1;
        const i = this.slots.findIndex((x) => x.k === 'open');
        if (i >= 0) this.seat(mm, i);
      }
    }
  }
  on_slot(m, msg) {
    if (this.state !== 'lobby') return;
    const i = msg.i | 0, s = this.slots[i];
    if (!s || i !== msg.i) return;
    const host = m.id === this.host, own = s.k === 'human' && s.m === m.id, ai = s.k !== 'human' && s.k !== 'open' && s.k !== 'closed';
    if (msg.k !== undefined) {
      if (!host || s.k === 'human' || !KINDS.includes(msg.k)) return;
      if (this.s.rank && msg.k !== 'open') return; // рейтинговый бой — только люди, закрытых мест нет
      s.k = msg.k;
    }
    if (own || (host && ai) || (host && msg.k !== undefined)) {
      if (msg.f !== undefined && FACTIONS.includes(msg.f)) s.f = msg.f;
      if (msg.team !== undefined && Number.isInteger(msg.team) && msg.team >= 0 && msg.team <= 4) s.t = msg.team;
      if (msg.c !== undefined && Number.isInteger(msg.c) && msg.c >= 0 && msg.c < COLORS && msg.c !== s.c) {
        // занятый цвет — места меняются цветами
        const o = this.slots.find((x) => x !== s && x.c === msg.c);
        if (o) o.c = s.c;
        s.c = msg.c;
      }
    }
    this.broadcastRoom();
  }
  on_take(m, msg) {
    if (this.state !== 'lobby') return;
    const i = msg.i | 0;
    if (i === -1) { this.seat(m, -1); this.broadcastRoom(); return; }
    const s = this.slots[i];
    if (!s || s.k !== 'open') return;
    this.seat(m, i);
    this.broadcastRoom();
  }
  // ---------- старт боя ----------
  on_start(m, msg) {
    if (m.id !== this.host || this.state !== 'lobby' || this.starting) return;
    if (!this.s.rank) { this.startNow(m, msg); return; }
    // рейтинговый бой: состав и правила проверяет комната, паузы после ухода и рейтинги — сервер аккаунтов (ответ приходит позже)
    const why = this.rankStartWhy();
    if (why) { this.sendM(m, { t: 'err', code: 'start', m: why }); return; }
    const who = this.slots.filter((x) => x.k === 'human').map((x) => this.members.find((y) => y.id === x.m));
    this.starting = true;
    this.waitRank(() => this.io.rankCheck(who.map((x) => x.uid))).then((info) => {
      this.starting = false;
      if (this.state !== 'lobby' || m.id !== this.host) return;
      if (!info || info.ok === false) { this.sendM(m, { t: 'err', code: 'start', m: 'Сервер рейтинга не отвечает — попробуйте ещё раз через минуту' }); return; }
      const now = this.now();
      for (const x of who) {
        const e = info[x.uid];
        if (e && e.cd > now) { this.sendM(m, { t: 'err', code: 'start', m: x.name + ' временно не может играть в рейтинговых боях (вышел из прошлого боя): ещё ' + Math.ceil((e.cd - now) / 60000) + ' мин' }); return; }
        if (e && e.rt) x.rt = e.rt;
      }
      this.startNow(m, msg);
    });
  }
  startNow(m, msg) {
    if (m.id !== this.host || this.state !== 'lobby') return;
    const cfg = msg.cfg;
    const bad = (t) => this.sendM(m, { t: 'err', code: 'start', m: t });
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.players) || JSON.stringify(cfg).length > 12000) { bad('Не удалось начать бой'); return; }
    const P = cfg.players;
    if (P.length < 2 || P.length > MAX_SLOTS) { bad('Нужно от 2 до ' + MAX_SLOTS + ' участников'); return; }
    // состав должен совпадать с местами комнаты (иначе места поменялись — пусть хост нажмёт ещё раз)
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i], p = P.find((x) => x && x.slot === i);
      const want = s.k !== 'open' && s.k !== 'closed';
      if (want !== !!p || (p && !!p.human !== (s.k === 'human'))) { bad('Состав изменился — нажмите «В бой» ещё раз'); return; }
      if (s.k === 'human') {
        const mm = this.members.find((x) => x.id === s.m);
        if (!mm || !mm.on) { bad('Не все игроки на связи'); return; }
      }
    }
    // имя, аккаунт и фото игрока в бое — по данным сервера, а не по описанию хоста (подделать нельзя)
    for (const p of P) {
      if (!p || !p.human) continue;
      const s = this.slots[p.slot], mm = s && s.k === 'human' ? this.members.find((x) => x.id === s.m) : null;
      p.name = mm ? mm.name : 'Игрок'; p.uid = mm ? mm.uid | 0 : 0; p.av = mm && mm.av ? 1 : 0;
    }
    const id = Math.random().toString(36).slice(2, 10);
    cfg.seed = (Math.random() * 4294967296) >>> 0;
    cfg.mp = true;
    const ranked = !!this.s.rank;
    // рейтинговые правила задаёт сервер, а не клиент хоста: карта, кредиты, тайное оружие, туман — как в комнате
    if (ranked) {
      cfg.map = this.s.map; cfg.credits = this.s.credits; cfg.superweapons = !!this.s.sw; cfg.fog = this.s.fog !== false; cfg.parallel = this.s.par !== false; cfg.poi = this.s.poi; cfg.debug = false;
      // участники, союзы и цвета — ровно как в комнате (описание боя от хоста их не меняет: иначе он мог бы сам рассадить соперников по командам);
      // страна — выбранная игроком («случайную» раскрывает игра хоста)
      if (P.length !== this.slots.length || new Set(P.map((x) => x && x.slot)).size !== P.length) { bad('Состав изменился — нажмите «В бой» ещё раз'); return; }
      for (const p of P) { const sl = this.slots[p.slot]; p.team = sl.t | 0; p.color = sl.c | 0; if (FACTIONS.includes(sl.f) && sl.f !== 'random') p.faction = sl.f; }
    }
    this.state = 'game'; this.lastRes = null;
    // roster — кто играл (по номерам игроков в бое), reports — итоги от игр, leaves — кто не вернулся (для судьи, этап 3)
    const roster = P.map((p) => ({ human: !!p.human, uid: p.human ? p.uid | 0 : 0, team: p.team | 0, name: p.name || '' }));
    const hostM = this.members.find((x) => x.id === this.host);
    this.game = { id, cfg, turn: 0, log: [], pending: [], started: false, t0: this.now(), desync: -1, hashes: new Map(), cp: new Map(), build: (hostM && hostM.build) || (this.members.find((x) => x.build) || {}).build || '', ranked, wall: this.now(), roster, reports: {}, leaves: {} };
    for (const mm of this.members) {
      mm.pid = mm.slot >= 0 ? P.findIndex((x) => x.slot === mm.slot && x.human) : -1;
      mm.loaded = false; mm.over = false; mm.dropped = false; mm.catching = false; mm.away = false; mm.out = false; mm.ack = -1; mm.cmdN = 0;
      this.sendM(mm, { t: 'start', id, cfg, me: mm.pid >= 0 ? mm.slot : -1, rk: ranked ? 1 : 0 });
    }
    this.broadcastRoom();
    this.ensureTimer();
  }
  on_loaded(m, msg) { if (this.game && msg.id === this.game.id) m.loaded = true; }
  // ---------- бой ----------
  on_c(m, msg) {
    const g = this.game;
    if (!g || m.pid < 0 || m.dropped || !Array.isArray(msg.c) || typeof msg.c[0] !== 'string') return;
    if (msg.c[0] === 'drop' || msg.c[0] === 'back') return;
    if (JSON.stringify(msg.c).length > 2048) return;
    if (++m.cmdN > 40) return; // не больше 40 приказов за ход
    g.pending.push([m.pid, msg.c]);
  }
  on_h(m, msg) {
    const g = this.game;
    if (!g || !Number.isInteger(msg.n) || msg.n < 0 || msg.n >= g.turn || !Number.isInteger(msg.h)) return;
    if (msg.n > m.ack) m.ack = msg.n;
    // вернувшийся догнал бой: снова сам командует войсками (до этого — ИИ)
    if (m.catching && msg.n >= g.turn - LAG_RESUME) {
      m.catching = false;
      if (m.dropped && m.pid >= 0 && !m.over && !m.away) { m.dropped = false; delete g.leaves[m.pid]; g.pending.push([m.pid, ['back']]); m.presT = this.now(); this.chat(null, m.name + ' вернулся в игру — снова командует сам', 'ok'); }
    }
    let e = g.hashes.get(msg.n);
    if (!e) { e = new Map(); g.hashes.set(msg.n, e); }
    e.set(m.id, msg.h >>> 0);
    if (msg.n % 50 === 49 && !g.cp.has(msg.n)) g.cp.set(msg.n, msg.h >>> 0); // контрольный хеш для записи боя
    if (e.size >= 2 && g.desync < 0) {
      const v = [...e.values()];
      if (v.some((x) => x !== v[0])) { g.desync = msg.n; this.broadcast({ t: 'desync', n: msg.n }); }
    }
    if (g.hashes.size > 120) for (const k of g.hashes.keys()) { if (k < g.turn - 600) g.hashes.delete(k); else break; }
  }
  // ходы, которые этому участнику уже можно знать: игрокам — все, зрителям — с задержкой
  seenTurns(m) { const g = this.game; return !g ? 0 : m.pid >= 0 ? g.turn : Math.max(0, g.turn - this.specDelay()); }
  specDelay() { return Math.round(this.T.SPEC_DELAY / TURN_MS); }
  turnList(from, to) { const g = this.game, list = []; for (let n = Math.max(0, from); n < to; n++) list.push([n, g.log[n] || 0]); return list; }
  on_resume(m, msg) {
    const g = this.game;
    if (!g || msg.id !== g.id) return;
    this.sendM(m, { t: 'turns', id: g.id, list: this.turnList(msg.from | 0, this.seenTurns(m)) });
    if (m.pid >= 0) { m.catching = true; this.holdWindow(m); } // командовать снова — когда догонит
  }
  // страница перезагрузилась посреди боя: заново описание боя и все ходы с начала — игра у
  // участника пересчитает бой быстрее реального времени и догонит остальных (зритель — до своей задержки)
  on_rejoin(m) {
    const g = this.game;
    if (!g || m.over) return;
    const wasAway = m.away;
    if (m.pid >= 0) { m.loaded = false; m.ack = -1; m.catching = true; m.away = false; this.holdWindow(m); }
    if (wasAway) this.broadcastRoom();
    this.sendM(m, { t: 'start', id: g.id, cfg: g.cfg, me: m.pid >= 0 ? m.slot : -1, rejoin: true, spec: m.pid < 0, delay: this.T.SPEC_DELAY, rk: g.ranked ? 1 : 0 });
    this.sendM(m, { t: 'turns', id: g.id, list: this.turnList(0, this.seenTurns(m)) });
  }
  // зритель (пришёл во время боя или нажал «Смотреть бой») — бой с начала до своей задержки
  on_watch(m) {
    const g = this.game;
    if (!g || m.pid >= 0) return;
    m.over = false;
    this.on_rejoin(m);
  }
  // игра досмотрела бой до конца: присылает отчёт об итогах (такт конца, хеш, кто как выбыл) — по ним судья решает исход
  on_over(m, msg) {
    const g = this.game;
    if (!g) return;
    if (m.pid >= 0 && g.reports[m.pid] === undefined && msg && msg.rep && typeof msg.rep === 'object' && JSON.stringify(msg.rep).length < 2000) g.reports[m.pid] = msg.rep;
    m.over = true;
    this.checkEnd();
  }
  // игрок вышел из боя в комнату: войсками командует ИИ, а вернуться он может кнопкой «Вернуться в бой»
  // (рейтинговый бой — в течение окна возврата, обычный — пока бой идёт); не вернётся — выход из боя засчитывается судьёй
  on_lobby(m) {
    if (!this.game) return;
    if (m.pid >= 0 && !m.over) {
      this.dropPid(m, 'leave');
      m.away = true;
      this.broadcastRoom();
    } else m.over = true; // зритель или уже закончивший бой просто уходит
    this.checkEnd();
  }
  // «Вернуться в бой» из комнаты: тот же путь, что у перезагрузившей страницу, — бой с начала, быстрый пересчёт, затем «back»
  on_return(m) {
    const g = this.game;
    if (!g) return;
    if (m.pid < 0 || m.over || !this.canReturn(m)) { this.sendM(m, { t: 'out' }); return; }
    this.on_rejoin(m);
  }
  on_leave(m) {
    const c = m.conn;
    this.removeMember(m);
    if (c) { c.member = null; try { c.close(1000, 'leave'); } catch (e) { /* уже */ } }
  }
  // игрок вылетел из боя (нет связи, отстал, вышел сам): войсками командует ИИ. Запись об уходе нужна судье и окну возврата:
  // tick — такт ухода, t — когда, vol — вышел сам (если не вернётся, это выход из боя), until — окно продлено вернувшемуся
  dropPid(m, why) {
    const g = this.game;
    if (!g || m.pid < 0) return;
    if (m.dropped) { const l = g.leaves[m.pid]; if (l && why === 'leave') { l.vol = true; l.why = 'leave'; } return; } // уже отдан ИИ — окно считается с первого вылета
    m.dropped = true;
    g.pending.push([m.pid, ['drop', 'normal']]);
    g.leaves[m.pid] = { tick: g.turn * TICKS_PER_TURN, why, t: this.now(), vol: why === 'leave' };
    m.presT = this.now();
    const back = g.ranked && why !== 'lag' ? ' (вернуться можно в течение ' + this.winText() + ')' : '';
    this.chat(null, why === 'leave' ? m.name + ' покинул бой — войсками командует ИИ' + back : why === 'lag' ? m.name + ' сильно отстаёт — войсками временно командует ИИ' : m.name + ' без связи — войсками командует ИИ' + back, 'warn');
  }
  // ---------- возврат в бой после вылета (ТЗ v8, этап 4) ----------
  winText() { const w = this.T.RETURN_WINDOW; return w >= 60000 ? Math.round(w / 60000) + ' мин' : Math.max(1, Math.round(w / 1000)) + ' с'; }
  // когда кончается окно возврата по записи об уходе
  retUntil(l) { return Math.max(l.t + this.T.RETURN_WINDOW, l.until || 0); }
  // можно ли этому участнику вернуться в бой: не вылетел — да; в обычном бою — пока он идёт; в рейтинговом — пока не вышло окно
  canReturn(m) {
    const g = this.game;
    if (!g || m.pid < 0 || m.out || m.over) return false;
    if (!g.ranked || !m.dropped) return true;
    const l = g.leaves[m.pid];
    return !l || this.now() < this.retUntil(l);
  }
  // вернувшемуся (просьба о возврате принята) продлеваем окно, чтобы он успел догнать бой
  holdWindow(m) {
    const g = this.game, l = g && g.leaves[m.pid];
    if (l && g.ranked) l.until = Math.max(l.until || 0, this.now() + this.T.CATCH_GRACE);
  }
  // что видит участник про возврат: ms — сколько осталось (-1 — без ограничения), why — почему вылетел; out — время вышло
  retInfo(m) {
    const g = this.game;
    if (!g || m.pid < 0) return undefined;
    if (m.out) return { out: 1 };
    if (!m.dropped || m.over) return undefined;
    const l = g.leaves[m.pid];
    if (!l) return undefined;
    return { ms: g.ranked ? Math.max(0, this.retUntil(l) - this.now()) : -1, why: l.vol ? 'leave' : l.why };
  }
  // окно возврата вышло (рейтинговый бой): выход окончательный, бой для этого игрока закончен. Его базу и войска не оставляем
  // ИИ до конца боя: сервер сам ставит в ход приказ «сдаться» (как кнопка, одинаково у всех) — остальные не доигрывают бой
  // с ИИ вместо ушедшего, а в бою на двоих побеждают сразу. Судья видит это как «ушёл и не вернулся» (выход), не как сдачу.
  expire(m, l) {
    m.out = true; m.over = true; m.away = false; l.final = true;
    const g = this.game;
    if (g && m.pid >= 0) g.pending.push([m.pid, ['surr']]);
    this.chat(null, m.name + ' не вернулся в бой — время возврата вышло', 'warn');
    this.sendM(m, { t: 'out' });
    this.broadcastRoom();
    this.checkEnd();
  }
  checkEnd() {
    const g = this.game;
    if (!g) return;
    // бой идёт, пока есть игрок, который его не завершил и не ушёл совсем: временно отданные ИИ (отстал,
    // свернул приложение, обрыв связи) могут вернуться — бой их ждёт. Ушедший без связи (отдан ИИ и не на
    // связи) бой не держит, если остальные уже закончили; если без связи все — бой закроет EMPTY_END
    const humans = this.members.filter((x) => x.pid >= 0);
    if (humans.some((x) => !x.over && !(x.dropped && (!x.on || x.away)))) return; // вышедший в комнату бой тоже не держит
    if (humans.length && !humans.some((x) => x.over)) return;
    this.endGame();
  }
  endGame() {
    // зрителям — оставшиеся ходы (бой окончен, задержка больше не нужна), их игра досчитает бой до конца
    const g = this.game;
    if (g) for (const m of this.members) if (m.conn && m.pid < 0) this.sendM(m, { t: 'turns', id: g.id, list: this.turnList(this.seenTurns(m), g.turn) });
    if (g) this.conclude(g);
    this.state = 'lobby'; this.game = null;
    for (const m of this.members) { m.pid = -1; m.loaded = false; m.over = false; m.dropped = false; m.away = false; m.out = false; }
    // места ушедших освобождаются
    for (const s of this.slots) if (s.k === 'human' && !this.members.some((x) => x.id === s.m)) { s.k = 'open'; s.m = 0; }
    this.broadcast({ t: 'end' });
    this.broadcastRoom();
  }

  // ---------- рейтинговые бои и итоги (ТЗ v8, этап 3) ----------
  get rankOn() { return !!(this.io.report && this.io.rankCheck); }
  // почему рейтинговый бой в этой комнате включить нельзя (пусто — можно)
  rankWhy() {
    if (!this.rankOn) return 'На этом сервере рейтинговые бои недоступны';
    const h = this.members.find((x) => x.id === this.host);
    if (!h || !h.uid) return 'Рейтинговый бой создают только игроки, вошедшие через Telegram';
    return '';
  }
  openSeats() { for (const sl of this.slots) if (sl.k !== 'human') sl.k = 'open'; }
  applyRankRules() {
    Object.assign(this.s, RANK_RULES);
    if (!RANKED_MAPS[this.s.map]) this.s.map = 'crossing';
    this.resize(RANKED_MAPS[this.s.map]);
    this.openSeats();
  }
  // можно ли начинать рейтинговый бой: места, состав, вход через Telegram, стороны (пусто — можно)
  rankStartWhy() {
    const need = RANKED_MAPS[this.s.map];
    if (!need || this.slots.length !== need) return 'На этой карте рейтинговый бой недоступен';
    for (const sl of this.slots) {
      if (sl.k !== 'human') return 'В рейтинговом бою все места занимают люди, без ИИ: свободно мест — ' + this.slots.filter((x) => x.k !== 'human').length;
      const mm = this.members.find((x) => x.id === sl.m);
      if (!mm || !mm.on) return 'Не все игроки на связи';
      if (!mm.uid) return mm.name + ' не вошёл через Telegram — в рейтинговом бою играют только вошедшие';
    }
    if (new Set(this.slots.map((sl, i) => (sl.t > 0 ? 't' + sl.t : 'p' + i))).size < 2) return 'Нужны хотя бы две стороны: разведите игроков по разным командам';
    return '';
  }
  // запрос к серверу рейтинга с ограничением по времени: ответ или null (ошибка, таймаут)
  waitRank(fn, ms) {
    let timer = 0;
    const wait = new Promise((res) => { timer = setTimeout(() => res(null), ms || this.T.RANK_WAIT); });
    const job = Promise.resolve().then(fn).then((r) => r || null, () => null);
    return Promise.race([job, wait]).then((r) => { clearTimeout(timer); return r; });
  }
  // рейтинг участника для показа в комнате: по режиму комнаты (два места — «Дуэль», иначе «Мультиплеер»)
  rtShow(x) {
    const r = x.rt && x.rt[this.slots.length === 2 ? 'duel' : 'multi'];
    return r ? { r: r.r, g: r.g, lg: r.lg, lc: r.lc } : undefined;
  }
  // игрок вышел из комнаты совсем (вернуться в бой уже нельзя): его уход окончательный
  leftFinal(m) { const g = this.game; if (g && m.pid >= 0 && g.leaves[m.pid]) g.leaves[m.pid].final = true; }
  // итог боя: судья решает по отчётам игр и записи уходов; результат уходит в рейтинг и всем в комнате
  conclude(g) {
    const now = this.now(), leaves = {};
    for (const pid of Object.keys(g.leaves)) { const l = g.leaves[pid]; leaves[pid] = { tick: l.tick, final: !!(l.vol || l.final) || now - l.t >= this.T.RETURN_WINDOW }; }
    const v = judge({ roster: g.roster, reports: g.reports, leaves, endTick: g.turn * TICKS_PER_TURN, earlyTicks: Math.round(this.T.EARLY_MS * TICKS_PER_SEC / 1000) });
    const P = g.cfg.players, by = new Map(v.players.map((p) => [p.pid, p])), people = [];
    g.roster.forEach((r, pid) => {
      if (!r.human) return;
      const j = by.get(pid);
      people.push({ pid, uid: r.uid, slot: P[pid].slot, name: r.name || 'Игрок', tk: j ? j.team : tkey(g.roster, pid), faction: v.rep && v.rep.f ? v.rep.f[pid] | 0 : 0,
        outcome: j ? j.outcome : v.penalties.includes(r.uid) ? 'early' : 'void', place: j ? j.rank : 0, quit: j ? j.quit : false });
    });
    // сервер аккаунтов не подключён или в бою не было вошедших через Telegram — записывать некому
    if (!this.io.report || !people.some((x) => x.uid > 0)) return;
    const payload = { id: this.code + '-' + g.id, t: g.wall, dur: Math.round(g.turn * TURN_MS / 1000), map: String(g.cfg.map || ''), mode: v.mode, ranked: g.ranked, status: v.status, reason: v.reason,
      ticks: v.rep ? v.rep.tk : 0, hash: v.rep ? v.rep.h : 0, players: people, teams: v.teams, penalties: v.penalties };
    const done = (res) => {
      const rows = people.map((h) => {
        const c = res && res.changes ? res.changes.find((x) => x.pid === h.pid) : null;
        return Object.assign({ pid: h.pid, slot: h.slot, u: h.uid, name: h.name, o: h.outcome, pl: h.place }, c ? { b: c.before, a: c.after, d: Math.round(c.delta * 10) / 10, lg: c.lg, lc: c.lc } : {});
      });
      if (res && res.changes) for (const c of res.changes) { const mm = this.members.find((x) => x.uid === c.uid); if (mm && c.rt) mm.rt = c.rt; }
      const out = { t: 'result', id: g.id, mid: payload.id, ranked: g.ranked, status: v.status, reason: v.reason, mode: v.mode, rated: !!(res && res.rated), rows, pen: res && res.penalties ? res.penalties : [], err: res ? undefined : 1 };
      // вернувшийся после конца боя увидит итог, который пропустил (см. helloDone)
      this.lastRes = out;
      for (const mm of this.members) if (mm.conn) mm.resSeen = g.id;
      this.broadcast(out);
      this.broadcastRoom();
    };
    // ответ сервера аккаунтов не пришёл — одна повторная попытка (запись боя на сервере идемпотентна: дважды не засчитается)
    const good = (r) => (r && r.ok !== false ? r : null);
    this.waitRank(() => this.io.report(payload)).then((res) => (good(res) || this.waitRank(() => this.io.report(payload)))).then((res) => { const r = good(res); done(r); if (r) this.saveRec(g, v, payload.id); });
  }
  // запись боя — на сервер аккаунтов, после итога (бой в базе уже есть). Не вышло — боя и рейтинга это не касается: просто записи не будет
  saveRec(g, v, id) {
    if (!this.io.saveRec || v.status !== 'ok' || !v.rep || g.desync >= 0) return;
    let rec = null;
    try { rec = buildRecord(g, v.rep, id); } catch (e) { rec = null; }
    if (!rec) return;
    pack(JSON.stringify(rec)).then((bytes) => this.waitRank(() => this.io.saveRec(id, bytes), this.T.REC_WAIT)).then((r) => {
      if (!r || r.ok === false) return;
      if (this.lastRes && this.lastRes.mid === id) this.lastRes.rec = 1; // кто вернётся в комнату позже, получит итог уже с записью
      this.broadcast({ t: 'rec', mid: id });
    }).catch(() => {});
  }

  // ---------- общий список открытых комнат ----------
  info() {
    const humans = this.slots.filter((x) => x.k === 'human').length, open = this.slots.filter((x) => x.k === 'open').length;
    const host = this.members.find((x) => x.id === this.host);
    return { code: this.code, name: this.s.name || ('Комната ' + ((host && host.name) || this.code)), map: this.s.map, n: this.slots.length, humans, open,
      ai: this.slots.filter((x) => ['easy', 'normal', 'hard'].includes(x.k)).length, spect: this.members.filter((x) => x.slot < 0).length, state: this.state, rank: !!this.s.rank, t: this.now() };
  }
  publish(t) {
    if (!this.io.publish) return;
    // в списке — только открытые комнаты, где кто-то на связи
    if (!this.s.pub || !this.members.some((x) => x.on)) { this.unpublish(); return; }
    if ((this.pubDirty && t - this.pubT > this.T.PUB_GAP) || t - this.pubT > 20000) {
      this.pubDirty = false; this.pubT = t; this.pubOn = true;
      try { this.io.publish(this.code, this.info()); } catch (e) { /* список недоступен */ }
    }
  }
  unpublish() { if (this.pubOn && this.io.publish) { this.pubOn = false; try { this.io.publish(this.code, null); } catch (e) { /* нет */ } } }

  // ---------- часы: ходы, обрывы связи ----------
  ensureTimer() {
    if (this.timer) return;
    this.timer = this.io.setInterval(() => this.tick(), TURN_MS / 2);
  }
  stopTimer() { if (this.timer) { this.io.clearInterval(this.timer); this.timer = null; } }
  tick() {
    const t = this.now();
    if (t - this.houseT > 1000) { this.houseT = t; this.housekeeping(t); }
    const g = this.game;
    if (!g) return;
    if (!g.started) {
      const waiting = this.members.filter((x) => x.pid >= 0 && x.on && !x.loaded);
      if (waiting.length && t - g.t0 < this.T.LOAD_WAIT) return;
      g.started = true; g.t0 = t;
    }
    // бой никого не ждёт: отстающий видит бой с задержкой и догоняет; отстал больше LAG_DROP —
    // войсками временно командует ИИ (на связи, но не присылает ходы: свернул приложение, слабый телефон)
    const lagDrop = Math.round(this.T.LAG_DROP / TURN_MS);
    for (const x of this.members) {
      if (x.pid < 0 || !x.on || x.dropped || x.over || x.catching) continue;
      if (g.turn - 1 - x.ack > lagDrop) { x.catching = true; this.dropPid(x, 'lag'); }
    }
    // ходы по реальному времени (после задержки таймера — до 4 ходов подряд)
    const due = Math.floor((t - g.t0) / TURN_MS) + 1;
    let k = 0;
    while (g.turn < due && k++ < 4) {
      const c = g.pending; g.pending = [];
      for (const m of this.members) m.cmdN = 0;
      g.log.push(c.length ? c : 0);
      const live = JSON.stringify(c.length ? { t: 'T', n: g.turn, c } : { t: 'T', n: g.turn });
      const dn = g.turn - this.specDelay(), dc = dn >= 0 ? g.log[dn] : null;
      const late = dn >= 0 ? JSON.stringify(dc ? { t: 'T', n: dn, c: dc } : { t: 'T', n: dn }) : null;
      for (const m of this.members) {
        if (!m.conn) continue;
        if (m.pid >= 0) { if (!m.away) { try { m.conn.send(live); } catch (e) { /* закрыто */ } } } else if (late) { try { m.conn.send(late); } catch (e) { /* закрыто */ } }
      }
      g.turn++;
    }
    if (g.turn < due - 20) g.t0 = t - g.turn * TURN_MS; // долгая задержка — не устраиваем лавину ходов
  }
  housekeeping(t) {
    for (const m of this.members.slice()) {
      if (m.on) continue;
      if (this.game && m.pid >= 0) { if (!m.dropped && !m.over && t - m.offT > this.T.DROP_AFTER) { this.dropPid(m, 'off'); this.checkEnd(); } }
      else if (t - m.offT > this.T.LOBBY_GRACE) this.removeMember(m);
    }
    // хост без связи — хостом становится участник на связи (прежний, вернувшись, — обычный участник)
    const H = this.members.find((x) => x.id === this.host);
    if (H && !H.on && t - H.offT > this.T.HOST_GRACE) {
      const h = this.members.find((x) => x.on);
      if (h) { this.host = h.id; this.chat(null, h.name + ' — теперь хост комнаты'); this.broadcastRoom(); }
    }
    // рейтинговый бой: окно возврата вылетевшего вышло — выход окончателен
    const g = this.game;
    if (g && g.ranked) {
      for (const x of this.members.slice()) {
        if (this.game !== g) break;
        if (x.pid < 0 || x.over || x.out || !x.dropped) continue;
        const l = g.leaves[x.pid];
        if (l && t >= this.retUntil(l)) this.expire(x, l);
      }
    }
    if (this.game && !this.members.some((x) => x.on)) {
      // никого на связи: через минуту бой закрывается (рейтинговый ждёт дольше — вылетевшие могут вернуться в течение окна)
      const wait = this.game.ranked ? Math.max(this.T.EMPTY_END, this.T.RETURN_WINDOW + this.T.CATCH_GRACE) : this.T.EMPTY_END;
      if (!this.game.emptyT) this.game.emptyT = t;
      else if (t - this.game.emptyT > wait) this.endGame();
    } else if (this.game) this.game.emptyT = 0;
    this.publish(t);
    if (!this.members.length && !this.conns.size) { this.unpublish(); this.stopTimer(); if (this.io.onEmpty) this.io.onEmpty(); }
  }
}

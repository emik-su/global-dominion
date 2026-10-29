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
export const PROTO = 1;
const TURN_MS = 100;
const MAX_MEMBERS = 16;   // игроки (до 8 мест) и зрители
const MAX_SLOTS = 8;
const KINDS = ['open', 'easy', 'normal', 'hard', 'closed'];
const FACTIONS = ['random', 'usa', 'rus', 'ger', 'irn', 'isr', 'chn', 'ind', 'ukr'];
const COLORS = 10;
const CREDITS = [2500, 5000, 10000];
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
};
const LAG_RESUME = 12;      // догнал бой (отставание ≤ 12 ходов) — снова командует сам
const MAX_MSG = 16384;

const clean = (s, n = 16) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

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
    this.s = { map: 'crossing', credits: 5000, sw: true, fog: true, dyn: true, cyc: true, dbg: false, pub: false, name: '' };
    this.pubT = -1e12; this.pubDirty = false; this.pubOn = false;
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
    const m = conn.member;
    if (m) m.lastMsg = t; // любое сообщение — участник на связи (свёрнутое приложение молчит)
    if (msg.t === 'ping') { this.send(conn, { t: 'pong', k: msg.k }); return; }
    if (!m) return;
    const h = this['on_' + msg.t];
    if (typeof h === 'function') h.call(this, m, msg);
  }
  send(conn, obj) { if (conn) { try { conn.send(JSON.stringify(obj)); } catch (e) { /* закрыто */ } } }
  sendM(m, obj) { if (m.conn) this.send(m.conn, obj); }
  broadcast(obj) { const s = JSON.stringify(obj); for (const m of this.members) if (m.conn) { try { m.conn.send(s); } catch (e) { /* закрыто */ } } }
  err(conn, code, text, close) { this.send(conn, { t: 'err', code, m: text }); if (close) setTimeout(() => { try { conn.close(4000, code); } catch (e) { /* уже */ } }, 50); }

  hello(conn, msg) {
    if (conn.member) return;
    if (msg.v !== PROTO) { this.err(conn, 'version', 'Версия игры отличается от сервера — обновите страницу', true); return; }
    const tok = String(msg.tok || '').slice(0, 40);
    if (!/^[A-Za-z0-9]{12,40}$/.test(tok)) { this.err(conn, 'tok', 'Ошибка входа', true); return; }
    let m = this.members.find((x) => x.tok === tok);
    if (m) {
      // переподключение: старое соединение закрываем
      if (m.conn && m.conn !== conn) { const old = m.conn; old.member = null; try { old.close(4001, 'replaced'); } catch (e) { /* уже */ } }
    } else {
      if (!this.created) {
        if (!msg.create) { this.err(conn, 'notfound', 'Комната не найдена: проверьте код или создайте новую', true); return; }
        this.created = true;
        const n = Math.max(2, Math.min(MAX_SLOTS, msg.n | 0 || 2));
        if (typeof msg.map === 'string' && /^[a-z0-9_-]{1,24}$/.test(msg.map)) this.s.map = msg.map;
        for (let i = 0; i < n; i++) this.slots.push({ k: 'open', m: 0, f: 'random', c: i % COLORS, t: 0 });
      } else if (msg.create) { this.err(conn, 'exists', 'Такая комната уже есть', true); return; }
      if (this.members.length >= MAX_MEMBERS) { this.err(conn, 'full', 'Комната заполнена', true); return; }
      m = { id: this.nextId++, tok, name: clean(msg.name) || 'Игрок', conn: null, on: false, offT: 0, slot: -1, lastMsg: this.now(), ack: -1, loaded: false, over: false, pid: -1, dropped: false };
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
    if (msg.name) m.name = clean(msg.name) || m.name;
    if (back && !m.dropped) this.presence(m, m.name + ' снова на связи', 'ok');
    conn.member = m;
    this.broadcastRoom();
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
      playing: !!this.game && m.pid >= 0 && !m.over,
      slots: this.slots.map((s) => ({ k: s.k, m: s.m, f: s.f, c: s.c, t: s.t })),
      mem: this.members.map((x) => ({ id: x.id, name: x.name, on: x.on, slot: x.slot })),
    };
  }
  broadcastRoom() { for (const m of this.members) if (m.conn) this.send(m.conn, this.roomFor(m)); this.pubDirty = true; }
  // k — вид системного сообщения для всплывающего окна в бою: warn (обрыв, ИИ командует), ok (вернулся)
  chat(m, text, k) { this.broadcast(Object.assign({ t: 'chat', n: m ? m.name : '', m: text, sys: !m }, k ? { k } : {})); }

  // ---------- лобби ----------
  on_name(m, msg) { const n = clean(msg.name); if (n) { m.name = n; this.broadcastRoom(); } }
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
    if (typeof s.map === 'string' && /^[a-z0-9_-]{1,24}$/.test(s.map)) this.s.map = s.map;
    if (CREDITS.includes(s.credits)) this.s.credits = s.credits;
    for (const k of ['sw', 'fog', 'dyn', 'cyc', 'pub']) if (typeof s[k] === 'boolean') this.s[k] = s[k];
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
    const id = Math.random().toString(36).slice(2, 10);
    cfg.seed = (Math.random() * 4294967296) >>> 0;
    cfg.mp = true;
    this.state = 'game';
    this.game = { id, cfg, turn: 0, log: [], pending: [], started: false, t0: this.now(), desync: -1, hashes: new Map() };
    for (const mm of this.members) {
      mm.pid = mm.slot >= 0 ? P.findIndex((x) => x.slot === mm.slot && x.human) : -1;
      mm.loaded = false; mm.over = false; mm.dropped = false; mm.catching = false; mm.ack = -1; mm.cmdN = 0;
      this.sendM(mm, { t: 'start', id, cfg, me: mm.pid >= 0 ? mm.slot : -1 });
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
      if (m.dropped && m.pid >= 0 && !m.over) { m.dropped = false; g.pending.push([m.pid, ['back']]); m.presT = this.now(); this.chat(null, m.name + ' вернулся в игру — снова командует сам', 'ok'); }
    }
    let e = g.hashes.get(msg.n);
    if (!e) { e = new Map(); g.hashes.set(msg.n, e); }
    e.set(m.id, msg.h >>> 0);
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
    if (m.pid >= 0) m.catching = true; // командовать снова — когда догонит
  }
  // страница перезагрузилась посреди боя: заново описание боя и все ходы с начала — игра у
  // участника пересчитает бой быстрее реального времени и догонит остальных (зритель — до своей задержки)
  on_rejoin(m) {
    const g = this.game;
    if (!g || m.over) return;
    if (m.pid >= 0) { m.loaded = false; m.ack = -1; m.catching = true; }
    this.sendM(m, { t: 'start', id: g.id, cfg: g.cfg, me: m.pid >= 0 ? m.slot : -1, rejoin: true, spec: m.pid < 0, delay: this.T.SPEC_DELAY });
    this.sendM(m, { t: 'turns', id: g.id, list: this.turnList(0, this.seenTurns(m)) });
  }
  // зритель (пришёл во время боя или нажал «Смотреть бой») — бой с начала до своей задержки
  on_watch(m) {
    const g = this.game;
    if (!g || m.pid >= 0) return;
    m.over = false;
    this.on_rejoin(m);
  }
  on_over(m) { if (this.game) { m.over = true; this.checkEnd(); } }
  // игрок ушёл из боя в комнату: войсками командует ИИ
  on_lobby(m) {
    if (!this.game) return;
    if (m.pid >= 0 && !m.dropped && !m.over) this.dropPid(m, 'leave');
    m.over = true;
    this.checkEnd();
  }
  on_leave(m) {
    const c = m.conn;
    this.removeMember(m);
    if (c) { c.member = null; try { c.close(1000, 'leave'); } catch (e) { /* уже */ } }
  }
  dropPid(m, why) {
    const g = this.game;
    if (!g || m.pid < 0 || m.dropped) return;
    m.dropped = true;
    g.pending.push([m.pid, ['drop', 'normal']]);
    m.presT = this.now();
    this.chat(null, why === 'leave' ? m.name + ' покинул бой — войсками командует ИИ' : why === 'lag' ? m.name + ' сильно отстаёт — войсками временно командует ИИ' : m.name + ' без связи — войсками командует ИИ', 'warn');
  }
  checkEnd() {
    const g = this.game;
    if (!g) return;
    // бой идёт, пока есть игрок, который его не завершил и не ушёл совсем: временно отданные ИИ (отстал,
    // свернул приложение, обрыв связи) могут вернуться — бой их ждёт. Ушедший без связи (отдан ИИ и не на
    // связи) бой не держит, если остальные уже закончили; если без связи все — бой закроет EMPTY_END
    const humans = this.members.filter((x) => x.pid >= 0);
    if (humans.some((x) => !x.over && !(x.dropped && !x.on))) return;
    if (humans.length && !humans.some((x) => x.over)) return;
    this.endGame();
  }
  endGame() {
    // зрителям — оставшиеся ходы (бой окончен, задержка больше не нужна), их игра досчитает бой до конца
    const g = this.game;
    if (g) for (const m of this.members) if (m.conn && m.pid < 0) this.sendM(m, { t: 'turns', id: g.id, list: this.turnList(this.seenTurns(m), g.turn) });
    this.state = 'lobby'; this.game = null;
    for (const m of this.members) { m.pid = -1; m.loaded = false; m.over = false; m.dropped = false; }
    // места ушедших освобождаются
    for (const s of this.slots) if (s.k === 'human' && !this.members.some((x) => x.id === s.m)) { s.k = 'open'; s.m = 0; }
    this.broadcast({ t: 'end' });
    this.broadcastRoom();
  }

  // ---------- общий список открытых комнат ----------
  info() {
    const humans = this.slots.filter((x) => x.k === 'human').length, open = this.slots.filter((x) => x.k === 'open').length;
    const host = this.members.find((x) => x.id === this.host);
    return { code: this.code, name: this.s.name || ('Комната ' + ((host && host.name) || this.code)), map: this.s.map, n: this.slots.length, humans, open,
      ai: this.slots.filter((x) => ['easy', 'normal', 'hard'].includes(x.k)).length, spect: this.members.filter((x) => x.slot < 0).length, state: this.state, t: this.now() };
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
        if (m.pid >= 0) { try { m.conn.send(live); } catch (e) { /* закрыто */ } } else if (late) { try { m.conn.send(late); } catch (e) { /* закрыто */ } }
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
    if (this.game && !this.members.some((x) => x.on)) {
      // никого на связи: через минуту бой закрывается
      if (!this.game.emptyT) this.game.emptyT = t;
      else if (t - this.game.emptyT > this.T.EMPTY_END) this.endGame();
    } else if (this.game) this.game.emptyT = 0;
    this.publish(t);
    if (!this.members.length && !this.conns.size) { this.unpublish(); this.stopTimer(); if (this.io.onEmpty) this.io.onEmpty(); }
  }
}

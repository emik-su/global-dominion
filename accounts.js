// =====================================================================
//  Аккаунты игроков (ТЗ v8): профили Telegram, фото, затем рейтинг и записи боёв.
//  Хранилище — SQLite: в Cloudflare это Durable Object AccountsDO (worker.js),
//  у Node-сервера — файл или память (nodestore.js). Модуль не знает, где он
//  работает: ему дают store = { sql(запрос, ...значения) → строки, tx(функция) }.
// =====================================================================

import { START, CALIB, MODES, EARLY_PENALTY, REPEAT_WINDOW, rate, league } from './rating.js';

// Миграции схемы по порядку; номер применённой хранится в таблице meta (в Durable Object PRAGMA user_version недоступен).
// Новые этапы только добавляют миграции — прежние не меняются.
export const MIGRATIONS = [
  // 1 — профили и кэш фото
  [
    `CREATE TABLE players (
       uid INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       username TEXT NOT NULL DEFAULT '',
       photo TEXT NOT NULL DEFAULT '',
       created INTEGER NOT NULL,
       seen INTEGER NOT NULL
     )`,
    `CREATE TABLE avatars (
       uid INTEGER PRIMARY KEY,
       url TEXT NOT NULL,
       type TEXT NOT NULL,
       t INTEGER NOT NULL,
       data BLOB NOT NULL
     )`,
  ],
  // 2 — рейтинг, бои и паузы после выхода из боя (ТЗ v8, этап 3)
  [
    `CREATE TABLE ratings (
       uid INTEGER NOT NULL,
       mode TEXT NOT NULL,
       rating REAL NOT NULL,
       games INTEGER NOT NULL DEFAULT 0,
       wins INTEGER NOT NULL DEFAULT 0,
       losses INTEGER NOT NULL DEFAULT 0,
       draws INTEGER NOT NULL DEFAULT 0,
       quits INTEGER NOT NULL DEFAULT 0,
       peak REAL NOT NULL,
       updated INTEGER NOT NULL,
       PRIMARY KEY (uid, mode)
     )`,
    'CREATE INDEX ratings_top ON ratings (mode, rating DESC)',
    `CREATE TABLE matches (
       id TEXT PRIMARY KEY,
       t INTEGER NOT NULL,
       dur INTEGER NOT NULL,
       map TEXT NOT NULL,
       mode TEXT NOT NULL,
       ranked INTEGER NOT NULL,
       status TEXT NOT NULL,
       reason TEXT NOT NULL DEFAULT '',
       n INTEGER NOT NULL,
       ticks INTEGER NOT NULL DEFAULT 0,
       hash INTEGER NOT NULL DEFAULT 0
     )`,
    'CREATE INDEX matches_t ON matches (t)',
    `CREATE TABLE match_players (
       match_id TEXT NOT NULL,
       pid INTEGER NOT NULL,
       uid INTEGER NOT NULL,
       name TEXT NOT NULL,
       tk TEXT NOT NULL,
       faction INTEGER NOT NULL DEFAULT 0,
       outcome TEXT NOT NULL,
       place INTEGER NOT NULL DEFAULT 0,
       r_before REAL,
       r_after REAL,
       delta REAL,
       PRIMARY KEY (match_id, pid)
     )`,
    'CREATE INDEX match_players_uid ON match_players (uid, match_id)',
    `CREATE TABLE cooldowns (
       uid INTEGER PRIMARY KEY,
       until INTEGER NOT NULL,
       strikes INTEGER NOT NULL,
       last INTEGER NOT NULL
     )`,
  ],
  // 3 — записи боёв на сервере (ТЗ v8, этап 5): сжатая запись кусками; в самом бое — её размер (0 — записи нет)
  [
    `CREATE TABLE replays (
       match_id TEXT NOT NULL,
       n INTEGER NOT NULL,
       data BLOB NOT NULL,
       PRIMARY KEY (match_id, n)
     )`,
    'ALTER TABLE matches ADD COLUMN rec INTEGER NOT NULL DEFAULT 0',
    'CREATE INDEX matches_rec ON matches (t) WHERE rec>0',
  ],
];
export const SCHEMA_VERSION = MIGRATIONS.length;
export const AVATAR_TTL = 7 * 24 * 3600e3; // фото перезапрашивается раз в неделю (или сразу, если сменилась ссылка)
export const AVATAR_MAX = 200 * 1024;
// Записи боёв: хранятся 30 суток, не больше 3000 самых новых и не больше 400 МБ всего (бесплатный Durable Object хранит ограниченный объём);
// кусок — не больше 900 КБ (в строке Durable Object — до 2 МБ)
export const REPLAY_KEEP = 30 * 24 * 3600e3;
export const REPLAY_MAX_COUNT = 3000;
export const REPLAY_TOTAL_BYTES = 400 * 1024 * 1024;
export const REPLAY_CHUNK = 900 * 1024;
export const REPLAY_MAX_BYTES = 8 * 1024 * 1024;

export class Accounts {
  constructor(store) {
    this.sql = store.sql;
    this.tx = store.tx;
    this.replayKeep = REPLAY_KEEP; this.replayMax = REPLAY_MAX_COUNT; this.replayBytes = REPLAY_TOTAL_BYTES; // свои пределы — для проверок
    this.migrate();
  }
  migrate() {
    this.sql('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const r = this.sql("SELECT v FROM meta WHERE k='schema'")[0];
    let cur = r ? +r.v : 0;
    if (cur > SCHEMA_VERSION) throw new Error('База новее сервера: схема ' + cur + ' > ' + SCHEMA_VERSION);
    for (; cur < SCHEMA_VERSION; cur++) {
      this.tx(() => {
        for (const q of MIGRATIONS[cur]) this.sql(q);
        this.sql("INSERT INTO meta (k,v) VALUES ('schema',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(cur + 1));
      });
    }
  }

  // ---------- профили ----------
  // p: проверенные данные Telegram { id, name, username, photo }. Если Telegram в этот раз фото не прислал, прежнее остаётся.
  login(p, now) {
    this.tx(() => {
      const have = this.sql('SELECT uid FROM players WHERE uid=?', p.id)[0];
      if (have) this.sql('UPDATE players SET name=?, username=?, photo=CASE WHEN ?<>\'\' THEN ? ELSE photo END, seen=? WHERE uid=?', p.name, p.username || '', p.photo || '', p.photo || '', now, p.id);
      else this.sql('INSERT INTO players (uid,name,username,photo,created,seen) VALUES (?,?,?,?,?,?)', p.id, p.name, p.username || '', p.photo || '', now, now);
    });
    return this.profile(p.id);
  }
  profile(uid) {
    const r = this.sql('SELECT uid,name,username,photo,created,seen FROM players WHERE uid=?', uid)[0];
    return r ? { uid: r.uid, name: r.name, username: r.username, photo: r.photo, av: !!r.photo, created: r.created, seen: r.seen } : null;
  }
  count() { return this.sql('SELECT COUNT(*) AS n FROM players')[0].n; }
  // сводка для самопроверки сервера: сколько игроков, боёв, записей и сколько байт занимают записи (записи — по частичному индексу)
  stats() {
    const r = this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(rec), 0) AS b FROM matches WHERE rec>0')[0];
    return { schema: SCHEMA_VERSION, players: this.count(), matches: this.sql('SELECT COUNT(*) AS n FROM matches')[0].n, records: r.n, recordBytes: r.b };
  }

  // ---------- рейтинг ----------
  rating(uid, mode) {
    const r = this.sql('SELECT rating,games,wins,losses,draws,quits,peak FROM ratings WHERE uid=? AND mode=?', uid, mode)[0];
    return r || { rating: START, games: 0, wins: 0, losses: 0, draws: 0, quits: 0, peak: START };
  }
  putRating(uid, mode, r, now) {
    this.sql('INSERT INTO ratings (uid,mode,rating,games,wins,losses,draws,quits,peak,updated) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid,mode) DO UPDATE SET rating=excluded.rating, games=excluded.games, wins=excluded.wins, losses=excluded.losses, draws=excluded.draws, quits=excluded.quits, peak=excluded.peak, updated=excluded.updated',
      uid, mode, r.rating, r.games, r.wins, r.losses, r.draws, r.quits, r.peak, now);
  }
  // оба рейтинга игрока для показа: { duel: { r, g, lg, lc }, multi: { … } } (r — округлённый рейтинг, g — боёв, lg — лига)
  ratings(uid) {
    const o = {};
    for (const mode of MODES) { const r = this.rating(uid, mode), L = league(r.rating, r.games); o[mode] = { r: Math.round(r.rating), g: r.games, w: r.wins, l: r.losses, lg: L.label, lc: L.color, pk: Math.round(r.peak) }; }
    return o;
  }
  // сколько боёв подряд за сутки у двух игроков друг против друга (засчитанных рейтинговых)
  duels(a, b, since) {
    return this.sql(`SELECT COUNT(*) AS n FROM match_players x JOIN match_players y ON x.match_id=y.match_id AND x.tk<>y.tk
      JOIN matches m ON m.id=x.match_id WHERE x.uid=? AND y.uid=? AND m.ranked=1 AND m.status='ok' AND m.t>?`, a, b, since)[0].n;
  }
  // Итог боя от комнаты: запись боя, рейтинг (если бой рейтинговый и засчитан) и наказания за ранний выход.
  // m: { id, t, dur, map, mode, ranked, status, reason, ticks, hash, players: [{ pid, uid, name, tk, faction, outcome, place, quit }], teams: { tk: место }, penalties: [uid] }
  // Повторный итог того же боя ничего не меняет (комната могла отправить его дважды) и возвращает прежний ответ.
  applyMatch(m, now) {
    return this.tx(() => {
      if (this.sql('SELECT id FROM matches WHERE id=?', m.id)[0]) return Object.assign(this.matchChanges(m.id), { dup: true });
      const humans = m.players || [];
      const ranked = !!m.ranked;
      const rated = ranked && m.status === 'ok' && humans.length >= 2 && humans.every((p) => p.uid > 0);
      const changes = [], pen = [];
      const row = {}; // pid → { before, after, delta }
      if (rated) {
        const R = new Map(humans.map((p) => [p.uid, this.rating(p.uid, m.mode)]));
        const since = now - REPEAT_WINDOW, repeat = {};
        for (const p of humans) {
          let worst = 0;
          for (const q of humans) if (q.tk !== p.tk) worst = Math.max(worst, this.duels(p.uid, q.uid, since));
          repeat[p.uid] = worst + 1;
        }
        const out = rate(humans.map((p) => ({ key: p.uid, team: p.tk, rating: R.get(p.uid).rating, games: R.get(p.uid).games, quit: !!p.quit })), m.teams, repeat);
        for (const p of humans) {
          const r = Object.assign({}, R.get(p.uid)), d = out.get(p.uid).delta, before = r.rating;
          r.rating = Math.max(0, before + d); r.games++; r.peak = Math.max(r.peak, r.rating);
          if (p.outcome === 'win') r.wins++; else if (p.outcome === 'draw') r.draws++; else r.losses++;
          if (p.outcome === 'quit') r.quits++;
          this.putRating(p.uid, m.mode, r, now);
          row[p.pid] = { before, after: r.rating, delta: r.rating - before };
          const L = league(r.rating, r.games);
          changes.push({ pid: p.pid, uid: p.uid, before: Math.round(before), after: Math.round(r.rating), delta: row[p.pid].delta, games: r.games, lg: L.label, lc: L.color, f: out.get(p.uid).f, rt: this.ratings(p.uid) });
        }
      }
      // ранний выход: −25 к рейтингу режима и пауза в рейтинговых боях (10 мин, затем 30 мин, затем 2 ч — в пределах суток)
      if (ranked) {
        for (const uid of new Set((m.penalties || []).filter((u) => u > 0))) {
          const c = this.sql('SELECT until,strikes,last FROM cooldowns WHERE uid=?', uid)[0];
          const strikes = (c && now - c.last < 24 * 3600e3 ? c.strikes : 0) + 1, mins = strikes === 1 ? 10 : strikes === 2 ? 30 : 120, until = now + mins * 60e3;
          this.sql('INSERT INTO cooldowns (uid,until,strikes,last) VALUES (?,?,?,?) ON CONFLICT(uid) DO UPDATE SET until=excluded.until, strikes=excluded.strikes, last=excluded.last', uid, until, strikes, now);
          const r = Object.assign({}, this.rating(uid, m.mode)), before = r.rating;
          r.rating = Math.max(0, before - EARLY_PENALTY); r.quits++;
          this.putRating(uid, m.mode, r, now);
          pen.push({ uid, loss: before - r.rating, until, strikes, mins });
        }
      }
      this.sql('INSERT INTO matches (id,t,dur,map,mode,ranked,status,reason,n,ticks,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)', m.id, m.t, m.dur | 0, m.map, m.mode, ranked ? 1 : 0, m.status, m.reason || '', humans.length, m.ticks | 0, m.hash >>> 0);
      for (const p of humans) {
        const r = row[p.pid];
        this.sql('INSERT INTO match_players (match_id,pid,uid,name,tk,faction,outcome,place,r_before,r_after,delta) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          m.id, p.pid, p.uid | 0, p.name, p.tk, p.faction | 0, p.outcome, p.place | 0, r ? r.before : null, r ? r.after : null, r ? r.delta : null);
      }
      return { id: m.id, dup: false, rated, changes, penalties: pen };
    });
  }
  // ответ о ранее записанном бое
  matchChanges(id) {
    const rows = this.sql('SELECT p.pid,p.uid,p.r_before,p.r_after,p.delta,m.mode FROM match_players p JOIN matches m ON m.id=p.match_id WHERE p.match_id=? AND p.r_before IS NOT NULL ORDER BY p.pid', id);
    return { id, rated: rows.length > 0, changes: rows.map((r) => {
      const x = this.rating(r.uid, r.mode), L = league(r.r_after, x.games);
      return { pid: r.pid, uid: r.uid, before: Math.round(r.r_before), after: Math.round(r.r_after), delta: r.delta, games: x.games, lg: L.label, lc: L.color, rt: this.ratings(r.uid) };
    }), penalties: [] };
  }
  // можно ли игроку в рейтинговый бой сейчас; рейтинги — для показа в комнате
  rankCheck(uids, now) {
    const o = {};
    for (const uid of uids) {
      const c = this.sql('SELECT until FROM cooldowns WHERE uid=?', uid)[0];
      o[uid] = { rt: this.ratings(uid), cd: c && c.until > now ? c.until : 0 };
    }
    return o;
  }
  // лучшие игроки режима (в таблицу попадают после калибровки)
  top(mode, limit = 20, offset = 0) {
    return this.sql(`SELECT r.uid, p.name, p.photo<>'' AS av, r.rating, r.games, r.wins, r.losses FROM ratings r JOIN players p ON p.uid=r.uid
      WHERE r.mode=? AND r.games>=? ORDER BY r.rating DESC, r.games DESC, r.uid LIMIT ? OFFSET ?`, mode, CALIB, limit, offset).map((x, i) => {
      const L = league(x.rating, x.games);
      return { n: offset + i + 1, uid: x.uid, name: x.name, av: !!x.av, r: Math.round(x.rating), g: x.games, w: x.wins, l: x.losses, lg: L.label, lc: L.color };
    });
  }
  // место игрока в таблице режима (null — калибровка не пройдена)
  place(uid, mode) {
    const r = this.rating(uid, mode);
    if (r.games < CALIB) return null;
    return this.sql('SELECT COUNT(*) AS n FROM ratings WHERE mode=? AND games>=? AND (rating>? OR (rating=? AND games>?))', mode, CALIB, r.rating, r.rating, r.games)[0].n + 1;
  }
  // бои игрока, новые сверху. after — курсор { t, id } последнего уже показанного боя (следующая страница)
  recent(uid, limit = 10, after = null) {
    const cur = after && Number.isFinite(after.t) ? 'AND (m.t<? OR (m.t=? AND m.id>?))' : '';
    const args = cur ? [uid, after.t, after.t, String(after.id || ''), limit] : [uid, limit];
    return this.sql(`SELECT m.id,m.t,m.map,m.mode,m.ranked,m.status,m.reason,m.dur,m.rec,p.outcome,p.place,p.r_before,p.r_after,p.delta FROM match_players p JOIN matches m ON m.id=p.match_id
      WHERE p.uid=? ${cur} ORDER BY m.t DESC, m.id LIMIT ?`, ...args).map((x) => ({ id: x.id, t: x.t, map: x.map, mode: x.mode, ranked: !!x.ranked, status: x.status, reason: x.reason, dur: x.dur, outcome: x.outcome, place: x.place,
      r: x.r_after == null ? null : Math.round(x.r_after), d: x.delta == null ? null : Math.round(x.delta * 10) / 10, rec: x.rec > 0 }));
  }
  // страница боёв игрока: не больше limit строк и признак «есть ещё»
  matchPage(uid, limit, after) {
    const rows = this.recent(uid, limit + 1, after);
    return { list: rows.slice(0, limit), more: rows.length > limit };
  }
  // ---------- записи боёв (ТЗ v8, этап 5) ----------
  // bytes — запись в хранимом виде (pack.js), хранится кусками; запись есть только у боя, который уже занесён (applyMatch). Повторная замена.
  putReplay(id, bytes, now) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > REPLAY_MAX_BYTES) return { ok: false, why: 'size' };
    return this.tx(() => {
      if (!this.sql('SELECT id FROM matches WHERE id=?', id)[0]) return { ok: false, why: 'nomatch' };
      this.sql('DELETE FROM replays WHERE match_id=?', id);
      for (let n = 0, off = 0; off < bytes.length; n++, off += REPLAY_CHUNK) this.sql('INSERT INTO replays (match_id,n,data) VALUES (?,?,?)', id, n, bytes.slice(off, off + REPLAY_CHUNK));
      this.sql('UPDATE matches SET rec=? WHERE id=?', bytes.length, id);
      this.purgeReplays(now);
      return { ok: true, bytes: bytes.length };
    });
  }
  // запись боя целиком (хранимые байты) или null
  getReplay(id) {
    const rows = this.sql('SELECT data FROM replays WHERE match_id=? ORDER BY n', id);
    if (!rows.length) return null;
    let len = 0;
    for (const r of rows) len += r.data.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const r of rows) { out.set(r.data, off); off += r.data.length; }
    return out;
  }
  // записи старше срока, а также сверх предела по числу и по объёму (уходят самые старые) удаляются; сами бои и рейтинги остаются.
  // Читаются только строки боёв с записью (частичный индекс matches_rec) — число прочитанных строк не растёт с числом всех боёв
  purgeReplays(now) {
    const gone = new Set();
    for (const r of this.sql('SELECT id FROM matches WHERE rec>0 AND t<?', now - this.replayKeep)) gone.add(r.id);
    let n = 0, sum = 0;
    for (const r of this.sql('SELECT id, rec FROM matches WHERE rec>0 ORDER BY t DESC, id')) {
      if (gone.has(r.id)) continue;
      n++; sum += r.rec;
      if (n > this.replayMax || sum > this.replayBytes) gone.add(r.id);
    }
    for (const id of gone) { this.sql('DELETE FROM replays WHERE match_id=?', id); this.sql('UPDATE matches SET rec=0 WHERE id=?', id); }
    return gone.size;
  }
  // карточка игрока: профиль, рейтинги, последние бои
  card(uid) {
    const p = this.profile(uid);
    if (!p) return null;
    return { uid: p.uid, name: p.name, av: p.av, created: p.created, seen: p.seen, rt: this.ratings(uid), pos: { duel: this.place(uid, 'duel'), multi: this.place(uid, 'multi') }, recent: this.recent(uid, 10) };
  }

  // ---------- фото ----------
  avatar(uid) {
    const r = this.sql('SELECT url,type,t,data FROM avatars WHERE uid=?', uid)[0];
    return r || null;
  }
  setAvatar(uid, url, type, data, now) {
    this.sql('INSERT INTO avatars (uid,url,type,t,data) VALUES (?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET url=excluded.url, type=excluded.type, t=excluded.t, data=excluded.data', uid, url, type, now, data);
  }
  // кэш свежий: та же ссылка и не старше AVATAR_TTL
  avatarFresh(a, photo, now) { return !!a && a.url === photo && now - a.t < AVATAR_TTL; }
}

// ---------- хранилища ----------
// Durable Object (Cloudflare): ctx — state объекта. BLOB приходит как ArrayBuffer — приводим к Uint8Array.
export function doStore(ctx) {
  const norm = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  return {
    sql(q, ...a) {
      const rows = ctx.storage.sql.exec(q, ...a).toArray();
      for (const r of rows) for (const k in r) r[k] = norm(r[k]);
      return rows;
    },
    tx: (fn) => ctx.storage.transactionSync(fn),
  };
}

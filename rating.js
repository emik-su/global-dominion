// =====================================================================
//  Рейтинг Эло для боёв на 2–8 игроков (ТЗ v8, раздел 3).
//  Только чистые функции: ни базы, ни часов, ни сети — поэтому формулы проверяются
//  таблицами в test/rating_test.mjs, а хранение и выбор соперников — в accounts.js.
//
//  Основа: ожидаемый результат E = 1 / (1 + 10^((Rb − Ra)/400)). Команда = среднее рейтингов
//  её игроков. В бою на n команд каждая команда сравнивается с каждой другой:
//      Δ = (1/(n−1)) · Σ (S − E),  S = 1 (место лучше) / 0,5 (поровну) / 0 (хуже)
//  Изменение игрока = K · Δ · множитель повторов. Сумма Δ по командам равна нулю.
// =====================================================================
export const START = 1000;        // рейтинг нового игрока
export const SCALE = 400;         // шкала Эло: +400 — соперник «в 10 раз вероятнее» выиграет
export const CALIB = 5;           // первые 5 боёв режима — «Калибровка» (лига скрыта)
export const MODES = ['duel', 'multi'];
export const MODE_NAME = { duel: 'Дуэль', multi: 'Мультиплеер' };
export const REPEAT_STEP = 0.25;  // каждый следующий бой с тем же соперником за сутки: −25 % к изменению рейтинга
export const REPEAT_WINDOW = 24 * 3600e3;
export const EARLY_PENALTY = 25;  // выход из боя до 3-й минуты: −25 очков рейтинга режима

export const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / SCALE));

// Чем меньше боёв, тем быстрее рейтинг находит своё место: 64 → 32 за 15 боёв. Высокий рейтинг (≥1700) меняется на 25 % медленнее.
export function kFactor(games, rating) {
  const k = 32 + 32 * Math.max(0, 1 - games / 15);
  return rating >= 1700 ? k * 0.75 : k;
}

export const repeatFactor = (n) => Math.max(0, 1 - REPEAT_STEP * (Math.max(1, n | 0) - 1));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// teams: [{ rating, rank }], rank 1 — лучшее место, равные места — равные числа. Возвращает Δ каждой команды (доля K, от −1 до 1).
export function teamDeltas(teams) {
  const n = teams.length;
  if (n < 2) return teams.map(() => 0);
  return teams.map((a, i) => {
    let s = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = teams[j], S = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      s += S - expected(a.rating, b.rating);
    }
    return s / (n - 1);
  });
}
// Δ команды, если бы она заняла последнее место (для игрока, покинувшего бой)
function lastDelta(i, teams) {
  const n = teams.length;
  let s = 0;
  for (let j = 0; j < n; j++) if (j !== i) s += expected(teams[i].rating, teams[j].rating);
  return -s / (n - 1);
}

// Изменения рейтинга после боя.
//   players: [{ key, team, rating, games, quit }]  key — любой уникальный ключ игрока, team — ключ его команды,
//            quit — игрок покинул бой (после 3-й минуты это поражение лично ему, а остальным — только если проиграла команда)
//   rank:    { ключ команды: место }
//   repeat:  { key: сколько боёв подряд за сутки с теми же соперниками, считая этот }
// Результат: Map(key → { delta, share, k, f }) — изменение рейтинга, доля Δ, коэффициент K, множитель повторов.
export function rate(players, rank, repeat = {}) {
  const byTeam = new Map();
  for (const p of players) {
    let t = byTeam.get(p.team);
    if (!t) { t = { key: p.team, members: [], rank: rank[p.team] }; byTeam.set(p.team, t); }
    t.members.push(p);
  }
  const T = [...byTeam.values()];
  for (const t of T) t.rating = avg(t.members.map((m) => m.rating));
  const D = teamDeltas(T), out = new Map();
  T.forEach((t, i) => {
    const anyQuit = t.members.some((m) => m.quit);
    for (const m of t.members) {
      let share = D[i];
      if (m.quit) share = lastDelta(i, T);
      else if (anyQuit && share < 0) share *= 0.5; // союзник ушёл, команда проиграла — остальные теряют вдвое меньше
      const k = kFactor(m.games, m.rating), f = repeatFactor(repeat[m.key] || 1);
      out.set(m.key, { delta: k * share * f, share, k, f });
    }
  });
  return out;
}

// ---------- лиги ----------
export const LEAGUES = [
  { id: 'bronze', name: 'Бронза', from: -Infinity, color: '#b97a45' },
  { id: 'silver', name: 'Серебро', from: 900, color: '#b4bdc8' },
  { id: 'gold', name: 'Золото', from: 1100, color: '#e6b83c' },
  { id: 'platinum', name: 'Платина', from: 1300, color: '#4fcdbd' },
  { id: 'diamond', name: 'Алмаз', from: 1500, color: '#68b5ff' },
  { id: 'master', name: 'Мастер', from: 1700, color: '#c27cff' },
  { id: 'legend', name: 'Легенда', from: 1900, color: '#ff6a5c' },
];
const ROMAN = ['', 'I', 'II', 'III'];
// Лига и дивизион (III — нижняя треть ступени, I — верхняя). До CALIB боёв в режиме лига скрыта.
export function league(rating, games) {
  if ((games | 0) < CALIB) return { id: 'calib', name: 'Калибровка', div: 0, label: 'Калибровка ' + (games | 0) + '/' + CALIB, color: '#8a94a3' };
  let i = LEAGUES.length - 1;
  while (i > 0 && rating < LEAGUES[i].from) i--;
  const L = LEAGUES[i];
  let div = 0;
  if (L.id !== 'legend') {
    const lo = i === 0 ? 700 : L.from;
    div = 3 - Math.max(0, Math.min(2, Math.floor((rating - lo) / (200 / 3))));
  }
  return { id: L.id, name: L.name, div, label: L.name + (div ? ' ' + ROMAN[div] : ''), color: L.color };
}
export const shown = (r) => Math.round(r);

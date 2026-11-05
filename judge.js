// =====================================================================
//  Судья боя (ТЗ v8, раздел 3): по отчётам игроков и записи уходов решает, кто победил, кто покинул бой
//  и засчитывать ли бой в рейтинг. Чистая функция — без базы, часов и сети (проверяется таблицей сценариев).
//
//  Сервер бой не считает: все игры участников считают его одинаково (lockstep), а в конце каждая присылает
//  отчёт — на каком такте бой кончился, хеш состояния и кто как выбыл. Бой засчитывается, только если отчёты
//  ВСЕХ, кто его досмотрел, совпали до последнего числа; расхождение — бой не засчитывается (и пишется для проверки).
//  Кто вышел, не дождавшись конца боя, отчёта не шлёт — для него решает запись сервера о том, когда он ушёл.
//  Правила выхода (ТЗ v8): до 3-й минуты — бой остальным не засчитывается, ушедшему штраф; после — поражение
//  ушедшему (и его команде, если она проиграла — остальным вдвое мягче); вернулся в бой вовремя — без наказания.
// =====================================================================
export const TICKS_PER_TURN = 6;       // тактов симуляции в одном ходе сервера (100 мс)
export const TICKS_PER_SEC = 60;
export const EARLY_SEC = 180;          // «ранний» выход: до 3-й минуты боя
export const MAX_TICKS = 10 * 3600 * TICKS_PER_SEC; // отчёт про бой длиннее 10 часов — подделка

const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

// Отчёт игры: { tk — такт конца боя, h — хеш состояния (uint32), r: [[жив 0/1, такт выбытия или −1, сдался 0/1, фракция], …] }
// → отчёт в виде для сравнения или null, если он неправдоподобен (чужой формат, число игроков не то, жив и выбыл одновременно).
export function normReport(raw, n) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.r) || raw.r.length !== n) return null;
  if (!int(raw.tk, 0, MAX_TICKS) || !int(raw.h, 0, 0xffffffff)) return null;
  const r = [];
  for (const x of raw.r) {
    if (!Array.isArray(x) || x.length !== 4) return null;
    const [a, d, s, f] = x;
    if (!(a === 0 || a === 1) || !int(d, -1, MAX_TICKS) || !(s === 0 || s === 1) || !int(f, 0, 63)) return null;
    if (a === 1 && d !== -1) return null;   // жив, но «выбыл»
    if (a === 0 && d < 0) return null;      // мёртв без времени выбытия
    r.push([a, d, s, f]);
  }
  return { tk: raw.tk, h: raw.h, r };
}
export const reportKey = (rep) => rep.tk + ':' + rep.h + ':' + rep.r.map((x) => x.join(',')).join(';');

// roster: [{ human, uid, team }] по номерам игроков; reports: { номер игрока: отчёт как прислал клиент };
// leaves: { номер игрока: { tick — такт ухода, final — вышел сам или время возврата истекло } } (только не вернувшиеся);
// endTick — сколько тактов прошло на сервере к закрытию боя; earlyTicks — граница «раннего» выхода.
// Результат: { status: 'ok' | 'void', reason, mode, players: [{ pid, uid, team, outcome, rank, quit, early }], teams: { ключ: место },
//              rep, penalties: [uid] }
export function judge(inp) {
  const { roster, reports = {}, leaves = {}, endTick = 0 } = inp;
  const earlyTicks = inp.earlyTicks == null ? EARLY_SEC * TICKS_PER_SEC : inp.earlyTicks;
  const N = roster.length;
  const humans = [];
  roster.forEach((p, pid) => { if (p && p.human) humans.push(pid); });
  const out = { status: 'void', reason: '', mode: humans.length === 2 && roster.length === 2 && new Set(roster.map((p, i) => tkey(roster, i))).size === 2 ? 'duel' : 'multi', players: [], teams: {}, rep: null, penalties: [] };
  const finalLeave = (pid) => { const l = leaves[pid]; return l && l.final ? l : null; };
  // уход без отчёта о конце боя: «ранний» ли он, судим по записи сервера
  const earlyLeavers = (known) => humans.filter((pid) => { const l = finalLeave(pid); return l && l.tick < earlyTicks && (known ? known(pid, l) : true); });

  // ---------- отчёты ----------
  const reps = new Map();
  for (const pid of humans) {
    if (!(pid in reports)) continue;
    const rep = normReport(reports[pid], N);
    if (rep) reps.set(pid, rep);
  }
  if (!reps.size) {
    // никто не досмотрел бой до конца: не засчитывается; тех, кто ушёл рано, это не освобождает от штрафа
    out.reason = 'noreport';
    out.penalties = earlyLeavers().map((pid) => roster[pid].uid).filter(Boolean);
    return out;
  }
  const groups = new Map();
  for (const [pid, r] of reps) { const k = reportKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(pid); }
  if (groups.size > 1) { out.reason = 'disagree'; out.groups = [...groups.values()]; return out; } // игры насчитали разное — не засчитывается
  const rep = reps.values().next().value;
  out.rep = { tk: rep.tk, h: rep.h, f: rep.r.map((x) => x[3]) }; // f — фракции игроков (в их порядке)

  // ---------- кто как выбыл ----------
  const alive = rep.r.map((x) => x[0] === 1), defT = rep.r.map((x) => (x[0] === 1 ? Infinity : x[1])), surr = rep.r.map((x) => x[2] === 1);
  const quit = {}, early = {};
  for (const pid of humans) {
    const l = finalLeave(pid);
    // ушёл, пока ещё был в бою (жив, или выбыл уже после ухода — тогда за него воевал ИИ)
    quit[pid] = !!l && (alive[pid] || defT[pid] > l.tick);
    // сдача до 3-й минуты приравнена к раннему выходу
    early[pid] = (quit[pid] && leaves[pid].tick < earlyTicks) || (surr[pid] && !alive[pid] && defT[pid] < earlyTicks);
  }
  const earlyPids = humans.filter((pid) => early[pid]);
  if (earlyPids.length) {
    out.reason = 'early';
    out.penalties = earlyPids.map((pid) => roster[pid].uid).filter(Boolean);
    return out;
  }

  // ---------- команды и места ----------
  const teams = new Map(); // ключ → { key, pids, alive, end, present, qt }
  for (let pid = 0; pid < N; pid++) {
    const k = tkey(roster, pid);
    let t = teams.get(k);
    if (!t) { t = { key: k, pids: [], alive: false, end: 0, present: false, qt: 0, humans: 0 }; teams.set(k, t); }
    t.pids.push(pid);
    if (alive[pid]) t.alive = true;
    t.end = Math.max(t.end, defT[pid]);
    if (roster[pid].human) { t.humans++; if (quit[pid]) t.qt = Math.max(t.qt, leaves[pid].tick); else t.present = true; }
  }
  if (teams.size < 2) { out.reason = 'single'; return out; }
  const list = [...teams.values()];
  // команда «на месте»: есть человек, досмотревший бой, либо людей в ней нет вовсе (ИИ)
  for (const t of list) if (!t.humans) t.present = true;
  if (!list.some((t) => t.present && t.humans)) { out.reason = 'abandoned'; return out; } // в бою не осталось ни одного человека
  const order = (a, b) => {
    if (a.present !== b.present) return a.present ? -1 : 1;                 // ушедшие целиком — ниже всех
    if (!a.present) return b.qt - a.qt;                                    // из ушедших выше те, кто продержался дольше
    if (a.alive !== b.alive) return a.alive ? -1 : 1;                      // оставшиеся в живых выше выбывших
    return b.end - a.end;                                                  // из выбывших выше те, кто продержался дольше
  };
  list.sort(order);
  let rank = 0;
  list.forEach((t, i) => { if (i === 0 || order(list[i - 1], t) !== 0) rank = i + 1; t.rank = rank; out.teams[t.key] = rank; });

  const winners = list.filter((t) => t.rank === 1).length;
  for (const pid of humans) {
    const t = teams.get(tkey(roster, pid));
    out.players.push({ pid, uid: roster[pid].uid | 0, team: t.key, rank: t.rank, quit: quit[pid], early: false,
      outcome: quit[pid] ? 'quit' : t.rank === 1 ? (winners > 1 ? 'draw' : 'win') : 'loss' });
  }
  out.status = 'ok';
  return out;
}

// ключ команды: игроки с одним номером команды (1–4) — союзники; «0» — сам за себя
export function tkey(roster, pid) { const t = roster[pid].team | 0; return t > 0 ? 't' + t : 'p' + pid; }

// =====================================================================
//  Вход через Telegram Mini App: проверка подписи initData (ТЗ v8, этап 1).
//  Работает одинаково в Cloudflare Workers и в Node.js (WebCrypto).
//
//  Два способа проверки (подпись приходит от Telegram вместе с данными пользователя):
//   1) Ed25519 по полю «signature» — нужен только ID бота (число до двоеточия в токене), токен не нужен.
//      Публичные ключи Telegram — из документации Mini Apps (проверено по двум независимым источникам).
//   2) HMAC-SHA256 по полю «hash» — нужен токен бота (секрет BOT_TOKEN).
//  Если есть и то и другое — берётся Ed25519. Без ID бота и без токена вход не подтверждается (гость).
// =====================================================================
export const TG_PUBKEY_PROD = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
export const TG_PUBKEY_TEST = '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec';
const MAX_INIT = 8192;
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const fromHex = (s) => Uint8Array.from(String(s).match(/../g).map((h) => parseInt(h, 16)));
const toHex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
function fromB64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// очистка текста (как в игре): без управляющих знаков и угловых скобок, обрезка по символам, а не по половинкам эмодзи
const clean = (s, n) => Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, n).join('').trim();

// адрес фото принимается только с серверов Telegram (подпись защищает значение, а список — от странных адресов)
export function photoOk(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' || x.username || x.password) return false;
    const h = x.hostname.toLowerCase();
    return ['t.me', 'telegram.org', 'telegram-cdn.org', 'telesco.pe', 'cdn-telegram.org'].some((d) => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}

// ник игрока из данных Telegram: @username, иначе имя и фамилия (до 16 знаков, как ники в игре)
export function displayName(u) {
  const n = clean(u.username || [u.first_name, u.last_name].filter(Boolean).join(' '), 16);
  return n || 'Игрок';
}

async function hmac(keyBytes, msgBytes) {
  const k = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, msgBytes));
}

// Подпись Ed25519 по открытому ключу (hex). Возвращает название алгоритма, под которым среда проверила подпись:
// 'Ed25519' (стандартное имя: Node, браузеры, Cloudflare по документации) или 'NODE-ED25519' (прежнее имя в Cloudflare Workers —
// пробуется, только если стандартное среда не приняла); '' — подпись не сошлась. Среда не знает ни одного имени — исключение.
export async function edVerify(pubHex, sig, msg) {
  const pub = fromHex(pubHex);
  let alg = 'Ed25519', key;
  try { key = await subtle().importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']); }
  catch (e) {
    alg = 'NODE-ED25519';
    key = await subtle().importKey('raw', pub, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
  }
  return (await subtle().verify(alg, key, sig, msg)) ? alg : '';
}

// Проверочный набор для страницы самопроверки сервера (/api/selfcheck): ключ, сообщение и подпись сделаны отдельно, не Telegram'ом.
const SELF = {
  pub: '69d54f9c825ac02ad0ed975da9418cdf3062367104f56d8fd8561906e97edb0c',
  msg: 'GLOBAL DOMINION selfcheck v1',
  sig: 'ac516cb8f14c5ea4f079763adb9db42b074e6ff4da9f4ee98bff4e2549fa2239685bc995761fcc895066541f28b1de80b9f8e8e9911a4c7e0b5d77ea89f9920b',
};
// Работает ли в этой среде проверка Ed25519: верная подпись должна приниматься, подправленное сообщение — нет.
// Результат: 'Ed25519' | 'NODE-ED25519' (под каким именем сработало) или 'fail: <причина>'.
export async function selfTest() {
  try {
    const good = await edVerify(SELF.pub, fromHex(SELF.sig), enc.encode(SELF.msg));
    if (!good) return 'fail: верная подпись не принята';
    if (await edVerify(SELF.pub, fromHex(SELF.sig), enc.encode(SELF.msg + '!'))) return 'fail: подправленное сообщение принято';
    return good;
  } catch (e) { return 'fail: ' + String(e && e.message || e).slice(0, 80); }
}

// opt: { botId, botToken, pubKey (hex; для проверок), maxAge (сек, по умолчанию 86400), now (мс) }
// Результат: { ok: true, id, name, username, photo, authDate, method } или { ok: false, why }
export async function verifyInitData(init, opt = {}) {
  if (typeof init !== 'string' || !init || init.length > MAX_INIT) return { ok: false, why: 'empty' };
  let sp;
  try { sp = new URLSearchParams(init); } catch (e) { return { ok: false, why: 'format' }; }
  const userRaw = sp.get('user'), authDate = +sp.get('auth_date'), sig = sp.get('signature'), hash = sp.get('hash');
  if (!userRaw || !Number.isFinite(authDate) || authDate <= 0) return { ok: false, why: 'fields' };
  const now = opt.now != null ? opt.now : Date.now(), maxAge = opt.maxAge || 86400;
  if (now / 1000 - authDate > maxAge) return { ok: false, why: 'expired' };
  if (authDate - now / 1000 > 300) return { ok: false, why: 'future' };
  const pairs = [...sp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const line = (skip) => pairs.filter(([k]) => !skip.includes(k)).map(([k, v]) => k + '=' + v).join('\n');
  // Принимается любое из двух доказательств подлинности: подпись Ed25519 (нужен ID бота) или HMAC по токену бота.
  // Если проверена только неудачная — отказ с причиной той проверки, которую пробовали
  let method = '', why = 'unconfigured';
  // номер бота задан, а подписи (signature) в данных нет — Telegram старой версии: без токена бота (HMAC) вход не подтвердить; это не «сервер не настроен»
  if (opt.botId && !sig) why = 'nosig';
  if (sig && opt.botId) {
    try {
      // Ed25519: сообщение «<ID бота>:WebAppData\n<поля по алфавиту без hash и signature>»
      const msg = enc.encode(String(opt.botId) + ':WebAppData\n' + line(['hash', 'signature']));
      if (await edVerify(opt.pubKey || TG_PUBKEY_PROD, fromB64u(sig), msg)) method = 'ed25519'; else why = 'signature';
    } catch (e) { why = 'signature'; }
  }
  if (!method && hash && opt.botToken) {
    try {
      // HMAC: ключ = HMAC("WebAppData", токен); хеш считается по всем полям, кроме hash (допускаем и вариант без signature)
      const secret = await hmac(enc.encode('WebAppData'), enc.encode(opt.botToken));
      const want = String(hash).toLowerCase();
      const a = toHex(await hmac(secret, enc.encode(line(['hash'])))), b = sig ? toHex(await hmac(secret, enc.encode(line(['hash', 'signature'])))) : '';
      if (a === want || b === want) method = 'hmac'; else why = 'hash';
    } catch (e) { why = 'hash'; }
  }
  if (!method) return { ok: false, why };
  let u;
  try { u = JSON.parse(userRaw); } catch (e) { return { ok: false, why: 'user' }; }
  if (!u || !Number.isSafeInteger(u.id) || u.id <= 0 || u.is_bot) return { ok: false, why: 'user' };
  return {
    ok: true, id: u.id, name: displayName(u), username: clean(u.username, 32) || '',
    photo: typeof u.photo_url === 'string' && photoOk(u.photo_url) ? u.photo_url : '', authDate, method,
  };
}

// настройки проверки из переменных окружения сервера (Workers: env, Node: process.env)
export function authOptions(env) {
  env = env || {};
  return { botId: String(env.TG_BOT_ID || '').replace(/\D/g, ''), botToken: env.BOT_TOKEN || '', pubKey: env.TG_PUBKEY || '' };
}
export const authConfigured = (env) => { const o = authOptions(env); return !!(o.botId || o.botToken); };

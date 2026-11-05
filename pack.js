// =====================================================================
//  Сжатие записей боёв (ТЗ v8, этап 5). Один код для Cloudflare и Node: только стандартные потоки
//  (CompressionStream / DecompressionStream есть и в Workers, и в Node 18+).
//  Формат хранимых байтов: первый байт — вид, дальше данные.
//    0x47 «G» — gzip от текста JSON (обычный случай);
//    0x4A «J» — текст JSON как есть (если сжатие в среде недоступно или не удалось).
// =====================================================================

const G = 0x47, J = 0x4a;
const enc = new TextEncoder(), dec = new TextDecoder();

async function pipe(bytes, stream) {
  const w = stream.writable.getWriter();
  // запись и чтение идут одновременно: иначе большой кусок встанет, пока никто не читает
  const out = new Response(stream.readable).arrayBuffer();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await out);
}

// Текст → хранимые байты (всегда возвращает байты: при невозможности сжать — как есть).
export async function pack(text) {
  const raw = enc.encode(text);
  let body = null, kind = J;
  if (typeof CompressionStream === 'function') {
    try { body = await pipe(raw, new CompressionStream('gzip')); kind = G; } catch (e) { body = null; }
  }
  if (!body) { body = raw; kind = J; }
  const out = new Uint8Array(body.length + 1);
  out[0] = kind; out.set(body, 1);
  return out;
}

// Хранимые байты → текст; null — формат не распознан или данные повреждены.
export async function unpack(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) return null;
  const body = bytes.subarray(1);
  try {
    if (bytes[0] === J) return dec.decode(body);
    if (bytes[0] === G && typeof DecompressionStream === 'function') return dec.decode(await pipe(body, new DecompressionStream('gzip')));
  } catch (e) { /* повреждено */ }
  return null;
}

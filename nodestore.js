// Хранилище аккаунтов для Node.js-сервера и проверок: встроенный SQLite (node:sqlite, Node 22+).
// Только для Node — в Cloudflare Worker этот файл не подключается.
import { DatabaseSync } from 'node:sqlite';

// file: путь к файлу базы или ':memory:'
export function nodeStore(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  return {
    db,
    sql: (q, ...a) => db.prepare(q).all(...a),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* нет открытой транзакции */ } throw e; }
    },
    close: () => db.close(),
  };
}

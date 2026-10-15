import { DatabaseSync } from 'node:sqlite';
import { ensureDbLocation } from '../../lib/storage.js';

/**
 * SQLite backend. node:sqlite is synchronous; the methods are async only so
 * both drivers present the same interface to the rest of the app.
 */
export function createSqliteDriver({ file }) {
  ensureDbLocation(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const toPlain = (row) => (row ? { ...row } : row);

  const api = {
    dialect: 'sqlite',
    describe: () => `sqlite:${file}`,

    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map(toPlain);
    },
    async get(sql, params = []) {
      return toPlain(db.prepare(sql).get(...params)) ?? null;
    },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async exec(sql) {
      db.exec(sql);
    },
    async tx(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn(api);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
        throw err;
      }
    },
    async close() {
      db.close();
    }
  };
  return api;
}

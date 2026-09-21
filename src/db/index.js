import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { runMigrations } from './migrations.js';
import { ensureDbLocation } from '../lib/storage.js';

let db = null;

export function getDb() {
  if (db) return db;
  // Fails fast with actionable guidance rather than a bare EACCES from SQLite.
  ensureDbLocation(config.dbFile);
  db = new DatabaseSync(config.dbFile);
  // WAL keeps reads from blocking on writes; foreign keys are off by default in SQLite.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db);
  logger.info('Database ready', { file: config.dbFile });
  return db;
}

export function closeDb() {
  if (!db) return;
  try { db.close(); } catch (err) { logger.warn('Database close failed', { err: err.message }); }
  db = null;
}

export const all = (sql, params = []) => getDb().prepare(sql).all(...params);
export const get = (sql, params = []) => getDb().prepare(sql).get(...params) ?? null;
export const run = (sql, params = []) => getDb().prepare(sql).run(...params);

/** Runs `fn` inside a transaction, rolling back on any throw. */
export function tx(fn) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* connection already unwound */ }
    throw err;
  }
}

/** SQLite returns null-prototype rows; plain objects serialise predictably. */
export const plain = (row) => (row ? { ...row } : row);
export const plainAll = (rows) => rows.map((r) => ({ ...r }));

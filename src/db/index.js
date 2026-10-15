import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { createSqliteDriver } from './drivers/sqlite.js';
import { runMigrations } from './migrations.js';

let driver = null;
let ready = null;

/**
 * Chooses the backend once, on first use: Postgres when DATABASE_URL is set
 * (persistent, for deployment), SQLite otherwise (zero-setup, for local work
 * and tests). Both expose the same async interface.
 */
async function connect() {
  if (config.databaseUrl) {
    const { createPostgresDriver } = await import('./drivers/postgres.js');
    driver = createPostgresDriver({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  } else {
    driver = createSqliteDriver({ file: config.dbFile });
  }
  await runMigrations(driver);
  logger.info('Database ready', { backend: driver.describe() });
  return driver;
}

/** Idempotent: concurrent callers await the same connection attempt. */
export function initDb() {
  if (!ready) {
    ready = connect().catch((err) => {
      ready = null; // let a later attempt retry instead of caching the failure
      throw err;
    });
  }
  return ready;
}

function requireDriver() {
  if (!driver) throw new Error('Database used before initDb() completed');
  return driver;
}

export const all = async (sql, params = []) => (await initDb()).all(sql, params);
export const get = async (sql, params = []) => (await initDb()).get(sql, params);
export const run = async (sql, params = []) => (await initDb()).run(sql, params);
export const exec = async (sql) => (await initDb()).exec(sql);
export const tx = async (fn) => (await initDb()).tx(fn);

export const dialect = () => requireDriver().dialect;

export async function closeDb() {
  if (!driver) return;
  try { await driver.close(); } catch (err) { logger.warn('Database close failed', { err: err.message }); }
  driver = null;
  ready = null;
}

// Both drivers already return plain objects; kept so call sites read unchanged.
export const plain = (row) => row ?? null;
export const plainAll = (rows) => rows;

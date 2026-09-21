import { logger } from '../lib/logger.js';

/**
 * Append-only list. Each entry runs once, inside a transaction, and the applied
 * version is recorded so restarts and upgrades are idempotent.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'core-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          currency      TEXT NOT NULL DEFAULT 'INR',
          locale        TEXT NOT NULL DEFAULT 'en-IN',
          monthly_income_minor INTEGER NOT NULL DEFAULT 0,
          settings_json TEXT NOT NULL DEFAULT '{}',
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE categories (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          icon       TEXT NOT NULL DEFAULT '💸',
          color      TEXT NOT NULL DEFAULT '#6366f1',
          kind       TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
          is_archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (user_id, name)
        );

        CREATE TABLE expenses (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          amount_minor   INTEGER NOT NULL,
          currency       TEXT NOT NULL DEFAULT 'INR',
          fx_rate        REAL NOT NULL DEFAULT 1,
          base_amount_minor INTEGER NOT NULL,
          merchant       TEXT NOT NULL DEFAULT '',
          note           TEXT NOT NULL DEFAULT '',
          payment_method TEXT NOT NULL DEFAULT 'other',
          tags_json      TEXT NOT NULL DEFAULT '[]',
          is_income      INTEGER NOT NULL DEFAULT 0,
          spent_at       TEXT NOT NULL,
          recurring_id   INTEGER,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at     TEXT
        );
        CREATE INDEX idx_expenses_user_date ON expenses(user_id, spent_at DESC);
        CREATE INDEX idx_expenses_user_cat  ON expenses(user_id, category_id);
        CREATE INDEX idx_expenses_live      ON expenses(user_id, deleted_at);

        CREATE TABLE budgets (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          category_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
          amount_minor INTEGER NOT NULL,
          period       TEXT NOT NULL DEFAULT 'monthly',
          rollover     INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (user_id, category_id)
        );

        CREATE TABLE goals (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name         TEXT NOT NULL,
          target_minor INTEGER NOT NULL,
          saved_minor  INTEGER NOT NULL DEFAULT 0,
          target_date  TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE groups (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          currency   TEXT NOT NULL DEFAULT 'INR',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE group_members (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          name     TEXT NOT NULL,
          is_self  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE group_expenses (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          payer_id     INTEGER NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
          description  TEXT NOT NULL,
          amount_minor INTEGER NOT NULL,
          split_mode   TEXT NOT NULL DEFAULT 'equal' CHECK (split_mode IN ('equal','shares','exact')),
          shares_json  TEXT NOT NULL DEFAULT '{}',
          spent_at     TEXT NOT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE settlements (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          from_id      INTEGER NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
          to_id        INTEGER NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
          amount_minor INTEGER NOT NULL,
          settled_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE recurring (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          merchant     TEXT NOT NULL,
          category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          amount_minor INTEGER NOT NULL,
          interval_days INTEGER NOT NULL,
          next_due     TEXT,
          confidence   REAL NOT NULL DEFAULT 0,
          status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ignored','cancelled')),
          last_seen    TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (user_id, merchant, interval_days)
        );

        CREATE TABLE audit_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          action     TEXT NOT NULL,
          entity     TEXT NOT NULL,
          entity_id  INTEGER,
          summary    TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_audit_user ON audit_log(user_id, id DESC);

        CREATE TABLE achievements (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code        TEXT NOT NULL,
          unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (user_id, code)
        );
      `);
    }
  },
  {
    version: 2,
    name: 'category-budget-limits',
    up: (db) => {
      // Soft per-category alert threshold, kept separate from the budget amount
      // so a user can be warned before the envelope is actually empty.
      db.exec(`ALTER TABLE budgets ADD COLUMN alert_at_percent INTEGER NOT NULL DEFAULT 80;`);
    }
  }
];

export function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      db.exec('COMMIT');
      logger.info('Applied migration', { version: migration.version, name: migration.name });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${err.message}`);
    }
  }
}

export const LATEST_VERSION = MIGRATIONS.at(-1).version;

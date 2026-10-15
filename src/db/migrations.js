import { logger } from '../lib/logger.js';
import { renderSchema } from './dialect.js';

/**
 * Append-only migrations. Each entry runs once and the applied version is
 * recorded, so restarts and upgrades are idempotent.
 *
 * SQL is written once using {{TOKENS}} that renderSchema expands per dialect,
 * so SQLite and Postgres stay in step from a single definition.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'core-schema',
    sql: `
      CREATE TABLE users (
        id            {{PK}},
        email         {{TEXT}} NOT NULL UNIQUE,
        name          {{TEXT}} NOT NULL,
        password_hash {{TEXT}} NOT NULL,
        currency      {{TEXT}} NOT NULL DEFAULT 'INR',
        locale        {{TEXT}} NOT NULL DEFAULT 'en-IN',
        monthly_income_minor {{INT}} NOT NULL DEFAULT 0,
        settings_json {{TEXT}} NOT NULL DEFAULT '{}',
        created_at    {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );

      CREATE TABLE categories (
        id         {{PK}},
        user_id    {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       {{TEXT}} NOT NULL,
        icon       {{TEXT}} NOT NULL DEFAULT '💸',
        color      {{TEXT}} NOT NULL DEFAULT '#6366f1',
        kind       {{TEXT}} NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
        is_archived {{INT}} NOT NULL DEFAULT 0,
        created_at {{TEXT}} NOT NULL DEFAULT ({{NOW}}),
        UNIQUE (user_id, name)
      );

      CREATE TABLE expenses (
        id             {{PK}},
        user_id        {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id    {{INT}} REFERENCES categories(id) ON DELETE SET NULL,
        amount_minor   {{INT}} NOT NULL,
        currency       {{TEXT}} NOT NULL DEFAULT 'INR',
        fx_rate        {{REAL}} NOT NULL DEFAULT 1,
        base_amount_minor {{INT}} NOT NULL,
        merchant       {{TEXT}} NOT NULL DEFAULT '',
        note           {{TEXT}} NOT NULL DEFAULT '',
        payment_method {{TEXT}} NOT NULL DEFAULT 'other',
        tags_json      {{TEXT}} NOT NULL DEFAULT '[]',
        is_income      {{INT}} NOT NULL DEFAULT 0,
        spent_at       {{TEXT}} NOT NULL,
        recurring_id   {{INT}},
        created_at     {{TEXT}} NOT NULL DEFAULT ({{NOW}}),
        updated_at     {{TEXT}} NOT NULL DEFAULT ({{NOW}}),
        deleted_at     {{TEXT}}
      );
      CREATE INDEX idx_expenses_user_date ON expenses(user_id, spent_at DESC);
      CREATE INDEX idx_expenses_user_cat  ON expenses(user_id, category_id);
      CREATE INDEX idx_expenses_live      ON expenses(user_id, deleted_at);

      CREATE TABLE budgets (
        id           {{PK}},
        user_id      {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id  {{INT}} REFERENCES categories(id) ON DELETE CASCADE,
        amount_minor {{INT}} NOT NULL,
        period       {{TEXT}} NOT NULL DEFAULT 'monthly',
        rollover     {{INT}} NOT NULL DEFAULT 0,
        created_at   {{TEXT}} NOT NULL DEFAULT ({{NOW}}),
        UNIQUE (user_id, category_id)
      );

      CREATE TABLE goals (
        id           {{PK}},
        user_id      {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         {{TEXT}} NOT NULL,
        target_minor {{INT}} NOT NULL,
        saved_minor  {{INT}} NOT NULL DEFAULT 0,
        target_date  {{TEXT}},
        created_at   {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );

      CREATE TABLE groups (
        id         {{PK}},
        user_id    {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       {{TEXT}} NOT NULL,
        currency   {{TEXT}} NOT NULL DEFAULT 'INR',
        created_at {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );

      CREATE TABLE group_members (
        id       {{PK}},
        group_id {{INT}} NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name     {{TEXT}} NOT NULL,
        is_self  {{INT}} NOT NULL DEFAULT 0
      );

      CREATE TABLE group_expenses (
        id           {{PK}},
        group_id     {{INT}} NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        payer_id     {{INT}} NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
        description  {{TEXT}} NOT NULL,
        amount_minor {{INT}} NOT NULL,
        split_mode   {{TEXT}} NOT NULL DEFAULT 'equal' CHECK (split_mode IN ('equal','shares','exact')),
        shares_json  {{TEXT}} NOT NULL DEFAULT '{}',
        spent_at     {{TEXT}} NOT NULL,
        created_at   {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );

      CREATE TABLE settlements (
        id           {{PK}},
        group_id     {{INT}} NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        from_id      {{INT}} NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
        to_id        {{INT}} NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
        amount_minor {{INT}} NOT NULL,
        settled_at   {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );

      CREATE TABLE recurring (
        id           {{PK}},
        user_id      {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        merchant     {{TEXT}} NOT NULL,
        category_id  {{INT}} REFERENCES categories(id) ON DELETE SET NULL,
        amount_minor {{INT}} NOT NULL,
        interval_days {{INT}} NOT NULL,
        next_due     {{TEXT}},
        confidence   {{REAL}} NOT NULL DEFAULT 0,
        status       {{TEXT}} NOT NULL DEFAULT 'active' CHECK (status IN ('active','ignored','cancelled')),
        last_seen    {{TEXT}},
        created_at   {{TEXT}} NOT NULL DEFAULT ({{NOW}}),
        UNIQUE (user_id, merchant, interval_days)
      );

      CREATE TABLE audit_log (
        id         {{PK}},
        user_id    {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action     {{TEXT}} NOT NULL,
        entity     {{TEXT}} NOT NULL,
        entity_id  {{INT}},
        summary    {{TEXT}} NOT NULL DEFAULT '',
        payload_json {{TEXT}} NOT NULL DEFAULT '{}',
        created_at {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );
      CREATE INDEX idx_audit_user ON audit_log(user_id, id DESC);

      CREATE TABLE achievements (
        id          {{PK}},
        user_id     {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code        {{TEXT}} NOT NULL,
        unlocked_at {{TEXT}} NOT NULL DEFAULT ({{NOW}}),
        UNIQUE (user_id, code)
      );
    `
  },
  {
    version: 2,
    name: 'category-budget-limits',
    sql: `ALTER TABLE budgets ADD COLUMN alert_at_percent {{INT}} NOT NULL DEFAULT 80;`
  },
  {
    version: 3,
    name: 'password-resets',
    // Only the SHA-256 of a reset token is stored: a leaked database must not
    // hand an attacker working reset links.
    sql: `
      CREATE TABLE password_resets (
        id         {{PK}},
        user_id    {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash {{TEXT}} NOT NULL UNIQUE,
        expires_at {{TEXT}} NOT NULL,
        used_at    {{TEXT}},
        created_at {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );
      CREATE INDEX idx_resets_user ON password_resets(user_id);
    `
  },
  {
    version: 4,
    name: 'shared-groups',
    // A member slot may now point at a real account, so other people can sign
    // in and see the same group rather than existing only as a name string.
    sql: `
      ALTER TABLE group_members ADD COLUMN user_id {{INT}} REFERENCES users(id) ON DELETE SET NULL;

      CREATE TABLE group_invites (
        id         {{PK}},
        group_id   {{INT}} NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        token_hash {{TEXT}} NOT NULL UNIQUE,
        created_by {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at {{TEXT}} NOT NULL,
        revoked_at {{TEXT}},
        created_at {{TEXT}} NOT NULL DEFAULT ({{NOW}})
      );
      CREATE INDEX idx_invites_group ON group_invites(group_id);
    `
  },
  {
    version: 5,
    name: 'offline-idempotency',
    // The offline queue retries writes. A client-generated id makes a replayed
    // request land on the same row instead of creating a duplicate expense.
    sql: `
      ALTER TABLE expenses ADD COLUMN client_uuid {{TEXT}};
      CREATE UNIQUE INDEX idx_expenses_client_uuid ON expenses(user_id, client_uuid);
    `
  }
];

/** Splits a multi-statement script, ignoring semicolons inside string literals. */
function splitStatements(script) {
  const out = [];
  let current = '';
  let quote = null;
  for (const ch of script) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';') { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export async function runMigrations(driver) {
  await driver.exec(renderSchema(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         {{PK}},
    version    {{INT}} NOT NULL UNIQUE,
    name       {{TEXT}} NOT NULL,
    applied_at {{TEXT}} NOT NULL DEFAULT ({{NOW}})
  );`, driver.dialect));

  const rows = await driver.all('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const statements = splitStatements(renderSchema(migration.sql, driver.dialect));
    try {
      await driver.tx(async (t) => {
        for (const statement of statements) await t.exec(statement);
        await t.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [migration.version, migration.name]);
      });
      logger.info('Applied migration', { version: migration.version, name: migration.name });
    } catch (err) {
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${err.message}`);
    }
  }
}

export const LATEST_VERSION = MIGRATIONS.at(-1).version;

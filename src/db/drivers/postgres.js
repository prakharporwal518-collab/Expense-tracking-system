import pg from 'pg';
import { toPostgres, withReturningId } from '../dialect.js';

// Postgres returns BIGINT (int8) and NUMERIC as strings to avoid precision loss.
// Every such value here is a money amount in minor units or a row count, all of
// which sit far inside Number.MAX_SAFE_INTEGER, so parse them as numbers —
// otherwise sums arrive as "12345" and silently concatenate instead of adding.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

/** Postgres backend, used whenever DATABASE_URL is set. */
export function createPostgresDriver({ connectionString, ssl }) {
  const pool = new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  // A pool error with no listener crashes the process on a dropped connection.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[db] idle postgres client error:', err.message);
  });

  const bind = (runner) => ({
    dialect: 'postgres',
    describe: () => 'postgres',

    async all(sql, params = []) {
      const res = await runner.query(toPostgres(sql), params);
      return res.rows;
    },
    async get(sql, params = []) {
      const res = await runner.query(toPostgres(sql), params);
      return res.rows[0] ?? null;
    },
    async run(sql, params = []) {
      const { sql: withReturn, returnsId } = withReturningId(sql);
      const res = await runner.query(toPostgres(withReturn), params);
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: returnsId ? (res.rows[0]?.id ?? null) : null
      };
    },
    async exec(sql) {
      await runner.query(toPostgres(sql));
    }
  });

  const api = {
    ...bind(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const scoped = { ...bind(client), tx: async (inner) => inner(scoped) };
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
  return api;
}

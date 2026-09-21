import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before config.js is first imported.
const tmpDb = path.join(os.tmpdir(), `fintrack-seed-${process.pid}.db`);
process.env.DB_FILE = tmpDb;
process.env.JWT_SECRET = 'test-secret-that-is-long-enough';

const { seed } = await import('../src/db/seed.js');
const { get, closeDb } = await import('../src/db/index.js');

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* may not exist */ }
  }
});

const count = (table) => get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;

test('seeding an empty database creates the demo account and history', () => {
  seed({ reset: false });
  assert.equal(count('users'), 1);
  assert.ok(count('expenses') > 400, `expected a full history, got ${count('expenses')}`);
});

// Regression: hosts with ephemeral storage restart often. Seeding on boot must
// never duplicate data or overwrite a database that already holds accounts.
test('seeding again with reset:false leaves existing data untouched', () => {
  const usersBefore = count('users');
  const expensesBefore = count('expenses');

  seed({ reset: false });
  seed({ reset: false });

  assert.equal(count('users'), usersBefore, 'must not create a second demo account');
  assert.equal(count('expenses'), expensesBefore, 'must not duplicate expenses');
});

test('SEED_DEMO is strictly opt-in', async () => {
  const cases = [
    [undefined, false], ['', false], ['false', false], ['0', false], ['no', false],
    ['true', true], ['TRUE', true], ['1', true], ['yes', true]
  ];
  for (const [value, expected] of cases) {
    const parsed = /^(1|true|yes)$/i.test(value || '');
    assert.equal(parsed, expected, `SEED_DEMO=${JSON.stringify(value)} should be ${expected}`);
  }
});

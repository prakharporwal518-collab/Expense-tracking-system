import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Point the app at a throwaway database BEFORE any module reads the config.
const tmpDb = path.join(os.tmpdir(), `fintrack-test-${process.pid}.db`);
process.env.DB_FILE = tmpDb;
process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.RATE_MAX = '10000';
process.env.RATE_AUTH_MAX = '10000';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db/index.js');

let server;
let base;
let token;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* may not exist */ }
  }
});

async function call(method, urlPath, body, useToken = true) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token && useToken) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

test('health endpoint reports schema state', async () => {
  const r = await call('GET', '/api/health', undefined, false);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.database, 'up');
  assert.equal(r.json.schemaVersion, r.json.expectedSchemaVersion);
});

test('registration creates an account with starter categories', async () => {
  const r = await call('POST', '/api/auth/register',
    { name: 'Test User', email: 'test@example.com', password: 'Str0ng!Pass', monthlyIncome: 50000 }, false);
  assert.equal(r.status, 201);
  assert.ok(r.json.token);
  token = r.json.token;

  const cats = await call('GET', '/api/categories');
  assert.ok(cats.json.categories.length > 10, 'default categories should be seeded');
});

test('duplicate email is rejected', async () => {
  const r = await call('POST', '/api/auth/register',
    { name: 'Other', email: 'test@example.com', password: 'Str0ng!Pass' }, false);
  assert.equal(r.status, 409);
});

test('weak password is rejected with guidance', async () => {
  const r = await call('POST', '/api/auth/register',
    { name: 'Weak', email: 'weak@example.com', password: 'aaaaaaaa' }, false);
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.json.error.details));
});

test('login is rejected for a wrong password and a missing account alike', async () => {
  const wrong = await call('POST', '/api/auth/login', { email: 'test@example.com', password: 'nope' }, false);
  const missing = await call('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'nope' }, false);
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  // Identical wording so the response never reveals which emails are registered.
  assert.equal(wrong.json.error.message, missing.json.error.message);
});

test('protected routes require a valid token', async () => {
  const none = await call('GET', '/api/expenses', undefined, false);
  assert.equal(none.status, 401);

  const forged = await fetch(base + '/api/expenses', { headers: { authorization: 'Bearer aaa.bbb.ccc' } });
  assert.equal(forged.status, 401);

  // A token with a valid body but a tampered signature must not be accepted.
  const [h, p] = token.split('.');
  const tampered = await fetch(base + '/api/expenses', { headers: { authorization: `Bearer ${h}.${p}.wrongsignature` } });
  assert.equal(tampered.status, 401);
});

test('expense lifecycle: create, edit, soft delete, restore', async () => {
  const created = await call('POST', '/api/expenses', { amount: 299.99, merchant: 'Test Cafe', category: 'Food' });
  assert.equal(created.status, 201);
  assert.equal(created.json.expense.amountMinor, 29999);
  const id = created.json.expense.id;

  const edited = await call('PATCH', `/api/expenses/${id}`, { amount: 350 });
  assert.equal(edited.json.expense.amountMinor, 35000);

  const deleted = await call('DELETE', `/api/expenses/${id}`);
  assert.equal(deleted.status, 200);

  const afterDelete = await call('GET', '/api/expenses');
  assert.ok(!afterDelete.json.expenses.some((e) => e.id === id), 'soft-deleted row is hidden from the list');

  const restored = await call('POST', `/api/expenses/${id}/restore`);
  assert.equal(restored.json.expense.deletedAt, null);
});

test('invalid expense input is rejected', async () => {
  assert.equal((await call('POST', '/api/expenses', { amount: -1 })).status, 422);
  assert.equal((await call('POST', '/api/expenses', { amount: 'abc' })).status, 422);
  assert.equal((await call('POST', '/api/expenses', {})).status, 422);
  assert.equal((await call('POST', '/api/expenses', { amount: 10, paymentMethod: 'bitcoin' })).status, 422);
});

test('a user cannot attach another account\'s category', async () => {
  const other = await call('POST', '/api/auth/register',
    { name: 'Mallory', email: 'mallory@example.com', password: 'Str0ng!Pass' }, false);
  const otherToken = other.json.token;

  const otherCats = await fetch(base + '/api/categories', { headers: { authorization: `Bearer ${otherToken}` } });
  const otherCatId = (await otherCats.json()).categories[0].id;

  const attempt = await call('POST', '/api/expenses', { amount: 100, categoryId: otherCatId });
  assert.equal(attempt.status, 400, 'cross-account category must be refused');
});

test('one user cannot read another user\'s expenses', async () => {
  const other = await call('POST', '/api/auth/register',
    { name: 'Eve', email: 'eve@example.com', password: 'Str0ng!Pass' }, false);
  const res = await fetch(base + '/api/expenses', { headers: { authorization: `Bearer ${other.json.token}` } });
  const body = await res.json();
  assert.equal(body.expenses.length, 0, 'a new account must not see anyone else\'s data');
});

test('malformed JSON returns a clean 400', async () => {
  const res = await fetch(base + '/api/expenses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{not json'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'BAD_JSON');
});

test('unknown API routes return JSON, not HTML', async () => {
  const r = await call('GET', '/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'NOT_FOUND');
});

test('server errors never leak internals in the message', async () => {
  const r = await call('GET', '/api/expenses/not-a-number');
  assert.equal(r.status, 400);
  assert.ok(!/SQLITE|stack|node_modules/i.test(JSON.stringify(r.json.error.message)));
});

test('budgets upsert rather than duplicating', async () => {
  const cats = await call('GET', '/api/categories');
  const food = cats.json.categories.find((c) => c.name === 'Food');

  await call('POST', '/api/budgets', { categoryId: food.id, amount: 5000 });
  await call('POST', '/api/budgets', { categoryId: food.id, amount: 8000 });

  const list = await call('GET', '/api/budgets');
  const matching = list.json.budgets.filter((b) => b.categoryId === food.id);
  assert.equal(matching.length, 1, 'setting the same category twice must not create two budgets');
  assert.equal(matching[0].amountMinor, 800000);
});

test('group split validation rejects inconsistent input', async () => {
  const group = await call('POST', '/api/groups', { name: 'Trip', members: ['Me', 'You', 'Them'] });
  assert.equal(group.status, 201);
  const detail = await call('GET', `/api/groups/${group.json.group.id}`);
  const ids = detail.json.members.map((m) => m.id);

  const badPayer = await call('POST', `/api/groups/${group.json.group.id}/expenses`,
    { description: 'x', amount: 100, payerId: 999999 });
  assert.equal(badPayer.status, 400);

  const badExact = await call('POST', `/api/groups/${group.json.group.id}/expenses`,
    { description: 'x', amount: 100, payerId: ids[0], splitMode: 'exact', shares: { [ids[0]]: 10 } });
  assert.equal(badExact.status, 400);

  const ok = await call('POST', `/api/groups/${group.json.group.id}/expenses`,
    { description: 'Dinner', amount: 300, payerId: ids[0] });
  assert.equal(ok.status, 201);

  const after = await call('GET', `/api/groups/${group.json.group.id}`);
  assert.equal(after.json.balances.reduce((a, b) => a + b.net_minor, 0), 0);
  assert.ok(after.json.transferCount <= ids.length - 1);
});

test('a group needs at least two members', async () => {
  const r = await call('POST', '/api/groups', { name: 'Solo', members: ['Me'] });
  assert.equal(r.status, 400);
});

test('CSV import skips bad rows and reports them', async () => {
  const csv = [
    'Date,Amount,Category,Merchant',
    '2026-09-10,250.75,Food,Chai Point',
    '15/09/2026,1200,Transport,Uber',
    'garbage,abc,,',
    '2026-09-12,999.99,,Netflix'
  ].join('\n');

  const dry = await call('POST', '/api/io/import/csv', { csv, dryRun: true });
  assert.equal(dry.json.wouldImport, 3);
  assert.equal(dry.json.skipped, 1);
  assert.ok(dry.json.preview.some((p) => p.spentAt.startsWith('2026-09-15')), 'dd/mm/yyyy should parse');

  const real = await call('POST', '/api/io/import/csv', { csv });
  assert.equal(real.status, 201);
  assert.equal(real.json.imported, 3);
});

test('CSV import rejects a file with no amount column', async () => {
  const r = await call('POST', '/api/io/import/csv', { csv: 'Foo,Bar\n1,2' });
  assert.equal(r.status, 400);
});

test('analytics endpoints answer for a sparse account', async () => {
  for (const p of ['/api/analytics/summary', '/api/analytics/insights', '/api/analytics/anomalies',
                   '/api/analytics/recurring', '/api/analytics/duplicates', '/api/analytics/forecast',
                   '/api/analytics/heatmap', '/api/analytics/achievements']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, `${p} returned ${r.status}`);
  }
});

test('natural-language parse endpoint blends keywords with the personal model', async () => {
  const r = await call('POST', '/api/expenses/parse', { text: '450 dinner at dominos yesterday upi' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.fields.amountMinor, 45000);
  assert.equal(r.json.fields.merchant, 'Dominos');
});

test('security headers are present', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy')?.includes("default-src 'self'"));
  assert.equal(res.headers.get('x-powered-by'), null, 'framework fingerprint should be hidden');
});

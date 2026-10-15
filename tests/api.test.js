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

/* ---------------- Password reset ---------------- */

test('forgot-password cannot be used to discover which emails exist', async () => {
  const known = await call('POST', '/api/auth/forgot-password', { email: 'test@example.com' }, false);
  const unknown = await call('POST', '/api/auth/forgot-password', { email: 'ghost@nowhere.test' }, false);
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.json.message, unknown.json.message, 'both answers must be identical');
});

test('a reset link works once, then never again', async () => {
  const req = await call('POST', '/api/auth/forgot-password', { email: 'test@example.com' }, false);
  const link = req.json.devResetLink;
  assert.ok(link, 'dev link should be returned when no mail provider is set');
  const token = new URL(link).searchParams.get('token');

  const preview = await call('GET', `/api/auth/reset-password/${token}`, undefined, false);
  assert.equal(preview.json.valid, true);
  assert.ok(preview.json.email.includes('•'), 'preview email must be masked');

  const weak = await call('POST', '/api/auth/reset-password', { token, password: 'aaaaaaaa' }, false);
  assert.equal(weak.status, 400, 'a weak new password must still be refused');

  const done = await call('POST', '/api/auth/reset-password', { token, password: 'Rotated@2026x' }, false);
  assert.equal(done.status, 200);
  assert.ok(done.json.token, 'a fresh session should be issued');

  const replay = await call('POST', '/api/auth/reset-password', { token, password: 'Another@2026x' }, false);
  assert.equal(replay.status, 400, 'the token must be single-use');

  const login = await call('POST', '/api/auth/login', { email: 'test@example.com', password: 'Rotated@2026x' }, false);
  assert.equal(login.status, 200);
  token_after_reset = login.json.token;
});

let token_after_reset = null;

test('resetting a password invalidates sessions issued before it', async () => {
  const email = `revoke${Date.now()}@example.com`;
  const created = await call('POST', '/api/auth/register', { name: 'Revoke', email, password: 'Str0ng!Pass1' }, false);
  const oldSession = created.json.token;

  const before = await fetch(base + '/api/expenses', { headers: { authorization: `Bearer ${oldSession}` } });
  assert.equal(before.status, 200, 'session should work before the reset');

  // JWT iat has one-second resolution, so the reset must land in a later second.
  await new Promise((r) => setTimeout(r, 1100));
  const link = (await call('POST', '/api/auth/forgot-password', { email }, false)).json.devResetLink;
  const resetToken = new URL(link).searchParams.get('token');
  await call('POST', '/api/auth/reset-password', { token: resetToken, password: 'Replaced@2026x' }, false);

  const after = await fetch(base + '/api/expenses', { headers: { authorization: `Bearer ${oldSession}` } });
  assert.equal(after.status, 401, 'the pre-reset session must stop working');
});

test('an invalid reset token reports invalid rather than erroring', async () => {
  const r = await call('GET', '/api/auth/reset-password/not-a-real-token', undefined, false);
  assert.equal(r.status, 200);
  assert.equal(r.json.valid, false);
  assert.equal(r.json.reason, 'unknown');
});

/* ---------------- Shared groups ---------------- */

test('a group can be shared with another account by invite link', async () => {
  const owner = (await call('POST', '/api/auth/register',
    { name: 'Owner', email: `own${Date.now()}@example.com`, password: 'Str0ng!Pass1' }, false)).json.token;
  const guest = (await call('POST', '/api/auth/register',
    { name: 'Guest', email: `guest${Date.now()}@example.com`, password: 'Str0ng!Pass1' }, false)).json.token;

  const as = async (tok, method, path, body) => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${tok}` };
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const group = await as(owner, 'POST', '/api/groups', { name: 'Trip', members: ['Owner', 'Guest', 'Riya'] });
  const gid = group.json.group.id;

  assert.equal((await as(guest, 'GET', `/api/groups/${gid}`)).status, 404,
    'a stranger must not even learn the group exists');
  assert.equal((await as(guest, 'POST', `/api/groups/${gid}/invite`, {})).status, 404,
    'only the owner may issue invites');

  const invite = await as(owner, 'POST', `/api/groups/${gid}/invite`, {});
  assert.equal(invite.status, 201);
  const token = invite.json.token;

  const preview = await as(guest, 'GET', `/api/groups/invite/${token}`);
  assert.equal(preview.json.valid, true);
  const slot = preview.json.openSlots.find((s) => s.name === 'Guest');
  assert.ok(slot, 'unclaimed names should be offered as slots');

  const joined = await as(guest, 'POST', `/api/groups/invite/${token}/accept`, { memberId: slot.id });
  assert.equal(joined.status, 201);

  const seen = await as(guest, 'GET', `/api/groups/${gid}`);
  assert.equal(seen.status, 200, 'the guest can now read the group');
  assert.equal(seen.json.role, 'member');
  assert.equal(seen.json.members.find((m) => m.name === 'Guest').isSelf, true,
    '"you" must be the slot this account holds');
  assert.equal(seen.json.members.find((m) => m.name === 'Owner').isSelf, false);

  const added = await as(guest, 'POST', `/api/groups/${gid}/expenses`,
    { description: 'Dinner', amount: 1200, payerId: slot.id });
  assert.equal(added.status, 201, 'members may add shared expenses');

  const ownerView = await as(owner, 'GET', `/api/groups/${gid}`);
  assert.ok(ownerView.json.expenses.some((e) => e.description === 'Dinner'));
  assert.equal(ownerView.json.balances.reduce((a, b) => a + b.net_minor, 0), 0);

  assert.equal((await as(guest, 'DELETE', `/api/groups/${gid}`)).status, 404,
    'a member must not be able to delete the group');

  // A second person cannot take a slot that is already claimed.
  const third = (await call('POST', '/api/auth/register',
    { name: 'Third', email: `third${Date.now()}@example.com`, password: 'Str0ng!Pass1' }, false)).json.token;
  assert.equal((await as(third, 'POST', `/api/groups/invite/${token}/accept`, { memberId: slot.id })).status, 409);

  await as(owner, 'DELETE', `/api/groups/${gid}/invite`);
  assert.equal((await as(third, 'GET', `/api/groups/invite/${token}`)).json.reason, 'revoked');
});

/* ---------------- Offline idempotency ---------------- */

/**
 * These run after the password-reset tests, which deliberately invalidate the
 * shared session, so they work against an account of their own.
 */
async function freshAccount() {
  const email = `idem${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await call('POST', '/api/auth/register', { name: 'Idem', email, password: 'Str0ng!Pass1' }, false);
  const tok = res.json.token;
  return async (method, path, body) => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${tok}` };
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}

test('replaying a queued write does not create a second expense', async () => {
  // The offline outbox retries on reconnect; a retry whose first attempt
  // actually succeeded must land on the same row, not duplicate it.
  const clientUuid = `offline-${Date.now()}-abcdef`;
  const payload = { amount: 123.45, merchant: 'Replay Cafe', clientUuid };

  const as = await freshAccount();
  const first = await as('POST', '/api/expenses', payload);
  assert.equal(first.status, 201);
  assert.notEqual(first.json.replayed, true);

  const second = await as('POST', '/api/expenses', payload);
  assert.equal(second.status, 200, 'a replay should be accepted, not rejected');
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.expense.id, first.json.expense.id, 'the same row must come back');

  const found = await as('GET', '/api/expenses?search=Replay%20Cafe');
  assert.equal(found.json.expenses.length, 1, 'exactly one row should exist');
});

test('two different queued writes both land', async () => {
  const as = await freshAccount();
  const stamp = Date.now();
  const a = await as('POST', '/api/expenses', { amount: 10, merchant: 'Distinct Shop', clientUuid: `q-${stamp}-aaaaaa` });
  const b = await as('POST', '/api/expenses', { amount: 20, merchant: 'Distinct Shop', clientUuid: `q-${stamp}-bbbbbb` });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.json.expense.id, b.json.expense.id);
});

test('a malformed client id is rejected rather than stored', async () => {
  const as = await freshAccount();
  const r = await as('POST', '/api/expenses', { amount: 5, clientUuid: 'has spaces and $ymbols!' });
  assert.equal(r.status, 422);
});

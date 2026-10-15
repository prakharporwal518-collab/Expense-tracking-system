import express from 'express';
import { validate, EMAIL_RE } from '../lib/validate.js';
import { hashPassword, verifyPassword, passwordStrength } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { get, run, plain, tx } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { sendMail, baseUrl, resetEmail } from '../lib/mailer.js';
import { AppError, unauthorized, badRequest } from '../lib/errors.js';
import { DEFAULT_CATEGORIES } from '../db/defaults.js';
import { audit } from '../services/store.js';

export const authRouter = express.Router();

const authLimiter = createRateLimiter({ max: config.rateLimit.authMax, windowMs: config.rateLimit.windowMs });

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, currency: u.currency,
  locale: u.locale, monthlyIncomeMinor: u.monthly_income_minor,
  settings: safeJson(u.settings_json)
});

function safeJson(str, fallback = {}) {
  try { return JSON.parse(str) ?? fallback; } catch { return fallback; }
}

function setAuthCookie(res, token) {
  const parts = [
    `token=${encodeURIComponent(token)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${config.tokenTtlSeconds}`
  ];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

authRouter.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, min: 2, max: 60 },
    email: { type: 'string', required: true, max: 160, pattern: EMAIL_RE, message: 'email must be a valid address' },
    password: { type: 'string', required: true, min: 8, max: 200, trim: false },
    currency: { type: 'string', max: 3, min: 3, default: config.defaultCurrency },
    monthlyIncome: { type: 'number', min: 0, max: 1e9, default: 0 }
  });

  const email = body.email.toLowerCase();
  const { score, tips } = passwordStrength(body.password);
  if (score < 2) throw badRequest('Please choose a stronger password', tips);

  const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) throw new AppError('An account with this email already exists', { status: 409, code: 'EMAIL_TAKEN' });

  const passwordHash = await hashPassword(body.password);

  const userId = await tx(async () => {
    const result = await run(
      `INSERT INTO users (email, name, password_hash, currency, monthly_income_minor)
       VALUES (?, ?, ?, ?, ?)`,
      [email, body.name, passwordHash, body.currency.toUpperCase(), Math.round(body.monthlyIncome * 100)]
    );
    const id = Number(result.lastInsertRowid);
    // Seed a sensible starter set so the app is usable from the first second.
    for (const c of DEFAULT_CATEGORIES) {
      await run('INSERT INTO categories (user_id, name, icon, color, kind) VALUES (?, ?, ?, ?, ?)',
        [id, c.name, c.icon, c.color, c.kind]);
    }
    await run('INSERT INTO audit_log (user_id, action, entity, entity_id, summary) VALUES (?,?,?,?,?)',
      [id, 'create', 'user', id, 'Account created']);
    return id;
  });

  const user = plain(await get('SELECT * FROM users WHERE id = ?', [userId]));
  const token = signToken({ sub: userId, email });
  setAuthCookie(res, token);
  res.status(201).json({ token, user: publicUser(user) });
}));

authRouter.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    email: { type: 'string', required: true, max: 160 },
    password: { type: 'string', required: true, max: 200, trim: false }
  });

  const user = plain(await get('SELECT * FROM users WHERE email = ?', [body.email.toLowerCase()]));
  // Always run a verification so a missing account and a wrong password take
  // comparable time — otherwise response timing leaks which emails exist.
  const ok = user
    ? await verifyPassword(body.password, user.password_hash)
    : await verifyPassword(body.password, 'scrypt$16384$8$1$00$00');
  if (!user || !ok) throw unauthorized('Email or password is incorrect');

  const token = signToken({ sub: user.id, email: user.email });
  setAuthCookie(res, token);
  res.json({ token, user: publicUser(user) });
}));

authRouter.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

authRouter.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', min: 2, max: 60 },
    currency: { type: 'string', min: 3, max: 3 },
    locale: { type: 'string', min: 2, max: 12 },
    monthlyIncome: { type: 'number', min: 0, max: 1e9 },
    settings: { type: 'object' }
  });

  const fields = [];
  const params = [];
  if (body.name !== undefined) { fields.push('name = ?'); params.push(body.name); }
  if (body.currency !== undefined) { fields.push('currency = ?'); params.push(body.currency.toUpperCase()); }
  if (body.locale !== undefined) { fields.push('locale = ?'); params.push(body.locale); }
  if (body.monthlyIncome !== undefined) { fields.push('monthly_income_minor = ?'); params.push(Math.round(body.monthlyIncome * 100)); }
  if (body.settings !== undefined) { fields.push('settings_json = ?'); params.push(JSON.stringify(body.settings).slice(0, 4000)); }
  if (!fields.length) throw badRequest('Nothing to update');

  params.push(req.user.id);
  await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  const user = plain(await get('SELECT * FROM users WHERE id = ?', [req.user.id]));
  res.json({ user: publicUser(user) });
}));

authRouter.post('/password-strength', (req, res) => {
  res.json(passwordStrength(req.body?.password || ''));
});

/* ------------------------------------------------------------------ */
/* Password reset                                                      */
/* ------------------------------------------------------------------ */

const RESET_TTL_MINUTES = 60;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Always answers the same way whether or not the address is registered.
 * Saying "no such account" would turn this endpoint into a way to discover
 * which emails have accounts here.
 */
authRouter.post('/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, { email: { type: 'string', required: true, max: 160 } });
  const neutral = { ok: true, message: 'If that email is registered, a reset link is on its way.' };

  const user = await get('SELECT id, email, name FROM users WHERE email = ?', [body.email.toLowerCase()]);
  if (!user) return res.json(neutral);

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString();

  // Outstanding links for this account stop working as soon as a new one is issued.
  await run("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
    [new Date().toISOString(), user.id]);
  await run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)',
    [user.id, hashToken(token), expiresAt]);

  const link = `${baseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
  const mail = resetEmail({ name: user.name, link, minutes: RESET_TTL_MINUTES });
  const result = await sendMail({ to: user.email, ...mail });

  await audit(user.id, 'request', 'password_reset', user.id, 'Password reset requested');

  // With no mail provider the operator cannot receive the link any other way,
  // so hand it back directly — but never once the app is running in production.
  if (!result.delivered && !config.isProd) {
    return res.json({ ...neutral, devResetLink: link, note: 'Email is not configured, so the link is returned here in development only.' });
  }
  res.json(neutral);
}));

/** Lets the UI show a friendly "expired link" page instead of a failed submit. */
authRouter.get('/reset-password/:token', asyncHandler(async (req, res) => {
  const row = await get(
    `SELECT pr.id, pr.expires_at, pr.used_at, u.email FROM password_resets pr
     JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ?`,
    [hashToken(String(req.params.token || ''))]
  );
  const valid = Boolean(row) && !row.used_at && new Date(row.expires_at) > new Date();
  res.json({
    valid,
    reason: !row ? 'unknown' : row.used_at ? 'used' : new Date(row.expires_at) <= new Date() ? 'expired' : null,
    email: valid ? row.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null
  });
}));

authRouter.post('/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    token: { type: 'string', required: true, min: 10, max: 200 },
    password: { type: 'string', required: true, min: 8, max: 200, trim: false }
  });

  const row = await get('SELECT * FROM password_resets WHERE token_hash = ?', [hashToken(body.token)]);
  if (!row) throw badRequest('That reset link is not valid. Request a new one.');
  if (row.used_at) throw badRequest('That reset link has already been used. Request a new one.');
  if (new Date(row.expires_at) <= new Date()) throw badRequest('That reset link has expired. Request a new one.');

  const { score, tips } = passwordStrength(body.password);
  if (score < 2) throw badRequest('Please choose a stronger password', tips);

  const user = await get('SELECT id, email, name, currency, locale, monthly_income_minor, settings_json FROM users WHERE id = ?', [row.user_id]);
  if (!user) throw badRequest('That account no longer exists.');

  const passwordHash = await hashPassword(body.password);
  const now = new Date().toISOString();

  await tx(async (t) => {
    await t.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [passwordHash, now, user.id]);
    // Burn every outstanding link, not just this one.
    await t.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [now, user.id]);
  });

  await audit(user.id, 'update', 'password', user.id, 'Password reset completed');

  // Sessions issued before the change are refused by requireAuth, so sign the
  // user in with a fresh token rather than leaving them logged out.
  const token = signToken({ sub: user.id, email: user.email });
  setAuthCookie(res, token);
  res.json({ ok: true, token, user: publicUser(user) });
}));

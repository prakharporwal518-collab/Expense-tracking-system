import express from 'express';
import { validate, EMAIL_RE } from '../lib/validate.js';
import { hashPassword, verifyPassword, passwordStrength } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { get, run, plain, tx } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { AppError, unauthorized, badRequest } from '../lib/errors.js';
import { DEFAULT_CATEGORIES } from '../db/defaults.js';

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

  const existing = get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) throw new AppError('An account with this email already exists', { status: 409, code: 'EMAIL_TAKEN' });

  const passwordHash = await hashPassword(body.password);

  const userId = tx(() => {
    const result = run(
      `INSERT INTO users (email, name, password_hash, currency, monthly_income_minor)
       VALUES (?, ?, ?, ?, ?)`,
      [email, body.name, passwordHash, body.currency.toUpperCase(), Math.round(body.monthlyIncome * 100)]
    );
    const id = Number(result.lastInsertRowid);
    // Seed a sensible starter set so the app is usable from the first second.
    for (const c of DEFAULT_CATEGORIES) {
      run('INSERT INTO categories (user_id, name, icon, color, kind) VALUES (?, ?, ?, ?, ?)',
        [id, c.name, c.icon, c.color, c.kind]);
    }
    run('INSERT INTO audit_log (user_id, action, entity, entity_id, summary) VALUES (?,?,?,?,?)',
      [id, 'create', 'user', id, 'Account created']);
    return id;
  });

  const user = plain(get('SELECT * FROM users WHERE id = ?', [userId]));
  const token = signToken({ sub: userId, email });
  setAuthCookie(res, token);
  res.status(201).json({ token, user: publicUser(user) });
}));

authRouter.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    email: { type: 'string', required: true, max: 160 },
    password: { type: 'string', required: true, max: 200, trim: false }
  });

  const user = plain(get('SELECT * FROM users WHERE email = ?', [body.email.toLowerCase()]));
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
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  const user = plain(get('SELECT * FROM users WHERE id = ?', [req.user.id]));
  res.json({ user: publicUser(user) });
}));

authRouter.post('/password-strength', (req, res) => {
  res.json(passwordStrength(req.body?.password || ''));
});

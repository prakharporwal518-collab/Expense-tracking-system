import { verifyToken } from '../lib/jwt.js';
import { unauthorized } from '../lib/errors.js';
import { get, plain } from '../db/index.js';

function extractToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.cookies?.token) return req.cookies.token;
  return null;
}

export function requireAuth(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized('Please sign in to continue');
    const payload = verifyToken(token);
    const user = get('SELECT id, email, name, currency, locale, monthly_income_minor, settings_json FROM users WHERE id = ?', [payload.sub]);
    if (!user) throw unauthorized('Account no longer exists');
    req.user = plain(user);
    next();
  } catch (err) {
    next(err);
  }
}

/** Tiny cookie parser — avoids a dependency for the one cookie we set. */
export function cookieParser(req, _res, next) {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      try { req.cookies[k] = decodeURIComponent(v); } catch { req.cookies[k] = v; }
    }
  }
  next();
}

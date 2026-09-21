import crypto from 'node:crypto';
import { config } from '../config.js';
import { unauthorized } from './errors.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, ttlSeconds = config.tokenTtlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') throw unauthorized('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');
  const [header, claims, sig] = parts;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${claims}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw unauthorized('Invalid token signature');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('Malformed token payload');
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw unauthorized('Session expired, please sign in again');
  }
  return payload;
}

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(plain, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scrypt(plain, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Returns 0-4 plus concrete advice, mirroring what the UI meter shows. */
export function passwordStrength(plain) {
  const s = String(plain || '');
  const tips = [];
  let score = 0;
  if (s.length >= 8) score++; else tips.push('use at least 8 characters');
  if (s.length >= 12) score++; else if (s.length >= 8) tips.push('12+ characters is much stronger');
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++; else tips.push('mix upper and lower case');
  if (/\d/.test(s)) score++; else tips.push('add a digit');
  if (/[^A-Za-z0-9]/.test(s)) score++; else tips.push('add a symbol');
  return { score: Math.min(4, score), tips };
}

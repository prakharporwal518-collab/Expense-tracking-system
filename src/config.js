import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
readDotEnv();

const isProd = process.env.NODE_ENV === 'production';

/**
 * A missing JWT secret in production is a hard failure: silently generating one
 * would invalidate every session on restart and hide a real misconfiguration.
 */
function resolveSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (isProd) {
    throw new Error('JWT_SECRET must be set (>=16 chars) when NODE_ENV=production');
  }
  const cacheFile = path.join(ROOT, 'data', '.dev-secret');
  try {
    if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8').trim();
    const generated = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(48).toString('hex');
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'fintrack.db'),
  // Postgres when DATABASE_URL is present (persistent), SQLite otherwise.
  databaseUrl: process.env.DATABASE_URL || null,
  databaseSsl: !/^(0|false|no)$/i.test(process.env.DATABASE_SSL || (process.env.DATABASE_URL?.includes('localhost') || process.env.DATABASE_URL?.includes('127.0.0.1') ? 'false' : 'true')),
  appUrl: process.env.APP_URL || null,
  resendApiKey: process.env.RESEND_API_KEY || null,
  mailFrom: process.env.MAIL_FROM || 'FinTrack <onboarding@resend.dev>',
  jwtSecret: resolveSecret(),
  tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 24 * 7),
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'INR',
  rateLimit: {
    windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_MAX || 300),
    authMax: Number(process.env.RATE_AUTH_MAX || 20)
  },
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  // Seeds demo data on boot, but only into a database with no accounts. Hosts
  // with ephemeral storage wipe the disk on every deploy, and their shell is
  // often a paid feature, so there is otherwise no way to populate a demo.
  seedDemo: /^(1|true|yes)$/i.test(process.env.SEED_DEMO || '')
};

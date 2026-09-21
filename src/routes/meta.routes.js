import express from 'express';
import { get } from '../db/index.js';
import { config } from '../config.js';
import { LATEST_VERSION } from '../db/migrations.js';
import { PAYMENT_METHODS, ACHIEVEMENTS } from '../db/defaults.js';

export const metaRouter = express.Router();

const startedAt = Date.now();

metaRouter.get('/health', (_req, res) => {
  // A health check that does not touch the database is not a health check.
  let database = 'down';
  let schemaVersion = null;
  try {
    const row = get('SELECT MAX(version) AS v FROM schema_migrations');
    schemaVersion = row?.v ?? null;
    database = 'up';
  } catch {
    database = 'down';
  }
  const healthy = database === 'up' && schemaVersion === LATEST_VERSION;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    database,
    schemaVersion,
    expectedSchemaVersion: LATEST_VERSION,
    env: config.env,
    timestamp: new Date().toISOString()
  });
});

metaRouter.get('/meta', (_req, res) => {
  res.json({
    paymentMethods: PAYMENT_METHODS,
    achievements: ACHIEVEMENTS,
    defaultCurrency: config.defaultCurrency,
    currencies: ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD', 'AED']
  });
});

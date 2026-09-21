import express from 'express';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { requestId } from './middleware/requestId.js';
import { securityHeaders } from './middleware/security.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { cookieParser, requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';

import { authRouter } from './routes/auth.routes.js';
import { expenseRouter } from './routes/expense.routes.js';
import { categoryRouter } from './routes/category.routes.js';
import { budgetRouter } from './routes/budget.routes.js';
import { goalRouter } from './routes/goal.routes.js';
import { groupRouter } from './routes/group.routes.js';
import { analyticsRouter } from './routes/analytics.routes.js';
import { ioRouter } from './routes/importExport.routes.js';
import { metaRouter } from './routes/meta.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(securityHeaders);
  app.use(cookieParser);
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode}`, { ms: Number(ms.toFixed(1)), requestId: req.id });
    });
    next();
  });

  app.use('/api', createRateLimiter());
  app.use('/api', metaRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/expenses', requireAuth, expenseRouter);
  app.use('/api/categories', requireAuth, categoryRouter);
  app.use('/api/budgets', requireAuth, budgetRouter);
  app.use('/api/goals', requireAuth, goalRouter);
  app.use('/api/groups', requireAuth, groupRouter);
  app.use('/api/analytics', requireAuth, analyticsRouter);
  app.use('/api/io', requireAuth, ioRouter);

  app.use(express.static(path.join(ROOT, 'public'), { maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));

  app.use(notFoundHandler);
  // Any non-API path falls through to the SPA shell so client routing works.
  app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  app.use(errorHandler);
  return app;
}

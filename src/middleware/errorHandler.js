import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` } });
  }
  next();
}

/** Turns known SQLite failures into messages a user can act on. */
function translateSqlite(err) {
  const msg = String(err.message || '');
  if (msg.includes('UNIQUE constraint failed')) {
    const field = msg.split('UNIQUE constraint failed:')[1]?.trim().split('.').pop() || 'value';
    return new AppError(`That ${field} is already in use`, { status: 409, code: 'DUPLICATE' });
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return new AppError('Referenced record does not exist', { status: 400, code: 'BAD_REFERENCE' });
  }
  if (msg.includes('CHECK constraint failed')) {
    return new AppError('A field held a value this record does not allow', { status: 400, code: 'BAD_VALUE' });
  }
  if (msg.includes('database is locked')) {
    return new AppError('The database is busy, please retry', { status: 503, code: 'DB_BUSY' });
  }
  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, next) {
  let error = err;

  if (!(error instanceof AppError)) {
    const translated = translateSqlite(error);
    if (translated) error = translated;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    error = new AppError('Request body is not valid JSON', { status: 400, code: 'BAD_JSON' });
  }

  const status = error.status || 500;
  const payload = {
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: status >= 500 ? 'Something went wrong on our side. The issue has been logged.' : error.message,
      requestId: req.id
    }
  };
  if (error.details) payload.error.details = error.details;
  if (status >= 500 && !config.isProd) payload.error.debug = { message: error.message, stack: error.stack?.split('\n').slice(0, 5) };

  const meta = { requestId: req.id, method: req.method, path: req.originalUrl, status };
  if (status >= 500) logger.error(`Unhandled: ${error.message}`, { ...meta, stack: error.stack?.split('\n')[1]?.trim() });
  else logger.debug(`Rejected: ${error.message}`, meta);

  if (res.headersSent) return next(error);
  res.status(status).json(payload);
}

/** Wraps async route handlers so a rejected promise reaches errorHandler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

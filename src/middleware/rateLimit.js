import { config } from '../config.js';
import { tooMany } from '../lib/errors.js';

/**
 * In-memory fixed-window limiter. Good enough for a single-process app; a
 * multi-instance deployment would swap this for Redis without touching routes.
 */
export function createRateLimiter({ windowMs = config.rateLimit.windowMs, max = config.rateLimit.max, key } = {}) {
  const hits = new Map();

  // Sweep expired buckets so a long-running process does not grow unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  if (typeof timer.unref === 'function') timer.unref();

  return function rateLimit(req, res, next) {
    const id = key ? key(req) : (req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    let bucket = hits.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(id, bucket);
    }
    bucket.count++;

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return next(tooMany(`Too many requests. Try again in ${Math.ceil((bucket.resetAt - now) / 1000)}s.`));
    }
    next();
  };
}

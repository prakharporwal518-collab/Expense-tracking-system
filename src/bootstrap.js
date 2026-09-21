import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { getDb, closeDb, get } from './db/index.js';
// Safe to import statically: bootstrap itself is only imported after the
// runtime check in server.js has confirmed node:sqlite is available.
import { seed, DEMO } from './db/seed.js';

/**
 * A crash in one request must not take the process down silently, and a
 * shutdown must not cut off in-flight requests or leave WAL files dirty.
 */
function installProcessGuards(server) {
  let shuttingDown = false;

  const shutdown = (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);

    const force = setTimeout(() => {
      logger.warn('Graceful shutdown timed out, forcing exit');
      process.exit(code || 1);
    }, 10_000);
    if (typeof force.unref === 'function') force.unref();

    server.close((err) => {
      if (err) logger.error('Error while closing server', { err: err.message });
      closeDb();
      clearTimeout(force);
      logger.info('Shutdown complete');
      process.exit(code);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — shutting down', { err: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
    shutdown('uncaughtException', 1);
  });
}

/**
 * Populates demo data only when the database holds no accounts, so an existing
 * deployment is never overwritten however often the process restarts.
 */
function maybeSeedDemo() {
  if (!config.seedDemo) return;
  try {
    const existing = get('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
    if (existing > 0) {
      logger.info('SEED_DEMO is on but the database already has accounts — leaving it untouched', { accounts: existing });
      return;
    }
    logger.info('Empty database and SEED_DEMO is on — generating demo data...');
    seed({ reset: false });
    logger.info('Demo data ready', { login: DEMO.email, password: DEMO.password });
  } catch (err) {
    // A failed demo seed must never stop a real deployment from serving.
    logger.warn('Demo seeding failed — starting with an empty database', { err: err.message });
  }
}

function start() {
  try {
    getDb(); // fail fast if the database cannot be opened or migrated
  } catch (err) {
    // A StorageError already knows how to explain itself; anything else is a
    // genuine database fault and the raw message is the most useful thing.
    if (err.guidance) process.stderr.write(err.guidance);
    else logger.error('Database initialisation failed — cannot start', { err: err.message });
    process.exit(1);
  }

  maybeSeedDemo();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`FinTrack running at http://localhost:${config.port}`, { env: config.env });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.port} is already in use. Set PORT to a free port and retry.`);
    } else {
      logger.error('Server error', { err: err.message });
    }
    process.exit(1);
  });

  installProcessGuards(server);
  return server;
}

export { start };

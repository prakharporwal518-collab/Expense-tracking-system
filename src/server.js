import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { getDb, closeDb } from './db/index.js';

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

function start() {
  try {
    getDb(); // fail fast if migrations cannot run
  } catch (err) {
    logger.error('Database initialisation failed — cannot start', { err: err.message });
    process.exit(1);
  }

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

start();

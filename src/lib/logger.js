import { config } from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const COLOR = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

function emit(level, msg, meta) {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString();
  const tail = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `${COLOR[level]}${stamp} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail}`;
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  error: (m, meta) => emit('error', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  info: (m, meta) => emit('info', m, meta),
  debug: (m, meta) => emit('debug', m, meta)
};

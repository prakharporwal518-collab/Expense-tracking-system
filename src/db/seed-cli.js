/**
 * `npm run seed` entry point. Like server.js, it must not statically import the
 * database layer: on a Node without usable `node:sqlite` that import fails while
 * the module graph is linked, before any check could run. So the runtime is
 * checked first and the seeder is loaded dynamically.
 */
import { checkRuntime } from '../lib/runtime.js';

checkRuntime();

const { seed, DEMO } = await import('./seed.js');
const { closeDb } = await import('./index.js');
const { logger } = await import('../lib/logger.js');

try {
  seed();
  closeDb();
  console.log(`\n  Demo login:  ${DEMO.email}  /  ${DEMO.password}\n`);
} catch (err) {
  logger.error('Seeding failed', { err: err.message });
  process.exit(1);
}

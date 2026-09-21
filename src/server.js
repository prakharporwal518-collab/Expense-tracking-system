/**
 * Entry point. Nothing here may statically import the database layer: an
 * unavailable builtin (`node:sqlite` on old Node) fails while the module graph
 * is linked, which happens before any module body executes. Checking the
 * runtime first, then importing the app dynamically, keeps the error readable.
 */
import { checkRuntime } from './lib/runtime.js';

checkRuntime();

const { start } = await import('./bootstrap.js');
start();

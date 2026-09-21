import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDbLocation, StorageError } from '../src/lib/storage.js';

// Regression: a Render deploy with DB_FILE=/var/data/fintrack.db but no Disk
// attached died with a bare "EACCES: permission denied, mkdir '/var/data'",
// which named neither the setting at fault nor the fix.
test('creates the database directory when it does not exist yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-store-'));
  const nested = path.join(dir, 'deep', 'nested', 'db.sqlite');
  assert.doesNotThrow(() => ensureDbLocation(nested));
  assert.ok(fs.existsSync(path.dirname(nested)), 'directory should have been created');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts an in-memory database without touching the filesystem', () => {
  assert.doesNotThrow(() => ensureDbLocation(':memory:'));
});

test('an unwritable location raises StorageError carrying guidance', () => {
  // /sys is kernel-managed: mkdir there fails even as root.
  let raised = null;
  try {
    ensureDbLocation('/sys/fintrack-test/db.sqlite');
  } catch (err) {
    raised = err;
  }
  assert.ok(raised instanceof StorageError, 'should raise StorageError');
  assert.ok(raised.guidance.includes('DB_FILE'), 'guidance must name the setting at fault');
  assert.ok(raised.guidance.includes('Add Disk'), 'guidance must offer the persistent fix');
  assert.ok(raised.guidance.includes('delete the DB_FILE'), 'guidance must offer the no-disk fix');
  assert.equal(raised.dbFile, '/sys/fintrack-test/db.sqlite');
});

test('the default configured location is usable', async () => {
  const { config } = await import('../src/config.js');
  assert.doesNotThrow(() => ensureDbLocation(config.dbFile),
    'the out-of-the-box DB_FILE must work with no configuration');
});

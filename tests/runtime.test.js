import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupported, MIN_NODE, parseVersion } from '../src/lib/runtime.js';

// Regression: a Render deploy pinned to Node 22.11.0 died with a bare
// ERR_UNKNOWN_BUILTIN_MODULE. `node:sqlite` exists from 22.5 but stayed behind
// --experimental-sqlite until 22.13, so 22.5 is NOT a usable floor.
test('rejects Node versions where node:sqlite is unavailable or flagged', () => {
  for (const v of ['20.18.0', '22.4.0', '22.5.0', '22.11.0', '22.12.99']) {
    assert.equal(isSupported(v), false, `${v} should be rejected`);
  }
});

test('accepts the first version where node:sqlite is unflagged, and later ones', () => {
  for (const v of ['22.13.0', '22.13.1', '22.22.2', '23.4.0', '24.0.0']) {
    assert.equal(isSupported(v), true, `${v} should be accepted`);
  }
});

test('the declared minimum matches what the code enforces', () => {
  assert.equal(isSupported(MIN_NODE.join('.')), true);
  const [maj, min, patch] = MIN_NODE;
  assert.equal(isSupported(`${maj}.${min}.${patch - 1}`), false, 'one patch below must fail');
});

test('the running interpreter satisfies the requirement', () => {
  assert.equal(isSupported(), true, `tests are running on Node ${process.versions.node}`);
});

test('version parsing tolerates odd input', () => {
  assert.deepEqual(parseVersion('22.13.0'), [22, 13, 0]);
  assert.doesNotThrow(() => isSupported('not.a.version'));
});

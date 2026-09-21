import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, toMajor, splitEvenly, splitByWeights } from '../src/lib/money.js';

test('toMinor converts without float drift', () => {
  assert.equal(toMinor('1234.56'), 123456);
  assert.equal(toMinor(0.1 + 0.2), 30);   // 0.30000000000000004
  assert.equal(toMinor('1,234.5'), 123450);
  assert.equal(toMinor(1.005), 101);      // classic float rounding trap
  assert.equal(toMinor('abc'), null);
  assert.equal(toMinor(Infinity), null);
});

test('toMajor round-trips', () => {
  assert.equal(toMajor(123456), 1234.56);
  assert.equal(toMajor(0), 0);
});

test('splitEvenly never loses or invents money', () => {
  for (const [total, n] of [[1000, 3], [100, 7], [1, 3], [999999, 13]]) {
    const parts = splitEvenly(total, n);
    assert.equal(parts.length, n);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `sum mismatch for ${total}/${n}`);
  }
});

test('splitByWeights preserves the total and honours proportions', () => {
  const parts = splitByWeights(1000, [1, 2, 1]);
  assert.deepEqual(parts, [250, 500, 250]);
  const odd = splitByWeights(100, [1, 1, 1]);
  assert.equal(odd.reduce((a, b) => a + b, 0), 100);
});

test('splitByWeights falls back to an even split when weights are all zero', () => {
  const parts = splitByWeights(900, [0, 0, 0]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 900);
});

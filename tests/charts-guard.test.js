import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastMonthlySpend } from '../src/services/forecast.js';

// Regression: a brand-new account has no months of history, but the forecast
// endpoint still returns `horizon` points. The chart must not try to anchor
// them to a non-existent last actual point.
test('forecast still returns points when there is no history at all', () => {
  const r = forecastMonthlySpend([], { horizon: 3 });
  assert.equal(r.method, 'insufficient-history');
  assert.equal(r.points.length, 3);
  for (const p of r.points) assert.ok(Number.isFinite(p.value));
});

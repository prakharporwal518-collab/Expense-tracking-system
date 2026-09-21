import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomalies, median, mad, robustZScores } from '../src/services/anomaly.js';
import { detectRecurring, normaliseMerchant } from '../src/services/recurring.js';
import { holtLinear, forecastMonthlySpend, projectCurrentMonth } from '../src/services/forecast.js';
import { computeHealth, safeToSpend } from '../src/services/health.js';
import { findDuplicates } from '../src/services/duplicates.js';
import { simulate, goalProjection } from '../src/services/whatif.js';

const DAY = 86_400_000;
const mkExpense = (amount, i, over = {}) => ({
  id: i, amount, category: 'Food', merchant: `M${i}`,
  date: new Date(Date.UTC(2026, 8, i + 1)).toISOString(), note: '', ...over
});

test('median and MAD behave on even and odd lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(mad([1, 1, 1, 1]), 0);
});

test('a single huge outlier cannot mask itself', () => {
  // The point of using MAD: with mean/stdev, one 25x value inflates the spread
  // enough to score itself as normal.
  const amounts = [200, 220, 180, 250, 210, 195, 230, 5000, 240];
  const expenses = amounts.map((a, i) => mkExpense(a, i));
  const found = detectAnomalies(expenses);
  assert.equal(found.length, 1);
  assert.equal(found[0].amount, 5000);
  assert.equal(found[0].severity, 'high');
});

test('uniform spending produces no anomalies', () => {
  const expenses = Array.from({ length: 12 }, (_, i) => mkExpense(200 + (i % 3), i));
  assert.equal(detectAnomalies(expenses).length, 0);
});

test('anomaly detection needs a minimum sample size', () => {
  assert.equal(detectAnomalies([mkExpense(100, 0), mkExpense(9999, 1)]).length, 0);
});

test('robustZScores degrades gracefully when every value is identical', () => {
  assert.deepEqual(robustZScores([5, 5, 5]), [0, 0, 0]);
});

test('detects a monthly subscription and ignores irregular spending', () => {
  const expenses = [];
  for (let i = 0; i < 6; i++) {
    expenses.push({ id: i, merchant: 'Netflix', amount: 64900, category: 'Entertainment', note: '',
      date: new Date(Date.UTC(2026, 3 + i, 5)).toISOString() });
  }
  // Irregular food orders at varying amounts must not look like a subscription.
  [1, 4, 9, 17, 23].forEach((d, i) => expenses.push({
    id: 100 + i, merchant: 'Swiggy', amount: 30000 + i * 9000, category: 'Food', note: '',
    date: new Date(Date.UTC(2026, 8, d)).toISOString()
  }));

  const found = detectRecurring(expenses, { now: new Date('2026-09-21') });
  const names = found.map((f) => f.merchant);
  assert.ok(names.includes('Netflix'), 'Netflix should be detected');
  assert.ok(!names.includes('Swiggy'), 'Swiggy should not be detected');
  const netflix = found.find((f) => f.merchant === 'Netflix');
  assert.equal(netflix.label, 'monthly');
  assert.equal(netflix.annualCost, Math.round((64900 * 365) / 30));
});

test('amount clustering separates a subscription from one-off charges at the same merchant', () => {
  const expenses = [];
  for (let i = 0; i < 5; i++) {
    expenses.push({ id: i, merchant: 'Cult Fit', amount: 129900, category: 'Health', note: '',
      date: new Date(Date.UTC(2026, 3 + i, 22)).toISOString() });
  }
  // Noise at the same merchant used to scramble the gap sequence entirely.
  [3, 11, 19].forEach((d, i) => expenses.push({ id: 50 + i, merchant: 'Cult Fit', amount: 40000 + i * 1000,
    category: 'Health', note: '', date: new Date(Date.UTC(2026, 7, d)).toISOString() }));

  const found = detectRecurring(expenses, { now: new Date('2026-09-21') });
  const subscription = found.find((f) => f.amount === 129900);
  assert.ok(subscription, 'the monthly cycle should survive the noise at the same merchant');
  assert.equal(subscription.label, 'monthly');
  assert.equal(subscription.occurrences, 5);
  // The thin, coincidental cluster may also surface, but must rank as weaker.
  const noise = found.find((f) => f.amount !== 129900 && f.merchant === 'Cult Fit');
  if (noise) assert.ok(noise.confidence < subscription.confidence, 'a 3-charge coincidence must not outrank a 5-month cycle');
});

test('normaliseMerchant strips noise so variants group together', () => {
  assert.equal(normaliseMerchant('SWIGGY PVT LTD 12345'), normaliseMerchant('Swiggy'));
});

test('holtLinear follows a rising trend', () => {
  const { forecasts, trend } = holtLinear([100, 110, 120, 130, 140], { horizon: 2 });
  assert.ok(trend > 0);
  assert.ok(forecasts[0] > 140 && forecasts[1] > forecasts[0]);
});

test('forecast never predicts negative spending', () => {
  const { points } = forecastMonthlySpend([5000, 3000, 1000, 200].map((total) => ({ total })), { horizon: 4 });
  for (const p of points) assert.ok(p.value >= 0 && p.low >= 0, `got ${p.value}/${p.low}`);
});

test('forecast reports low confidence with almost no history', () => {
  const r = forecastMonthlySpend([{ total: 500 }], { horizon: 2 });
  assert.equal(r.method, 'insufficient-history');
  assert.ok(r.confidence <= 0.3);
});

test('current-month projection shrinks toward history early in the month', () => {
  const early = projectCurrentMonth({ spentSoFar: 10000, dayOfMonth: 2, daysInMonth: 30, historicalAverage: 60000 });
  const late = projectCurrentMonth({ spentSoFar: 145000, dayOfMonth: 29, daysInMonth: 30, historicalAverage: 60000 });
  assert.ok(early.weight < late.weight, 'run-rate should be trusted more later in the month');
  assert.ok(early.projected < 150000, 'a noisy 2-day run rate must not dominate');
});

test('health score stays within bounds and explains itself', () => {
  const r = computeHealth({ income: 5_000_000, spend: 3_800_000, budgetTotal: 4_000_000, budgetSpent: 3_800_000,
    monthlyTotals: [3_600_000, 3_900_000, 3_800_000], subscriptionAnnual: 240_000, trackedDays: 22, periodDays: 30 });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(Object.keys(r.parts).length, 5);
  assert.ok(r.weakest.label);
});

test('health score copes with a brand-new account', () => {
  const r = computeHealth({ income: 0, spend: 0, budgetTotal: 0, budgetSpent: 0, monthlyTotals: [], subscriptionAnnual: 0, trackedDays: 0, periodDays: 30 });
  assert.ok(Number.isFinite(r.score) && r.score >= 0 && r.score <= 100);
});

test('overspending is scored worse than staying inside budget', () => {
  const base = { income: 100000, monthlyTotals: [], subscriptionAnnual: 0, trackedDays: 30, periodDays: 30 };
  const good = computeHealth({ ...base, spend: 50000, budgetTotal: 60000, budgetSpent: 50000 });
  const bad = computeHealth({ ...base, spend: 150000, budgetTotal: 60000, budgetSpent: 150000 });
  assert.ok(good.score > bad.score);
});

test('safeToSpend flags an overspent envelope', () => {
  const r = safeToSpend({ budgetTotal: 100000, spentSoFar: 120000, daysRemaining: 5 });
  assert.equal(r.status, 'over');
  assert.ok(r.perDay_minor < 0);
});

test('duplicate detection respects the time window', () => {
  const now = Date.now();
  const near = findDuplicates([
    { id: 1, amount: 45000, merchant: 'Swiggy', date: new Date(now).toISOString(), category: 'Food' },
    { id: 2, amount: 45000, merchant: 'swiggy ltd', date: new Date(now + 3600_000).toISOString(), category: 'Food' }
  ]);
  assert.equal(near.length, 1);

  const far = findDuplicates([
    { id: 1, amount: 45000, merchant: 'Swiggy', date: new Date(now).toISOString(), category: 'Food' },
    { id: 2, amount: 45000, merchant: 'Swiggy', date: new Date(now + 10 * DAY).toISOString(), category: 'Food' }
  ]);
  assert.equal(far.length, 0);
});

test('what-if simulation computes the saving and compounding', () => {
  const r = simulate({
    categoryTotals: [{ category: 'Food', total: 1_000_000 }, { category: 'Transport', total: 500_000 }],
    adjustments: { Food: -20 }, monthlyIncome: 5_000_000, annualReturnRate: 12, horizonMonths: 12
  });
  assert.equal(r.monthlySaving, 200_000);
  assert.equal(r.annualSaving, 2_400_000);
  assert.ok(r.futureValue > r.annualSaving, 'compounding should beat the plain sum');
  assert.ok(r.newSavingsRate > r.oldSavingsRate);
});

test('what-if clamps absurd adjustments', () => {
  const r = simulate({ categoryTotals: [{ category: 'Food', total: 1000 }], adjustments: { Food: -100000 } });
  assert.ok(r.projectedSpend >= 0);
});

test('goal projection detects a stalled goal', () => {
  const r = goalProjection({ target: 100000, saved: 1000, monthlySurplus: 0 });
  assert.equal(r.status, 'stalled');
  assert.equal(r.onTrack, false);
});

test('goal projection reports a reached goal', () => {
  const r = goalProjection({ target: 100000, saved: 100000, monthlySurplus: 5000 });
  assert.equal(r.status, 'reached');
  assert.equal(r.progress, 1);
});

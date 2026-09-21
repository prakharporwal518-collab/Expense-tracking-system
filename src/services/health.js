import { median } from './anomaly.js';

/**
 * Financial Health Score (0-100) — a weighted blend of five signals, each
 * scored 0-100 on its own so the UI can explain exactly what is dragging the
 * number down instead of showing an opaque total.
 */
const WEIGHTS = { savingsRate: 0.30, budgetAdherence: 0.25, volatility: 0.15, subscriptionLoad: 0.15, consistency: 0.15 };

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function computeHealth({
  income = 0,
  spend = 0,
  budgetTotal = 0,
  budgetSpent = 0,
  monthlyTotals = [],
  subscriptionAnnual = 0,
  trackedDays = 0,
  periodDays = 30
}) {
  const parts = {};

  // 1. Savings rate — 20%+ saved is the widely used healthy benchmark.
  const savingsRate = income > 0 ? (income - spend) / income : null;
  parts.savingsRate = {
    label: 'Savings rate',
    value: savingsRate === null ? null : Number((savingsRate * 100).toFixed(1)),
    score: savingsRate === null ? 50 : clamp((savingsRate / 0.2) * 100),
    hint: savingsRate === null
      ? 'Set your monthly income to unlock this'
      : savingsRate >= 0.2 ? 'Excellent — you are saving 20%+'
      : savingsRate > 0 ? 'Aim for 20% of income saved'
      : 'You are spending more than you earn'
  };

  // 2. Budget adherence — full marks at or under budget, zero at 2x over.
  const ratio = budgetTotal > 0 ? budgetSpent / budgetTotal : null;
  parts.budgetAdherence = {
    label: 'Budget adherence',
    value: ratio === null ? null : Number((ratio * 100).toFixed(1)),
    score: ratio === null ? 50 : ratio <= 1 ? 100 : clamp(100 - (ratio - 1) * 100),
    hint: ratio === null ? 'Set budgets to track this'
      : ratio <= 0.85 ? 'Comfortably inside budget'
      : ratio <= 1 ? 'Close to the limit'
      : 'Over budget this period'
  };

  // 3. Volatility — coefficient of variation across months. Steady is healthy.
  let cv = null;
  const totals = monthlyTotals.map((m) => (typeof m === 'number' ? m : m.total)).filter((n) => n > 0);
  if (totals.length >= 3) {
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length);
    cv = mean > 0 ? sd / mean : 0;
  }
  parts.volatility = {
    label: 'Spending stability',
    value: cv === null ? null : Number((cv * 100).toFixed(1)),
    score: cv === null ? 50 : clamp(100 - cv * 250),
    hint: cv === null ? 'Needs 3+ months of history'
      : cv < 0.2 ? 'Very steady month to month'
      : cv < 0.4 ? 'Moderately variable' : 'Spending swings a lot'
  };

  // 4. Subscription load — recurring cost as a share of income.
  const monthlySubs = subscriptionAnnual / 12;
  const subShare = income > 0 ? monthlySubs / income : null;
  parts.subscriptionLoad = {
    label: 'Subscription load',
    value: subShare === null ? null : Number((subShare * 100).toFixed(1)),
    score: subShare === null ? 60 : clamp(100 - (subShare / 0.1) * 100),
    hint: subShare === null ? 'Set income to measure this'
      : subShare < 0.05 ? 'Light subscription footprint'
      : subShare < 0.1 ? 'Reasonable, but worth reviewing' : 'Subscriptions are eating your income'
  };

  // 5. Consistency — are you actually logging expenses?
  const coverage = periodDays > 0 ? Math.min(1, trackedDays / Math.min(periodDays, 30)) : 0;
  parts.consistency = {
    label: 'Tracking consistency',
    value: Number((coverage * 100).toFixed(0)),
    score: clamp(coverage * 100),
    hint: coverage > 0.7 ? 'Great logging habit' : coverage > 0.3 ? 'Log a little more often' : 'Track daily for better insights'
  };

  const total = Object.entries(WEIGHTS).reduce((sum, [key, w]) => sum + parts[key].score * w, 0);
  const score = Math.round(clamp(total));

  return {
    score,
    grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'E',
    verdict: score >= 85 ? 'Excellent' : score >= 70 ? 'Healthy' : score >= 55 ? 'Okay' : score >= 40 ? 'Needs attention' : 'At risk',
    parts,
    weakest: Object.entries(parts).sort((a, b) => a[1].score - b[1].score)[0][1]
  };
}

/** "Safe to spend today" — what's left in the envelope divided by days remaining. */
export function safeToSpend({ budgetTotal, spentSoFar, daysRemaining, upcomingRecurring = 0 }) {
  if (!budgetTotal) return null;
  const remaining = budgetTotal - spentSoFar - upcomingRecurring;
  const days = Math.max(1, daysRemaining);
  return {
    remaining_minor: Math.round(remaining),
    perDay_minor: Math.round(remaining / days),
    daysRemaining: days,
    committed_minor: Math.round(upcomingRecurring),
    status: remaining < 0 ? 'over' : remaining / days < budgetTotal / 60 ? 'tight' : 'ok'
  };
}

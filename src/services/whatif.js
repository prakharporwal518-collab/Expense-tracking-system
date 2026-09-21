import { DAY_MS } from '../lib/dates.js';

/**
 * "What if I cut dining by 20%?" — applies hypothetical per-category changes to
 * a real spending baseline and compounds the monthly saving forward, so the
 * user sees the one-year and goal impact instead of an abstract percentage.
 */
export function simulate({ categoryTotals, adjustments = {}, monthlyIncome = 0, horizonMonths = 12, annualReturnRate = 0 }) {
  const baseline = categoryTotals.reduce((sum, c) => sum + c.total, 0);

  const rows = categoryTotals.map((c) => {
    const pct = Number(adjustments[c.category] ?? 0);
    const safePct = Math.max(-100, Math.min(500, Number.isFinite(pct) ? pct : 0));
    const adjusted = Math.max(0, Math.round(c.total * (1 + safePct / 100)));
    return { category: c.category, before: c.total, after: adjusted, delta: adjusted - c.total, changePercent: safePct };
  });

  const projected = rows.reduce((sum, r) => sum + r.after, 0);
  const monthlyDelta = baseline - projected; // positive = money saved

  // Optional compounding, e.g. if the freed-up money were invested.
  const monthlyRate = annualReturnRate / 12 / 100;
  let futureValue = 0;
  for (let m = 0; m < horizonMonths; m++) futureValue = (futureValue + monthlyDelta) * (1 + monthlyRate);

  return {
    baselineSpend: baseline,
    projectedSpend: projected,
    monthlySaving: monthlyDelta,
    annualSaving: monthlyDelta * 12,
    horizonMonths,
    futureValue: Math.round(futureValue),
    newSavingsRate: monthlyIncome > 0 ? Number((((monthlyIncome - projected) / monthlyIncome) * 100).toFixed(1)) : null,
    oldSavingsRate: monthlyIncome > 0 ? Number((((monthlyIncome - baseline) / monthlyIncome) * 100).toFixed(1)) : null,
    rows: rows.sort((a, b) => a.delta - b.delta)
  };
}

/** How long until a savings goal is met at the current surplus rate. */
export function goalProjection({ target, saved, monthlySurplus, targetDate }) {
  const remaining = Math.max(0, target - saved);
  const progress = target > 0 ? Math.min(1, saved / target) : 0;

  if (remaining === 0) return { progress: 1, status: 'reached', monthsNeeded: 0, etaISO: null, onTrack: true };
  if (!monthlySurplus || monthlySurplus <= 0) {
    return { progress, status: 'stalled', monthsNeeded: null, etaISO: null, onTrack: false,
      note: 'No monthly surplus — this goal is not progressing.' };
  }

  const monthsNeeded = Math.ceil(remaining / monthlySurplus);
  const eta = new Date(Date.now() + monthsNeeded * 30 * DAY_MS);
  const onTrack = targetDate ? eta <= new Date(targetDate) : true;
  const requiredPerMonth = targetDate
    ? Math.max(0, Math.ceil(remaining / Math.max(1, (new Date(targetDate) - Date.now()) / (30 * DAY_MS))))
    : null;

  return { progress: Number(progress.toFixed(3)), status: 'active', monthsNeeded, etaISO: eta.toISOString(), onTrack, requiredPerMonth };
}

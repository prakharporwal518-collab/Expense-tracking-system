import { median } from './anomaly.js';

/**
 * Holt's linear exponential smoothing — level + trend, no seasonality.
 *
 *   level_t = α·y_t + (1-α)(level_{t-1} + trend_{t-1})
 *   trend_t = β(level_t - level_{t-1}) + (1-β)·trend_{t-1}
 *   forecast(h) = level_t + h·trend_t
 *
 * Chosen over a plain average because spending usually drifts, and over full
 * Holt-Winters because a student's history is rarely long enough (2+ years)
 * for seasonal indices to be anything but noise.
 */
export function holtLinear(series, { alpha = 0.5, beta = 0.3, horizon = 1 } = {}) {
  if (!series.length) return { forecasts: Array(horizon).fill(0), level: 0, trend: 0 };
  if (series.length === 1) return { forecasts: Array(horizon).fill(series[0]), level: series[0], trend: 0 };

  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const forecasts = Array.from({ length: horizon }, (_, h) => Math.max(0, level + (h + 1) * trend));
  return { forecasts, level, trend };
}

/** Mean absolute error of one-step-ahead forecasts, used as a ± band. */
function backtestError(series, opts) {
  if (series.length < 4) return null;
  const errors = [];
  for (let cut = 3; cut < series.length; cut++) {
    const { forecasts } = holtLinear(series.slice(0, cut), { ...opts, horizon: 1 });
    errors.push(Math.abs(series[cut] - forecasts[0]));
  }
  return errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
}

export function forecastMonthlySpend(monthlyTotals, { horizon = 3 } = {}) {
  const series = monthlyTotals.map((m) => m.total);
  if (series.length < 2) {
    const only = series[0] ?? 0;
    return {
      method: 'insufficient-history',
      points: Array.from({ length: horizon }, () => ({ value: only, low: only, high: only })),
      confidence: 0.2,
      note: 'Add a couple more months of data for a real forecast.'
    };
  }

  const { forecasts, trend } = holtLinear(series, { horizon });
  const mae = backtestError(series, {}) ?? median(series) * 0.25;
  const avg = series.reduce((a, b) => a + b, 0) / series.length;
  // Error relative to typical spend -> confidence. 0 error = 0.95, error == avg = ~0.
  const confidence = Number(Math.max(0.2, Math.min(0.95, 1 - mae / Math.max(1, avg))).toFixed(2));

  return {
    method: 'holt-linear',
    trendPerMonth: Math.round(trend),
    direction: trend > avg * 0.03 ? 'rising' : trend < -avg * 0.03 ? 'falling' : 'flat',
    confidence,
    marginOfError: Math.round(mae),
    points: forecasts.map((v) => ({
      value: Math.round(v),
      low: Math.max(0, Math.round(v - mae)),
      high: Math.round(v + mae)
    }))
  };
}

/**
 * Projects where this month lands, blending the run-rate so far with how much
 * of the month is left. Early in the month the run-rate is noisy, so it is
 * shrunk toward the historical average (a simple empirical-Bayes style prior).
 */
export function projectCurrentMonth({ spentSoFar, dayOfMonth, daysInMonth, historicalAverage }) {
  const elapsed = Math.max(1, dayOfMonth);
  const runRate = spentSoFar / elapsed;
  const naive = runRate * daysInMonth;
  if (!historicalAverage) return { projected: Math.round(naive), method: 'run-rate', weight: 1 };
  const weight = Math.min(1, elapsed / daysInMonth); // trust the run-rate more as the month fills in
  const projected = naive * weight + historicalAverage * (1 - weight);
  return {
    projected: Math.round(projected),
    method: 'shrunk-run-rate',
    weight: Number(weight.toFixed(2)),
    runRatePerDay: Math.round(runRate)
  };
}

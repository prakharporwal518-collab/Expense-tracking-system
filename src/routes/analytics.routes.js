import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, plainAll, plain } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { liveExpenses, computeStreak, listAchievements, safeJson } from '../services/store.js';
import { detectAnomalies } from '../services/anomaly.js';
import { detectRecurring } from '../services/recurring.js';
import { forecastMonthlySpend, projectCurrentMonth } from '../services/forecast.js';
import { computeHealth, safeToSpend } from '../services/health.js';
import { findDuplicates } from '../services/duplicates.js';
import { simulate, goalProjection } from '../services/whatif.js';
import { startOfMonth, endOfMonth, daysInMonth, monthKey, isoDay, DAY_MS, addMonths } from '../lib/dates.js';

export const analyticsRouter = express.Router();

/** Normalises stored rows into the flat shape the analytics services expect. */
const toAnalyticRows = (rows) => rows
  .filter((r) => !r.is_income)
  .map((r) => ({
    id: r.id,
    amount: r.base_amount_minor,
    category: r.category_name || 'Uncategorised',
    merchant: r.merchant || '',
    note: r.note || '',
    date: r.spent_at
  }));

function monthlyTotals(userId, months = 12) {
  const since = addMonths(new Date(), -(months - 1)).toISOString();
  const rows = plainAll(all(
    `SELECT substr(spent_at,1,7) AS month,
            COALESCE(SUM(CASE WHEN is_income = 0 THEN base_amount_minor ELSE 0 END),0) AS total,
            COALESCE(SUM(CASE WHEN is_income = 1 THEN base_amount_minor ELSE 0 END),0) AS income,
            COUNT(*) AS count
     FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND spent_at >= ?
     GROUP BY month ORDER BY month ASC`, [userId, since]
  ));
  return rows;
}

analyticsRouter.get('/summary', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();

  const thisMonth = get(
    `SELECT COALESCE(SUM(CASE WHEN is_income=0 THEN base_amount_minor ELSE 0 END),0) AS spent,
            COALESCE(SUM(CASE WHEN is_income=1 THEN base_amount_minor ELSE 0 END),0) AS earned,
            COUNT(*) AS count
     FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND spent_at BETWEEN ? AND ?`,
    [userId, monthStart, monthEnd]
  );

  const prevStart = startOfMonth(addMonths(now, -1)).toISOString();
  const prevEnd = endOfMonth(addMonths(now, -1)).toISOString();
  const lastMonth = get(
    `SELECT COALESCE(SUM(CASE WHEN is_income=0 THEN base_amount_minor ELSE 0 END),0) AS spent
     FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND spent_at BETWEEN ? AND ?`,
    [userId, prevStart, prevEnd]
  );

  const byCategory = plainAll(all(
    `SELECT COALESCE(c.name,'Uncategorised') AS category, COALESCE(c.icon,'💸') AS icon, COALESCE(c.color,'#64748b') AS color,
            SUM(e.base_amount_minor) AS total, COUNT(*) AS count
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
     WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.is_income = 0 AND e.spent_at BETWEEN ? AND ?
     GROUP BY category ORDER BY total DESC`, [userId, monthStart, monthEnd]
  ));

  const byPayment = plainAll(all(
    `SELECT payment_method AS method, SUM(base_amount_minor) AS total, COUNT(*) AS count
     FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND is_income = 0 AND spent_at BETWEEN ? AND ?
     GROUP BY method ORDER BY total DESC`, [userId, monthStart, monthEnd]
  ));

  const daily = plainAll(all(
    `SELECT date(spent_at) AS day, SUM(CASE WHEN is_income=0 THEN base_amount_minor ELSE 0 END) AS total
     FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND spent_at BETWEEN ? AND ?
     GROUP BY day ORDER BY day ASC`, [userId, monthStart, monthEnd]
  ));

  const months = monthlyTotals(userId, 12);
  const budgets = plainAll(all(
    `SELECT b.*, c.name AS category_name FROM budgets b LEFT JOIN categories c ON c.id = b.category_id WHERE b.user_id = ?`,
    [userId]
  ));

  // Adherence must compare like with like. Measuring total spend against the sum
  // of a few category envelopes makes every user look reckless, so the spend side
  // is restricted to the same scope the budgets actually cover.
  const overallBudget = budgets.find((b) => !b.category_id);
  const categoryBudgets = budgets.filter((b) => b.category_id);
  let budgetTotal = 0;
  let budgetSpent = 0;
  if (overallBudget) {
    budgetTotal = overallBudget.amount_minor;
    budgetSpent = thisMonth.spent;
  } else if (categoryBudgets.length) {
    budgetTotal = categoryBudgets.reduce((sum, b) => sum + b.amount_minor, 0);
    const placeholders = categoryBudgets.map(() => '?').join(',');
    budgetSpent = get(
      `SELECT COALESCE(SUM(base_amount_minor),0) AS t FROM expenses
       WHERE user_id = ? AND deleted_at IS NULL AND is_income = 0
         AND spent_at BETWEEN ? AND ? AND category_id IN (${placeholders})`,
      [userId, monthStart, monthEnd, ...categoryBudgets.map((b) => b.category_id)]
    )?.t ?? 0;
  }

  const dayOfMonth = now.getUTCDate();
  const dim = daysInMonth(now);
  const historicalAvg = months.length > 1
    ? months.slice(0, -1).reduce((s, m) => s + m.total, 0) / (months.length - 1)
    : null;

  const projection = projectCurrentMonth({
    spentSoFar: thisMonth.spent, dayOfMonth, daysInMonth: dim, historicalAverage: historicalAvg
  });

  const trackedDays = get(
    `SELECT COUNT(DISTINCT date(spent_at)) AS n FROM expenses
     WHERE user_id = ? AND deleted_at IS NULL AND spent_at >= ?`,
    [userId, new Date(Date.now() - 30 * DAY_MS).toISOString()]
  )?.n ?? 0;

  const recurring = detectRecurring(toAnalyticRows(liveExpenses(userId, { limit: 3000 })), { now });
  const subscriptionAnnual = recurring.reduce((s, r) => s + r.annualCost, 0);

  const health = computeHealth({
    income: req.user.monthly_income_minor || thisMonth.earned,
    spend: thisMonth.spent,
    budgetTotal,
    budgetSpent,
    monthlyTotals: months,
    subscriptionAnnual,
    trackedDays,
    periodDays: 30
  });

  const upcoming = recurring
    .filter((r) => r.daysUntil >= 0 && r.daysUntil <= dim - dayOfMonth)
    .reduce((s, r) => s + r.amount, 0);

  res.json({
    month: monthKey(now),
    currency: req.user.currency,
    locale: req.user.locale,
    thisMonth: { spentMinor: thisMonth.spent, earnedMinor: thisMonth.earned, netMinor: thisMonth.earned - thisMonth.spent, count: thisMonth.count },
    lastMonth: { spentMinor: lastMonth.spent },
    changePercent: lastMonth.spent > 0 ? Number((((thisMonth.spent - lastMonth.spent) / lastMonth.spent) * 100).toFixed(1)) : null,
    byCategory,
    byPayment,
    daily,
    months,
    projection,
    health,
    streak: computeStreak(userId),
    budgetTotalMinor: budgetTotal,
    budgetSpentMinor: budgetSpent,
    safeToSpend: safeToSpend({ budgetTotal, spentSoFar: budgetSpent, daysRemaining: dim - dayOfMonth + 1, upcomingRecurring: upcoming }),
    subscriptions: { count: recurring.length, annualMinor: subscriptionAnnual, monthlyMinor: Math.round(subscriptionAnnual / 12) }
  });
}));

analyticsRouter.get('/anomalies', asyncHandler(async (req, res) => {
  const q = validate(req.query, { threshold: { type: 'number', min: 1, max: 20, default: 3.5 }, days: { type: 'number', integer: true, min: 7, max: 730, default: 180 } });
  const rows = toAnalyticRows(liveExpenses(req.user.id, { from: new Date(Date.now() - q.days * DAY_MS).toISOString(), limit: 3000 }));
  res.json({ anomalies: detectAnomalies(rows, { threshold: q.threshold }).slice(0, 40), analysed: rows.length });
}));

analyticsRouter.get('/recurring', asyncHandler(async (req, res) => {
  const rows = toAnalyticRows(liveExpenses(req.user.id, { limit: 4000 }));
  const detected = detectRecurring(rows);
  const ignored = new Set(plainAll(all("SELECT merchant FROM recurring WHERE user_id = ? AND status = 'ignored'", [req.user.id])).map((r) => r.merchant));
  const visible = detected.filter((d) => !ignored.has(d.merchantKey));
  res.json({
    subscriptions: visible,
    totals: {
      monthlyMinor: Math.round(visible.reduce((s, r) => s + r.annualCost, 0) / 12),
      annualMinor: visible.reduce((s, r) => s + r.annualCost, 0)
    }
  });
}));

analyticsRouter.post('/recurring/ignore', asyncHandler(async (req, res) => {
  const body = validate(req.body, { merchantKey: { type: 'string', required: true, max: 120 }, amountMinor: { type: 'number', integer: true, default: 0 }, intervalDays: { type: 'number', integer: true, default: 30 } });
  const { run } = await import('../db/index.js');
  run(`INSERT INTO recurring (user_id, merchant, amount_minor, interval_days, status)
       VALUES (?,?,?,?,'ignored')
       ON CONFLICT(user_id, merchant, interval_days) DO UPDATE SET status = 'ignored'`,
    [req.user.id, body.merchantKey, body.amountMinor, body.intervalDays]);
  res.json({ ok: true });
}));

analyticsRouter.get('/duplicates', asyncHandler(async (req, res) => {
  const rows = toAnalyticRows(liveExpenses(req.user.id, { from: new Date(Date.now() - 90 * DAY_MS).toISOString(), limit: 2000 }));
  res.json({ duplicates: findDuplicates(rows).slice(0, 30) });
}));

analyticsRouter.get('/forecast', asyncHandler(async (req, res) => {
  const q = validate(req.query, { horizon: { type: 'number', integer: true, min: 1, max: 12, default: 3 } });
  const months = monthlyTotals(req.user.id, 18);
  const forecast = forecastMonthlySpend(months, { horizon: q.horizon });
  const labels = Array.from({ length: q.horizon }, (_, i) => monthKey(addMonths(new Date(), i + 1)));
  res.json({ history: months, forecast: { ...forecast, points: forecast.points.map((p, i) => ({ ...p, month: labels[i] })) } });
}));

analyticsRouter.post('/whatif', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    adjustments: { type: 'object', required: true },
    horizonMonths: { type: 'number', integer: true, min: 1, max: 120, default: 12 },
    annualReturnRate: { type: 'number', min: 0, max: 40, default: 0 }
  });
  const monthStart = startOfMonth(new Date()).toISOString();
  const categoryTotals = plainAll(all(
    `SELECT COALESCE(c.name,'Uncategorised') AS category, SUM(e.base_amount_minor) AS total
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
     WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.is_income = 0 AND e.spent_at >= ?
     GROUP BY category ORDER BY total DESC`, [req.user.id, monthStart]
  ));
  res.json(simulate({
    categoryTotals,
    adjustments: body.adjustments,
    monthlyIncome: req.user.monthly_income_minor,
    horizonMonths: body.horizonMonths,
    annualReturnRate: body.annualReturnRate
  }));
}));

analyticsRouter.get('/heatmap', asyncHandler(async (req, res) => {
  const q = validate(req.query, { days: { type: 'number', integer: true, min: 30, max: 400, default: 365 } });
  const from = new Date(Date.now() - q.days * DAY_MS).toISOString();
  const rows = plainAll(all(
    `SELECT date(spent_at) AS day, SUM(base_amount_minor) AS total, COUNT(*) AS count
     FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND is_income = 0 AND spent_at >= ?
     GROUP BY day ORDER BY day ASC`, [req.user.id, from]
  ));
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0);
  res.json({ days: rows, maxMinor: max, from: isoDay(from), to: isoDay(new Date()) });
}));

analyticsRouter.get('/achievements', asyncHandler(async (req, res) => {
  res.json({ achievements: listAchievements(req.user.id), streak: computeStreak(req.user.id) });
}));

analyticsRouter.get('/activity', asyncHandler(async (req, res) => {
  const q = validate(req.query, { limit: { type: 'number', integer: true, min: 1, max: 200, default: 50 } });
  const rows = plainAll(all('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?', [req.user.id, q.limit]));
  res.json({ activity: rows.map((r) => ({ id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, summary: r.summary, at: r.created_at, payload: safeJson(r.payload_json, {}) })) });
}));

/** Plain-language insights, ranked so the UI can show the top few. */
analyticsRouter.get('/insights', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const fmt = (minor) => {
    try {
      return new Intl.NumberFormat(req.user.locale || 'en-IN', {
        style: 'currency', currency: req.user.currency || 'INR', maximumFractionDigits: 0
      }).format((Number(minor) || 0) / 100);
    } catch {
      return `${req.user.currency} ${((Number(minor) || 0) / 100).toFixed(0)}`;
    }
  };
  const rows = liveExpenses(userId, { limit: 4000 });
  const analytic = toAnalyticRows(rows);
  const insights = [];

  const months = monthlyTotals(userId, 6);
  if (months.length >= 2) {
    const current = months.at(-1);
    const prev = months.at(-2);
    if (prev.total > 0) {
      const change = ((current.total - prev.total) / prev.total) * 100;
      if (Math.abs(change) >= 10) {
        insights.push({
          type: change > 0 ? 'warning' : 'positive',
          priority: Math.min(10, Math.abs(change) / 10),
          title: `Spending ${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(0)}% vs last month`,
          detail: `You are at ${fmt(current.total)} versus ${fmt(prev.total)} last month.`
        });
      }
    }
  }

  const anomalies = detectAnomalies(analytic.filter((r) => new Date(r.date) > new Date(Date.now() - 45 * DAY_MS)));
  for (const a of anomalies.slice(0, 3)) {
    insights.push({ type: 'warning', priority: 7, title: `Unusual ${a.category} spend`, detail: `${a.reason} on ${isoDay(a.date)}.`, expenseId: a.id });
  }

  const recurring = detectRecurring(analytic, { now });
  const soon = recurring.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 7);
  for (const r of soon.slice(0, 3)) {
    insights.push({ type: 'info', priority: 6, title: `${r.merchant} renews in ${r.daysUntil} day${r.daysUntil === 1 ? '' : 's'}`, detail: `Roughly ${fmt(r.amount)} every ${r.label.replace('ly', '')}.` });
  }
  if (recurring.length >= 3) {
    const annual = recurring.reduce((s, r) => s + r.annualCost, 0);
    insights.push({ type: 'info', priority: 5, title: `${recurring.length} subscriptions cost you ${fmt(annual)}/year`, detail: 'Cancelling the ones you forgot about is the fastest saving available.' });
  }

  const dupes = findDuplicates(analytic.filter((r) => new Date(r.date) > new Date(Date.now() - 30 * DAY_MS)));
  if (dupes.length) insights.push({ type: 'warning', priority: 8, title: `${dupes.length} possible duplicate entr${dupes.length === 1 ? 'y' : 'ies'}`, detail: 'Two identical charges landed close together — check if one was a retry.' });

  const budgets = plainAll(all(
    `SELECT b.amount_minor, b.alert_at_percent, c.name AS category, c.id AS category_id
     FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.user_id = ?`, [userId]));
  const monthStart = startOfMonth(now).toISOString();
  for (const b of budgets) {
    const spent = get('SELECT COALESCE(SUM(base_amount_minor),0) AS t FROM expenses WHERE user_id = ? AND category_id = ? AND deleted_at IS NULL AND is_income = 0 AND spent_at >= ?', [userId, b.category_id, monthStart])?.t ?? 0;
    const pct = b.amount_minor > 0 ? (spent / b.amount_minor) * 100 : 0;
    if (pct >= 100) insights.push({ type: 'danger', priority: 10, title: `${b.category} budget blown`, detail: `${pct.toFixed(0)}% of your ${b.category} budget used.` });
    else if (pct >= b.alert_at_percent) insights.push({ type: 'warning', priority: 8, title: `${b.category} budget ${pct.toFixed(0)}% used`, detail: 'Slow down to finish the month inside budget.' });
  }

  const streak = computeStreak(userId);
  if (streak.current >= 3) insights.push({ type: 'positive', priority: 4, title: `${streak.current}-day tracking streak`, detail: 'Consistency is what makes the forecasts accurate.' });

  const goals = plainAll(all('SELECT * FROM goals WHERE user_id = ?', [userId]));
  const surplus = (req.user.monthly_income_minor || 0) - (months.at(-1)?.total ?? 0);
  for (const g of goals.slice(0, 3)) {
    const p = goalProjection({ target: g.target_minor, saved: g.saved_minor, monthlySurplus: surplus, targetDate: g.target_date });
    if (p.status === 'stalled') insights.push({ type: 'warning', priority: 6, title: `"${g.name}" is not progressing`, detail: 'Your spending leaves no surplus this month.' });
    else if (p.status === 'active' && !p.onTrack) insights.push({ type: 'warning', priority: 6, title: `"${g.name}" is behind schedule`, detail: `Save about ${fmt(p.requiredPerMonth)}/month to hit your date.` });
  }

  if (!insights.length) insights.push({ type: 'info', priority: 1, title: 'Nothing unusual', detail: 'Your spending looks steady. Keep logging to unlock deeper insights.' });

  res.json({ insights: insights.sort((a, b) => b.priority - a.priority).slice(0, 12) });
}));

import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, plain, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { startOfMonth, endOfMonth, daysInMonth } from '../lib/dates.js';
import { audit, evaluateAchievements } from '../services/store.js';

export const budgetRouter = express.Router();

budgetRouter.get('/', asyncHandler(async (req, res) => {
  const now = new Date();
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();
  const dim = daysInMonth(now);
  const dayOfMonth = now.getUTCDate();
  const daysLeft = Math.max(0, dim - dayOfMonth + 1);

  const rows = plainAll(all(
    `SELECT b.*, c.name AS category, c.icon, c.color FROM budgets b
     LEFT JOIN categories c ON c.id = b.category_id WHERE b.user_id = ? ORDER BY b.amount_minor DESC`,
    [req.user.id]
  ));

  const budgets = rows.map((b) => {
    const spent = get(
      `SELECT COALESCE(SUM(base_amount_minor),0) AS t FROM expenses
       WHERE user_id = ? AND deleted_at IS NULL AND is_income = 0 AND spent_at BETWEEN ? AND ?
       ${b.category_id ? 'AND category_id = ?' : ''}`,
      b.category_id ? [req.user.id, monthStart, monthEnd, b.category_id] : [req.user.id, monthStart, monthEnd]
    )?.t ?? 0;

    const percent = b.amount_minor > 0 ? (spent / b.amount_minor) * 100 : 0;
    const remaining = b.amount_minor - spent;
    // Pace tells the user whether they're ahead of or behind a linear burn.
    const expectedByNow = (b.amount_minor / dim) * dayOfMonth;

    return {
      id: b.id,
      categoryId: b.category_id,
      category: b.category || 'Overall',
      icon: b.icon || '🎯',
      color: b.color || '#6366f1',
      amountMinor: b.amount_minor,
      spentMinor: spent,
      remainingMinor: remaining,
      percentUsed: Number(percent.toFixed(1)),
      alertAtPercent: b.alert_at_percent,
      rollover: Boolean(b.rollover),
      perDayLeftMinor: daysLeft > 0 ? Math.round(remaining / daysLeft) : 0,
      pace: spent > expectedByNow * 1.1 ? 'ahead' : spent < expectedByNow * 0.9 ? 'behind' : 'on-track',
      status: percent >= 100 ? 'over' : percent >= b.alert_at_percent ? 'warning' : 'ok'
    };
  });

  res.json({
    budgets,
    daysLeft,
    totals: {
      budgetedMinor: budgets.reduce((s, b) => s + b.amountMinor, 0),
      spentMinor: budgets.reduce((s, b) => s + b.spentMinor, 0)
    }
  });
}));

budgetRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    categoryId: { type: 'number', integer: true, min: 1 },
    amount: { type: 'number', required: true, min: 0, max: 1e9 },
    alertAtPercent: { type: 'number', integer: true, min: 10, max: 100, default: 80 },
    rollover: { type: 'boolean', default: false }
  });

  if (body.categoryId) {
    const cat = get('SELECT id FROM categories WHERE id = ? AND user_id = ?', [body.categoryId, req.user.id]);
    if (!cat) throw badRequest('That category does not belong to your account');
  }

  // A repeated budget for the same category is an update, not a duplicate.
  run(
    `INSERT INTO budgets (user_id, category_id, amount_minor, alert_at_percent, rollover)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, category_id) DO UPDATE SET
       amount_minor = excluded.amount_minor,
       alert_at_percent = excluded.alert_at_percent,
       rollover = excluded.rollover`,
    [req.user.id, body.categoryId ?? null, toMinor(body.amount), body.alertAtPercent, body.rollover ? 1 : 0]
  );

  audit(req.user.id, 'upsert', 'budget', body.categoryId ?? null, `Budget set to ${body.amount}`);
  const unlocked = evaluateAchievements(req.user.id);
  res.status(201).json({ ok: true, unlocked });
}));

budgetRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid budget id');
  const existing = get('SELECT id FROM budgets WHERE id = ? AND user_id = ?', [id, req.user.id]);
  if (!existing) throw notFound('Budget not found');
  run('DELETE FROM budgets WHERE id = ? AND user_id = ?', [id, req.user.id]);
  audit(req.user.id, 'delete', 'budget', id, 'Budget removed');
  res.json({ ok: true });
}));

import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, plain, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { goalProjection } from '../services/whatif.js';
import { startOfMonth } from '../lib/dates.js';
import { audit, evaluateAchievements } from '../services/store.js';

export const goalRouter = express.Router();

function monthlySurplus(user) {
  const monthStart = startOfMonth(new Date()).toISOString();
  const spent = get('SELECT COALESCE(SUM(base_amount_minor),0) AS t FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND is_income = 0 AND spent_at >= ?', [user.id, monthStart])?.t ?? 0;
  const earned = get('SELECT COALESCE(SUM(base_amount_minor),0) AS t FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND is_income = 1 AND spent_at >= ?', [user.id, monthStart])?.t ?? 0;
  const income = user.monthly_income_minor || earned;
  return income - spent;
}

goalRouter.get('/', asyncHandler(async (req, res) => {
  const surplus = monthlySurplus(req.user);
  const rows = plainAll(all('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]));
  res.json({
    monthlySurplusMinor: surplus,
    goals: rows.map((g) => ({
      id: g.id, name: g.name, targetMinor: g.target_minor, savedMinor: g.saved_minor,
      targetDate: g.target_date, createdAt: g.created_at,
      projection: goalProjection({ target: g.target_minor, saved: g.saved_minor, monthlySurplus: surplus, targetDate: g.target_date })
    }))
  });
}));

goalRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, min: 1, max: 60 },
    target: { type: 'number', required: true, min: 1, max: 1e9 },
    saved: { type: 'number', min: 0, max: 1e9, default: 0 },
    targetDate: { type: 'date' }
  });
  if (body.saved > body.target) throw badRequest('Saved amount cannot exceed the target');

  const result = run('INSERT INTO goals (user_id, name, target_minor, saved_minor, target_date) VALUES (?,?,?,?,?)',
    [req.user.id, body.name, toMinor(body.target), toMinor(body.saved), body.targetDate ?? null]);
  const id = Number(result.lastInsertRowid);
  audit(req.user.id, 'create', 'goal', id, `Created goal "${body.name}"`);
  const unlocked = evaluateAchievements(req.user.id);
  res.status(201).json({ goal: plain(get('SELECT * FROM goals WHERE id = ?', [id])), unlocked });
}));

goalRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid goal id');
  const existing = plain(get('SELECT * FROM goals WHERE id = ? AND user_id = ?', [id, req.user.id]));
  if (!existing) throw notFound('Goal not found');

  const body = validate(req.body, {
    name: { type: 'string', min: 1, max: 60 },
    target: { type: 'number', min: 1, max: 1e9 },
    saved: { type: 'number', min: 0, max: 1e9 },
    contribute: { type: 'number', min: -1e9, max: 1e9 },
    targetDate: { type: 'date' }
  });

  const sets = [];
  const params = [];
  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.target !== undefined) { sets.push('target_minor = ?'); params.push(toMinor(body.target)); }
  if (body.saved !== undefined) { sets.push('saved_minor = ?'); params.push(toMinor(body.saved)); }
  if (body.contribute !== undefined) {
    // Contributions are relative and must never push the balance negative.
    const next = Math.max(0, existing.saved_minor + toMinor(body.contribute));
    sets.push('saved_minor = ?'); params.push(next);
  }
  if (body.targetDate !== undefined) { sets.push('target_date = ?'); params.push(body.targetDate); }
  if (!sets.length) throw badRequest('No changes supplied');

  params.push(id, req.user.id);
  run(`UPDATE goals SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  audit(req.user.id, 'update', 'goal', id, `Updated goal "${existing.name}"`);
  const unlocked = evaluateAchievements(req.user.id);
  res.json({ goal: plain(get('SELECT * FROM goals WHERE id = ?', [id])), unlocked });
}));

goalRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid goal id');
  const existing = get('SELECT id FROM goals WHERE id = ? AND user_id = ?', [id, req.user.id]);
  if (!existing) throw notFound('Goal not found');
  run('DELETE FROM goals WHERE id = ? AND user_id = ?', [id, req.user.id]);
  audit(req.user.id, 'delete', 'goal', id, 'Goal removed');
  res.json({ ok: true });
}));

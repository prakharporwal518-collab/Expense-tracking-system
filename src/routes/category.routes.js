import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, plain, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { startOfMonth } from '../lib/dates.js';
import { audit } from '../services/store.js';

export const categoryRouter = express.Router();

categoryRouter.get('/', asyncHandler(async (req, res) => {
  const monthStart = startOfMonth(new Date()).toISOString();
  const rows = plainAll(all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id AND e.deleted_at IS NULL) AS usage_count,
            (SELECT COALESCE(SUM(e.base_amount_minor),0) FROM expenses e
              WHERE e.category_id = c.id AND e.deleted_at IS NULL AND e.spent_at >= ?) AS month_total
     FROM categories c WHERE c.user_id = ? ORDER BY c.kind, c.name`,
    [monthStart, req.user.id]
  ));
  res.json({
    categories: rows.map((c) => ({
      id: c.id, name: c.name, icon: c.icon, color: c.color, kind: c.kind,
      archived: Boolean(c.is_archived), usageCount: c.usage_count, monthTotalMinor: c.month_total
    }))
  });
}));

categoryRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, min: 1, max: 40 },
    icon: { type: 'string', max: 8, default: '💸' },
    color: { type: 'string', max: 9, pattern: /^#[0-9a-fA-F]{6}$/, message: 'color must be a hex value like #6366f1', default: '#6366f1' },
    kind: { type: 'string', enum: ['expense', 'income'], default: 'expense' }
  });

  const existing = get('SELECT id FROM categories WHERE user_id = ? AND lower(name) = lower(?)', [req.user.id, body.name]);
  if (existing) throw conflict('You already have a category with that name');

  const result = run('INSERT INTO categories (user_id, name, icon, color, kind) VALUES (?,?,?,?,?)',
    [req.user.id, body.name, body.icon, body.color, body.kind]);
  const id = Number(result.lastInsertRowid);
  audit(req.user.id, 'create', 'category', id, `Created category "${body.name}"`);
  res.status(201).json({ category: { id, ...body, archived: false, usageCount: 0, monthTotalMinor: 0 } });
}));

categoryRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid category id');
  const existing = plain(get('SELECT * FROM categories WHERE id = ? AND user_id = ?', [id, req.user.id]));
  if (!existing) throw notFound('Category not found');

  const body = validate(req.body, {
    name: { type: 'string', min: 1, max: 40 },
    icon: { type: 'string', max: 8 },
    color: { type: 'string', max: 9, pattern: /^#[0-9a-fA-F]{6}$/, message: 'color must be a hex value' },
    archived: { type: 'boolean' }
  });

  const sets = [];
  const params = [];
  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.icon !== undefined) { sets.push('icon = ?'); params.push(body.icon); }
  if (body.color !== undefined) { sets.push('color = ?'); params.push(body.color); }
  if (body.archived !== undefined) { sets.push('is_archived = ?'); params.push(body.archived ? 1 : 0); }
  if (!sets.length) throw badRequest('No changes supplied');

  params.push(id, req.user.id);
  run(`UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  audit(req.user.id, 'update', 'category', id, `Updated category "${existing.name}"`);
  res.json({ category: plain(get('SELECT * FROM categories WHERE id = ?', [id])) });
}));

categoryRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid category id');
  const existing = plain(get('SELECT * FROM categories WHERE id = ? AND user_id = ?', [id, req.user.id]));
  if (!existing) throw notFound('Category not found');

  const inUse = get('SELECT COUNT(*) AS n FROM expenses WHERE category_id = ? AND deleted_at IS NULL', [id])?.n ?? 0;
  // Deleting would orphan real history, so archive instead and say so plainly.
  if (inUse > 0) {
    run('UPDATE categories SET is_archived = 1 WHERE id = ? AND user_id = ?', [id, req.user.id]);
    audit(req.user.id, 'archive', 'category', id, `Archived category "${existing.name}"`);
    return res.json({ ok: true, archived: true, reason: `${inUse} expense(s) use this category, so it was archived rather than deleted.` });
  }

  run('DELETE FROM categories WHERE id = ? AND user_id = ?', [id, req.user.id]);
  audit(req.user.id, 'delete', 'category', id, `Deleted category "${existing.name}"`);
  res.json({ ok: true, archived: false });
}));

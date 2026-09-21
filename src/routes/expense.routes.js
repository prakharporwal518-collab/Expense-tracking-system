import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, tx, plain, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { PAYMENT_METHODS } from '../db/defaults.js';
import { parseExpenseText } from '../services/nlp.js';
import { trainModel, predict } from '../services/categorizer.js';
import { findDuplicates } from '../services/duplicates.js';
import { shapeExpense, liveExpenses, audit, evaluateAchievements, resolveCategoryId, safeJson } from '../services/store.js';

export const expenseRouter = express.Router();

const LIST_SCHEMA = {
  from: { type: 'date' },
  to: { type: 'date' },
  categoryId: { type: 'number', integer: true, min: 1 },
  search: { type: 'string', max: 100 },
  paymentMethod: { type: 'string', enum: PAYMENT_METHODS },
  type: { type: 'string', enum: ['expense', 'income', 'all'], default: 'all' },
  minAmount: { type: 'number', min: 0 },
  maxAmount: { type: 'number', min: 0 },
  tag: { type: 'string', max: 40 },
  limit: { type: 'number', integer: true, min: 1, max: 500, default: 100 },
  offset: { type: 'number', integer: true, min: 0, default: 0 },
  sort: { type: 'string', enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'], default: 'date_desc' },
  includeDeleted: { type: 'boolean', default: false }
};

const SORTS = {
  date_desc: 'e.spent_at DESC, e.id DESC',
  date_asc: 'e.spent_at ASC, e.id ASC',
  amount_desc: 'e.base_amount_minor DESC',
  amount_asc: 'e.base_amount_minor ASC'
};

expenseRouter.get('/', asyncHandler(async (req, res) => {
  const q = validate(req.query, LIST_SCHEMA);
  if (q.minAmount != null && q.maxAmount != null && q.minAmount > q.maxAmount) {
    throw badRequest('minAmount cannot be greater than maxAmount');
  }

  const where = ['e.user_id = ?'];
  const params = [req.user.id];
  if (!q.includeDeleted) where.push('e.deleted_at IS NULL');
  if (q.from) { where.push('e.spent_at >= ?'); params.push(q.from); }
  if (q.to) { where.push('e.spent_at <= ?'); params.push(q.to); }
  if (q.categoryId) { where.push('e.category_id = ?'); params.push(q.categoryId); }
  if (q.paymentMethod) { where.push('e.payment_method = ?'); params.push(q.paymentMethod); }
  if (q.type === 'expense') where.push('e.is_income = 0');
  if (q.type === 'income') where.push('e.is_income = 1');
  if (q.minAmount != null) { where.push('e.base_amount_minor >= ?'); params.push(toMinor(q.minAmount)); }
  if (q.maxAmount != null) { where.push('e.base_amount_minor <= ?'); params.push(toMinor(q.maxAmount)); }
  if (q.tag) { where.push('lower(e.tags_json) LIKE ?'); params.push(`%"${q.tag.toLowerCase()}"%`); }
  if (q.search) {
    where.push('(lower(e.merchant) LIKE ? OR lower(e.note) LIKE ?)');
    const like = `%${q.search.toLowerCase()}%`;
    params.push(like, like);
  }

  const whereSql = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN e.is_income = 0 THEN e.base_amount_minor ELSE 0 END),0) AS spent,
                            COALESCE(SUM(CASE WHEN e.is_income = 1 THEN e.base_amount_minor ELSE 0 END),0) AS earned
                     FROM expenses e WHERE ${whereSql}`, params);

  const rows = plainAll(all(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, c.kind AS category_kind
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
     WHERE ${whereSql} ORDER BY ${SORTS[q.sort]} LIMIT ? OFFSET ?`,
    [...params, q.limit, q.offset]
  ));

  res.json({
    expenses: rows.map(shapeExpense),
    pagination: { total: total.n, limit: q.limit, offset: q.offset, hasMore: q.offset + rows.length < total.n },
    totals: { spentMinor: total.spent, earnedMinor: total.earned, netMinor: total.earned - total.spent }
  });
}));

const WRITE_SCHEMA = {
  amount: { type: 'number', required: true, min: 0.01, max: 1e9 },
  categoryId: { type: 'number', integer: true, min: 1 },
  category: { type: 'string', max: 40 },
  merchant: { type: 'string', max: 120, default: '' },
  note: { type: 'string', max: 500, default: '' },
  paymentMethod: { type: 'string', enum: PAYMENT_METHODS, default: 'other' },
  currency: { type: 'string', min: 3, max: 3 },
  fxRate: { type: 'number', min: 0.000001, max: 100000, default: 1 },
  tags: { type: 'array', of: 'string', max: 10, default: () => [] },
  isIncome: { type: 'boolean', default: false },
  spentAt: { type: 'date', default: () => new Date().toISOString() }
};

function resolveCategory(req, body) {
  if (body.categoryId) {
    const cat = get('SELECT id FROM categories WHERE id = ? AND user_id = ?', [body.categoryId, req.user.id]);
    if (!cat) throw badRequest('That category does not belong to your account');
    return body.categoryId;
  }
  if (body.category) return resolveCategoryId(req.user.id, body.category, body.isIncome ? 'income' : 'expense');
  return null;
}

expenseRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, WRITE_SCHEMA);
  const amountMinor = toMinor(body.amount);
  if (amountMinor == null || amountMinor <= 0) throw badRequest('amount must be a positive number');

  const currency = (body.currency || req.user.currency).toUpperCase();
  const fxRate = currency === req.user.currency ? 1 : body.fxRate;
  const baseAmountMinor = Math.round(amountMinor * fxRate);
  const categoryId = resolveCategory(req, body);

  const result = tx(() => run(
    `INSERT INTO expenses (user_id, category_id, amount_minor, currency, fx_rate, base_amount_minor,
                           merchant, note, payment_method, tags_json, is_income, spent_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.id, categoryId, amountMinor, currency, fxRate, baseAmountMinor,
     body.merchant, body.note, body.paymentMethod, JSON.stringify(body.tags), body.isIncome ? 1 : 0, body.spentAt]
  ));

  const id = Number(result.lastInsertRowid);
  audit(req.user.id, 'create', 'expense', id, `Added ${body.isIncome ? 'income' : 'expense'} of ${body.amount}`, { amountMinor, merchant: body.merchant });
  const unlocked = evaluateAchievements(req.user.id);

  const row = plain(get(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = ?`, [id]));

  // Warn about a likely double-entry without blocking the save — the user decides.
  const recent = liveExpenses(req.user.id, { from: new Date(Date.now() - 3 * 86400000).toISOString(), limit: 60 })
    .map((r) => ({ id: r.id, amount: r.base_amount_minor, merchant: r.merchant, date: r.spent_at, category: r.category_name }));
  const dupes = findDuplicates(recent).filter((d) => d.duplicate.id === id || d.original.id === id);

  res.status(201).json({ expense: shapeExpense(row), unlocked, possibleDuplicate: dupes[0] || null });
}));

expenseRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid expense id');
  const row = plain(get(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
     WHERE e.id = ? AND e.user_id = ?`, [id, req.user.id]));
  if (!row) throw notFound('Expense not found');
  res.json({ expense: shapeExpense(row) });
}));

expenseRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid expense id');
  const existing = plain(get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [id, req.user.id]));
  if (!existing) throw notFound('Expense not found');
  if (existing.deleted_at) throw conflict('Restore this expense before editing it');

  const optional = Object.fromEntries(Object.entries(WRITE_SCHEMA).map(([k, v]) => [k, { ...v, required: false, default: undefined }]));
  const body = validate(req.body, optional);

  const sets = [];
  const params = [];
  const push = (col, val) => { sets.push(`${col} = ?`); params.push(val); };

  if (body.amount !== undefined) {
    const amountMinor = toMinor(body.amount);
    if (amountMinor == null || amountMinor <= 0) throw badRequest('amount must be a positive number');
    push('amount_minor', amountMinor);
    const fx = body.fxRate ?? existing.fx_rate;
    push('base_amount_minor', Math.round(amountMinor * fx));
  }
  if (body.currency !== undefined) push('currency', body.currency.toUpperCase());
  if (body.fxRate !== undefined) {
    push('fx_rate', body.fxRate);
    const amt = body.amount !== undefined ? toMinor(body.amount) : existing.amount_minor;
    push('base_amount_minor', Math.round(amt * body.fxRate));
  }
  if (body.merchant !== undefined) push('merchant', body.merchant);
  if (body.note !== undefined) push('note', body.note);
  if (body.paymentMethod !== undefined) push('payment_method', body.paymentMethod);
  if (body.tags !== undefined) push('tags_json', JSON.stringify(body.tags));
  if (body.isIncome !== undefined) push('is_income', body.isIncome ? 1 : 0);
  if (body.spentAt !== undefined) push('spent_at', body.spentAt);
  if (body.categoryId !== undefined || body.category !== undefined) {
    push('category_id', resolveCategory(req, { ...body, isIncome: body.isIncome ?? Boolean(existing.is_income) }));
  }
  if (!sets.length) throw badRequest('No changes supplied');

  sets.push("updated_at = datetime('now')");
  params.push(id, req.user.id);
  run(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  audit(req.user.id, 'update', 'expense', id, 'Expense edited', { before: { amount_minor: existing.amount_minor, merchant: existing.merchant } });

  const row = plain(get(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = ?`, [id]));
  res.json({ expense: shapeExpense(row) });
}));

/** Soft delete, so the UI can offer a real undo. */
expenseRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid expense id');
  const existing = plain(get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [id, req.user.id]));
  if (!existing) throw notFound('Expense not found');
  if (existing.deleted_at) return res.json({ ok: true, alreadyDeleted: true });

  run("UPDATE expenses SET deleted_at = datetime('now') WHERE id = ? AND user_id = ?", [id, req.user.id]);
  audit(req.user.id, 'delete', 'expense', id, `Deleted expense at ${existing.merchant || 'unknown'}`, { amount_minor: existing.amount_minor });
  res.json({ ok: true, undoToken: id });
}));

expenseRouter.post('/:id/restore', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Invalid expense id');
  const existing = plain(get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [id, req.user.id]));
  if (!existing) throw notFound('Expense not found');
  run('UPDATE expenses SET deleted_at = NULL WHERE id = ? AND user_id = ?', [id, req.user.id]);
  audit(req.user.id, 'restore', 'expense', id, 'Expense restored');
  const row = plain(get(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = ?`, [id]));
  res.json({ expense: shapeExpense(row) });
}));

/** Natural-language add: parse first, let the client confirm, then POST normally. */
expenseRouter.post('/parse', asyncHandler(async (req, res) => {
  const { text } = validate(req.body, { text: { type: 'string', required: true, min: 1, max: 400 } });
  const parsed = parseExpenseText(text);

  // Blend the personal Naive Bayes model with the keyword guess.
  const history = liveExpenses(req.user.id, { limit: 800 })
    .filter((r) => r.category_name)
    .map((r) => ({ text: `${r.merchant} ${r.note}`, category: r.category_name }));
  const model = trainModel(history);
  const ml = predict(model, text);

  const chosen = ml.category || parsed.fields.categoryGuess;
  const category = chosen ? plain(get('SELECT id, name, icon, color FROM categories WHERE user_id = ? AND lower(name) = lower(?)', [req.user.id, chosen])) : null;

  res.json({
    ...parsed,
    fields: {
      ...parsed.fields,
      categoryGuess: chosen,
      categoryId: category?.id ?? null,
      categoryIcon: category?.icon ?? null,
      categoryConfidence: Math.max(parsed.fields.categoryConfidence, ml.confidence || 0),
      categorySource: ml.source
    }
  });
}));

/** Suggests a category for a merchant/note pair as the user types. */
expenseRouter.post('/suggest-category', asyncHandler(async (req, res) => {
  const { text } = validate(req.body, { text: { type: 'string', required: true, min: 1, max: 200 } });
  const history = liveExpenses(req.user.id, { limit: 800 })
    .filter((r) => r.category_name)
    .map((r) => ({ text: `${r.merchant} ${r.note}`, category: r.category_name }));
  const prediction = predict(trainModel(history), text);
  const category = prediction.category
    ? plain(get('SELECT id, name, icon, color FROM categories WHERE user_id = ? AND lower(name) = lower(?)', [req.user.id, prediction.category]))
    : null;
  res.json({ ...prediction, categoryId: category?.id ?? null, icon: category?.icon ?? null, trainedOn: history.length });
}));

expenseRouter.get('/meta/tags', asyncHandler(async (req, res) => {
  const rows = liveExpenses(req.user.id, { limit: 5000 });
  const counts = new Map();
  for (const r of rows) for (const t of safeJson(r.tags_json, [])) counts.set(t, (counts.get(t) || 0) + 1);
  res.json({ tags: [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 50) });
}));

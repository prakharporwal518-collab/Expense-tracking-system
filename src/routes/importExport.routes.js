import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, tx, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest } from '../lib/errors.js';
import { toMinor, toMajor } from '../lib/money.js';
import { parseCsv, toCsv, detectColumns } from '../lib/csv.js';
import { PAYMENT_METHODS } from '../db/defaults.js';
import { liveExpenses, resolveCategoryId, audit, evaluateAchievements, safeJson } from '../services/store.js';
import { predict, trainModel } from '../services/categorizer.js';
import { isoDay } from '../lib/dates.js';

export const ioRouter = express.Router();

ioRouter.get('/export.csv', asyncHandler(async (req, res) => {
  const rows = liveExpenses(req.user.id, { limit: 20000 });
  const csv = toCsv(rows, [
    { key: 'spent_at', label: 'Date', get: (r) => isoDay(r.spent_at) },
    { key: 'amount', label: 'Amount', get: (r) => toMajor(r.amount_minor).toFixed(2) },
    { key: 'currency', label: 'Currency' },
    { key: 'category', label: 'Category', get: (r) => r.category_name || '' },
    { key: 'merchant', label: 'Merchant' },
    { key: 'note', label: 'Note' },
    { key: 'payment_method', label: 'PaymentMethod' },
    { key: 'is_income', label: 'IsIncome', get: (r) => (r.is_income ? 'yes' : 'no') },
    { key: 'tags', label: 'Tags', get: (r) => safeJson(r.tags_json, []).join('|') }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fintrack-${isoDay(new Date())}.csv"`);
  res.send(csv);
}));

ioRouter.get('/export.json', asyncHandler(async (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    user: { name: req.user.name, email: req.user.email, currency: req.user.currency },
    categories: plainAll(all('SELECT name, icon, color, kind FROM categories WHERE user_id = ?', [req.user.id])),
    budgets: plainAll(all('SELECT b.amount_minor, b.alert_at_percent, c.name AS category FROM budgets b LEFT JOIN categories c ON c.id=b.category_id WHERE b.user_id = ?', [req.user.id])),
    goals: plainAll(all('SELECT name, target_minor, saved_minor, target_date FROM goals WHERE user_id = ?', [req.user.id])),
    expenses: liveExpenses(req.user.id, { limit: 20000 }).map((r) => ({
      date: r.spent_at, amountMinor: r.amount_minor, currency: r.currency,
      category: r.category_name, merchant: r.merchant, note: r.note,
      paymentMethod: r.payment_method, isIncome: Boolean(r.is_income), tags: safeJson(r.tags_json, [])
    }))
  };
  res.setHeader('Content-Disposition', `attachment; filename="fintrack-${isoDay(new Date())}.json"`);
  res.json(payload);
}));

/**
 * Imports a CSV. Every row is validated independently: a bad row is reported
 * with its line number and skipped, so one malformed line never aborts an
 * otherwise-good import. `dryRun` previews the outcome before committing.
 */
ioRouter.post('/import/csv', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    csv: { type: 'string', required: true, min: 2, max: 5_000_000, trim: false },
    dryRun: { type: 'boolean', default: false },
    autoCategorise: { type: 'boolean', default: true }
  });

  const rows = parseCsv(body.csv);
  if (rows.length < 2) throw badRequest('CSV needs a header row and at least one data row');

  const header = rows[0];
  const cols = detectColumns(header);
  if (cols.amount === -1) throw badRequest('Could not find an "Amount" column', { detectedHeaders: header });

  const history = liveExpenses(req.user.id, { limit: 800 }).filter((r) => r.category_name)
    .map((r) => ({ text: `${r.merchant} ${r.note}`, category: r.category_name }));
  const model = trainModel(history);

  const parsed = [];
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const lineNo = i + 1;
    const pick = (idx) => (idx >= 0 && idx < cells.length ? String(cells[idx]).trim() : '');

    const rawAmount = pick(cols.amount).replace(/[^\d.\-]/g, '');
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      errors.push({ line: lineNo, reason: `Unreadable amount "${pick(cols.amount)}"` });
      continue;
    }

    const rawDate = pick(cols.date);
    let spentAt = rawDate ? new Date(rawDate) : new Date();
    if (Number.isNaN(spentAt.getTime())) {
      // Accept dd/mm/yyyy and dd-mm-yyyy, common in Indian bank exports.
      const m = rawDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        spentAt = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), 12));
      }
    }
    if (Number.isNaN(spentAt.getTime())) {
      errors.push({ line: lineNo, reason: `Unreadable date "${rawDate}"` });
      continue;
    }

    const merchant = pick(cols.merchant).slice(0, 120);
    const note = pick(cols.note).slice(0, 500);
    const incomeCell = pick(cols.isIncome).toLowerCase();
    const isIncome = ['yes', 'true', '1', 'credit', 'income', 'cr'].includes(incomeCell);

    let category = pick(cols.category).slice(0, 40);
    if (!category && body.autoCategorise) {
      category = predict(model, `${merchant} ${note}`).category || '';
    }

    const methodCell = pick(cols.paymentMethod).toLowerCase();
    const paymentMethod = PAYMENT_METHODS.includes(methodCell) ? methodCell : 'other';

    parsed.push({
      line: lineNo,
      amount: Math.abs(amount),
      spentAt: spentAt.toISOString(),
      merchant, note, category, paymentMethod, isIncome
    });
  }

  if (body.dryRun) {
    return res.json({
      dryRun: true,
      detectedColumns: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v >= 0 ? header[v] : null])),
      wouldImport: parsed.length,
      skipped: errors.length,
      errors: errors.slice(0, 50),
      preview: parsed.slice(0, 10)
    });
  }

  let imported = 0;
  tx(() => {
    for (const p of parsed) {
      const categoryId = p.category ? resolveCategoryId(req.user.id, p.category, p.isIncome ? 'income' : 'expense') : null;
      const amountMinor = toMinor(p.amount);
      run(
        `INSERT INTO expenses (user_id, category_id, amount_minor, currency, fx_rate, base_amount_minor,
                               merchant, note, payment_method, tags_json, is_income, spent_at)
         VALUES (?,?,?,?,1,?,?,?,?,'["imported"]',?,?)`,
        [req.user.id, categoryId, amountMinor, req.user.currency, amountMinor,
         p.merchant, p.note, p.paymentMethod, p.isIncome ? 1 : 0, p.spentAt]
      );
      imported++;
    }
  });

  audit(req.user.id, 'import', 'expense', null, `Imported ${imported} expenses from CSV`, { skipped: errors.length });
  const unlocked = evaluateAchievements(req.user.id);
  res.status(201).json({ imported, skipped: errors.length, errors: errors.slice(0, 50), unlocked });
}));

/** A monthly statement rendered as printable HTML — the browser handles PDF. */
ioRouter.get('/report/:month', asyncHandler(async (req, res) => {
  const month = String(req.params.month);
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Month must look like 2026-09');

  const from = `${month}-01T00:00:00.000Z`;
  const to = `${month}-31T23:59:59.999Z`;
  const rows = liveExpenses(req.user.id, { from, to, limit: 5000 });
  const spent = rows.filter((r) => !r.is_income).reduce((s, r) => s + r.base_amount_minor, 0);
  const earned = rows.filter((r) => r.is_income).reduce((s, r) => s + r.base_amount_minor, 0);

  const byCategory = new Map();
  for (const r of rows.filter((x) => !x.is_income)) {
    const key = r.category_name || 'Uncategorised';
    byCategory.set(key, (byCategory.get(key) || 0) + r.base_amount_minor);
  }

  res.json({
    month,
    currency: req.user.currency,
    summary: { spentMinor: spent, earnedMinor: earned, netMinor: earned - spent, transactions: rows.length },
    byCategory: [...byCategory.entries()].map(([category, total]) => ({ category, totalMinor: total })).sort((a, b) => b.totalMinor - a.totalMinor),
    expenses: rows.map((r) => ({
      date: isoDay(r.spent_at), amountMinor: r.amount_minor, category: r.category_name,
      merchant: r.merchant, note: r.note, isIncome: Boolean(r.is_income)
    }))
  });
}));

import { all, get, run, plainAll, plain } from '../db/index.js';
import { ACHIEVEMENTS } from '../db/defaults.js';
import { DAY_MS, isoDay } from '../lib/dates.js';

/** Shared data-access helpers used by several routers. */

export const liveExpenses = (userId, { from, to, limit = 5000 } = {}) => {
  const clauses = ['e.user_id = ?', 'e.deleted_at IS NULL'];
  const params = [userId];
  if (from) { clauses.push('e.spent_at >= ?'); params.push(from); }
  if (to) { clauses.push('e.spent_at <= ?'); params.push(to); }
  params.push(limit);
  return plainAll(all(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, c.kind AS category_kind
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.spent_at DESC, e.id DESC LIMIT ?`,
    params
  ));
};

export const shapeExpense = (row) => ({
  id: row.id,
  amountMinor: row.amount_minor,
  baseAmountMinor: row.base_amount_minor,
  currency: row.currency,
  fxRate: row.fx_rate,
  categoryId: row.category_id,
  category: row.category_name || null,
  categoryIcon: row.category_icon || '💸',
  categoryColor: row.category_color || '#64748b',
  merchant: row.merchant,
  note: row.note,
  paymentMethod: row.payment_method,
  tags: safeJson(row.tags_json, []),
  isIncome: Boolean(row.is_income),
  spentAt: row.spent_at,
  recurringId: row.recurring_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at
});

export function safeJson(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function audit(userId, action, entity, entityId, summary, payload = {}) {
  try {
    run('INSERT INTO audit_log (user_id, action, entity, entity_id, summary, payload_json) VALUES (?,?,?,?,?,?)',
      [userId, action, entity, entityId ?? null, summary, JSON.stringify(payload).slice(0, 8000)]);
  } catch {
    // Audit is best-effort; never fail the user's actual operation over it.
  }
}

/** Consecutive days (ending today or yesterday) with at least one expense. */
export function computeStreak(userId) {
  const rows = all(
    `SELECT DISTINCT date(spent_at) AS d FROM expenses
     WHERE user_id = ? AND deleted_at IS NULL ORDER BY d DESC LIMIT 400`, [userId]
  ).map((r) => r.d);
  if (!rows.length) return { current: 0, longest: 0, lastTracked: null };

  const daySet = new Set(rows);
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - DAY_MS));

  let current = 0;
  let cursor = daySet.has(today) ? new Date(today) : daySet.has(yesterday) ? new Date(yesterday) : null;
  while (cursor && daySet.has(isoDay(cursor))) {
    current++;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }

  let longest = 0;
  let streak = 0;
  let prev = null;
  for (const d of [...rows].reverse()) {
    if (prev && Math.round((new Date(d) - new Date(prev)) / DAY_MS) === 1) streak++;
    else streak = 1;
    longest = Math.max(longest, streak);
    prev = d;
  }
  return { current, longest, lastTracked: rows[0] };
}

export function unlock(userId, code) {
  const meta = ACHIEVEMENTS.find((a) => a.code === code);
  if (!meta) return null;
  const existing = get('SELECT id FROM achievements WHERE user_id = ? AND code = ?', [userId, code]);
  if (existing) return null;
  run('INSERT INTO achievements (user_id, code) VALUES (?, ?)', [userId, code]);
  audit(userId, 'unlock', 'achievement', null, `Unlocked "${meta.name}"`);
  return meta;
}

/** Re-evaluates every achievement rule; returns only the newly unlocked ones. */
export function evaluateAchievements(userId) {
  const fresh = [];
  const count = get('SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND deleted_at IS NULL', [userId])?.n ?? 0;
  const streak = computeStreak(userId);
  const budgets = get('SELECT COUNT(*) AS n FROM budgets WHERE user_id = ?', [userId])?.n ?? 0;
  const goals = plainAll(all('SELECT target_minor, saved_minor FROM goals WHERE user_id = ?', [userId]));
  const settled = get('SELECT COUNT(*) AS n FROM settlements s JOIN groups g ON g.id = s.group_id WHERE g.user_id = ?', [userId])?.n ?? 0;

  const rules = [
    [count >= 1, 'first_expense'],
    [count >= 10, 'ten_expenses'],
    [count >= 50, 'fifty_expenses'],
    [streak.current >= 7 || streak.longest >= 7, 'streak_7'],
    [streak.current >= 30 || streak.longest >= 30, 'streak_30'],
    [budgets >= 1, 'budget_set'],
    [goals.length >= 1, 'goal_created'],
    [goals.some((g) => g.saved_minor >= g.target_minor && g.target_minor > 0), 'goal_reached'],
    [settled >= 1, 'split_master']
  ];
  for (const [condition, code] of rules) {
    if (!condition) continue;
    const unlocked = unlock(userId, code);
    if (unlocked) fresh.push(unlocked);
  }
  return fresh;
}

export function listAchievements(userId) {
  const owned = new Map(plainAll(all('SELECT code, unlocked_at FROM achievements WHERE user_id = ?', [userId]))
    .map((r) => [r.code, r.unlocked_at]));
  return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: owned.has(a.code), unlockedAt: owned.get(a.code) || null }));
}

/** Ensures a category exists by name, creating it if the user is new to it. */
export function resolveCategoryId(userId, name, kind = 'expense') {
  if (!name) return null;
  const existing = get('SELECT id FROM categories WHERE user_id = ? AND lower(name) = lower(?)', [userId, name]);
  if (existing) return existing.id;
  const result = run('INSERT INTO categories (user_id, name, kind) VALUES (?, ?, ?)', [userId, name, kind]);
  return Number(result.lastInsertRowid);
}

export const getCategory = (userId, id) =>
  plain(get('SELECT * FROM categories WHERE id = ? AND user_id = ?', [id, userId]));

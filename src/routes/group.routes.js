import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, tx, plain, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { settlementPlan, resolveShares } from '../services/settle.js';
import { audit, evaluateAchievements } from '../services/store.js';

export const groupRouter = express.Router();

function ownedGroup(userId, groupId) {
  const group = plain(get('SELECT * FROM groups WHERE id = ? AND user_id = ?', [groupId, userId]));
  if (!group) throw notFound('Group not found');
  return group;
}

groupRouter.get('/', asyncHandler(async (req, res) => {
  const groups = plainAll(all('SELECT * FROM groups WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]));
  res.json({
    groups: groups.map((g) => {
      const members = plainAll(all('SELECT * FROM group_members WHERE group_id = ?', [g.id]));
      const expenses = plainAll(all('SELECT * FROM group_expenses WHERE group_id = ?', [g.id]));
      return {
        id: g.id, name: g.name, currency: g.currency, createdAt: g.created_at,
        memberCount: members.length,
        expenseCount: expenses.length,
        totalMinor: expenses.reduce((s, e) => s + e.amount_minor, 0)
      };
    })
  });
}));

groupRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, min: 1, max: 60 },
    members: { type: 'array', of: 'string', max: 30, required: true },
    currency: { type: 'string', min: 3, max: 3 }
  });
  if (body.members.length < 2) throw badRequest('A group needs at least 2 members');

  const id = tx(() => {
    const result = run('INSERT INTO groups (user_id, name, currency) VALUES (?,?,?)',
      [req.user.id, body.name, (body.currency || req.user.currency).toUpperCase()]);
    const groupId = Number(result.lastInsertRowid);
    body.members.forEach((name, i) => {
      run('INSERT INTO group_members (group_id, name, is_self) VALUES (?,?,?)', [groupId, name, i === 0 ? 1 : 0]);
    });
    return groupId;
  });

  audit(req.user.id, 'create', 'group', id, `Created group "${body.name}"`);
  res.status(201).json({ group: plain(get('SELECT * FROM groups WHERE id = ?', [id])) });
}));

groupRouter.get('/:id', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  const group = ownedGroup(req.user.id, groupId);

  const members = plainAll(all('SELECT * FROM group_members WHERE group_id = ? ORDER BY id', [groupId]));
  const expenses = plainAll(all('SELECT * FROM group_expenses WHERE group_id = ? ORDER BY spent_at DESC', [groupId]));
  const settlements = plainAll(all('SELECT * FROM settlements WHERE group_id = ? ORDER BY settled_at DESC', [groupId]));

  const plan = settlementPlan(members, expenses, settlements);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  res.json({
    group: { id: group.id, name: group.name, currency: group.currency, createdAt: group.created_at },
    members: members.map((m) => ({ id: m.id, name: m.name, isSelf: Boolean(m.is_self) })),
    expenses: expenses.map((e) => ({
      id: e.id, description: e.description, amountMinor: e.amount_minor,
      payerId: e.payer_id, payerName: nameOf.get(e.payer_id) || 'Unknown',
      splitMode: e.split_mode, spentAt: e.spent_at,
      shares: Object.fromEntries(resolveShares(members, e))
    })),
    settlements: settlements.map((s) => ({
      id: s.id, fromId: s.from_id, toId: s.to_id,
      fromName: nameOf.get(s.from_id), toName: nameOf.get(s.to_id),
      amountMinor: s.amount_minor, settledAt: s.settled_at
    })),
    ...plan,
    totalMinor: expenses.reduce((s, e) => s + e.amount_minor, 0)
  });
}));

groupRouter.post('/:id/members', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  ownedGroup(req.user.id, groupId);
  const body = validate(req.body, { name: { type: 'string', required: true, min: 1, max: 40 } });
  const result = run('INSERT INTO group_members (group_id, name) VALUES (?,?)', [groupId, body.name]);
  res.status(201).json({ member: { id: Number(result.lastInsertRowid), name: body.name, isSelf: false } });
}));

groupRouter.post('/:id/expenses', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  ownedGroup(req.user.id, groupId);

  const body = validate(req.body, {
    description: { type: 'string', required: true, min: 1, max: 120 },
    amount: { type: 'number', required: true, min: 0.01, max: 1e9 },
    payerId: { type: 'number', integer: true, required: true, min: 1 },
    splitMode: { type: 'string', enum: ['equal', 'shares', 'exact'], default: 'equal' },
    shares: { type: 'object', default: () => ({}) },
    spentAt: { type: 'date', default: () => new Date().toISOString() }
  });

  const members = plainAll(all('SELECT id FROM group_members WHERE group_id = ?', [groupId]));
  const memberIds = new Set(members.map((m) => m.id));
  if (!memberIds.has(body.payerId)) throw badRequest('The payer must be a member of this group');

  const amountMinor = toMinor(body.amount);
  if (amountMinor == null || amountMinor <= 0) throw badRequest('amount must be a positive number');

  // Shares are keyed by member id; reject unknown ids rather than silently dropping them.
  const sharesMinor = {};
  for (const [key, value] of Object.entries(body.shares || {})) {
    const memberId = Number(key);
    if (!memberIds.has(memberId)) throw badRequest(`Member ${key} is not in this group`);
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) throw badRequest('Share values must be non-negative numbers');
    sharesMinor[memberId] = body.splitMode === 'exact' ? toMinor(num) : num;
  }

  if (body.splitMode === 'exact') {
    const sum = Object.values(sharesMinor).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - amountMinor) > 100) {
      throw badRequest(`Exact shares add up to ${(sum / 100).toFixed(2)} but the expense is ${body.amount}`);
    }
  }
  if (body.splitMode !== 'equal' && !Object.keys(sharesMinor).length) {
    throw badRequest(`splitMode "${body.splitMode}" requires a shares object`);
  }

  const result = run(
    `INSERT INTO group_expenses (group_id, payer_id, description, amount_minor, split_mode, shares_json, spent_at)
     VALUES (?,?,?,?,?,?,?)`,
    [groupId, body.payerId, body.description, amountMinor, body.splitMode, JSON.stringify(sharesMinor), body.spentAt]
  );
  audit(req.user.id, 'create', 'group_expense', Number(result.lastInsertRowid), `Added "${body.description}" to group`);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
}));

groupRouter.delete('/:id/expenses/:expenseId', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  const expenseId = Number(req.params.expenseId);
  if (!Number.isInteger(groupId) || !Number.isInteger(expenseId)) throw badRequest('Invalid id');
  ownedGroup(req.user.id, groupId);
  const existing = get('SELECT id FROM group_expenses WHERE id = ? AND group_id = ?', [expenseId, groupId]);
  if (!existing) throw notFound('Group expense not found');
  run('DELETE FROM group_expenses WHERE id = ? AND group_id = ?', [expenseId, groupId]);
  res.json({ ok: true });
}));

groupRouter.post('/:id/settle', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  ownedGroup(req.user.id, groupId);

  const body = validate(req.body, {
    fromId: { type: 'number', integer: true, required: true, min: 1 },
    toId: { type: 'number', integer: true, required: true, min: 1 },
    amount: { type: 'number', required: true, min: 0.01, max: 1e9 }
  });
  if (body.fromId === body.toId) throw badRequest('A member cannot settle with themselves');

  const members = plainAll(all('SELECT id FROM group_members WHERE group_id = ?', [groupId]));
  const ids = new Set(members.map((m) => m.id));
  if (!ids.has(body.fromId) || !ids.has(body.toId)) throw badRequest('Both members must belong to this group');

  run('INSERT INTO settlements (group_id, from_id, to_id, amount_minor) VALUES (?,?,?,?)',
    [groupId, body.fromId, body.toId, toMinor(body.amount)]);
  audit(req.user.id, 'settle', 'group', groupId, `Recorded a settlement of ${body.amount}`);
  const unlocked = evaluateAchievements(req.user.id);
  res.status(201).json({ ok: true, unlocked });
}));

groupRouter.delete('/:id', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  const group = ownedGroup(req.user.id, groupId);
  run('DELETE FROM groups WHERE id = ? AND user_id = ?', [groupId, req.user.id]);
  audit(req.user.id, 'delete', 'group', groupId, `Deleted group "${group.name}"`);
  res.json({ ok: true });
}));

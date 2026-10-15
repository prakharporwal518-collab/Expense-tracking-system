import crypto from 'node:crypto';
import express from 'express';
import { validate } from '../lib/validate.js';
import { all, get, run, tx, plain, plainAll } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { settlementPlan, resolveShares } from '../services/settle.js';
import { baseUrl } from '../lib/mailer.js';
import { audit, evaluateAchievements } from '../services/store.js';

export const groupRouter = express.Router();

/** Owner-only operations: renaming, deleting, inviting, removing members. */
async function ownedGroup(userId, groupId) {
  const group = plain(await get('SELECT * FROM groups WHERE id = ? AND user_id = ?', [groupId, userId]));
  if (!group) throw notFound('Group not found');
  return group;
}

/**
 * A group is reachable by its owner and by anyone holding a member slot linked
 * to their account. Returning the role lets each route decide what that person
 * is allowed to change.
 */
async function accessibleGroup(userId, groupId) {
  const group = plain(await get('SELECT * FROM groups WHERE id = ?', [groupId]));
  if (!group) throw notFound('Group not found');
  if (group.user_id === userId) return { group, role: 'owner' };

  const membership = await get('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  // Not found rather than forbidden: a stranger should not learn the group exists.
  if (!membership) throw notFound('Group not found');
  return { group, role: 'member', memberId: membership.id };
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const INVITE_TTL_DAYS = 14;

groupRouter.get('/', asyncHandler(async (req, res) => {
  const groups = plainAll(await all(
    `SELECT g.* FROM groups g
     WHERE g.user_id = ?
        OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.user_id = ?)
     ORDER BY g.created_at DESC`,
    [req.user.id, req.user.id]
  ));
  const summaries = [];
  for (const g of groups) {
    const members = plainAll(await all('SELECT * FROM group_members WHERE group_id = ?', [g.id]));
    const expenses = plainAll(await all('SELECT * FROM group_expenses WHERE group_id = ?', [g.id]));
    summaries.push({
      id: g.id, name: g.name, currency: g.currency, createdAt: g.created_at,
      role: g.user_id === req.user.id ? 'owner' : 'member',
      sharedWithCount: members.filter((m) => m.user_id).length,
      memberCount: members.length,
      expenseCount: expenses.length,
      totalMinor: expenses.reduce((s, e) => s + e.amount_minor, 0)
    });
  }
  res.json({ groups: summaries });
}));

groupRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, min: 1, max: 60 },
    members: { type: 'array', of: 'string', max: 30, required: true },
    currency: { type: 'string', min: 3, max: 3 }
  });
  if (body.members.length < 2) throw badRequest('A group needs at least 2 members');

  const id = await tx(async () => {
    const result = await run('INSERT INTO groups (user_id, name, currency) VALUES (?,?,?)',
      [req.user.id, body.name, (body.currency || req.user.currency).toUpperCase()]);
    const groupId = Number(result.lastInsertRowid);
    for (const [i, name] of body.members.entries()) {
      // The first slot is the creator's own, so link it to their account up front.
      await run('INSERT INTO group_members (group_id, name, is_self, user_id) VALUES (?,?,?,?)',
        [groupId, name, i === 0 ? 1 : 0, i === 0 ? req.user.id : null]);
    }
    return groupId;
  });

  await audit(req.user.id, 'create', 'group', id, `Created group "${body.name}"`);
  res.status(201).json({ group: plain(await get('SELECT * FROM groups WHERE id = ?', [id])) });
}));

groupRouter.get('/:id', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  const { group, role } = await accessibleGroup(req.user.id, groupId);

  const members = plainAll(await all('SELECT * FROM group_members WHERE group_id = ? ORDER BY id', [groupId]));
  const expenses = plainAll(await all('SELECT * FROM group_expenses WHERE group_id = ? ORDER BY spent_at DESC', [groupId]));
  const settlements = plainAll(await all('SELECT * FROM settlements WHERE group_id = ? ORDER BY settled_at DESC', [groupId]));

  const plan = settlementPlan(members, expenses, settlements);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  res.json({
    group: { id: group.id, name: group.name, currency: group.currency, createdAt: group.created_at },
    role,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      // "You" is whichever slot this account holds, not simply the first one.
      isSelf: m.user_id ? m.user_id === req.user.id : Boolean(m.is_self) && group.user_id === req.user.id,
      linked: Boolean(m.user_id)
    })),
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
  await ownedGroup(req.user.id, groupId);
  const body = validate(req.body, { name: { type: 'string', required: true, min: 1, max: 40 } });
  const result = await run('INSERT INTO group_members (group_id, name) VALUES (?,?)', [groupId, body.name]);
  res.status(201).json({ member: { id: Number(result.lastInsertRowid), name: body.name, isSelf: false } });
}));

groupRouter.post('/:id/expenses', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  await accessibleGroup(req.user.id, groupId);

  const body = validate(req.body, {
    description: { type: 'string', required: true, min: 1, max: 120 },
    amount: { type: 'number', required: true, min: 0.01, max: 1e9 },
    payerId: { type: 'number', integer: true, required: true, min: 1 },
    splitMode: { type: 'string', enum: ['equal', 'shares', 'exact'], default: 'equal' },
    shares: { type: 'object', default: () => ({}) },
    spentAt: { type: 'date', default: () => new Date().toISOString() }
  });

  const members = plainAll(await all('SELECT id FROM group_members WHERE group_id = ?', [groupId]));
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

  const result = await run(
    `INSERT INTO group_expenses (group_id, payer_id, description, amount_minor, split_mode, shares_json, spent_at)
     VALUES (?,?,?,?,?,?,?)`,
    [groupId, body.payerId, body.description, amountMinor, body.splitMode, JSON.stringify(sharesMinor), body.spentAt]
  );
  await audit(req.user.id, 'create', 'group_expense', Number(result.lastInsertRowid), `Added "${body.description}" to group`);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
}));

groupRouter.delete('/:id/expenses/:expenseId', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  const expenseId = Number(req.params.expenseId);
  if (!Number.isInteger(groupId) || !Number.isInteger(expenseId)) throw badRequest('Invalid id');
  await accessibleGroup(req.user.id, groupId);
  const existing = await get('SELECT id FROM group_expenses WHERE id = ? AND group_id = ?', [expenseId, groupId]);
  if (!existing) throw notFound('Group expense not found');
  await run('DELETE FROM group_expenses WHERE id = ? AND group_id = ?', [expenseId, groupId]);
  res.json({ ok: true });
}));

groupRouter.post('/:id/settle', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  await accessibleGroup(req.user.id, groupId);

  const body = validate(req.body, {
    fromId: { type: 'number', integer: true, required: true, min: 1 },
    toId: { type: 'number', integer: true, required: true, min: 1 },
    amount: { type: 'number', required: true, min: 0.01, max: 1e9 }
  });
  if (body.fromId === body.toId) throw badRequest('A member cannot settle with themselves');

  const members = plainAll(await all('SELECT id FROM group_members WHERE group_id = ?', [groupId]));
  const ids = new Set(members.map((m) => m.id));
  if (!ids.has(body.fromId) || !ids.has(body.toId)) throw badRequest('Both members must belong to this group');

  await run('INSERT INTO settlements (group_id, from_id, to_id, amount_minor) VALUES (?,?,?,?)',
    [groupId, body.fromId, body.toId, toMinor(body.amount)]);
  await audit(req.user.id, 'settle', 'group', groupId, `Recorded a settlement of ${body.amount}`);
  const unlocked = await evaluateAchievements(req.user.id);
  res.status(201).json({ ok: true, unlocked });
}));

groupRouter.delete('/:id', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  const group = await ownedGroup(req.user.id, groupId);
  await run('DELETE FROM groups WHERE id = ? AND user_id = ?', [groupId, req.user.id]);
  await audit(req.user.id, 'delete', 'group', groupId, `Deleted group "${group.name}"`);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Invitations — turning a name on a list into a real participant      */
/* ------------------------------------------------------------------ */

/** Only the owner can issue an invite link. */
groupRouter.post('/:id/invite', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  await ownedGroup(req.user.id, groupId);

  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();

  // One live invite per group: issuing a new link retires the previous one.
  await run('UPDATE group_invites SET revoked_at = ? WHERE group_id = ? AND revoked_at IS NULL',
    [new Date().toISOString(), groupId]);
  await run('INSERT INTO group_invites (group_id, token_hash, created_by, expires_at) VALUES (?,?,?,?)',
    [groupId, hashToken(token), req.user.id, expiresAt]);

  await audit(req.user.id, 'create', 'group_invite', groupId, 'Created a group invite link');
  res.status(201).json({ token, url: `${baseUrl(req)}/join?invite=${encodeURIComponent(token)}`, expiresAt });
}));

groupRouter.delete('/:id/invite', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) throw badRequest('Invalid group id');
  await ownedGroup(req.user.id, groupId);
  await run('UPDATE group_invites SET revoked_at = ? WHERE group_id = ? AND revoked_at IS NULL',
    [new Date().toISOString(), groupId]);
  res.json({ ok: true });
}));

async function resolveInvite(token) {
  const invite = plain(await get('SELECT * FROM group_invites WHERE token_hash = ?', [hashToken(String(token || ''))]));
  if (!invite) return { ok: false, reason: 'unknown' };
  if (invite.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(invite.expires_at) <= new Date()) return { ok: false, reason: 'expired' };
  return { ok: true, invite };
}

/** Preview before joining: which group, and which seats are still free. */
groupRouter.get('/invite/:token', asyncHandler(async (req, res) => {
  const { ok, reason, invite } = await resolveInvite(req.params.token);
  if (!ok) return res.json({ valid: false, reason });

  const group = plain(await get('SELECT * FROM groups WHERE id = ?', [invite.group_id]));
  if (!group) return res.json({ valid: false, reason: 'unknown' });

  const members = plainAll(await all('SELECT * FROM group_members WHERE group_id = ? ORDER BY id', [invite.group_id]));
  const mine = members.find((m) => m.user_id === req.user.id);

  res.json({
    valid: true,
    alreadyJoined: Boolean(mine) || group.user_id === req.user.id,
    group: { id: group.id, name: group.name, currency: group.currency },
    openSlots: members.filter((m) => !m.user_id).map((m) => ({ id: m.id, name: m.name })),
    memberCount: members.length
  });
}));

/**
 * Joining claims one of the existing unclaimed names (so the history already
 * recorded against "Aman" becomes Aman's), or adds a new member slot.
 */
groupRouter.post('/invite/:token/accept', asyncHandler(async (req, res) => {
  const { ok, reason, invite } = await resolveInvite(req.params.token);
  if (!ok) throw badRequest(`That invite link is ${reason === 'unknown' ? 'not valid' : reason}.`);

  const body = validate(req.body, {
    memberId: { type: 'number', integer: true, min: 1 },
    name: { type: 'string', max: 40 }
  });

  const group = plain(await get('SELECT * FROM groups WHERE id = ?', [invite.group_id]));
  if (!group) throw notFound('Group not found');

  const existing = await get('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [invite.group_id, req.user.id]);
  if (existing || group.user_id === req.user.id) {
    return res.json({ ok: true, alreadyJoined: true, groupId: invite.group_id });
  }

  let memberId;
  if (body.memberId) {
    const slot = plain(await get('SELECT * FROM group_members WHERE id = ? AND group_id = ?', [body.memberId, invite.group_id]));
    if (!slot) throw badRequest('That member is not part of this group');
    if (slot.user_id) throw conflict('Someone has already claimed that name');
    await run('UPDATE group_members SET user_id = ? WHERE id = ?', [req.user.id, slot.id]);
    memberId = slot.id;
  } else {
    const name = (body.name || req.user.name).trim().slice(0, 40) || req.user.name;
    const inserted = await run('INSERT INTO group_members (group_id, name, is_self, user_id) VALUES (?,?,0,?)',
      [invite.group_id, name, req.user.id]);
    memberId = Number(inserted.lastInsertRowid);
  }

  await audit(req.user.id, 'join', 'group', invite.group_id, `Joined group "${group.name}"`);
  res.status(201).json({ ok: true, groupId: invite.group_id, memberId, groupName: group.name });
}));

/** Unlinks a person from the group without deleting the shared history. */
groupRouter.delete('/:id/members/:memberId', asyncHandler(async (req, res) => {
  const groupId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(groupId) || !Number.isInteger(memberId)) throw badRequest('Invalid id');
  await ownedGroup(req.user.id, groupId);

  const member = plain(await get('SELECT * FROM group_members WHERE id = ? AND group_id = ?', [memberId, groupId]));
  if (!member) throw notFound('Member not found');
  if (!member.user_id) throw badRequest('That member has not joined, so there is nothing to unlink');

  await run('UPDATE group_members SET user_id = NULL WHERE id = ?', [memberId]);
  await audit(req.user.id, 'update', 'group', groupId, `Unlinked ${member.name} from the group`);
  res.json({ ok: true });
}));

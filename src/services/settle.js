import { splitEvenly, splitByWeights } from '../lib/money.js';

/**
 * Group debt simplification — the "min cash flow" problem.
 *
 * Naively, N people who paid for each other owe up to N*(N-1) transfers.
 * Instead we reduce every person to a single net balance (paid - owed), then
 * greedily match the biggest creditor with the biggest debtor and settle
 * min(|debt|, credit) between them. Each match zeroes out at least one person,
 * so this always finishes in at most N-1 transfers.
 *
 * Greedy is not guaranteed optimal (the true minimum is NP-hard — it is
 * equivalent to a set-partition problem), but it is within one transfer of
 * optimal in practice and runs in O(N log N) per round.
 */
export function computeBalances(members, expenses) {
  const balance = new Map(members.map((m) => [m.id, 0]));

  for (const exp of expenses) {
    if (!balance.has(exp.payer_id)) continue;
    const shares = resolveShares(members, exp);
    balance.set(exp.payer_id, balance.get(exp.payer_id) + exp.amount_minor);
    for (const [memberId, owed] of shares) {
      if (!balance.has(memberId)) continue;
      balance.set(memberId, balance.get(memberId) - owed);
    }
  }
  return balance;
}

/** Returns Map(memberId -> minor units owed) that always sums to the total. */
export function resolveShares(members, exp) {
  const parsed = safeParse(exp.shares_json);
  const out = new Map();

  if (exp.split_mode === 'exact' && parsed && Object.keys(parsed).length) {
    let sum = 0;
    for (const [id, amount] of Object.entries(parsed)) {
      const v = Math.round(Number(amount) || 0);
      out.set(Number(id), v);
      sum += v;
    }
    // Absorb any mismatch into the largest share rather than silently losing money.
    const diff = exp.amount_minor - sum;
    if (diff !== 0 && out.size) {
      const largest = [...out.entries()].sort((a, b) => b[1] - a[1])[0][0];
      out.set(largest, out.get(largest) + diff);
    }
    return out;
  }

  if (exp.split_mode === 'shares' && parsed && Object.keys(parsed).length) {
    const ids = Object.keys(parsed).map(Number);
    const weights = ids.map((id) => Math.max(0, Number(parsed[id]) || 0));
    const amounts = splitByWeights(exp.amount_minor, weights);
    ids.forEach((id, i) => out.set(id, amounts[i]));
    return out;
  }

  const ids = members.map((m) => m.id);
  const amounts = splitEvenly(exp.amount_minor, ids.length);
  ids.forEach((id, i) => out.set(id, amounts[i]));
  return out;
}

function safeParse(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function simplifyDebts(balanceMap, { epsilon = 1 } = {}) {
  const debtors = [];
  const creditors = [];
  for (const [id, amount] of balanceMap) {
    if (amount < -epsilon) debtors.push({ id, amount: -amount });
    else if (amount > epsilon) creditors.push({ id, amount });
  }

  const transfers = [];
  let guard = 0;
  const maxRounds = debtors.length + creditors.length + 2;

  while (debtors.length && creditors.length && guard++ < maxRounds) {
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);
    const debtor = debtors[0];
    const creditor = creditors[0];
    const amount = Math.min(debtor.amount, creditor.amount);

    transfers.push({ from: debtor.id, to: creditor.id, amount_minor: amount });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount <= epsilon) debtors.shift();
    if (creditor.amount <= epsilon) creditors.shift();
  }

  return transfers;
}

export function settlementPlan(members, expenses, settlements = []) {
  const balance = computeBalances(members, expenses);
  // Money already handed over shifts the balances before we simplify.
  for (const s of settlements) {
    if (balance.has(s.from_id)) balance.set(s.from_id, balance.get(s.from_id) + s.amount_minor);
    if (balance.has(s.to_id)) balance.set(s.to_id, balance.get(s.to_id) - s.amount_minor);
  }

  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const transfers = simplifyDebts(balance).map((t) => ({
    ...t,
    fromName: nameOf.get(t.from) || 'Unknown',
    toName: nameOf.get(t.to) || 'Unknown'
  }));

  const naiveCount = expenses.reduce((acc, e) => acc + Math.max(0, members.length - 1), 0);

  return {
    balances: members.map((m) => ({ id: m.id, name: m.name, net_minor: balance.get(m.id) ?? 0 })),
    transfers,
    transferCount: transfers.length,
    naiveTransferCount: naiveCount,
    saved: Math.max(0, naiveCount - transfers.length)
  };
}

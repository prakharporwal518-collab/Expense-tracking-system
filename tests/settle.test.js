import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementPlan, computeBalances, simplifyDebts } from '../src/services/settle.js';

const members = [
  { id: 1, name: 'Prakhar' }, { id: 2, name: 'Aman' },
  { id: 3, name: 'Riya' }, { id: 4, name: 'Sana' }
];

test('balances always sum to zero', () => {
  const expenses = [
    { payer_id: 1, amount_minor: 120000, split_mode: 'equal', shares_json: '{}' },
    { payer_id: 2, amount_minor: 80000, split_mode: 'equal', shares_json: '{}' },
    { payer_id: 3, amount_minor: 40001, split_mode: 'equal', shares_json: '{}' } // odd amount
  ];
  const balances = computeBalances(members, expenses);
  assert.equal([...balances.values()].reduce((a, b) => a + b, 0), 0);
});

test('settlement needs at most n-1 transfers', () => {
  const expenses = [
    { payer_id: 1, amount_minor: 120000, split_mode: 'equal', shares_json: '{}' },
    { payer_id: 2, amount_minor: 80000, split_mode: 'equal', shares_json: '{}' },
    { payer_id: 3, amount_minor: 40000, split_mode: 'equal', shares_json: '{}' },
    { payer_id: 1, amount_minor: 60000, split_mode: 'shares', shares_json: JSON.stringify({ 1: 1, 2: 1, 3: 2 }) }
  ];
  const plan = settlementPlan(members, expenses);
  assert.ok(plan.transferCount <= members.length - 1, `${plan.transferCount} transfers`);
  assert.equal(plan.balances.reduce((a, b) => a + b.net_minor, 0), 0);
});

test('transfers actually clear every debt', () => {
  const expenses = [
    { payer_id: 1, amount_minor: 99999, split_mode: 'equal', shares_json: '{}' },
    { payer_id: 4, amount_minor: 50001, split_mode: 'equal', shares_json: '{}' }
  ];
  const plan = settlementPlan(members, expenses);
  const net = new Map(plan.balances.map((b) => [b.id, b.net_minor]));
  for (const t of plan.transfers) {
    net.set(t.from, net.get(t.from) + t.amount_minor);
    net.set(t.to, net.get(t.to) - t.amount_minor);
  }
  for (const [id, v] of net) assert.ok(Math.abs(v) <= 1, `member ${id} left with ${v}`);
});

test('already-recorded settlements shift the plan', () => {
  const expenses = [{ payer_id: 1, amount_minor: 40000, split_mode: 'equal', shares_json: '{}' }];
  const before = settlementPlan(members, expenses);
  const after = settlementPlan(members, expenses, [{ from_id: 2, to_id: 1, amount_minor: 10000 }]);
  assert.ok(after.transferCount <= before.transferCount);
});

test('exact splits that do not add up are absorbed, not lost', () => {
  const expenses = [{ payer_id: 1, amount_minor: 10000, split_mode: 'exact', shares_json: JSON.stringify({ 1: 3000, 2: 3000 }) }];
  const balances = computeBalances(members, expenses);
  assert.equal([...balances.values()].reduce((a, b) => a + b, 0), 0);
});

test('malformed shares json does not crash the split', () => {
  const expenses = [{ payer_id: 1, amount_minor: 10000, split_mode: 'shares', shares_json: 'not json' }];
  assert.doesNotThrow(() => computeBalances(members, expenses));
});

test('simplifyDebts returns nothing when everyone is square', () => {
  assert.deepEqual(simplifyDebts(new Map([[1, 0], [2, 0]])), []);
});

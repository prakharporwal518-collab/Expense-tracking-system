import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpenseText } from '../src/services/nlp.js';

const NOW = new Date('2026-09-21T10:00:00Z');
const parse = (text) => parseExpenseText(text, { now: NOW });

test('extracts amount, merchant, category, date and method', () => {
  const r = parse('380 lunch at dominos yesterday upi #team');
  assert.equal(r.ok, true);
  assert.equal(r.fields.amountMinor, 38000);
  assert.equal(r.fields.merchant, 'Dominos');
  assert.equal(r.fields.categoryGuess, 'Food');
  assert.equal(r.fields.paymentMethod, 'upi');
  assert.equal(r.fields.spentAt.slice(0, 10), '2026-09-20');
  assert.deepEqual(r.fields.tags, ['team']);
});

test('does not read a word beginning with "cr" as the crore multiplier', () => {
  // "credited" once matched the `cr` suffix, inflating 45000 by 10 million and
  // letting the year in the date win as the amount instead.
  const r = parse('salary 45000 credited on 2026-09-01');
  assert.equal(r.fields.amountMinor, 4_500_000);
  assert.equal(r.fields.isIncome, true);
});

test('handles k and lakh multipliers', () => {
  assert.equal(parse('1.2k uber ride').fields.amountMinor, 120000);
  assert.equal(parse('1.5 lakh rent').fields.amountMinor, 15_000_000);
});

test('prefers an explicit "at X" merchant over a known brand', () => {
  assert.equal(parse('90 at the corner chai stall today cash').fields.merchant, 'The Corner Chai Stall');
});

test('falls back to a brand when there is no positional cue', () => {
  assert.equal(parse('1200 uber to airport').fields.merchant, 'Uber');
});

test('does not treat a generic word as a merchant', () => {
  assert.equal(parse('15000 rent transfer').fields.merchant, '');
});

test('reports failure instead of guessing when there is no amount', () => {
  const r = parse('hello there');
  assert.equal(r.ok, false);
  assert.match(r.reason, /amount/i);
});

test('relative dates resolve correctly', () => {
  assert.equal(parse('100 coffee 3 days ago').fields.spentAt.slice(0, 10), '2026-09-18');
  assert.equal(parse('100 coffee today').fields.spentAt.slice(0, 10), '2026-09-21');
});

test('never throws on hostile input', () => {
  for (const s of ['', '   ', '#'.repeat(500), '<script>alert(1)</script>', '999999999999999999999', '₹₹₹']) {
    assert.doesNotThrow(() => parseExpenseText(s, { now: NOW }));
  }
});

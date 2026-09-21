import { DAY_MS } from '../lib/dates.js';
import { normaliseMerchant } from './recurring.js';

/**
 * Flags probable double-entries: the same amount at the same merchant within a
 * short window. Common when a UPI app retries, or when both partners log the
 * same shared bill.
 */
export function findDuplicates(expenses, { windowHours = 48, amountTolerance = 0.01 } = {}) {
  const sorted = [...expenses].sort((a, b) => new Date(a.date) - new Date(b.date));
  const windowMs = windowHours * 3600 * 1000;
  const pairs = [];

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const gap = new Date(sorted[j].date) - new Date(sorted[i].date);
      if (gap > windowMs) break; // sorted, so nothing further can be in range

      const a = sorted[i];
      const b = sorted[j];
      const amountDiff = Math.abs(a.amount - b.amount) / Math.max(1, a.amount);
      if (amountDiff > amountTolerance) continue;

      const ma = normaliseMerchant(a.merchant);
      const mb = normaliseMerchant(b.merchant);
      const sameMerchant = ma && mb ? ma === mb : (a.category === b.category);
      if (!sameMerchant) continue;

      pairs.push({
        original: { id: a.id, date: a.date, amount: a.amount, merchant: a.merchant },
        duplicate: { id: b.id, date: b.date, amount: b.amount, merchant: b.merchant },
        hoursApart: Number((gap / 3600000).toFixed(1)),
        confidence: amountDiff === 0 && ma === mb ? 0.95 : 0.7
      });
    }
  }
  return pairs.sort((a, b) => b.confidence - a.confidence);
}

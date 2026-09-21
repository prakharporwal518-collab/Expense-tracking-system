import { DAY_MS, daysBetween } from '../lib/dates.js';
import { median } from './anomaly.js';

/**
 * Finds subscriptions the user never told us about.
 *
 * Groups charges by normalised merchant, looks at the gaps between consecutive
 * charges, and reports a recurrence when those gaps cluster tightly around a
 * familiar period (weekly / monthly / quarterly / yearly) AND the amounts are
 * stable. Confidence blends gap regularity with amount stability, so an
 * occasional Swiggy order never looks like a subscription.
 */
const KNOWN_PERIODS = [
  { days: 7, label: 'weekly', tolerance: 2 },
  { days: 14, label: 'fortnightly', tolerance: 3 },
  { days: 30, label: 'monthly', tolerance: 5 },
  { days: 91, label: 'quarterly', tolerance: 10 },
  { days: 365, label: 'yearly', tolerance: 20 }
];

export const normaliseMerchant = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(pvt|ltd|inc|india|ind|payment|txn|ref|order|auto|debit|upi)\b/g, ' ')
    .replace(/\d{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function matchPeriod(medianGap) {
  for (const p of KNOWN_PERIODS) {
    if (Math.abs(medianGap - p.days) <= p.tolerance) return p;
  }
  return null;
}

/**
 * Within one merchant, splits charges into clusters of similar amount.
 * A real subscription bills the same figure every cycle, so this separates the
 * ₹649 Netflix renewal from a one-off ₹1,200 charge at the same merchant —
 * without it, those stray charges corrupt the gap sequence and hide the cycle.
 */
function clusterByAmount(items, tolerance = 0.08) {
  const sorted = [...items].sort((a, b) => a.amount - b.amount);
  const clusters = [];
  for (const item of sorted) {
    const target = clusters.find((c) => {
      const ref = c.median;
      return ref > 0 && Math.abs(item.amount - ref) / ref <= tolerance;
    });
    if (target) {
      target.items.push(item);
      target.median = median(target.items.map((i) => i.amount));
    } else {
      clusters.push({ items: [item], median: item.amount });
    }
  }
  return clusters.map((c) => c.items);
}

export function detectRecurring(expenses, { now = new Date(), minOccurrences = 3 } = {}) {
  const groups = new Map();
  for (const e of expenses) {
    const key = normaliseMerchant(e.merchant) || normaliseMerchant(e.note);
    if (!key || key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const found = [];
  const candidates = [];
  for (const [key, itemsRaw] of groups) {
    if (itemsRaw.length < minOccurrences) continue;
    for (const cluster of clusterByAmount(itemsRaw)) {
      if (cluster.length >= minOccurrences) candidates.push([key, cluster]);
    }
  }

  for (const [key, itemsRaw] of candidates) {
    const items = [...itemsRaw].sort((a, b) => new Date(a.date) - new Date(b.date));

    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push(daysBetween(items[i - 1].date, items[i].date));
    const usable = gaps.filter((g) => g >= 3); // same-day repeats aren't a cycle
    if (usable.length < minOccurrences - 1) continue;

    const medGap = median(usable);
    const period = matchPeriod(medGap);
    if (!period) continue;

    // How tightly do the gaps hug the period? 1.0 = perfectly regular.
    const deviation = median(usable.map((g) => Math.abs(g - medGap)));
    const regularity = Math.max(0, 1 - deviation / Math.max(1, period.tolerance));

    const amounts = items.map((i) => i.amount);
    const medAmount = median(amounts);
    const amountSpread = medAmount > 0 ? median(amounts.map((a) => Math.abs(a - medAmount))) / medAmount : 1;
    const stability = Math.max(0, 1 - amountSpread * 4);

    // Three charges spaced evenly can be coincidence; a dozen cannot. Damp the
    // score by how much evidence there is so well-observed cycles rank above
    // thin ones instead of tying at ~1.0.
    const support = Math.min(1, (items.length - 2) / 3);
    const confidence = Number(((regularity * 0.6 + stability * 0.4) * (0.55 + 0.45 * support)).toFixed(2));
    if (confidence < 0.5) continue;

    const last = items.at(-1);
    const nextDue = new Date(new Date(last.date).getTime() + period.days * DAY_MS);
    const daysUntil = Math.round((nextDue - now) / DAY_MS);

    found.push({
      merchantKey: key,
      merchant: last.merchant || key,
      label: period.label,
      intervalDays: period.days,
      occurrences: items.length,
      amount: Math.round(medAmount),
      annualCost: Math.round((medAmount * 365) / period.days),
      lastCharged: last.date,
      nextDue: nextDue.toISOString(),
      daysUntil,
      overdue: daysUntil < -period.tolerance,
      confidence,
      category: last.category || null
    });
  }
  return found.sort((a, b) => b.annualCost - a.annualCost);
}

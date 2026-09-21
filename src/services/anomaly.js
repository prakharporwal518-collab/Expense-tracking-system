/**
 * Outlier detection on spending, per category.
 *
 * Uses the Median Absolute Deviation rather than mean/stdev: a single ₹50,000
 * laptop would inflate the mean and standard deviation so much that it hides
 * itself. The median and MAD barely move, so the outlier still stands out.
 *
 *   robustZ = 0.6745 * (x - median) / MAD
 */
const CONSISTENCY = 0.6745; // scales MAD to be comparable with a standard deviation

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mad(values, med = median(values)) {
  if (!values.length) return 0;
  return median(values.map((v) => Math.abs(v - med)));
}

export function robustZScores(values) {
  const med = median(values);
  const dispersion = mad(values, med);
  if (dispersion === 0) {
    // Every value identical (or too few): fall back to a plain stdev.
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length || 1);
    const sd = Math.sqrt(variance);
    if (sd === 0) return values.map(() => 0);
    return values.map((v) => (v - mean) / sd);
  }
  return values.map((v) => (CONSISTENCY * (v - med)) / dispersion);
}

/**
 * @param {Array<{id:number, amount:number, category:string, date:string, merchant:string}>} expenses
 * @returns anomalies sorted by severity
 */
export function detectAnomalies(expenses, { threshold = 3.5, minSamples = 5 } = {}) {
  const byCategory = new Map();
  for (const e of expenses) {
    const key = e.category || 'Uncategorised';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(e);
  }

  const anomalies = [];
  for (const [category, items] of byCategory) {
    if (items.length < minSamples) continue;
    const amounts = items.map((i) => i.amount);
    const zs = robustZScores(amounts);
    const med = median(amounts);
    items.forEach((item, i) => {
      const z = zs[i];
      if (z <= threshold) return; // only unusually LARGE spends are interesting
      anomalies.push({
        id: item.id,
        category,
        merchant: item.merchant,
        date: item.date,
        amount: item.amount,
        typical: Math.round(med),
        zScore: Number(z.toFixed(2)),
        timesTypical: med > 0 ? Number((item.amount / med).toFixed(1)) : null,
        severity: z > 8 ? 'high' : z > 5 ? 'medium' : 'low',
        reason: med > 0
          ? `${(item.amount / med).toFixed(1)}x your usual ${category} spend`
          : `Unusually large for ${category}`
      });
    });
  }
  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

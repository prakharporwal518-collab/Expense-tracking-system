/**
 * All money is stored and computed as integer minor units (paise / cents).
 * Floats are only allowed at the edges: parsing user input and rendering.
 */
export const MAX_MINOR = 1_000_000_000_00; // 100 billion major units

export function toMinor(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[, _]/g, '')) : Number(value);
  if (!Number.isFinite(n)) return null;
  // Round on the string form to dodge 1.005 -> 1.00499999 float artefacts.
  const rounded = Math.round((n + Number.EPSILON * Math.sign(n)) * 100);
  if (!Number.isSafeInteger(rounded)) return null;
  return rounded;
}

export const toMajor = (minor) => Math.round(Number(minor) || 0) / 100;

export function formatMoney(minor, currency = 'INR', locale = 'en-IN') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(toMajor(minor));
  } catch {
    return `${currency} ${toMajor(minor).toFixed(2)}`;
  }
}

/** Split `total` into `n` parts that sum back to exactly `total` (no lost paise). */
export function splitEvenly(total, n) {
  if (n <= 0) return [];
  const base = Math.trunc(total / n);
  let remainder = total - base * n;
  const step = remainder >= 0 ? 1 : -1;
  return Array.from({ length: n }, () => {
    const extra = remainder !== 0 ? step : 0;
    remainder -= extra;
    return base + extra;
  });
}

/** Split by weights, distributing the rounding remainder to the largest shares. */
export function splitByWeights(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return splitEvenly(total, weights.length);
  const raw = weights.map((w) => (total * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floored[order[k].i] += 1;
  return floored;
}

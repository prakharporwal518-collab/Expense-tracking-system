export const DAY_MS = 86_400_000;

export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
export const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

export function startOfMonth(d = new Date()) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
}

export function endOfMonth(d = new Date()) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

export function addMonths(d, n) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, Math.min(x.getUTCDate(), 28)));
}

export const daysInMonth = (d = new Date()) =>
  new Date(Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth() + 1, 0)).getUTCDate();

export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY_MS);

/** Inclusive list of month keys, oldest first. */
export function monthRange(from, to) {
  const out = [];
  let cur = startOfMonth(from);
  const end = startOfMonth(to);
  while (cur <= end && out.length < 240) {
    out.push(monthKey(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

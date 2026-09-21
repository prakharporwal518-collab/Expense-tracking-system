import { toMinor } from '../lib/money.js';
import { DAY_MS } from '../lib/dates.js';

/**
 * Natural-language expense parser.
 * "380 lunch at dominos yesterday upi #team" ->
 *   { amountMinor: 38000, merchant: 'Dominos', spentAt: <yesterday>, paymentMethod: 'upi', tags: ['team'] }
 *
 * Everything is best-effort: each extractor returns null when unsure and the
 * caller decides what to do with a partial parse, so a weird phrase degrades
 * into "amount only" rather than a wrong entry.
 */

const PAYMENT_METHODS = {
  upi: ['upi', 'gpay', 'g-pay', 'googlepay', 'phonepe', 'paytm', 'bhim', 'scan'],
  card: ['card', 'credit', 'debit', 'visa', 'mastercard', 'rupay', 'swipe'],
  cash: ['cash', 'note', 'notes', 'currency'],
  netbanking: ['netbanking', 'neft', 'imps', 'rtgs', 'transfer', 'bank'],
  wallet: ['wallet', 'paytmwallet', 'amazonpay']
};

const INCOME_WORDS = ['salary', 'stipend', 'received', 'refund', 'cashback', 'credited', 'income', 'earned', 'bonus', 'interest'];

const CATEGORY_HINTS = {
  Food: ['lunch', 'dinner', 'breakfast', 'food', 'snack', 'pizza', 'burger', 'coffee', 'tea', 'swiggy', 'zomato', 'restaurant', 'cafe', 'canteen', 'mess', 'dominos', 'kfc', 'biryani', 'chai'],
  Groceries: ['grocery', 'groceries', 'vegetables', 'milk', 'bigbasket', 'blinkit', 'zepto', 'dmart', 'supermarket', 'kirana'],
  Transport: ['uber', 'ola', 'rapido', 'auto', 'cab', 'taxi', 'bus', 'metro', 'train', 'fuel', 'petrol', 'diesel', 'parking', 'toll', 'irctc'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'shopping', 'clothes', 'shoes', 'shirt', 'jeans', 'ajio', 'meesho'],
  Bills: ['electricity', 'water', 'gas', 'rent', 'wifi', 'broadband', 'recharge', 'mobile', 'airtel', 'jio', 'bill', 'maintenance'],
  Entertainment: ['movie', 'netflix', 'spotify', 'prime', 'hotstar', 'game', 'steam', 'concert', 'pvr', 'inox', 'bookmyshow'],
  Health: ['medicine', 'pharmacy', 'doctor', 'hospital', 'gym', 'apollo', 'clinic', 'dentist', 'checkup'],
  Education: ['book', 'books', 'course', 'udemy', 'coursera', 'tuition', 'fees', 'exam', 'college', 'stationery', 'leetcode'],
  Travel: ['flight', 'hotel', 'airbnb', 'oyo', 'trip', 'makemytrip', 'goibibo', 'vacation', 'indigo'],
  Subscriptions: ['subscription', 'renewal', 'membership', 'plan', 'premium', 'chatgpt', 'github', 'icloud']
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function extractAmount(text) {
  // "1.2k" / "₹450" / "450.50" / "2,300" — pick the largest plausible figure so
  // "2 coffees 240" reads as 240, not 2.
  // The (?![a-z]) guard stops a word like "credited" from being read as the
  // "cr" (crore) multiplier, which would inflate the figure by 10 million.
  const matches = [...text.matchAll(/(?:[₹$€£]\s*)?(\d+(?:[,\d]*)(?:\.\d{1,2})?)\s*(k|lakh|lac|cr)?(?![a-z])/gi)];
  let best = null;
  for (const m of matches) {
    const digits = m[1].replace(/,/g, '');
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const suffix = (m[2] || '').toLowerCase();
    if (suffix === 'k') value *= 1_000;
    else if (suffix === 'lakh' || suffix === 'lac') value *= 100_000;
    else if (suffix === 'cr') value *= 10_000_000;
    // A bare 1-2 digit number that looks like a date fragment is not an amount.
    if (!suffix && value <= 31 && /\b(st|nd|rd|th)\b/i.test(m[0])) continue;
    if (value <= 0 || value > 1e9) continue;
    if (!best || value > best.value) best = { value, raw: m[0], index: m.index };
  }
  if (!best) return null;
  return { amountMinor: toMinor(best.value), raw: best.raw, index: best.index };
}

function extractDate(text, now = new Date()) {
  const t = text.toLowerCase();
  const base = new Date(now);

  if (/\byesterday\b/.test(t)) return { date: new Date(base.getTime() - DAY_MS), raw: 'yesterday' };
  if (/\bday before yesterday\b/.test(t)) return { date: new Date(base.getTime() - 2 * DAY_MS), raw: 'day before yesterday' };
  if (/\btoday\b/.test(t)) return { date: base, raw: 'today' };
  if (/\btomorrow\b/.test(t)) return { date: new Date(base.getTime() + DAY_MS), raw: 'tomorrow' };

  const ago = t.match(/(\d+)\s*(day|days|week|weeks|month|months)\s+ago/);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2];
    const mult = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1;
    return { date: new Date(base.getTime() - n * mult * DAY_MS), raw: ago[0] };
  }

  const lastWeekday = t.match(/\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (lastWeekday) {
    const target = WEEKDAYS.indexOf(lastWeekday[1]);
    const d = new Date(base);
    let back = (d.getDay() - target + 7) % 7;
    if (back === 0) back = 7;
    return { date: new Date(d.getTime() - back * DAY_MS), raw: lastWeekday[0] };
  }

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) return { date: d, raw: iso[0] };
  }

  const dayMonth = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTHS.indexOf(dayMonth[2]);
    if (day >= 1 && day <= 31 && month >= 0) {
      let year = base.getUTCFullYear();
      let d = new Date(Date.UTC(year, month, day, 12));
      // A date more than a week ahead almost certainly means last year.
      if (d.getTime() - base.getTime() > 7 * DAY_MS) d = new Date(Date.UTC(year - 1, month, day, 12));
      if (!Number.isNaN(d.getTime())) return { date: d, raw: dayMonth[0] };
    }
  }

  return null;
}

/** Real merchant names only — generic words like "lunch" or "rent" must not
 *  become merchants, so this is curated rather than derived from CATEGORY_HINTS. */
const BRANDS = [
  'swiggy', 'zomato', 'dominos', 'kfc', 'mcdonalds', 'starbucks', 'subway', 'chaayos',
  'bigbasket', 'blinkit', 'zepto', 'dmart', 'instamart', 'licious',
  'uber', 'ola', 'rapido', 'irctc', 'indigo', 'vistara', 'redbus',
  'amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa', 'croma',
  'airtel', 'jio', 'vodafone', 'vi', 'bsnl', 'tatapower', 'adani',
  'netflix', 'spotify', 'hotstar', 'prime', 'steam', 'pvr', 'inox', 'bookmyshow', 'youtube',
  'apollo', 'pharmeasy', 'netmeds', 'cultfit', 'practo',
  'udemy', 'coursera', 'unacademy', 'byjus', 'leetcode', 'github', 'chatgpt', 'notion', 'figma', 'icloud',
  'makemytrip', 'goibibo', 'oyo', 'airbnb', 'cleartrip', 'agoda',
  'paytm', 'phonepe', 'gpay', 'razorpay', 'zerodha', 'groww', 'upstox'
];

function extractMerchant(text) {
  // An explicit "at X" / "from X" is the strongest signal and wins outright.
  const m = text.match(/\b(?:at|from)\s+([A-Za-z][A-Za-z0-9'&.\- ]{1,38}?)(?=\s+(?:on|for|using|via|by|with|yesterday|today|tomorrow|last|\d)|[,.#]|$)/i);
  if (m) {
    const cleaned = m[1].trim().replace(/\s{2,}/g, ' ');
    if (cleaned.length >= 2) return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // Otherwise fall back to a known brand anywhere in the sentence, so
  // "uber to airport" is recorded against Uber rather than the destination.
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const brand = words.find((w) => BRANDS.includes(w));
  return brand ? brand.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

function extractPaymentMethod(text) {
  const words = new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/));
  for (const [method, keys] of Object.entries(PAYMENT_METHODS)) {
    if (keys.some((k) => words.has(k))) return method;
  }
  return null;
}

function extractTags(text) {
  return [...text.matchAll(/#([A-Za-z0-9_-]{1,24})/g)].map((m) => m[1].toLowerCase());
}

export function guessCategoryByKeyword(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const wordSet = new Set(words);
  let best = null;
  for (const [category, keys] of Object.entries(CATEGORY_HINTS)) {
    let hits = 0;
    for (const k of keys) {
      if (wordSet.has(k)) hits += 2;
      else if (k.length > 4 && text.toLowerCase().includes(k)) hits += 1;
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { category, hits };
  }
  return best ? { category: best.category, confidence: Math.min(0.95, 0.5 + best.hits * 0.12) } : null;
}

export function parseExpenseText(input, { now = new Date() } = {}) {
  const text = String(input || '').slice(0, 400).trim();
  if (!text) {
    return { ok: false, reason: 'Nothing to parse', confidence: 0, fields: {}, warnings: [] };
  }

  const warnings = [];
  const amount = extractAmount(text);
  const date = extractDate(text, now);
  const merchant = extractMerchant(text);
  const paymentMethod = extractPaymentMethod(text);
  const tags = extractTags(text);
  const lower = text.toLowerCase();
  const isIncome = INCOME_WORDS.some((w) => lower.includes(w));
  const categoryGuess = guessCategoryByKeyword(text);

  // The note is the sentence minus the machine-readable bits.
  let note = text;
  if (amount) note = note.replace(amount.raw, ' ');
  if (date) note = note.replace(new RegExp(date.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  note = note.replace(/#[A-Za-z0-9_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  if (!amount) warnings.push('No amount found — type a number like 250 or 1.2k');
  if (!date) warnings.push('No date found — defaulting to today');
  if (!merchant) warnings.push('No merchant found — try "at <place>"');

  let confidence = 0;
  if (amount) confidence += 0.5;
  if (date) confidence += 0.15;
  if (merchant) confidence += 0.15;
  if (categoryGuess) confidence += 0.15;
  if (paymentMethod) confidence += 0.05;

  return {
    ok: Boolean(amount),
    reason: amount ? null : 'Could not find an amount in that sentence',
    confidence: Number(confidence.toFixed(2)),
    warnings,
    fields: {
      amountMinor: amount?.amountMinor ?? null,
      merchant: merchant ?? '',
      note,
      spentAt: (date?.date ?? now).toISOString(),
      paymentMethod: paymentMethod ?? 'other',
      tags,
      isIncome,
      categoryGuess: categoryGuess?.category ?? null,
      categoryConfidence: categoryGuess?.confidence ?? 0
    }
  };
}

export { CATEGORY_HINTS };

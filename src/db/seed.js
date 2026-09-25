import { getDb, run, get, tx } from './index.js';
import { hashPassword } from '../lib/password.js';
import { DEFAULT_CATEGORIES } from './defaults.js';
import { logger } from '../lib/logger.js';
import { DAY_MS } from '../lib/dates.js';

/**
 * Generates ~9 months of believable history for a student: a monthly stipend,
 * real subscriptions on fixed cycles, everyday spending with weekend weighting,
 * a couple of deliberate outliers and one duplicate, so every analytics feature
 * has something true to find.
 */
const DEMO = { email: 'demo@fintrack.app', password: 'Demo@1234', name: 'Prakhar' };

// Deterministic PRNG so repeated seeds produce identical, debuggable data.
let seedState = 42;
const rand = () => {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
};
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const MERCHANTS = {
  Food: ['Swiggy', 'Zomato', 'Campus Canteen', 'Chai Point', 'Dominos', 'Biryani House'],
  Groceries: ['Blinkit', 'DMart', 'Zepto', 'Local Kirana'],
  Transport: ['Uber', 'Ola', 'Rapido', 'Metro Card', 'Petrol Pump'],
  Shopping: ['Amazon', 'Flipkart', 'Myntra', 'Decathlon'],
  Bills: ['Airtel', 'Electricity Board', 'Jio Fiber'],
  Entertainment: ['BookMyShow', 'PVR', 'Steam'],
  Health: ['Apollo Pharmacy', 'Cult Fit', 'Local Clinic'],
  Education: ['Udemy', 'Coursera', 'Bookstore']
};

const SUBSCRIPTIONS = [
  { merchant: 'Netflix', category: 'Entertainment', amount: 64900, day: 5, interval: 30 },
  { merchant: 'Spotify', category: 'Entertainment', amount: 11900, day: 12, interval: 30 },
  { merchant: 'Jio Fiber', category: 'Bills', amount: 79900, day: 2, interval: 30 },
  { merchant: 'GitHub', category: 'Education', amount: 34900, day: 18, interval: 30 },
  { merchant: 'Cult Fit', category: 'Health', amount: 129900, day: 22, interval: 30 }
];

const TYPICAL = {
  Food: [12000, 45000], Groceries: [30000, 120000], Transport: [6000, 35000],
  Shopping: [50000, 300000], Bills: [40000, 150000], Entertainment: [20000, 90000],
  Health: [25000, 110000], Education: [30000, 250000]
};

export function seed({ months = 9, reset = true } = {}) {
  getDb();

  const existing = get('SELECT id FROM users WHERE email = ?', [DEMO.email]);
  if (existing && reset) {
    run('DELETE FROM users WHERE id = ?', [existing.id]); // cascades to everything
    logger.info('Removed previous demo account');
  } else if (existing) {
    logger.info('Demo account already exists, skipping');
    return existing.id;
  }

  return tx(() => {
    const passwordHash = hashPasswordSync();
    const userId = Number(run(
      'INSERT INTO users (email, name, password_hash, currency, monthly_income_minor) VALUES (?,?,?,?,?)',
      [DEMO.email, DEMO.name, passwordHash, 'INR', 4_500_000]
    ).lastInsertRowid);

    const catIds = {};
    for (const c of DEFAULT_CATEGORIES) {
      catIds[c.name] = Number(run(
        'INSERT INTO categories (user_id, name, icon, color, kind) VALUES (?,?,?,?,?)',
        [userId, c.name, c.icon, c.color, c.kind]
      ).lastInsertRowid);
    }

    const addExpense = (opts) => run(
      `INSERT INTO expenses (user_id, category_id, amount_minor, currency, fx_rate, base_amount_minor,
                             merchant, note, payment_method, tags_json, is_income, spent_at)
       VALUES (?,?,?,?,1,?,?,?,?,?,?,?)`,
      [userId, opts.categoryId ?? null, opts.amount, 'INR', opts.amount, opts.merchant, opts.note ?? '',
       opts.method ?? 'upi', JSON.stringify(opts.tags ?? []), opts.isIncome ? 1 : 0, opts.date]
    );

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1));
    let count = 0;

    // Monthly stipend on the 1st.
    for (let m = 0; m < months; m++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1, 10));
      if (d > now) break;
      addExpense({ categoryId: catIds.Salary, amount: 4_500_000, merchant: 'Internship Stipend', date: d.toISOString(), isIncome: true, method: 'netbanking' });
      count++;
    }

    // Subscriptions on their fixed cycle.
    for (const sub of SUBSCRIPTIONS) {
      for (let m = 0; m < months; m++) {
        const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, sub.day, 9));
        if (d > now) break;
        addExpense({ categoryId: catIds[sub.category], amount: sub.amount, merchant: sub.merchant, note: 'Subscription renewal', date: d.toISOString(), method: 'card', tags: ['subscription'] });
        count++;
      }
    }

    // Everyday spending, heavier on weekends.
    for (let day = new Date(start); day <= now; day = new Date(day.getTime() + DAY_MS)) {
      const isWeekend = [0, 6].includes(day.getUTCDay());
      const txCount = isWeekend ? randInt(1, 4) : randInt(0, 3);
      for (let i = 0; i < txCount; i++) {
        const category = pick(Object.keys(MERCHANTS));
        const [lo, hi] = TYPICAL[category];
        const amount = randInt(lo, isWeekend ? Math.round(hi * 1.3) : hi);
        const d = new Date(day.getTime() + randInt(8, 22) * 3600_000);
        if (d > now) continue;
        addExpense({
          categoryId: catIds[category], amount, merchant: pick(MERCHANTS[category]),
          date: d.toISOString(), method: pick(['upi', 'upi', 'card', 'cash'])
        });
        count++;
      }
    }

    // Deliberate outliers for the anomaly detector to find.
    const laptopDay = new Date(now.getTime() - 20 * DAY_MS);
    addExpense({ categoryId: catIds.Shopping, amount: 7_499_900, merchant: 'Amazon', note: 'Laptop upgrade', date: laptopDay.toISOString(), method: 'card', tags: ['big-purchase'] });
    const tripDay = new Date(now.getTime() - 45 * DAY_MS);
    addExpense({ categoryId: catIds.Travel, amount: 1_850_000, merchant: 'MakeMyTrip', note: 'Goa trip flights', date: tripDay.toISOString(), method: 'card' });
    count += 2;

    // A deliberate duplicate pair, 40 minutes apart.
    const dupDay = new Date(now.getTime() - 3 * DAY_MS);
    addExpense({ categoryId: catIds.Food, amount: 47800, merchant: 'Swiggy', note: 'Dinner order', date: dupDay.toISOString() });
    addExpense({ categoryId: catIds.Food, amount: 47800, merchant: 'Swiggy', note: 'Dinner order (retry)', date: new Date(dupDay.getTime() + 40 * 60000).toISOString() });
    count += 2;

    // Budgets, goals and a trip group.
    const budgets = [['Food', 900_000], ['Transport', 400_000], ['Shopping', 600_000], ['Entertainment', 300_000], ['Groceries', 500_000]];
    for (const [name, amount] of budgets) {
      run('INSERT INTO budgets (user_id, category_id, amount_minor, alert_at_percent) VALUES (?,?,?,?)', [userId, catIds[name], amount, 80]);
    }

    run('INSERT INTO goals (user_id, name, target_minor, saved_minor, target_date) VALUES (?,?,?,?,?)',
      [userId, 'New Laptop Fund', 8_000_000, 3_200_000, new Date(now.getTime() + 180 * DAY_MS).toISOString()]);
    run('INSERT INTO goals (user_id, name, target_minor, saved_minor, target_date) VALUES (?,?,?,?,?)',
      [userId, 'Emergency Fund', 15_000_000, 4_500_000, new Date(now.getTime() + 400 * DAY_MS).toISOString()]);

    const groupId = Number(run('INSERT INTO groups (user_id, name, currency) VALUES (?,?,?)', [userId, 'Goa Trip 2026', 'INR']).lastInsertRowid);
    const memberIds = ['Prakhar', 'Aman', 'Riya', 'Sana'].map((name, i) =>
      Number(run('INSERT INTO group_members (group_id, name, is_self) VALUES (?,?,?)', [groupId, name, i === 0 ? 1 : 0]).lastInsertRowid));

    const groupExpenses = [
      ['Hotel booking', 2_400_000, 0, 'equal', {}],
      ['Flight tickets', 3_200_000, 1, 'equal', {}],
      ['Scooter rental', 480_000, 2, 'equal', {}],
      ['Dinner at beach shack', 620_000, 0, 'shares', { 0: 1, 1: 1, 2: 2, 3: 1 }],
      ['Water sports', 900_000, 3, 'equal', {}]
    ];
    for (const [desc, amount, payerIdx, mode, shares] of groupExpenses) {
      const mapped = Object.fromEntries(Object.entries(shares).map(([k, v]) => [memberIds[Number(k)], v]));
      run('INSERT INTO group_expenses (group_id, payer_id, description, amount_minor, split_mode, shares_json, spent_at) VALUES (?,?,?,?,?,?,?)',
        [groupId, memberIds[payerIdx], desc, amount, mode, JSON.stringify(mapped), new Date(now.getTime() - randInt(10, 40) * DAY_MS).toISOString()]);
    }

    run('INSERT INTO audit_log (user_id, action, entity, summary) VALUES (?,?,?,?)', [userId, 'seed', 'user', 'Demo data generated']);

    logger.info('Seed complete', { user: DEMO.email, password: DEMO.password, expenses: count });
    return userId;
  });
}

// hashPassword is async, but seeding runs inside a synchronous transaction.
// Precomputing one known-good hash for the demo account keeps both honest.
import crypto from 'node:crypto';
function hashPasswordSync() {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(DEMO.password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export { DEMO };

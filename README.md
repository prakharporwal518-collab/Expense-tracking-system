# 💰 FinTrack — Expense Tracking System

A full-stack expense tracker that does the things ordinary expense trackers don't:
it **forecasts** next month, **finds subscriptions you forgot about**, **flags spending
that is out of character**, and **settles group debts in the fewest possible transfers**.

Built with Node.js + Express + SQLite on the back end and a dependency-free
vanilla-JS front end. No build step, no bundler, no CDN — clone, install, run.

![Node](https://img.shields.io/badge/node-%3E%3D22.5-green) ![Tests](https://img.shields.io/badge/tests-64%20passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Quick start

```bash
npm install     # one dependency: express
npm run seed    # optional: 9 months of realistic demo data
npm start       # http://localhost:3000
```

Demo login: **demo@fintrack.app** / **Demo@1234**

```bash
npm test        # 64 unit + integration tests
npm run dev     # auto-restart on file changes
```

Requires **Node 22.5+** (it uses the built-in `node:sqlite`, so there is no native
module to compile and nothing to install beyond Express).

---

## What makes it different

Most trackers are a form and a pie chart. These are the features that aren't:

### 🗣️ Natural-language entry
Type `380 lunch at dominos yesterday upi #team` and it extracts the amount, merchant,
category, date, payment method and tags before you hit enter.

Handles `1.2k`, `1.5 lakh`, `₹450`, `3 days ago`, `last friday`, `12 sep`, and knows
that "salary … credited" is income. Every extractor returns `null` when unsure, so a
sentence it can't read degrades to "amount only" instead of silently filing something wrong.

### 🧠 Personal category prediction
A **multinomial Naive Bayes** classifier trained on *your own* history, so "Reliance"
can mean Groceries for you and Bills for someone else. Falls back to keyword matching
until there are enough samples to be meaningful, and says which source it used.

### 📈 Forecasting (Holt's linear exponential smoothing)
```
level_t = α·y_t + (1-α)(level_{t-1} + trend_{t-1})
trend_t = β(level_t - level_{t-1}) + (1-β)·trend_{t-1}
```
Chosen over a plain average because spending drifts, and over full Holt-Winters because
a student's history is rarely long enough for seasonal indices to be anything but noise.
The ± band comes from **backtesting** one-step-ahead errors, so the confidence shown is earned.

Mid-month, the projection blends your run-rate with your historical average, weighted by
how much of the month has elapsed — a noisy two-day run-rate never dominates.

### 🔍 Anomaly detection (median absolute deviation)
```
robustZ = 0.6745 · (x − median) / MAD
```
Uses MAD rather than mean/standard deviation deliberately: a single ₹75,000 laptop
inflates the mean and stdev enough to **score itself as normal**. The median barely moves,
so the outlier still stands out.

### 🔁 Subscription discovery
Nobody tells FinTrack about your subscriptions — it infers them. Charges are grouped by
normalised merchant, then **sub-clustered by amount** (a real subscription bills the same
figure every cycle), so a stray one-off charge at the same merchant can't scramble the
gap sequence. Confidence blends cycle regularity, amount stability and how much evidence
there is, so three evenly-spaced charges don't outrank a twelve-month cycle.

### 🤝 Debt simplification (min cash flow)
Four friends on a trip can owe each other up to N×(N−1) transfers. FinTrack reduces
everyone to a single net balance, then greedily matches the largest creditor with the
largest debtor. Each match zeroes out at least one person, so it **always settles in at
most N−1 transfers**.

Greedy isn't provably optimal — the true minimum is NP-hard, equivalent to set-partition —
but it lands within one transfer of optimal in practice and runs in O(N log N) per round.

### 🧪 What-if simulator
Drag a category down 20% and see the monthly saving, the annual saving, and what it would
compound to if invested — plus what it does to your savings rate.

### 🏥 Financial health score
0–100 from five independently-scored signals (savings rate, budget adherence, spending
volatility, subscription load, tracking consistency), so the UI can name the one thing
dragging it down instead of showing an opaque number.

### Plus
👯 Duplicate detection · 🎯 Budget envelopes with pace + "safe to spend today" ·
⭐ Goals with ETA projection · 🔥 Streaks and achievements · 📅 Year-long activity heatmap ·
⌨️ Command palette (`Ctrl/⌘ K`) · ↩️ Soft delete with real undo · 📥 CSV import with
per-row error reporting · 📤 CSV/JSON export · 📜 Audit log · 🌓 Dark & light themes

---

## Architecture

```
src/
├── server.js          Bootstrap, graceful shutdown, process guards
├── app.js             Express wiring and middleware order
├── config.js          Env loading; refuses to start in prod without JWT_SECRET
├── db/
│   ├── index.js       SQLite connection, WAL, transaction helper
│   ├── migrations.js  Versioned, append-only, idempotent
│   └── seed.js        Deterministic demo-data generator
├── lib/               errors · validate · money · jwt · password · csv · dates · logger
├── middleware/        auth · rateLimit · errorHandler · security · requestId
├── services/          nlp · categorizer · anomaly · recurring · forecast ·
│                      health · settle · duplicates · whatif · store
└── routes/            auth · expense · category · budget · goal · group ·
                       analytics · importExport · meta

public/                Vanilla ES modules — no framework, no build step
├── js/charts.js       Hand-rolled SVG charts (donut, line+forecast band, bars, gauge, heatmap)
└── js/views/          One module per screen
```

### Money is never a float
Every amount is stored and computed as an **integer number of minor units** (paise/cents).
Floats appear only at the edges — parsing input and rendering output. Splitting ₹10.00
three ways yields `[334, 333, 333]`, which sums back to exactly ₹10.00. There is a test
asserting no split ever loses or invents a paisa.

---

## Error handling

Handling failure is a feature here, not an afterthought:

| Layer | What it does |
|---|---|
| **Validation** | Dependency-free schema validator coerces and checks every input; returns *all* field errors at once, not just the first |
| **Error taxonomy** | One `AppError` type for deliberate rejections. Anything else is treated as a bug: logged in full, scrubbed to a generic message before it reaches the client |
| **SQLite translation** | `UNIQUE`/`FOREIGN KEY`/`CHECK`/`database is locked` become actionable messages instead of raw driver text |
| **Transactions** | Multi-step writes roll back as a unit |
| **Rate limiting** | Per-IP fixed window, stricter on auth routes, with `Retry-After` |
| **Auth** | scrypt password hashing; HMAC-SHA256 JWTs verified with `timingSafeEqual`; login times are equalised so responses don't leak which emails exist |
| **Cross-account access** | Every query is scoped by `user_id`; tests assert one account cannot read or reference another's data |
| **Soft deletes** | Deletions are reversible, and the UI offers a real undo |
| **CSV import** | A malformed row is reported with its line number and skipped — one bad line never aborts a good import. `dryRun` previews first |
| **Front end** | Every view is wrapped in an error boundary that renders a retry card; global handlers catch unhandled rejections; offline/online is surfaced |
| **Process** | `uncaughtException` and `unhandledRejection` are logged; SIGINT/SIGTERM drain in-flight requests before closing the DB |
| **Health check** | `/api/health` verifies the database *and* that the schema is at the expected version, returning 503 if not |

---

## API

All `/api` routes except `/api/health`, `/api/meta` and `/api/auth/*` require
`Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` · `/login` · `/logout` | Session management |
| `GET/PATCH` | `/api/auth/me` | Profile |
| `GET/POST/PATCH/DELETE` | `/api/expenses` | Expense CRUD (filter, search, sort, paginate) |
| `POST` | `/api/expenses/:id/restore` | Undo a delete |
| `POST` | `/api/expenses/parse` | Natural-language parse |
| `POST` | `/api/expenses/suggest-category` | ML category suggestion |
| `GET` | `/api/analytics/summary` | KPIs, health score, safe-to-spend |
| `GET` | `/api/analytics/insights` | Ranked plain-language insights |
| `GET` | `/api/analytics/anomalies` · `/recurring` · `/duplicates` | Detectors |
| `GET` | `/api/analytics/forecast` · `/heatmap` · `/achievements` · `/activity` | Analysis |
| `POST` | `/api/analytics/whatif` | Simulation |
| `GET/POST/DELETE` | `/api/budgets` · `/goals` · `/categories` · `/groups` | Resources |
| `POST` | `/api/groups/:id/settle` | Record a settlement |
| `GET` | `/api/io/export.csv` · `export.json` · `report/:month` | Export |
| `POST` | `/api/io/import/csv` | Import (supports `dryRun`) |

---

## Configuration

Copy `.env.example` to `.env`. Every value has a safe development default.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DB_FILE` | `./data/fintrack.db` | |
| `JWT_SECRET` | auto-generated in dev | **Required** in production (≥16 chars) |
| `DEFAULT_CURRENCY` | `INR` | |
| `TOKEN_TTL_SECONDS` | `604800` | 7 days |
| `RATE_MAX` / `RATE_AUTH_MAX` | `300` / `20` | Per window |
| `LOG_LEVEL` | `debug` (dev) | |

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl/⌘ K` | Command palette |
| `/` | Focus quick-add |
| `n` | New expense |
| `g` then `d`/`e`/`b`/`o`/`s`/`p`/`l`/`c` | Jump to a section |

---

## Testing

```bash
npm test
```

64 tests covering the algorithms (money splitting, NLP parsing, MAD outlier detection,
subscription clustering, Holt forecasting, debt settlement) and the API (auth, cross-account
isolation, validation, CSV import, error shapes, security headers). The API tests run
against a throwaway database and clean up after themselves.

Several tests are **regression tests for bugs found during development** — for example,
that a word beginning with "cr" ("credited") is not parsed as the crore multiplier, and
that a forecast for an account with no history doesn't crash the trend chart.

---

## License

MIT

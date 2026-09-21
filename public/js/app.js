import { api, auth, setUnauthorizedHandler, ApiError } from './api.js';
import { el, toast, toastError, setMoneyFormat, spinner, debounce } from './ui.js';
import { state, setState, theme } from './state.js';
import { authView } from './views/auth.js';
import { dashboardView } from './views/dashboard.js';
import { expensesView, openEditor } from './views/expenses.js';
import { budgetsView } from './views/budgets.js';
import { goalsView } from './views/goals.js';
import { subscriptionsView } from './views/subscriptions.js';
import { splitView } from './views/split.js';
import { labView } from './views/lab.js';
import { settingsView } from './views/settings.js';

const ROUTES = {
  dashboard:     { label: 'Dashboard',     icon: '📊', title: 'Dashboard',           sub: 'Your money at a glance',                     view: dashboardView },
  expenses:      { label: 'Expenses',      icon: '🧾', title: 'Expenses',            sub: 'Every transaction, searchable',              view: expensesView },
  budgets:       { label: 'Budgets',       icon: '🎯', title: 'Budgets',             sub: 'Envelopes and pacing',                       view: budgetsView },
  goals:         { label: 'Goals',         icon: '⭐', title: 'Savings goals',       sub: 'What you are working towards',               view: goalsView },
  subscriptions: { label: 'Subscriptions', icon: '🔁', title: 'Subscriptions',       sub: 'Recurring charges we found for you',         view: subscriptionsView },
  split:         { label: 'Split',         icon: '🤝', title: 'Split expenses',      sub: 'Settle group debts in the fewest transfers',  view: splitView },
  lab:           { label: 'Lab',           icon: '🧪', title: 'Lab',                 sub: 'Simulate, detect outliers, clean duplicates', view: labView },
  settings:      { label: 'Settings',      icon: '⚙️', title: 'Settings',            sub: 'Profile, data and achievements',             view: settingsView }
};

const appRoot = document.getElementById('app');
const bootEl = document.getElementById('boot');

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  theme.set(theme.get());

  setUnauthorizedHandler(() => {
    // The token is stale — drop it and send the user back to sign-in once.
    if (!state.user) return;
    auth.token = null;
    setState({ user: null });
    toast('Your session expired. Please sign in again.', { type: 'warn', timeout: 5000 });
    showAuth();
  });

  let user = null;
  if (auth.token) {
    try {
      const res = await api.get('/api/auth/me');
      user = res.user;
    } catch {
      auth.token = null; // expired or tampered — fall through to the login screen
    }
  }

  bootEl.hidden = true;
  appRoot.hidden = false;

  if (user) await startApp(user);
  else showAuth();
}

function showAuth() {
  appRoot.replaceChildren();
  authView(appRoot, (user) => startApp(user));
}

async function startApp(user) {
  setState({ user });
  setMoneyFormat(user.currency, user.locale);

  try {
    const [meta, categories] = await Promise.all([api.get('/api/meta'), api.get('/api/categories')]);
    setState({ meta, categories: categories.categories.filter((c) => !c.archived) });
  } catch (err) {
    // Non-fatal: the shell still works, just with fewer dropdown options.
    toast('Some reference data failed to load. Some dropdowns may be empty.', { type: 'warn' });
  }

  renderShell();
  navigate(location.hash.replace('#', '') || 'dashboard');
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */
let contentEl = null;
let navEl = null;

function renderShell() {
  const user = state.user;
  const initials = user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  navEl = el('nav', { class: 'sidebar' },
    el('div', { class: 'sidebar-brand' }, el('span', { text: '💰' }), 'FinTrack'),
    ...Object.entries(ROUTES).map(([key, r]) =>
      el('button', { class: 'nav-item', dataset: { route: key }, onclick: () => navigate(key) },
        el('span', { class: 'ico', text: r.icon }), r.label)
    ),
    el('div', { class: 'sidebar-foot' },
      el('div', { class: 'sidebar-user' },
        el('div', { class: 'avatar', text: initials }),
        el('div', { class: 'meta' }, el('b', { text: user.name }), el('small', { text: user.email }))
      ),
      el('button', { class: 'nav-item', onclick: () => { theme.toggle(); } },
        el('span', { class: 'ico', text: '🌓' }), 'Toggle theme'),
      el('button', { class: 'nav-item', onclick: openPalette },
        el('span', { class: 'ico', text: '⌘' }), 'Commands (Ctrl K)')
    )
  );

  contentEl = el('div', { id: 'content' });

  const quickInput = el('input', {
    type: 'text', id: 'quickadd-input',
    placeholder: 'Quick add: 450 lunch at dominos yesterday upi',
    autocomplete: 'off'
  });
  const preview = el('div', { class: 'qa-preview', hidden: true });

  const quick = el('div', { class: 'quickadd' },
    el('span', { class: 'lead', text: '⚡' }),
    quickInput,
    el('span', { class: 'kbd', text: '↵' }),
    preview
  );

  wireQuickAdd(quickInput, preview);

  const main = el('main', { class: 'main' },
    el('div', { class: 'topbar' },
      el('div', {}, el('h1', { id: 'page-title' }), el('div', { class: 'sub', id: 'page-sub' })),
      el('div', { class: 'topbar-actions' },
        quick,
        el('button', { class: 'btn btn-primary', onclick: () => openEditor(null, refresh) }, '+ Add')
      )
    ),
    contentEl
  );

  appRoot.replaceChildren(el('div', { class: 'shell' }, navEl, main));
}

/* ------------------------------------------------------------------ */
/* Quick add (natural language)                                        */
/* ------------------------------------------------------------------ */
function wireQuickAdd(input, preview) {
  let parsed = null;

  const runParse = debounce(async (text) => {
    if (text.trim().length < 3) {
      preview.hidden = true;
      parsed = null;
      return;
    }
    try {
      const res = await api.post('/api/expenses/parse', { text });
      parsed = res;
      const f = res.fields;
      const chips = [];
      if (f.amountMinor) chips.push(['Amount', (f.amountMinor / 100).toFixed(2)]);
      if (f.merchant) chips.push(['Merchant', f.merchant]);
      if (f.categoryGuess) chips.push(['Category', `${f.categoryIcon || ''} ${f.categoryGuess}`.trim()]);
      if (f.spentAt) chips.push(['Date', new Date(f.spentAt).toLocaleDateString()]);
      if (f.paymentMethod && f.paymentMethod !== 'other') chips.push(['Via', f.paymentMethod]);
      if (f.isIncome) chips.push(['Type', 'income']);
      if (f.tags?.length) chips.push(['Tags', f.tags.map((t) => `#${t}`).join(' ')]);

      preview.replaceChildren(
        el('div', { class: 'qa-chips' }, ...chips.map(([k, v]) => el('span', { class: 'qa-chip' }, `${k}: `, el('b', { text: String(v) })))),
        res.ok
          ? el('div', { style: 'display:flex;gap:.5rem;align-items:center' },
              el('span', { class: 'card-sub', text: `${Math.round(res.confidence * 100)}% confident` }),
              el('div', { style: 'margin-left:auto;display:flex;gap:.4rem' },
                el('button', { class: 'btn btn-sm', onclick: () => { openEditor(null, refresh, res.fields); reset(); } }, 'Review first'),
                el('button', { class: 'btn btn-sm btn-primary', onclick: () => commit() }, 'Add now ↵')
              )
            )
          : el('div', { class: 'qa-warn', text: res.reason || 'Could not understand that.' }),
        ...(res.warnings || []).slice(0, 2).map((w) => el('div', { class: 'qa-warn', text: `· ${w}` }))
      );
      preview.hidden = false;
    } catch (err) {
      if (!(err instanceof ApiError)) return;
      preview.hidden = true;
    }
  }, 320);

  const reset = () => { input.value = ''; preview.hidden = true; parsed = null; };

  async function commit() {
    if (!parsed?.ok) return;
    const f = parsed.fields;
    try {
      const res = await api.post('/api/expenses', {
        amount: f.amountMinor / 100,
        merchant: f.merchant,
        note: f.note,
        paymentMethod: f.paymentMethod,
        spentAt: f.spentAt,
        isIncome: f.isIncome,
        tags: f.tags,
        ...(f.categoryId ? { categoryId: f.categoryId } : {})
      });
      reset();
      toast(`Added ${res.expense.merchant || 'expense'}`, {
        type: 'success', timeout: 3200,
        action: { label: 'Undo', onClick: () => api.del(`/api/expenses/${res.expense.id}`).then(refresh).catch(toastError) }
      });
      if (res.possibleDuplicate) {
        toast(`A near-identical entry exists from ${res.possibleDuplicate.hoursApart}h earlier.`, { type: 'warn', title: 'Possible duplicate', timeout: 7000 });
      }
      for (const a of res.unlocked || []) toast(a.description, { type: 'success', title: `${a.icon} ${a.name} unlocked!`, timeout: 6000 });
      refresh();
    } catch (err) { toastError(err); }
  }

  input.addEventListener('input', (e) => runParse(e.target.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') reset();
  });
  document.addEventListener('click', (e) => {
    if (!preview.hidden && !preview.contains(e.target) && e.target !== input) preview.hidden = true;
  });
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */
let currentRoute = null;

async function navigate(route) {
  if (!ROUTES[route]) route = 'dashboard';
  currentRoute = route;
  const def = ROUTES[route];

  history.replaceState(null, '', `#${route}`);
  document.title = `FinTrack · ${def.title}`;
  document.getElementById('page-title').textContent = def.title;
  document.getElementById('page-sub').textContent = def.sub;

  for (const btn of navEl.querySelectorAll('.nav-item[data-route]')) {
    btn.classList.toggle('active', btn.dataset.route === route);
  }

  contentEl.replaceChildren();
  try {
    await def.view(contentEl);
  } catch (err) {
    console.error('View crashed', err);
    contentEl.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('span', { class: 'ico', text: '💥' }),
        el('b', { text: 'This page hit an error' }),
        el('p', { text: err.message, style: 'font-size:.85rem;margin:.4rem 0 1rem;color:var(--text-dim)' }),
        el('button', { class: 'btn btn-primary', onclick: () => navigate(route) }, 'Try again')
      )
    ));
    toastError(err);
  }
}

const refresh = () => navigate(currentRoute || 'dashboard');

window.addEventListener('navigate', (e) => navigate(e.detail));
window.addEventListener('profile-updated', () => renderShell() || navigate(currentRoute));
window.addEventListener('hashchange', () => {
  const route = location.hash.replace('#', '');
  if (route && route !== currentRoute) navigate(route);
});

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */
const paletteEl = document.getElementById('palette');
const paletteInput = document.getElementById('palette-input');
const paletteResults = document.getElementById('palette-results');
let paletteIndex = 0;
let paletteItems = [];

function baseCommands() {
  return [
    ...Object.entries(ROUTES).map(([key, r]) => ({ icon: r.icon, label: `Go to ${r.label}`, hint: 'navigate', run: () => navigate(key) })),
    { icon: '➕', label: 'Add an expense', hint: 'create', run: () => openEditor(null, refresh) },
    { icon: '🌓', label: 'Toggle light / dark theme', hint: 'theme', run: () => theme.toggle() },
    { icon: '⬇', label: 'Export expenses as CSV', hint: 'data', run: () => api.download('/api/io/export.csv', 'fintrack-expenses.csv').catch(toastError) },
    { icon: '⬇', label: 'Export full backup as JSON', hint: 'data', run: () => api.download('/api/io/export.json', 'fintrack-backup.json').catch(toastError) },
    { icon: '🚪', label: 'Sign out', hint: 'session', run: async () => { try { await api.post('/api/auth/logout'); } catch { /* ignore */ } auth.token = null; location.reload(); } }
  ];
}

function renderPalette(query) {
  const q = query.trim().toLowerCase();
  const commands = baseCommands();
  paletteItems = q ? commands.filter((c) => c.label.toLowerCase().includes(q) || c.hint.includes(q)) : commands;

  // If it does not look like a command, offer to log it as an expense instead.
  if (q.length > 3 && /\d/.test(q) && paletteItems.length < 3) {
    paletteItems.unshift({
      icon: '⚡', label: `Log "${query.trim()}" as an expense`, hint: 'quick add',
      run: async () => {
        try {
          const parsed = await api.post('/api/expenses/parse', { text: query });
          if (!parsed.ok) return toast(parsed.reason || 'Could not read that as an expense', { type: 'warn' });
          openEditor(null, refresh, parsed.fields);
        } catch (err) { toastError(err); }
      }
    });
  }

  paletteIndex = 0;
  paletteResults.replaceChildren(...paletteItems.map((c, i) =>
    el('div', {
      class: `palette-item ${i === paletteIndex ? 'sel' : ''}`,
      onclick: () => { closePalette(); c.run(); }
    }, el('span', { text: c.icon }), el('span', { text: c.label }), el('small', { text: c.hint }))
  ));
  if (!paletteItems.length) {
    paletteResults.replaceChildren(el('div', { class: 'palette-item', style: 'color:var(--text-dim)' }, 'No matching commands'));
  }
}

function highlight() {
  [...paletteResults.children].forEach((node, i) => node.classList.toggle('sel', i === paletteIndex));
  paletteResults.children[paletteIndex]?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  paletteEl.hidden = false;
  paletteInput.value = '';
  renderPalette('');
  paletteInput.focus();
}

function closePalette() {
  paletteEl.hidden = true;
  paletteInput.value = '';
}

paletteInput.addEventListener('input', (e) => renderPalette(e.target.value));
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); highlight(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); highlight(); }
  if (e.key === 'Enter') { e.preventDefault(); const c = paletteItems[paletteIndex]; if (c) { closePalette(); c.run(); } }
  if (e.key === 'Escape') closePalette();
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    state.user ? openPalette() : null;
    return;
  }
  if (typing || !state.user) return;
  // Single-key shortcuts, only when not typing into a field.
  if (e.key === 'n') { e.preventDefault(); openEditor(null, refresh); }
  if (e.key === '/') { e.preventDefault(); document.getElementById('quickadd-input')?.focus(); }
  if (e.key === 'g') {
    const once = (ev) => {
      const map = { d: 'dashboard', e: 'expenses', b: 'budgets', s: 'subscriptions', l: 'lab', p: 'split', o: 'goals', c: 'settings' };
      if (map[ev.key]) navigate(map[ev.key]);
      document.removeEventListener('keydown', once);
    };
    document.addEventListener('keydown', once);
  }
});

/* ------------------------------------------------------------------ */
/* Global safety nets                                                  */
/* ------------------------------------------------------------------ */
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection', e.reason);
  if (e.reason instanceof ApiError && e.reason.status !== 401) toastError(e.reason);
  e.preventDefault();
});

window.addEventListener('error', (e) => {
  console.error('Uncaught error', e.error || e.message);
});

window.addEventListener('offline', () => toast('You are offline. Changes will fail until the connection returns.', { type: 'warn', timeout: 6000 }));
window.addEventListener('online', () => toast('Back online.', { type: 'success', timeout: 2500 }));

boot().catch((err) => {
  console.error('Boot failed', err);
  bootEl.hidden = true;
  appRoot.hidden = false;
  appRoot.replaceChildren(el('div', { class: 'auth-wrap' },
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-brand' }, el('span', { text: '💥' }), 'FinTrack could not start'),
      el('p', { class: 'auth-sub', text: err.message }),
      el('button', { class: 'btn btn-primary btn-block', onclick: () => location.reload() }, 'Reload')
    )
  ));
});

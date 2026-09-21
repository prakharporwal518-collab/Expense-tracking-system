/** Shared DOM helpers: escaping, formatting, toasts and modals. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Always use this before interpolating user data into innerHTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let moneyFormat = { currency: 'INR', locale: 'en-IN' };
export const setMoneyFormat = (currency, locale) => { moneyFormat = { currency: currency || 'INR', locale: locale || 'en-IN' }; };

export function money(minor, { compact = false, sign = false } = {}) {
  const value = (Number(minor) || 0) / 100;
  // Compact notation only engages above 1 lakh; the extra decimal belongs to it
  // (so an axis never prints 1.5L and 2L both as "2L") and nowhere else.
  const useCompact = compact && Math.abs(value) >= 100000;
  try {
    const out = new Intl.NumberFormat(moneyFormat.locale, {
      style: 'currency', currency: moneyFormat.currency,
      notation: useCompact ? 'compact' : 'standard',
      // Zero reads as "₹0", not "₹0.00"; small amounts keep their paise.
      maximumFractionDigits: useCompact || value === 0 || Math.abs(value) >= 1000 ? (useCompact ? 1 : 0) : 2
    }).format(Math.abs(value));
    return sign && value !== 0 ? (value > 0 ? `+${out}` : `−${out}`) : (value < 0 ? `−${out}` : out);
  } catch {
    return `${moneyFormat.currency} ${value.toFixed(2)}`;
  }
}

export const num = (n) => new Intl.NumberFormat(moneyFormat.locale).format(Number(n) || 0);

export function dateLabel(iso, style = 'medium') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (style === 'relative') {
    const days = Math.round((Date.now() - d.getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days > 1 && days < 7) return `${days} days ago`;
    if (days < 0 && days > -7) return `in ${Math.abs(days)} days`;
  }
  return d.toLocaleDateString(moneyFormat.locale, { day: 'numeric', month: 'short', year: style === 'long' ? 'numeric' : undefined });
}

export const monthLabel = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en', { month: 'short', year: '2-digit' });
};

/* ---------- Toasts ---------- */
const toastRoot = () => document.getElementById('toasts');

export function toast(message, { type = 'info', title = null, timeout = 4200, action = null } = {}) {
  const root = toastRoot();
  if (!root) return;
  const node = el('div', { class: `toast ${type}` });
  const body = el('div');
  if (title) body.append(el('b', { text: title }));
  body.append(el('p', { text: message }));
  node.append(body);

  const actions = el('div', { class: 'act' });
  if (action) {
    actions.append(el('button', {
      class: 'btn btn-sm',
      onclick: () => { node.remove(); action.onClick(); }
    }, action.label));
  }
  actions.append(el('button', { class: 'btn btn-sm btn-icon', title: 'Dismiss', onclick: () => node.remove() }, '✕'));
  node.append(actions);

  root.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

export const toastError = (err) => {
  const msg = err?.message || 'Something went wrong';
  const details = Array.isArray(err?.details) ? err.details.join(' · ') : null;
  return toast(details || msg, { type: 'error', title: details ? msg : 'Error', timeout: 6500 });
};

/* ---------- Modal ---------- */
export function modal({ title, body, footer, wide = false, onClose = null }) {
  const root = document.getElementById('modal-root');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const content = el('div', { class: `modal ${wide ? 'modal-wide' : ''}` },
    el('div', { class: 'modal-head' }, el('h3', { text: title }), el('button', { onclick: close, title: 'Close' }, '✕')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('div', { class: 'modal-foot' }, footer) : null
  );

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => { if (e.target === backdrop) close(); }
  }, content);

  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  setTimeout(() => content.querySelector('input,select,textarea,button')?.focus(), 50);
  return { close, content };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };
    const m = modal({
      title,
      body: el('p', { text: message, style: 'color:var(--text-dim);font-size:.9rem' }),
      footer: [
        el('button', { class: 'btn', onclick: () => { done(false); m.close(); } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { done(true); m.close(); } }, confirmLabel)
      ],
      onClose: () => done(false)
    });
  });
}

export const spinner = () => el('div', { class: 'empty' }, el('div', { class: 'boot-spinner', style: 'margin:0 auto' }));

export const emptyState = (icon, title, sub) =>
  el('div', { class: 'empty' }, el('span', { class: 'ico', text: icon }), el('b', { text: title }), sub ? el('p', { text: sub, style: 'font-size:.85rem;margin-top:.25rem' }) : null);

export const debounce = (fn, ms = 300) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

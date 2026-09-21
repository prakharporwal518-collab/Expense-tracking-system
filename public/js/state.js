/** Tiny observable store — views subscribe and re-render on change. */
const listeners = new Set();

export const state = {
  user: null,
  route: 'dashboard',
  summary: null,
  categories: [],
  meta: null,
  loading: false
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('State listener failed', err); }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const theme = {
  get() {
    try { return localStorage.getItem('fintrack.theme') || 'dark'; } catch { return 'dark'; }
  },
  set(value) {
    try { localStorage.setItem('fintrack.theme', value); } catch { /* ignore */ }
    document.documentElement.dataset.theme = value;
  },
  toggle() {
    const next = this.get() === 'dark' ? 'light' : 'dark';
    this.set(next);
    return next;
  }
};

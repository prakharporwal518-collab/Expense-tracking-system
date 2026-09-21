import { api } from '../api.js';
import { el, money, dateLabel, toast, toastError, spinner, emptyState, modal, confirmDialog, debounce } from '../ui.js';
import { state } from '../state.js';

const filters = {
  search: '', categoryId: '', paymentMethod: '', type: 'all',
  sort: 'date_desc', limit: 50, offset: 0
};

export async function expensesView(root) {
  filters.offset = 0;
  const bar = el('div', { class: 'filters' });
  const tableCard = el('div', { class: 'card' }, spinner());
  root.append(bar, tableCard);

  const searchInput = el('input', {
    class: 'input', type: 'search', placeholder: 'Search merchant or note…', value: filters.search,
    oninput: debounce((e) => { filters.search = e.target.value.trim(); filters.offset = 0; load(); }, 320)
  });

  const categorySelect = el('select', {
    class: 'input',
    onchange: (e) => { filters.categoryId = e.target.value; filters.offset = 0; load(); }
  },
    el('option', { value: '' }, 'All categories'),
    ...state.categories.map((c) => el('option', { value: c.id }, `${c.icon} ${c.name}`))
  );

  const typeSelect = el('select', { class: 'input', onchange: (e) => { filters.type = e.target.value; filters.offset = 0; load(); } },
    el('option', { value: 'all' }, 'All types'),
    el('option', { value: 'expense' }, 'Expenses'),
    el('option', { value: 'income' }, 'Income')
  );

  const methodSelect = el('select', { class: 'input', onchange: (e) => { filters.paymentMethod = e.target.value; filters.offset = 0; load(); } },
    el('option', { value: '' }, 'Any method'),
    ...(state.meta?.paymentMethods || []).map((m) => el('option', { value: m }, m))
  );

  const sortSelect = el('select', { class: 'input', onchange: (e) => { filters.sort = e.target.value; filters.offset = 0; load(); } },
    el('option', { value: 'date_desc' }, 'Newest first'),
    el('option', { value: 'date_asc' }, 'Oldest first'),
    el('option', { value: 'amount_desc' }, 'Largest first'),
    el('option', { value: 'amount_asc' }, 'Smallest first')
  );

  bar.append(searchInput, categorySelect, typeSelect, methodSelect, sortSelect,
    el('button', { class: 'btn btn-sm', onclick: () => openEditor(null, load) }, '+ Add manually'),
    el('button', { class: 'btn btn-sm', onclick: () => api.download('/api/io/export.csv', 'fintrack-expenses.csv').catch(toastError) }, '⬇ CSV')
  );

  async function load() {
    tableCard.replaceChildren(spinner());
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== null) params.set(k, v);

    let data;
    try {
      data = await api.get(`/api/expenses?${params}`);
    } catch (err) {
      tableCard.replaceChildren(emptyState('⚠️', 'Could not load expenses', err.message));
      return;
    }

    if (!data.expenses.length) {
      tableCard.replaceChildren(emptyState('🗂️', 'No expenses match', 'Try clearing the filters or add your first expense.'));
      return;
    }

    const rows = data.expenses.map((e) => el('tr', {},
      el('td', {}, el('div', { style: 'display:flex;align-items:center;gap:.5rem' },
        el('span', { text: e.categoryIcon }),
        el('div', {},
          el('div', { style: 'font-weight:600', text: e.merchant || e.note || 'Untitled' }),
          e.note && e.merchant ? el('div', { class: 'card-sub', text: e.note }) : null
        )
      )),
      el('td', {}, e.category ? el('span', { class: 'pill', text: e.category }) : el('span', { class: 'card-sub', text: '—' })),
      el('td', {}, el('span', { class: 'card-sub', text: dateLabel(e.spentAt, 'relative') })),
      el('td', {}, el('span', { class: 'pill', text: e.paymentMethod })),
      el('td', {}, ...(e.tags || []).slice(0, 3).map((t) => el('span', { class: 'tag', text: `#${t}`, style: 'margin-right:.25rem' }))),
      el('td', { class: 'num', style: e.isIncome ? 'color:var(--good)' : '' }, `${e.isIncome ? '+' : ''}${money(e.amountMinor)}`),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'btn btn-sm btn-icon', title: 'Edit', onclick: () => openEditor(e, load) }, '✏️'),
        el('button', { class: 'btn btn-sm btn-icon btn-danger', title: 'Delete', onclick: () => remove(e, load) }, '🗑')
      ))
    ));

    const pageStart = data.pagination.offset + 1;
    const pageEnd = data.pagination.offset + data.expenses.length;

    tableCard.replaceChildren(
      el('div', { class: 'card-head' },
        el('h3', { text: `${data.pagination.total} transactions` }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'card-sub', text: `Spent ${money(data.totals.spentMinor)} · Earned ${money(data.totals.earnedMinor)}` })
      ),
      el('div', { class: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Description'), el('th', {}, 'Category'), el('th', {}, 'Date'),
            el('th', {}, 'Method'), el('th', {}, 'Tags'), el('th', { class: 'num' }, 'Amount'), el('th', {}, '')
          )),
          el('tbody', {}, ...rows)
        )
      ),
      el('div', { style: 'display:flex;gap:.5rem;align-items:center;margin-top:1rem' },
        el('span', { class: 'card-sub', text: `Showing ${pageStart}–${pageEnd} of ${data.pagination.total}` }),
        el('div', { class: 'spacer', style: 'margin-left:auto;display:flex;gap:.5rem' },
          el('button', { class: 'btn btn-sm', disabled: filters.offset === 0, onclick: () => { filters.offset = Math.max(0, filters.offset - filters.limit); load(); } }, '← Prev'),
          el('button', { class: 'btn btn-sm', disabled: !data.pagination.hasMore, onclick: () => { filters.offset += filters.limit; load(); } }, 'Next →')
        )
      )
    );
  }

  await load();
  return load;
}

async function remove(expense, reload) {
  const ok = await confirmDialog({
    title: 'Delete expense?',
    message: `${expense.merchant || 'This expense'} · ${money(expense.amountMinor)}. You can undo this straight away.`,
    confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;

  try {
    await api.del(`/api/expenses/${expense.id}`);
    reload();
    toast('Expense deleted', {
      type: 'success',
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await api.post(`/api/expenses/${expense.id}/restore`);
            toast('Restored', { type: 'success', timeout: 2200 });
            reload();
          } catch (err) { toastError(err); }
        }
      }
    });
  } catch (err) { toastError(err); }
}

/** Shared add/edit form, also used by the quick-add confirmation flow. */
export function openEditor(expense, onSaved, prefill = null) {
  const isEdit = Boolean(expense);
  const data = expense || prefill || {};

  const amount = el('input', { class: 'input', type: 'number', step: '0.01', min: '0.01', required: true, placeholder: '0.00', value: data.amountMinor ? (data.amountMinor / 100).toFixed(2) : '' });
  const merchant = el('input', { class: 'input', type: 'text', maxlength: '120', placeholder: 'e.g. Swiggy', value: data.merchant || '' });
  const note = el('input', { class: 'input', type: 'text', maxlength: '500', placeholder: 'Optional note', value: data.note || '' });
  const date = el('input', { class: 'input', type: 'date', value: (data.spentAt || new Date().toISOString()).slice(0, 10) });
  const tags = el('input', { class: 'input', type: 'text', placeholder: 'comma,separated', value: (data.tags || []).join(', ') });

  const category = el('select', { class: 'input' },
    el('option', { value: '' }, 'Uncategorised'),
    ...state.categories.map((c) => el('option', { value: c.id, selected: String(c.id) === String(data.categoryId) }, `${c.icon} ${c.name}`))
  );

  const method = el('select', { class: 'input' },
    ...(state.meta?.paymentMethods || ['other']).map((m) => el('option', { value: m, selected: m === (data.paymentMethod || 'other') }, m))
  );

  const isIncome = el('input', { type: 'checkbox', checked: Boolean(data.isIncome) });
  const errorBox = el('div', { class: 'field-error', hidden: true });

  const body = el('div', {},
    errorBox,
    el('div', { class: 'field' }, el('label', { text: 'Amount' }), amount),
    el('div', { class: 'row' },
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Category' }), category),
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Date' }), date)
    ),
    el('div', { class: 'field' }, el('label', { text: 'Merchant' }), merchant),
    el('div', { class: 'field' }, el('label', { text: 'Note' }), note),
    el('div', { class: 'row' },
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Payment method' }), method),
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Tags' }), tags)
    ),
    el('label', { style: 'display:flex;align-items:center;gap:.5rem;font-size:.87rem;cursor:pointer' }, isIncome, 'This is income, not an expense')
  );

  const saveBtn = el('button', { class: 'btn btn-primary' }, isEdit ? 'Save changes' : 'Add expense');

  const m = modal({
    title: isEdit ? 'Edit expense' : 'Add expense',
    body,
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn]
  });

  // Suggest a category from the merchant text, but never overwrite a manual pick.
  let suggested = false;
  merchant.addEventListener('blur', async () => {
    if (suggested || category.value || !merchant.value.trim()) return;
    try {
      const s = await api.post('/api/expenses/suggest-category', { text: `${merchant.value} ${note.value}` });
      if (s.categoryId) {
        category.value = String(s.categoryId);
        suggested = true;
        toast(`Category suggested: ${s.category} (${Math.round(s.confidence * 100)}%)`, { type: 'info', timeout: 2600 });
      }
    } catch { /* suggestion is optional */ }
  });

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    const value = Number(amount.value);
    if (!Number.isFinite(value) || value <= 0) {
      errorBox.textContent = 'Enter an amount greater than zero.';
      errorBox.hidden = false;
      amount.classList.add('error');
      amount.focus();
      return;
    }

    const payload = {
      amount: value,
      merchant: merchant.value.trim(),
      note: note.value.trim(),
      paymentMethod: method.value,
      spentAt: new Date(`${date.value}T12:00:00`).toISOString(),
      isIncome: isIncome.checked,
      tags: tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 10)
    };
    if (category.value) payload.categoryId = Number(category.value);

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const res = isEdit
        ? await api.patch(`/api/expenses/${expense.id}`, payload)
        : await api.post('/api/expenses', payload);

      m.close();
      toast(isEdit ? 'Expense updated' : 'Expense added', { type: 'success', timeout: 2400 });

      if (res.possibleDuplicate) {
        toast(`A near-identical entry was logged ${res.possibleDuplicate.hoursApart}h earlier. Check it is not a double entry.`, { type: 'warn', title: 'Possible duplicate', timeout: 8000 });
      }
      for (const a of res.unlocked || []) {
        toast(a.description, { type: 'success', title: `${a.icon} ${a.name} unlocked!`, timeout: 6000 });
      }
      onSaved?.();
    } catch (err) {
      errorBox.textContent = Array.isArray(err.details) ? err.details.join(' · ') : err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save changes' : 'Add expense';
    }
  });
}

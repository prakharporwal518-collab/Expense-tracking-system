import { api } from '../api.js';
import { el, money, toast, toastError, spinner, emptyState, modal, confirmDialog } from '../ui.js';
import { state } from '../state.js';

const PACE_LABEL = { ahead: '🔺 spending fast', behind: '🟢 under pace', 'on-track': '⚖️ on pace' };

export async function budgetsView(root) {
  root.append(spinner());
  let data;
  try {
    data = await api.get('/api/budgets');
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'Could not load budgets', err.message));
    return;
  }

  root.replaceChildren();
  const reload = () => budgetsView(root);

  const used = data.totals.budgetedMinor > 0 ? (data.totals.spentMinor / data.totals.budgetedMinor) * 100 : 0;

  root.append(el('div', { class: 'grid grid-3' },
    el('div', { class: 'card stat' }, el('div', { class: 'label', text: 'Total budgeted' }), el('div', { class: 'value', text: money(data.totals.budgetedMinor) })),
    el('div', { class: 'card stat' }, el('div', { class: 'label', text: 'Spent against budget' }), el('div', { class: 'value', text: money(data.totals.spentMinor) }), el('div', { class: `delta ${used > 100 ? 'up' : 'down'}`, text: `${used.toFixed(0)}% used` })),
    el('div', { class: 'card stat' }, el('div', { class: 'label', text: 'Days left this month' }), el('div', { class: 'value', text: String(data.daysLeft) }))
  ));

  const list = el('div', { class: 'card', style: 'margin-top:1.1rem' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Category envelopes' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm btn-primary', onclick: () => openBudgetEditor(null, reload) }, '+ New budget')
    )
  );

  if (!data.budgets.length) {
    list.append(emptyState('🎯', 'No budgets yet', 'Set a monthly limit per category and FinTrack will pace it for you.'));
  } else {
    for (const b of data.budgets) {
      list.append(el('div', { class: 'budget-row' },
        el('div', { class: 'budget-top' },
          el('span', { text: b.icon }),
          el('b', { text: b.category }),
          el('span', { class: 'pill', text: PACE_LABEL[b.pace] || b.pace }),
          el('div', { class: 'spacer' }),
          el('span', { text: `${money(b.spentMinor)} / ${money(b.amountMinor)}`, style: 'font-variant-numeric:tabular-nums' }),
          el('button', { class: 'btn btn-sm btn-icon', title: 'Edit', onclick: () => openBudgetEditor(b, reload) }, '✏️'),
          el('button', { class: 'btn btn-sm btn-icon btn-danger', title: 'Remove', onclick: () => removeBudget(b, reload) }, '🗑')
        ),
        el('div', { class: `bar ${b.status}` }, el('i', { style: `width:${Math.min(100, b.percentUsed)}%` })),
        el('div', { style: 'display:flex;margin-top:.4rem;font-size:.78rem;color:var(--text-dim)' },
          el('span', { text: `${b.percentUsed}% used · alert at ${b.alertAtPercent}%` }),
          el('span', {
            style: `margin-left:auto;${b.remainingMinor < 0 ? 'color:var(--bad)' : ''}`,
            text: b.remainingMinor < 0
              ? `Over by ${money(Math.abs(b.remainingMinor))}`
              : `${money(b.remainingMinor)} left · ${money(b.perDayLeftMinor)}/day`
          })
        )
      ));
    }
  }
  root.append(list);
}

function openBudgetEditor(budget, onSaved) {
  const isEdit = Boolean(budget);
  const amount = el('input', { class: 'input', type: 'number', min: '0', step: '1', placeholder: '5000', value: budget ? (budget.amountMinor / 100).toFixed(0) : '' });
  const alertAt = el('input', { class: 'input', type: 'number', min: '10', max: '100', value: budget?.alertAtPercent ?? 80 });

  const category = el('select', { class: 'input', disabled: isEdit },
    ...state.categories.filter((c) => c.kind === 'expense')
      .map((c) => el('option', { value: c.id, selected: budget && String(c.id) === String(budget.categoryId) }, `${c.icon} ${c.name}`))
  );

  const errorBox = el('div', { class: 'field-error', hidden: true });
  const saveBtn = el('button', { class: 'btn btn-primary' }, isEdit ? 'Update budget' : 'Create budget');

  const m = modal({
    title: isEdit ? `Budget · ${budget.category}` : 'New budget',
    body: el('div', {},
      errorBox,
      el('div', { class: 'field' }, el('label', { text: 'Category' }), category),
      el('div', { class: 'field' }, el('label', { text: 'Monthly limit' }), amount),
      el('div', { class: 'field' }, el('label', { text: 'Warn me at (% used)' }), alertAt)
    ),
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn]
  });

  saveBtn.addEventListener('click', async () => {
    const value = Number(amount.value);
    if (!Number.isFinite(value) || value < 0) {
      errorBox.textContent = 'Enter a valid monthly limit.';
      errorBox.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.post('/api/budgets', {
        categoryId: Number(category.value),
        amount: value,
        alertAtPercent: Number(alertAt.value) || 80
      });
      m.close();
      toast('Budget saved', { type: 'success', timeout: 2200 });
      onSaved?.();
    } catch (err) {
      errorBox.textContent = Array.isArray(err.details) ? err.details.join(' · ') : err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

async function removeBudget(budget, onDone) {
  const ok = await confirmDialog({ title: 'Remove budget?', message: `The ${budget.category} envelope will stop being tracked.`, confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/budgets/${budget.id}`);
    toast('Budget removed', { type: 'success', timeout: 2000 });
    onDone?.();
  } catch (err) { toastError(err); }
}

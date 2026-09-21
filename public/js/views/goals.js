import { api } from '../api.js';
import { el, money, dateLabel, toast, toastError, spinner, emptyState, modal, confirmDialog } from '../ui.js';

export async function goalsView(root) {
  root.append(spinner());
  let data;
  try {
    data = await api.get('/api/goals');
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'Could not load goals', err.message));
    return;
  }

  root.replaceChildren();
  const reload = () => goalsView(root);

  root.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Savings goals' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill', text: `Monthly surplus: ${money(data.monthlySurplusMinor, { sign: true })}` }),
      el('button', { class: 'btn btn-sm btn-primary', onclick: () => openGoalEditor(null, reload) }, '+ New goal')
    ),
    data.goals.length ? null : emptyState('⭐', 'No goals yet', 'Name something you are saving for and FinTrack will project when you will get there.')
  ));

  if (!data.goals.length) return;

  const grid = el('div', { class: 'grid grid-2', style: 'margin-top:1.1rem' });
  for (const g of data.goals) {
    const p = g.projection;
    const pct = Math.round(p.progress * 100);
    const statusText = p.status === 'reached' ? '🎉 Goal reached!'
      : p.status === 'stalled' ? '⚠️ No surplus — not progressing'
      : p.onTrack ? `🟢 On track · ETA ${dateLabel(p.etaISO)}`
      : `🟠 Behind · needs ${money(p.requiredPerMonth)}/month`;

    grid.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: g.name }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn-sm btn-icon', title: 'Edit', onclick: () => openGoalEditor(g, reload) }, '✏️'),
        el('button', { class: 'btn btn-sm btn-icon btn-danger', title: 'Delete', onclick: () => removeGoal(g, reload) }, '🗑')
      ),
      el('div', { style: 'display:flex;align-items:baseline;gap:.5rem;margin-bottom:.6rem' },
        el('span', { style: 'font-size:1.5rem;font-weight:800', text: money(g.savedMinor) }),
        el('span', { class: 'card-sub', text: `of ${money(g.targetMinor)}` }),
        el('span', { class: 'pill', style: 'margin-left:auto', text: `${pct}%` })
      ),
      el('div', { class: `bar ${p.status === 'reached' ? 'ok' : p.onTrack ? 'ok' : 'warning'}` }, el('i', { style: `width:${Math.min(100, pct)}%` })),
      el('p', { class: 'card-sub', style: 'margin-top:.6rem', text: statusText }),
      g.targetDate ? el('p', { class: 'card-sub', text: `Target date: ${dateLabel(g.targetDate, 'long')}` }) : null,
      el('div', { style: 'display:flex;gap:.5rem;margin-top:.85rem' },
        el('button', { class: 'btn btn-sm', onclick: () => contribute(g, reload) }, '💰 Add money'),
        p.monthsNeeded ? el('span', { class: 'card-sub', style: 'align-self:center', text: `~${p.monthsNeeded} months to go` }) : null
      )
    ));
  }
  root.append(grid);
}

function contribute(goal, onSaved) {
  const input = el('input', { class: 'input', type: 'number', step: '0.01', placeholder: '1000' });
  const errorBox = el('div', { class: 'field-error', hidden: true });
  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Add to goal');

  const m = modal({
    title: `Add to "${goal.name}"`,
    body: el('div', {},
      errorBox,
      el('p', { class: 'card-sub', style: 'margin-bottom:1rem', text: `Currently ${money(goal.savedMinor)} of ${money(goal.targetMinor)}. Use a negative number to withdraw.` }),
      el('div', { class: 'field' }, el('label', { text: 'Amount' }), input)
    ),
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn]
  });

  saveBtn.addEventListener('click', async () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value === 0) {
      errorBox.textContent = 'Enter a non-zero amount.';
      errorBox.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    try {
      const res = await api.patch(`/api/goals/${goal.id}`, { contribute: value });
      m.close();
      toast('Goal updated', { type: 'success', timeout: 2200 });
      for (const a of res.unlocked || []) toast(a.description, { type: 'success', title: `${a.icon} ${a.name} unlocked!`, timeout: 6000 });
      onSaved?.();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

function openGoalEditor(goal, onSaved) {
  const isEdit = Boolean(goal);
  const name = el('input', { class: 'input', maxlength: '60', placeholder: 'New laptop', value: goal?.name || '' });
  const target = el('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: '80000', value: goal ? (goal.targetMinor / 100).toFixed(0) : '' });
  const saved = el('input', { class: 'input', type: 'number', min: '0', step: '1', value: goal ? (goal.savedMinor / 100).toFixed(0) : '0' });
  const date = el('input', { class: 'input', type: 'date', value: goal?.targetDate ? goal.targetDate.slice(0, 10) : '' });
  const errorBox = el('div', { class: 'field-error', hidden: true });
  const saveBtn = el('button', { class: 'btn btn-primary' }, isEdit ? 'Save goal' : 'Create goal');

  const m = modal({
    title: isEdit ? 'Edit goal' : 'New savings goal',
    body: el('div', {},
      errorBox,
      el('div', { class: 'field' }, el('label', { text: 'What are you saving for?' }), name),
      el('div', { class: 'row' },
        el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Target amount' }), target),
        el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Already saved' }), saved)
      ),
      el('div', { class: 'field' }, el('label', { text: 'Target date (optional)' }), date)
    ),
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn]
  });

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    if (!name.value.trim()) { errorBox.textContent = 'Give the goal a name.'; errorBox.hidden = false; return; }
    const targetValue = Number(target.value);
    const savedValue = Number(saved.value) || 0;
    if (!Number.isFinite(targetValue) || targetValue < 1) { errorBox.textContent = 'Target must be at least 1.'; errorBox.hidden = false; return; }
    if (savedValue > targetValue) { errorBox.textContent = 'Saved amount cannot exceed the target.'; errorBox.hidden = false; return; }

    const payload = { name: name.value.trim(), target: targetValue, saved: savedValue };
    if (date.value) payload.targetDate = new Date(`${date.value}T12:00:00`).toISOString();

    saveBtn.disabled = true;
    try {
      const res = isEdit ? await api.patch(`/api/goals/${goal.id}`, payload) : await api.post('/api/goals', payload);
      m.close();
      toast(isEdit ? 'Goal saved' : 'Goal created', { type: 'success', timeout: 2200 });
      for (const a of res.unlocked || []) toast(a.description, { type: 'success', title: `${a.icon} ${a.name} unlocked!`, timeout: 6000 });
      onSaved?.();
    } catch (err) {
      errorBox.textContent = Array.isArray(err.details) ? err.details.join(' · ') : err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

async function removeGoal(goal, onDone) {
  const ok = await confirmDialog({ title: 'Delete goal?', message: `"${goal.name}" and its progress will be removed.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/goals/${goal.id}`);
    toast('Goal deleted', { type: 'success', timeout: 2000 });
    onDone?.();
  } catch (err) { toastError(err); }
}

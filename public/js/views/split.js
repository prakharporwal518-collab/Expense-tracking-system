import { api } from '../api.js';
import { el, money, dateLabel, toast, toastError, spinner, emptyState, modal, confirmDialog } from '../ui.js';

export async function splitView(root) {
  root.append(spinner());
  let data;
  try {
    data = await api.get('/api/groups');
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'Could not load groups', err.message));
    return;
  }

  root.replaceChildren();
  const reload = () => splitView(root);

  root.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Shared expense groups' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm btn-primary', onclick: () => openGroupCreator(reload) }, '+ New group')
    ),
    el('p', { class: 'card-sub', text: 'Track who paid for what on a trip, then settle up in the fewest possible transfers.' })
  ));

  if (!data.groups.length) {
    root.append(el('div', { style: 'margin-top:1.1rem' }, emptyState('🤝', 'No groups yet', 'Create one for your next trip or flat share.')));
    return;
  }

  const grid = el('div', { class: 'grid grid-3', style: 'margin-top:1.1rem' });
  for (const g of data.groups) {
    grid.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', { text: g.name })),
      el('div', { class: 'stat' },
        el('div', { class: 'value', style: 'font-size:1.4rem', text: money(g.totalMinor) }),
        el('div', { class: 'delta flat', text: `${g.memberCount} members · ${g.expenseCount} expenses` })
      ),
      el('button', { class: 'btn btn-block', style: 'margin-top:.9rem', onclick: () => openGroupDetail(g.id, reload) }, 'Open & settle →')
    ));
  }
  root.append(grid);
}

async function openGroupDetail(groupId, onChanged) {
  let g;
  try {
    g = await api.get(`/api/groups/${groupId}`);
  } catch (err) { return toastError(err); }

  const body = el('div');

  /* Balances */
  body.append(el('h4', { text: 'Balances', style: 'font-size:.85rem;color:var(--text-dim);margin-bottom:.5rem' }));
  for (const b of g.balances) {
    body.append(el('div', { style: 'display:flex;align-items:center;gap:.5rem;padding:.35rem 0;font-size:.88rem' },
      el('span', { text: b.name }),
      el('span', {
        style: `margin-left:auto;font-weight:600;color:${b.net_minor > 0 ? 'var(--good)' : b.net_minor < 0 ? 'var(--bad)' : 'var(--text-dim)'}`,
        text: b.net_minor === 0 ? 'settled' : b.net_minor > 0 ? `is owed ${money(b.net_minor)}` : `owes ${money(Math.abs(b.net_minor))}`
      })
    ));
  }

  /* Settlement plan */
  body.append(el('h4', { text: 'Settle up', style: 'font-size:.85rem;color:var(--text-dim);margin:1.1rem 0 .5rem' }));
  if (!g.transfers.length) {
    body.append(el('p', { class: 'card-sub', text: '🎉 Everyone is square — no transfers needed.' }));
  } else {
    body.append(el('p', { class: 'card-sub', style: 'margin-bottom:.6rem', text: `${g.transferCount} transfer${g.transferCount === 1 ? '' : 's'} clears every debt (a naive settlement would need up to ${g.naiveTransferCount}).` }));
    for (const t of g.transfers) {
      body.append(el('div', { style: 'display:flex;align-items:center;gap:.5rem;padding:.5rem .7rem;background:var(--surface-2);border-radius:10px;margin-bottom:.4rem;font-size:.88rem' },
        el('b', { text: t.fromName }), el('span', { text: '→' }), el('b', { text: t.toName }),
        el('span', { style: 'margin-left:auto;font-weight:700', text: money(t.amount_minor) }),
        el('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            try {
              const res = await api.post(`/api/groups/${groupId}/settle`, { fromId: t.from, toId: t.to, amount: t.amount_minor / 100 });
              toast('Settlement recorded', { type: 'success', timeout: 2200 });
              for (const a of res.unlocked || []) toast(a.description, { type: 'success', title: `${a.icon} ${a.name} unlocked!`, timeout: 6000 });
              m.close();
              openGroupDetail(groupId, onChanged);
              onChanged?.();
            } catch (err) { toastError(err); }
          }
        }, 'Mark paid')
      ));
    }
  }

  /* Expense list */
  body.append(el('h4', { text: 'Expenses', style: 'font-size:.85rem;color:var(--text-dim);margin:1.1rem 0 .5rem' }));
  if (!g.expenses.length) {
    body.append(el('p', { class: 'card-sub', text: 'No shared expenses yet.' }));
  } else {
    body.append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'What'), el('th', {}, 'Paid by'), el('th', {}, 'Split'), el('th', { class: 'num' }, 'Amount'), el('th', {}, ''))),
      el('tbody', {}, ...g.expenses.map((e) => el('tr', {},
        el('td', {}, el('div', {}, el('div', { style: 'font-weight:600', text: e.description }), el('div', { class: 'card-sub', text: dateLabel(e.spentAt) }))),
        el('td', {}, e.payerName),
        el('td', {}, el('span', { class: 'pill', text: e.splitMode })),
        el('td', { class: 'num' }, money(e.amountMinor)),
        el('td', {}, el('button', {
          class: 'btn btn-sm btn-icon btn-danger', title: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Delete shared expense?', message: `"${e.description}" will be removed and balances recalculated.`, confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            try {
              await api.del(`/api/groups/${groupId}/expenses/${e.id}`);
              toast('Removed', { type: 'success', timeout: 2000 });
              m.close();
              openGroupDetail(groupId, onChanged);
            } catch (err) { toastError(err); }
          }
        }, '🗑'))
      )))
    )));
  }

  const m = modal({
    title: g.group.name,
    wide: true,
    body,
    footer: [
      el('button', { class: 'btn btn-danger', onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete group?', message: `"${g.group.name}" and all its shared expenses will be deleted.`, confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try { await api.del(`/api/groups/${groupId}`); m.close(); toast('Group deleted', { type: 'success' }); onChanged?.(); }
        catch (err) { toastError(err); }
      } }, 'Delete group'),
      el('button', { class: 'btn btn-primary', onclick: () => { m.close(); openGroupExpense(g, () => { openGroupDetail(groupId, onChanged); onChanged?.(); }); } }, '+ Add expense')
    ]
  });
}

function openGroupExpense(g, onSaved) {
  const desc = el('input', { class: 'input', maxlength: '120', placeholder: 'Dinner at the beach shack' });
  const amount = el('input', { class: 'input', type: 'number', step: '0.01', min: '0.01', placeholder: '2400' });
  const payer = el('select', { class: 'input' }, ...g.members.map((m) => el('option', { value: m.id }, m.name)));
  const mode = el('select', { class: 'input' },
    el('option', { value: 'equal' }, 'Split equally'),
    el('option', { value: 'shares' }, 'By shares (e.g. 1 : 2 : 1)'),
    el('option', { value: 'exact' }, 'Exact amounts')
  );

  const shareBox = el('div', { hidden: true, style: 'margin-top:.5rem' });
  const shareInputs = new Map();
  for (const member of g.members) {
    const input = el('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: '1', style: 'max-width:110px' });
    shareInputs.set(member.id, input);
    shareBox.append(el('div', { style: 'display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem' },
      el('span', { text: member.name, style: 'flex:1;font-size:.87rem' }), input));
  }
  mode.addEventListener('change', () => {
    shareBox.hidden = mode.value === 'equal';
    if (mode.value === 'exact') for (const i of shareInputs.values()) i.value = '';
    if (mode.value === 'shares') for (const i of shareInputs.values()) i.value = '1';
  });

  const errorBox = el('div', { class: 'field-error', hidden: true });
  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Add expense');

  const m = modal({
    title: `Add expense to ${g.group.name}`,
    body: el('div', {},
      errorBox,
      el('div', { class: 'field' }, el('label', { text: 'Description' }), desc),
      el('div', { class: 'row' },
        el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Amount' }), amount),
        el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Paid by' }), payer)
      ),
      el('div', { class: 'field' }, el('label', { text: 'How to split' }), mode, shareBox)
    ),
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn]
  });

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    if (!desc.value.trim()) { errorBox.textContent = 'Add a description.'; errorBox.hidden = false; return; }
    const value = Number(amount.value);
    if (!Number.isFinite(value) || value <= 0) { errorBox.textContent = 'Enter an amount greater than zero.'; errorBox.hidden = false; return; }

    const shares = {};
    if (mode.value !== 'equal') {
      for (const [id, input] of shareInputs) {
        const n = Number(input.value);
        if (Number.isFinite(n) && n > 0) shares[id] = n;
      }
      if (!Object.keys(shares).length) { errorBox.textContent = 'Give at least one member a share.'; errorBox.hidden = false; return; }
    }

    saveBtn.disabled = true;
    try {
      await api.post(`/api/groups/${g.group.id}/expenses`, {
        description: desc.value.trim(), amount: value, payerId: Number(payer.value),
        splitMode: mode.value, shares
      });
      m.close();
      toast('Shared expense added', { type: 'success', timeout: 2200 });
      onSaved?.();
    } catch (err) {
      errorBox.textContent = Array.isArray(err.details) ? err.details.join(' · ') : err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

function openGroupCreator(onSaved) {
  const name = el('input', { class: 'input', maxlength: '60', placeholder: 'Goa Trip 2026' });
  const members = el('textarea', { class: 'input', rows: '5', placeholder: 'One name per line.\nYou\nAman\nRiya' });
  const errorBox = el('div', { class: 'field-error', hidden: true });
  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Create group');

  const m = modal({
    title: 'New group',
    body: el('div', {},
      errorBox,
      el('div', { class: 'field' }, el('label', { text: 'Group name' }), name),
      el('div', { class: 'field' }, el('label', { text: 'Members (first one is you)' }), members)
    ),
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn]
  });

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    const list = members.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!name.value.trim()) { errorBox.textContent = 'Give the group a name.'; errorBox.hidden = false; return; }
    if (list.length < 2) { errorBox.textContent = 'Add at least two members, one per line.'; errorBox.hidden = false; return; }

    saveBtn.disabled = true;
    try {
      await api.post('/api/groups', { name: name.value.trim(), members: list });
      m.close();
      toast('Group created', { type: 'success', timeout: 2200 });
      onSaved?.();
    } catch (err) {
      errorBox.textContent = Array.isArray(err.details) ? err.details.join(' · ') : err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

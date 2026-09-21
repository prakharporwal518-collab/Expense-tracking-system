import { api, auth } from '../api.js';
import { el, money, dateLabel, toast, toastError, spinner, emptyState, modal, setMoneyFormat } from '../ui.js';
import { state, setState, theme } from '../state.js';

export async function settingsView(root) {
  root.append(spinner());
  let achievements, activity;
  try {
    [achievements, activity] = await Promise.all([
      api.get('/api/analytics/achievements'),
      api.get('/api/analytics/activity?limit=25')
    ]);
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'Could not load settings', err.message));
    return;
  }

  root.replaceChildren();
  const user = state.user;

  /* ---- Profile ---- */
  const name = el('input', { class: 'input', value: user.name, maxlength: '60' });
  const income = el('input', { class: 'input', type: 'number', min: '0', step: '100', value: (user.monthlyIncomeMinor / 100).toFixed(0) });
  const currency = el('select', { class: 'input' },
    ...(state.meta?.currencies || ['INR']).map((c) => el('option', { value: c, selected: c === user.currency }, c))
  );
  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Save profile');

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const res = await api.patch('/api/auth/me', {
        name: name.value.trim(),
        monthlyIncome: Number(income.value) || 0,
        currency: currency.value
      });
      setState({ user: res.user });
      setMoneyFormat(res.user.currency, res.user.locale);
      toast('Profile saved', { type: 'success', timeout: 2200 });
      window.dispatchEvent(new CustomEvent('profile-updated'));
    } catch (err) {
      toastError(err);
    } finally {
      saveBtn.disabled = false;
    }
  });

  const profileCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Profile' })),
    el('div', { class: 'field' }, el('label', { text: 'Name' }), name),
    el('div', { class: 'field' }, el('label', { text: 'Email' }), el('input', { class: 'input', value: user.email, disabled: true })),
    el('div', { class: 'row' },
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Monthly income' }), income),
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Currency' }), currency)
    ),
    el('p', { class: 'card-sub', style: 'margin-bottom:.9rem', text: 'Your income powers the savings-rate and health-score calculations.' }),
    saveBtn
  );

  /* ---- Data ---- */
  const dataCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Your data' })),
    el('p', { class: 'card-sub', style: 'margin-bottom:.9rem', text: 'Export everything at any time — it is your data.' }),
    el('div', { style: 'display:flex;gap:.5rem;flex-wrap:wrap' },
      el('button', { class: 'btn', onclick: () => api.download('/api/io/export.csv', 'fintrack-expenses.csv').catch(toastError) }, '⬇ Export CSV'),
      el('button', { class: 'btn', onclick: () => api.download('/api/io/export.json', 'fintrack-backup.json').catch(toastError) }, '⬇ Export JSON'),
      el('button', { class: 'btn btn-primary', onclick: () => openImport() }, '⬆ Import CSV')
    ),
    el('hr', { style: 'border:none;border-top:1px solid var(--border);margin:1.1rem 0' }),
    el('div', { style: 'display:flex;align-items:center;gap:.5rem' },
      el('span', { text: 'Theme', style: 'font-size:.88rem' }),
      el('button', {
        class: 'btn btn-sm', style: 'margin-left:auto',
        onclick: (e) => { const next = theme.toggle(); e.target.textContent = next === 'dark' ? '🌙 Dark' : '☀️ Light'; }
      }, theme.get() === 'dark' ? '🌙 Dark' : '☀️ Light')
    ),
    el('div', { style: 'display:flex;align-items:center;gap:.5rem;margin-top:.7rem' },
      el('span', { text: 'Session', style: 'font-size:.88rem' }),
      el('button', {
        class: 'btn btn-sm btn-danger', style: 'margin-left:auto',
        onclick: async () => {
          try { await api.post('/api/auth/logout'); } catch { /* cookie clears client-side anyway */ }
          auth.token = null;
          location.reload();
        }
      }, 'Sign out')
    )
  );

  root.append(el('div', { class: 'grid grid-2' }, profileCard, dataCard));

  /* ---- Achievements ---- */
  const unlocked = achievements.achievements.filter((a) => a.unlocked).length;
  root.append(el('div', { class: 'card', style: 'margin-top:1.1rem' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Achievements' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill', text: `${unlocked} / ${achievements.achievements.length}` }),
      achievements.streak.current > 0 ? el('span', { class: 'pill', text: `🔥 ${achievements.streak.current}-day streak` }) : null,
      el('span', { class: 'pill', text: `Best: ${achievements.streak.longest} days` })
    ),
    el('div', { class: 'ach-grid' },
      ...achievements.achievements.map((a) => el('div', { class: `ach ${a.unlocked ? 'unlocked' : 'locked'}`, title: a.description },
        el('div', { class: 'ico', text: a.icon }),
        el('b', { text: a.name }),
        el('small', { text: a.unlocked ? dateLabel(a.unlockedAt) : a.description })
      ))
    )
  ));

  /* ---- Activity log ---- */
  root.append(el('div', { class: 'card', style: 'margin-top:1.1rem' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Recent activity' }), el('div', { class: 'spacer' }), el('span', { class: 'card-sub', text: 'Every change is logged' })),
    activity.activity.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'What'), el('th', {}, 'When'))),
          el('tbody', {}, ...activity.activity.map((a) => el('tr', {},
            el('td', {}, el('span', { class: 'pill', text: a.action })),
            el('td', { text: a.summary }),
            el('td', {}, el('span', { class: 'card-sub', text: dateLabel(a.at, 'relative') }))
          )))
        ))
      : emptyState('📜', 'No activity yet', null)
  ));
}

function openImport() {
  const fileInput = el('input', { class: 'input', type: 'file', accept: '.csv,text/csv' });
  const preview = el('div', { style: 'margin-top:1rem' });
  const importBtn = el('button', { class: 'btn btn-primary', disabled: true }, 'Import');
  let csvText = null;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 5_000_000) {
      preview.replaceChildren(el('p', { class: 'field-error', text: 'That file is larger than 5 MB. Split it into smaller files.' }));
      return;
    }
    preview.replaceChildren(spinner());
    try {
      csvText = await file.text();
      const dry = await api.post('/api/io/import/csv', { csv: csvText, dryRun: true });
      const detected = Object.entries(dry.detectedColumns).filter(([, v]) => v).map(([k, v]) => `${k} → "${v}"`);
      preview.replaceChildren(
        el('p', { style: 'font-size:.88rem;margin-bottom:.5rem' }, `Ready to import `, el('b', { text: String(dry.wouldImport) }), ` rows${dry.skipped ? `, skipping ${dry.skipped}` : ''}.`),
        el('p', { class: 'card-sub', text: `Columns detected: ${detected.join(', ') || 'none'}` }),
        ...(dry.errors.length
          ? [el('div', { style: 'margin-top:.6rem;max-height:120px;overflow:auto' },
              ...dry.errors.slice(0, 8).map((e) => el('p', { class: 'field-error', text: `Line ${e.line}: ${e.reason}` })))]
          : [])
      );
      importBtn.disabled = dry.wouldImport === 0;
    } catch (err) {
      preview.replaceChildren(el('p', { class: 'field-error', text: err.message }));
      importBtn.disabled = true;
    }
  });

  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    importBtn.textContent = 'Importing…';
    try {
      const res = await api.post('/api/io/import/csv', { csv: csvText });
      m.close();
      toast(`Imported ${res.imported} expenses${res.skipped ? `, skipped ${res.skipped}` : ''}.`, { type: 'success', timeout: 5000 });
      window.dispatchEvent(new CustomEvent('navigate', { detail: 'expenses' }));
    } catch (err) {
      toastError(err);
      importBtn.disabled = false;
      importBtn.textContent = 'Import';
    }
  });

  const m = modal({
    title: 'Import expenses from CSV',
    body: el('div', {},
      el('p', { class: 'card-sub', style: 'margin-bottom:1rem', text: 'Headers are matched loosely, so exports from most banks and other trackers work. Dates may be YYYY-MM-DD or DD/MM/YYYY. Rows without a category are auto-categorised.' }),
      el('div', { class: 'field' }, el('label', { text: 'CSV file' }), fileInput),
      preview
    ),
    footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), importBtn]
  });
}

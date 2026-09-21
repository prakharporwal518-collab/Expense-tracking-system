import { api } from '../api.js';
import { el, money, dateLabel, toast, toastError, spinner, emptyState, debounce } from '../ui.js';
import { barChart } from '../charts.js';

/** Reads better than "0h" for charges only minutes apart. */
const gapLabel = (hours) => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
};

/** The "Lab": what-if simulation, anomaly review and duplicate cleanup. */
export async function labView(root) {
  root.append(spinner());

  let summary, anomalies, duplicates;
  try {
    [summary, anomalies, duplicates] = await Promise.all([
      api.get('/api/analytics/summary'),
      api.get('/api/analytics/anomalies'),
      api.get('/api/analytics/duplicates')
    ]);
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'Could not load the lab', err.message));
    return;
  }

  root.replaceChildren();

  /* ---------- What-if simulator ---------- */
  const categories = summary.byCategory.slice(0, 6);
  const adjustments = {};
  const resultBox = el('div', { style: 'margin-top:1rem' });

  const runSim = debounce(async () => {
    try {
      const sim = await api.post('/api/analytics/whatif', { adjustments, annualReturnRate: Number(rateInput.value) || 0, horizonMonths: 12 });
      const saving = sim.monthlySaving;
      resultBox.replaceChildren(
        el('div', { class: 'grid grid-3' },
          el('div', { class: 'card stat', style: 'background:var(--surface-2)' },
            el('div', { class: 'label', text: 'Monthly change' }),
            el('div', { class: 'value', style: `font-size:1.35rem;color:${saving > 0 ? 'var(--good)' : saving < 0 ? 'var(--bad)' : ''}`, text: money(Math.abs(saving)) }),
            el('div', { class: 'delta flat', text: saving > 0 ? 'saved per month' : saving < 0 ? 'extra per month' : 'no change' })
          ),
          el('div', { class: 'card stat', style: 'background:var(--surface-2)' },
            el('div', { class: 'label', text: 'Over 12 months' }),
            el('div', { class: 'value', style: 'font-size:1.35rem', text: money(Math.abs(sim.annualSaving)) })
          ),
          el('div', { class: 'card stat', style: 'background:var(--surface-2)' },
            el('div', { class: 'label', text: 'If invested' }),
            el('div', { class: 'value', style: 'font-size:1.35rem', text: money(Math.abs(sim.futureValue)) }),
            el('div', { class: 'delta flat', text: `at ${rateInput.value}% a year` })
          )
        ),
        sim.oldSavingsRate !== null
          ? el('p', { class: 'card-sub', style: 'margin-top:.85rem', text: `Savings rate would move from ${sim.oldSavingsRate}% to ${sim.newSavingsRate}%.` })
          : el('p', { class: 'card-sub', style: 'margin-top:.85rem', text: 'Set your monthly income in Settings to see the effect on your savings rate.' })
      );
    } catch (err) { toastError(err); }
  }, 260);

  const rateInput = el('input', { class: 'input', type: 'number', min: '0', max: '40', step: '1', value: '12', style: 'max-width:90px', oninput: runSim });

  const sliders = el('div', {});
  for (const c of categories) {
    const output = el('output', { text: '0%' });
    const range = el('input', {
      type: 'range', min: '-100', max: '100', value: '0', step: '5',
      oninput: (e) => {
        const v = Number(e.target.value);
        adjustments[c.category] = v;
        output.textContent = `${v > 0 ? '+' : ''}${v}%`;
        output.style.color = v < 0 ? 'var(--good)' : v > 0 ? 'var(--bad)' : '';
        runSim();
      }
    });
    sliders.append(el('div', { class: 'slider-row' },
      el('label', { text: `${c.icon} ${c.category}` }),
      range, output,
      el('span', { class: 'card-sub', style: 'flex:0 0 78px;text-align:right', text: money(c.total, { compact: true }) })
    ));
  }

  const simCard = el('div', { class: 'card span-2' },
    el('div', { class: 'card-head' },
      el('h3', { text: '🧪 What-if simulator' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'card-sub', text: 'Annual return' }), rateInput
    ),
    el('p', { class: 'card-sub', style: 'margin-bottom:.9rem', text: 'Drag a category to see what cutting (or increasing) it would really be worth.' }),
    categories.length ? sliders : emptyState('📊', 'No spending to simulate yet', 'Log some expenses first.'),
    resultBox
  );

  const catBars = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'This month by category' })),
    barChart(summary.byCategory.slice(0, 7).map((c) => ({ label: c.category, value: c.total, color: c.color })))
  );

  root.append(el('div', { class: 'grid grid-3' }, simCard, catBars));
  if (categories.length) runSim();

  /* ---------- Anomalies ---------- */
  const anomalyCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '🔍 Unusual spending' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'card-sub', text: `${anomalies.analysed} transactions analysed` })
    ),
    el('p', { class: 'card-sub', style: 'margin-bottom:.8rem', text: 'Outliers found with a median-absolute-deviation test, so one huge purchase cannot hide itself by skewing the average.' })
  );

  if (!anomalies.anomalies.length) {
    anomalyCard.append(emptyState('✅', 'Nothing unusual', 'Every transaction sits close to your normal range.'));
  } else {
    anomalyCard.append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Merchant'), el('th', {}, 'Category'), el('th', {}, 'When'), el('th', {}, 'Why'), el('th', { class: 'num' }, 'Amount'))),
      el('tbody', {}, ...anomalies.anomalies.slice(0, 12).map((a) => el('tr', {},
        el('td', { style: 'font-weight:600' }, a.merchant || '—'),
        el('td', {}, el('span', { class: 'pill', text: a.category })),
        el('td', {}, el('span', { class: 'card-sub', text: dateLabel(a.date) })),
        el('td', {}, el('span', {
          class: 'pill',
          style: `color:${a.severity === 'high' ? 'var(--bad)' : a.severity === 'medium' ? 'var(--warn)' : ''}`,
          text: a.reason
        })),
        el('td', { class: 'num' }, money(a.amount))
      )))
    )));
  }

  /* ---------- Duplicates ---------- */
  const dupCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: '👯 Possible duplicates' })),
    el('p', { class: 'card-sub', style: 'margin-bottom:.8rem', text: 'Near-identical charges logged close together — often a payment retry or a bill logged twice.' })
  );

  if (!duplicates.duplicates.length) {
    dupCard.append(emptyState('✅', 'No duplicates found', 'Your ledger looks clean.'));
  } else {
    for (const d of duplicates.duplicates.slice(0, 10)) {
      dupCard.append(el('div', { style: 'display:flex;align-items:center;gap:.6rem;padding:.65rem .8rem;background:var(--surface-2);border-radius:10px;margin-bottom:.5rem;flex-wrap:wrap' },
        el('div', { style: 'flex:1;min-width:170px' },
          el('div', { style: 'font-weight:600;font-size:.88rem', text: d.duplicate.merchant || 'Unnamed' }),
          el('div', { class: 'card-sub', text: `${money(d.duplicate.amount)} · ${gapLabel(d.hoursApart)} after the first one` })
        ),
        el('span', { class: 'pill', text: `${Math.round(d.confidence * 100)}% match` }),
        el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            try {
              await api.del(`/api/expenses/${d.duplicate.id}`);
              toast('Duplicate removed', {
                type: 'success',
                action: { label: 'Undo', onClick: () => api.post(`/api/expenses/${d.duplicate.id}/restore`).then(() => labView(root)).catch(toastError) }
              });
              labView(root);
            } catch (err) { toastError(err); }
          }
        }, 'Delete the copy')
      ));
    }
  }

  root.append(el('div', { class: 'grid grid-2', style: 'margin-top:1.1rem' }, anomalyCard, dupCard));
}

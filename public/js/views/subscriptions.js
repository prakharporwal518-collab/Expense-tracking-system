import { api } from '../api.js';
import { el, money, dateLabel, toast, toastError, spinner, emptyState } from '../ui.js';

export async function subscriptionsView(root) {
  root.append(spinner());
  let data;
  try {
    data = await api.get('/api/analytics/recurring');
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'Could not load subscriptions', err.message));
    return;
  }

  root.replaceChildren();
  const reload = () => subscriptionsView(root);

  root.append(el('div', { class: 'grid grid-3' },
    el('div', { class: 'card stat' }, el('div', { class: 'label', text: 'Monthly recurring' }), el('div', { class: 'value', text: money(data.totals.monthlyMinor) })),
    el('div', { class: 'card stat' }, el('div', { class: 'label', text: 'Annual cost' }), el('div', { class: 'value', text: money(data.totals.annualMinor) })),
    el('div', { class: 'card stat' }, el('div', { class: 'label', text: 'Detected' }), el('div', { class: 'value', text: String(data.subscriptions.length) }), el('div', { class: 'delta flat', text: 'Found automatically from your history' }))
  ));

  const card = el('div', { class: 'card', style: 'margin-top:1.1rem' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Recurring charges' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'card-sub', text: 'Nobody told us about these — they were inferred from repeating charge patterns.' })
    )
  );

  if (!data.subscriptions.length) {
    card.append(emptyState('🔁', 'No recurring charges detected', 'Once the same merchant bills you on a regular cycle three times, it shows up here.'));
  } else {
    const rows = data.subscriptions.map((s) => el('tr', {},
      el('td', {}, el('div', {},
        el('div', { style: 'font-weight:600', text: s.merchant }),
        el('div', { class: 'card-sub', text: `${s.occurrences} charges · last ${dateLabel(s.lastCharged)}` })
      )),
      el('td', {}, el('span', { class: 'pill', text: s.label })),
      el('td', {}, el('span', {
        class: 'pill',
        style: s.overdue ? 'color:var(--warn)' : '',
        text: s.overdue ? 'overdue' : s.daysUntil <= 7 ? `in ${s.daysUntil}d` : dateLabel(s.nextDue)
      })),
      el('td', {}, el('div', { style: 'display:flex;align-items:center;gap:.4rem' },
        el('div', { class: 'bar ok', style: 'width:52px' }, el('i', { style: `width:${s.confidence * 100}%` })),
        el('span', { class: 'card-sub', text: `${Math.round(s.confidence * 100)}%` })
      )),
      el('td', { class: 'num' }, money(s.amount)),
      el('td', { class: 'num', style: 'color:var(--text-dim)' }, `${money(s.annualCost)}/yr`),
      el('td', {}, el('button', {
        class: 'btn btn-sm', title: 'Stop treating this as a subscription',
        onclick: async () => {
          try {
            await api.post('/api/analytics/recurring/ignore', { merchantKey: s.merchantKey, amountMinor: s.amount, intervalDays: s.intervalDays });
            toast(`${s.merchant} dismissed`, { type: 'success', timeout: 2200 });
            reload();
          } catch (err) { toastError(err); }
        }
      }, 'Not a subscription'))
    ));

    card.append(el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Merchant'), el('th', {}, 'Cycle'), el('th', {}, 'Next charge'),
          el('th', {}, 'Confidence'), el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, 'Yearly'), el('th', {}, '')
        )),
        el('tbody', {}, ...rows)
      )
    ));
  }

  root.append(card);
}

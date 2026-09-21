import { api } from '../api.js';
import { el, money, dateLabel, monthLabel, toast, toastError, spinner, emptyState } from '../ui.js';
import { donutChart, lineChart, gaugeChart, heatmap } from '../charts.js';
import { state } from '../state.js';

const INSIGHT_ICON = { warning: '⚠️', danger: '🚨', positive: '✅', info: '💡' };

export async function dashboardView(root) {
  root.append(spinner());

  let summary, insights, forecast, heat;
  try {
    [summary, insights, forecast, heat] = await Promise.all([
      api.get('/api/analytics/summary'),
      api.get('/api/analytics/insights'),
      api.get('/api/analytics/forecast?horizon=3'),
      api.get('/api/analytics/heatmap')
    ]);
  } catch (err) {
    root.replaceChildren(emptyState('📡', 'Could not load your dashboard', err.message));
    toastError(err);
    return;
  }

  root.replaceChildren();
  const { thisMonth, lastMonth, changePercent, health, byCategory, months, projection, safeToSpend, streak, subscriptions } = summary;

  /* ---- KPI row ---- */
  const deltaClass = changePercent === null ? 'flat' : changePercent > 0 ? 'up' : 'down';
  const deltaText = changePercent === null
    ? 'No data for last month'
    : `${changePercent > 0 ? '▲' : '▼'} ${Math.abs(changePercent)}% vs last month (${money(lastMonth.spentMinor, { compact: true })})`;

  const kpis = el('div', { class: 'grid grid-4' },
    el('div', { class: 'card stat' },
      el('div', { class: 'label', text: 'Spent this month' }),
      el('div', { class: 'value', text: money(thisMonth.spentMinor) }),
      el('div', { class: `delta ${deltaClass}`, text: deltaText })
    ),
    el('div', { class: 'card stat' },
      el('div', { class: 'label', text: 'Income this month' }),
      el('div', { class: 'value', text: money(thisMonth.earnedMinor) }),
      el('div', { class: `delta ${thisMonth.netMinor >= 0 ? 'down' : 'up'}`, text: `Net ${money(thisMonth.netMinor, { sign: true })}` })
    ),
    el('div', { class: 'card stat' },
      el('div', { class: 'label', text: 'Projected month end' }),
      el('div', { class: 'value', text: money(projection.projected) }),
      el('div', { class: 'delta flat', text: `≈ ${money(projection.runRatePerDay || 0)}/day so far` })
    ),
    el('div', { class: 'card stat' },
      el('div', { class: 'label', text: 'Safe to spend / day' }),
      el('div', {
        class: 'value',
        text: safeToSpend ? money(safeToSpend.perDay_minor) : '—',
        style: safeToSpend?.status === 'over' ? 'color:var(--bad)' : safeToSpend?.status === 'tight' ? 'color:var(--warn)' : ''
      }),
      el('div', { class: 'delta flat', text: safeToSpend ? `${safeToSpend.daysRemaining} days left · ${money(safeToSpend.committed_minor)} committed` : 'Set a budget to unlock' })
    )
  );
  root.append(kpis);

  /* ---- Trend + health ---- */
  const historyPoints = months.map((m) => ({ label: monthLabel(m.month), value: m.total }));
  const forecastPoints = forecast.forecast.points.map((p) => ({ label: monthLabel(p.month), value: p.value, low: p.low, high: p.high }));

  const trendCard = el('div', { class: 'card span-2' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Spending trend & forecast' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill', text: `${forecast.forecast.direction ?? 'flat'} · ${Math.round((forecast.forecast.confidence ?? 0) * 100)}% confidence` })
    ),
    lineChart(historyPoints, { forecast: forecastPoints }),
    el('div', { class: 'legend-inline', style: 'margin-top:.75rem' },
      el('span', {}, el('i', { style: 'background:var(--brand)' }), 'Actual'),
      el('span', {}, el('i', { style: 'background:var(--accent)' }), `Forecast (±${money(forecast.forecast.marginOfError || 0, { compact: true })})`)
    )
  );

  const healthCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Financial health' }), el('div', { class: 'spacer' }), el('span', { class: 'pill', text: `Grade ${health.grade}` })),
    el('div', { class: 'gauge' },
      el('div', { style: 'text-align:center' },
        gaugeChart(health.score),
        el('div', { class: 'card-sub', text: health.verdict, style: 'margin-top:.3rem' })
      ),
      el('div', { class: 'gauge-parts' },
        ...Object.values(health.parts).map((part) => el('div', { class: 'gauge-part' },
          el('div', { class: 'top' }, el('span', { text: part.label }), el('b', { text: `${Math.round(part.score)}` })),
          el('div', { class: 'bar ok' }, el('i', { style: `width:${Math.max(2, part.score)}%;background:${part.score >= 70 ? 'var(--good)' : part.score >= 45 ? 'var(--warn)' : 'var(--bad)'}` }))
        ))
      )
    ),
    el('p', { class: 'card-sub', style: 'margin-top:.85rem', text: `Biggest lever: ${health.weakest.label} — ${health.weakest.hint}` })
  );

  root.append(el('div', { class: 'grid grid-3', style: 'margin-top:1.1rem' }, trendCard, healthCard));

  /* ---- Categories + insights ---- */
  const slices = byCategory.slice(0, 8).map((c) => ({ label: c.category, value: c.total, color: c.color }));
  const totalCat = slices.reduce((s, x) => s + x.value, 0);

  const categoryCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Where the money went' })),
    el('div', { style: 'display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap;justify-content:center' },
      donutChart(slices),
      el('div', { class: 'donut-legend', style: 'flex:1;min-width:190px' },
        ...(slices.length ? slices.map((s) => el('div', {},
          el('i', { style: `background:${s.color}` }),
          el('span', { text: s.label }),
          el('span', { class: 'amt', text: `${money(s.value, { compact: true })} · ${totalCat ? ((s.value / totalCat) * 100).toFixed(0) : 0}%` })
        )) : [el('p', { class: 'card-sub', text: 'No categorised spending yet.' })])
      )
    )
  );

  const insightCard = el('div', { class: 'card span-2' },
    el('div', { class: 'card-head' },
      el('h3', { text: 'Insights' }),
      el('div', { class: 'spacer' }),
      streak.current > 0 ? el('span', { class: 'pill', text: `🔥 ${streak.current}-day streak` }) : null
    ),
    ...(insights.insights.length
      ? insights.insights.slice(0, 7).map((i) => el('div', { class: `insight ${i.type}` },
          el('span', { class: 'ico', text: INSIGHT_ICON[i.type] || '💡' }),
          el('div', {}, el('b', { text: i.title }), el('p', { text: i.detail }))
        ))
      : [emptyState('🔍', 'No insights yet', 'Log a few more expenses.')])
  );

  root.append(el('div', { class: 'grid grid-3', style: 'margin-top:1.1rem' }, insightCard, categoryCard));

  /* ---- Heatmap + subscriptions ---- */
  const heatCard = el('div', { class: 'card span-2' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Spending activity' }), el('div', { class: 'spacer' }), el('span', { class: 'card-sub', text: 'Last 12 months' })),
    heatmap(heat.days, heat.maxMinor)
  );

  const subCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Subscriptions found' })),
    el('div', { class: 'stat' },
      el('div', { class: 'value', text: money(subscriptions.monthlyMinor), style: 'font-size:1.5rem' }),
      el('div', { class: 'delta flat', text: `${subscriptions.count} detected · ${money(subscriptions.annualMinor)}/year` })
    ),
    el('button', {
      class: 'btn btn-block', style: 'margin-top:1rem',
      onclick: () => window.dispatchEvent(new CustomEvent('navigate', { detail: 'subscriptions' }))
    }, 'Review subscriptions →')
  );

  root.append(el('div', { class: 'grid grid-3', style: 'margin-top:1.1rem' }, heatCard, subCard));
}

/**
 * Hand-rolled SVG charts — no charting library, so the app stays dependency-free
 * and works with a strict CSP and no network access.
 */
import { esc, money, monthLabel } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  return n;
};

/** Rounds a max value up to a clean axis bound so labels read nicely. */
function niceMax(value) {
  if (value <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(value));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/* ---------------- Donut ---------------- */
export function donutChart(slices, { size = 190, thickness = 26 } = {}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const wrap = document.createElement('div');

  if (!total) {
    wrap.innerHTML = `<p style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:2rem 0">No spending yet this month.</p>`;
    return wrap;
  }

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'chart' });
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  for (const slice of slices) {
    const fraction = slice.value / total;
    const arc = svgEl('circle', {
      cx: c, cy: c, r, fill: 'none', stroke: slice.color, 'stroke-width': thickness,
      'stroke-dasharray': `${fraction * circumference} ${circumference}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${c} ${c})`
    });
    arc.style.transition = 'stroke-width .15s';
    const title = svgEl('title');
    title.textContent = `${slice.label}: ${money(slice.value)} (${(fraction * 100).toFixed(1)}%)`;
    arc.append(title);
    arc.addEventListener('mouseenter', () => arc.setAttribute('stroke-width', thickness + 5));
    arc.addEventListener('mouseleave', () => arc.setAttribute('stroke-width', thickness));
    svg.append(arc);
    offset += fraction * circumference;
  }

  const capText = svgEl('text', { x: c, y: c - 4, 'text-anchor': 'middle', style: 'fill:var(--text-dim);font-size:11px' });
  capText.textContent = 'Total';
  svg.append(capText);
  const totalText = svgEl('text', { x: c, y: c + 16, 'text-anchor': 'middle', style: 'fill:var(--text);font-size:17px;font-weight:700' });
  totalText.textContent = money(total, { compact: true });
  svg.append(totalText);

  wrap.append(svg);
  return wrap;
}

/* ---------------- Line / area with forecast ---------------- */
export function lineChart(series, { width = 720, height = 300, forecast = [] } = {}) {
  const wrap = document.createElement('div');
  // The forecast is drawn as a continuation of the last real point, so a line
  // needs at least two actual observations. A forecast on its own (which the API
  // still returns for a brand-new account) has nothing to attach to.
  if (series.length < 2) {
    wrap.innerHTML = `<p style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:2rem 0">Not enough history to plot a trend yet — log expenses across two months to see one.</p>`;
    return wrap;
  }
  const all = [...series, ...forecast];

  const pad = { top: 16, right: 14, bottom: 26, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...all.map((d) => d.value), 1));
  const stepX = innerW / (all.length - 1);
  const x = (i) => pad.left + i * stepX;
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', preserveAspectRatio: 'xMidYMid meet' });

  for (let i = 0; i <= 4; i++) {
    const gy = pad.top + (innerH / 4) * i;
    svg.append(svgEl('line', { x1: pad.left, y1: gy, x2: width - pad.right, y2: gy, class: 'grid-line' }));
    const label = svgEl('text', { x: pad.left - 8, y: gy + 4, 'text-anchor': 'end' });
    label.textContent = money(max - (max / 4) * i, { compact: true });
    svg.append(label);
  }

  const path = (points) => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const actualPts = series.map((d, i) => ({ x: x(i), y: y(d.value) }));

  const gradId = `grad-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svgEl('stop', { offset: '0%', 'stop-color': 'var(--brand)', 'stop-opacity': .35 }));
  grad.append(svgEl('stop', { offset: '100%', 'stop-color': 'var(--brand)', 'stop-opacity': 0 }));
  defs.append(grad);
  svg.append(defs);

  svg.append(svgEl('path', {
    d: `${path(actualPts)} L${actualPts.at(-1).x},${pad.top + innerH} L${actualPts[0].x},${pad.top + innerH} Z`,
    fill: `url(#${gradId})`
  }));
  svg.append(svgEl('path', { d: path(actualPts), fill: 'none', stroke: 'var(--brand)', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));

  if (forecast.length) {
    // Forecast band + dashed continuation, starting from the last real point.
    const offset = series.length - 1;
    const fPts = forecast.map((d, i) => ({ x: x(offset + 1 + i), y: y(d.value) }));
    const hi = forecast.map((d, i) => ({ x: x(offset + 1 + i), y: y(d.high ?? d.value) }));
    const lo = forecast.map((d, i) => ({ x: x(offset + 1 + i), y: y(d.low ?? d.value) })).reverse();
    // Confidence band: trace the high edge forward, then the low edge back.
    const band = [actualPts.at(-1), ...hi, ...lo, actualPts.at(-1)];
    const bandPath = band.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
    svg.append(svgEl('path', { d: bandPath, fill: 'var(--accent)', opacity: .13 }));
    svg.append(svgEl('path', { d: path([actualPts.at(-1), ...fPts]), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.5, 'stroke-dasharray': '6 4' }));
    for (const p of fPts) svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: 3.5, fill: 'var(--accent)' }));
  }

  all.forEach((d, i) => {
    const isForecast = i >= series.length;
    if (!isForecast) {
      const dot = svgEl('circle', { cx: x(i), cy: y(d.value), r: 3.5, fill: 'var(--brand)' });
      const t = svgEl('title');
      t.textContent = `${d.label}: ${money(d.value)}`;
      dot.append(t);
      svg.append(dot);
    }
    // Thin out x labels so they never collide.
    if (all.length <= 8 || i % Math.ceil(all.length / 8) === 0 || i === all.length - 1) {
      const label = svgEl('text', { x: x(i), y: height - 8, 'text-anchor': 'middle' });
      label.textContent = d.label;
      if (isForecast) label.setAttribute('style', 'fill:var(--accent)');
      svg.append(label);
    }
  });

  wrap.append(svg);
  return wrap;
}

/* ---------------- Bars ---------------- */
export function barChart(items, { height = 300, color = 'var(--brand)' } = {}) {
  const wrap = document.createElement('div');
  if (!items.length) {
    wrap.innerHTML = `<p style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:1.5rem 0">Nothing to show.</p>`;
    return wrap;
  }
  // A narrow viewBox keeps the labels legible once the SVG is scaled down into
  // a one-column card; a 720-wide box renders them at ~6px there.
  const width = 420;
  const pad = { top: 12, right: 10, bottom: 46, left: 62 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...items.map((d) => d.value), 1));
  const slot = innerW / items.length;
  const barW = Math.min(40, slot * 0.66);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', preserveAspectRatio: 'xMidYMid meet' });
  for (let i = 0; i <= 3; i++) {
    const gy = pad.top + (innerH / 3) * i;
    svg.append(svgEl('line', { x1: pad.left, y1: gy, x2: width - pad.right, y2: gy, class: 'grid-line' }));
    const l = svgEl('text', { x: pad.left - 8, y: gy + 4, 'text-anchor': 'end' });
    l.textContent = money(max - (max / 3) * i, { compact: true });
    svg.append(l);
  }

  items.forEach((d, i) => {
    const h = Math.max(2, (d.value / max) * innerH);
    const bx = pad.left + slot * i + (slot - barW) / 2;
    const rect = svgEl('rect', {
      x: bx, y: pad.top + innerH - h, width: barW, height: h, rx: 5,
      fill: d.color || color, opacity: .9
    });
    const t = svgEl('title');
    t.textContent = `${d.label}: ${money(d.value)}`;
    rect.append(t);
    svg.append(rect);
    // Rotate labels so longer category names stay readable without truncation.
    const cx = bx + barW / 2;
    const lab = svgEl('text', {
      x: cx, y: height - 30, 'text-anchor': 'end',
      transform: `rotate(-38 ${cx} ${height - 30})`, style: 'font-size:12px'
    });
    lab.textContent = d.label.length > 13 ? `${d.label.slice(0, 12)}…` : d.label;
    svg.append(lab);
  });

  wrap.append(svg);
  return wrap;
}

/* ---------------- Health gauge ---------------- */
export function gaugeChart(score, { size = 128 } = {}) {
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  const c = size / 2;
  const r = c - 11;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = score >= 85 ? 'var(--good)' : score >= 70 ? '#84cc16' : score >= 55 ? 'var(--warn)' : 'var(--bad)';

  svg.append(svgEl('circle', { cx: c, cy: c, r, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 11 }));
  svg.append(svgEl('circle', {
    cx: c, cy: c, r, fill: 'none', stroke: color, 'stroke-width': 11, 'stroke-linecap': 'round',
    'stroke-dasharray': `${pct * circumference} ${circumference}`, transform: `rotate(-90 ${c} ${c})`
  }));
  const t = svgEl('text', { x: c, y: c + 9, 'text-anchor': 'middle', style: `fill:${color};font-size:26px;font-weight:800` });
  t.textContent = String(Math.round(score));
  svg.append(t);
  return svg;
}

/* ---------------- Calendar heatmap ---------------- */
export function heatmap(days, maxMinor) {
  const wrap = document.createElement('div');
  const byDay = new Map(days.map((d) => [d.day, d.total]));
  const grid = document.createElement('div');
  grid.className = 'heat';

  const end = new Date();
  const start = new Date(end.getTime() - 363 * 86400000);
  // Align the first column to a Sunday so weekday rows line up.
  start.setDate(start.getDate() - start.getDay());

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const total = byDay.get(key) || 0;
    const intensity = maxMinor > 0 && total > 0 ? Math.min(1, Math.sqrt(total / maxMinor)) : 0;
    const cell = document.createElement('i');
    if (intensity > 0) {
      cell.style.background = `color-mix(in srgb, var(--brand) ${Math.round(18 + intensity * 82)}%, var(--surface-2))`;
    }
    cell.title = total > 0 ? `${key}: ${money(total)}` : `${key}: nothing tracked`;
    grid.append(cell);
  }

  wrap.append(grid);
  const legend = document.createElement('div');
  legend.className = 'heat-legend';
  legend.innerHTML = `<span>Less</span>${[0, 25, 50, 75, 100]
    .map((p) => `<i style="background:color-mix(in srgb, var(--brand) ${p}%, var(--surface-2))"></i>`).join('')}<span>More</span>`;
  wrap.append(legend);
  return wrap;
}

export { monthLabel };

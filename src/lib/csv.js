/** RFC4180-ish CSV parser: handles quoted fields, escaped quotes and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, ''); // strip BOM from Excel exports

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function toCsv(rows, headers) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = headers.map((h) => escape(h.label ?? h.key)).join(',');
  const body = rows.map((r) => headers.map((h) => escape(h.get ? h.get(r) : r[h.key])).join(','));
  return [head, ...body].join('\r\n');
}

/** Maps loosely-named CSV headers onto our fields, so exports from other apps import cleanly. */
export function detectColumns(header) {
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...candidates) => {
    for (const c of candidates) {
      const idx = norm.indexOf(c);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  return {
    date: find('date', 'spentat', 'transactiondate', 'when', 'day'),
    amount: find('amount', 'value', 'price', 'debit', 'total', 'cost'),
    category: find('category', 'type', 'group'),
    merchant: find('merchant', 'payee', 'vendor', 'description', 'narration', 'particulars'),
    note: find('note', 'notes', 'comment', 'remarks', 'memo'),
    paymentMethod: find('paymentmethod', 'method', 'mode', 'payment'),
    isIncome: find('isincome', 'income', 'credit', 'direction')
  };
}

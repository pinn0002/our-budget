// Pure money math. All calculations are in integer cents (USD) to avoid rounding drift.

export const toCents = n => Math.round(Number(n) * 100);
export const monthOf = date => date.slice(0, 7);

export function todayISO(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// INR per 1 USD. USD amounts pass through.
export function toUSD(amount, currency, rate) {
  return currency === 'INR' ? Math.round((amount / rate) * 100) / 100 : Math.round(amount * 100) / 100;
}

// How much of an expense each member is responsible for, in cents.
export function shares(exp, memberIds) {
  const total = toCents(exp.usd);
  if (exp.forWhom !== 'shared') return { [exp.forWhom]: total };
  const out = {};
  let assigned = 0;
  memberIds.forEach((id, i) => {
    if (i === memberIds.length - 1) { out[id] = total - assigned; return; }
    const pct = exp.split?.[id] ?? 100 / memberIds.length;
    out[id] = Math.round((total * pct) / 100);
    assigned += out[id];
  });
  return out;
}

// Net position per member, in cents. Positive = others owe them.
export function balances(expenses, settlements, memberIds) {
  const net = Object.fromEntries(memberIds.map(id => [id, 0]));
  for (const e of expenses) {
    if (!(e.paidBy in net)) continue;
    const sh = shares(e, memberIds);
    net[e.paidBy] += toCents(e.usd);
    for (const [id, c] of Object.entries(sh)) if (id in net) net[id] -= c;
  }
  for (const s of settlements) {
    if (s.from in net) net[s.from] += toCents(s.usd);
    if (s.to in net) net[s.to] -= toCents(s.usd);
  }
  return net;
}

// For a couple: who owes whom. Returns null when even.
export function whoOwes(net) {
  const ids = Object.keys(net);
  if (ids.length !== 2) return null;
  const [a, b] = ids;
  if (net[a] === 0) return null;
  return net[a] < 0 ? { from: a, to: b, cents: -net[a] } : { from: b, to: a, cents: net[a] };
}

// Spending summary for one month, in cents.
export function monthSummary(expenses, month, memberIds) {
  const s = {
    total: 0, shared: 0,
    person: Object.fromEntries(memberIds.map(id => [id, { personal: 0, sharedPart: 0, total: 0 }])),
    // byCat[catId] = { total, shared, personal: { [memberId]: cents } }
    byCat: {},
  };
  for (const e of expenses) {
    if (monthOf(e.date) !== month) continue;
    const c = toCents(e.usd);
    s.total += c;
    const cat = (s.byCat[e.categoryId] ??= { total: 0, shared: 0, personal: {} });
    cat.total += c;
    if (e.forWhom === 'shared') {
      s.shared += c;
      cat.shared += c;
      for (const [id, part] of Object.entries(shares(e, memberIds))) {
        if (s.person[id]) { s.person[id].sharedPart += part; s.person[id].total += part; }
      }
    } else if (s.person[e.forWhom]) {
      s.person[e.forWhom].personal += c;
      s.person[e.forWhom].total += c;
      cat.personal[e.forWhom] = (cat.personal[e.forWhom] || 0) + c;
    }
  }
  return s;
}

export const recurringExpenseId = (recId, month) => `exp_rec_${recId}_${month.replace('-', '')}`;

// Expenses that should exist for active recurring items up to `today` but don't yet.
// `exists(id)` must return true for any id ever created (including deleted ones),
// so a deleted month is not re-added. Ids are deterministic so both phones agree.
export function dueRecurring(recurring, exists, today = new Date()) {
  const todayStr = todayISO(today);
  const current = monthOf(todayStr);
  const out = [];
  for (const r of recurring) {
    if (!r.active || r.deleted) continue;
    for (let m = r.startMonth; m <= current; m = addMonths(m, 1)) {
      const day = Math.min(r.day, daysInMonth(m));
      const date = `${m}-${String(day).padStart(2, '0')}`;
      if (date > todayStr) break;
      const id = recurringExpenseId(r.id, m);
      if (exists(id)) continue;
      out.push({ id, date, recurringId: r.id });
    }
  }
  return out;
}

// Pull the most likely total / currency / merchant / date out of OCR'd receipt text.
export function parseReceipt(text) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const amountRe = /(?:₹|rs\.?|inr|\$|usd)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+[.,]\d{2}|\d+)(?!\d)/gi;
  const parseAmt = s => Number(s.replace(/,(?=\d{2,3}(\D|$))/g, '').replace(',', '.'));
  const amountsIn = l => [...l.matchAll(amountRe)].map(m => parseAmt(m[1])).filter(n => n > 0 && n < 1e7);

  let currency = null;
  if (/₹|\brs\.?\s*\d|\binr\b|rupee/i.test(text)) currency = 'INR';
  else if (/\$|\busd\b/i.test(text)) currency = 'USD';

  let amount = null;
  const totalLines = lines.filter(l => /(grand\s*total|total|amount\s*due|balance\s*due|net\s*amount|amount\s*paid)/i.test(l) && !/sub\s*-?\s*total/i.test(l));
  for (const l of totalLines.reverse()) {
    const a = amountsIn(l).filter(n => !Number.isInteger(n) || n >= 1);
    if (a.length) { amount = a[a.length - 1]; break; }
  }
  if (amount == null) {
    const decimals = lines.flatMap(l => [...l.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{2})(?!\d)/g)].map(m => parseAmt(m[1])));
    if (decimals.length) amount = Math.max(...decimals);
  }

  const merchant = lines.find(l => /[a-z]{3,}/i.test(l) && !/receipt|invoice|tax|welcome|thank/i.test(l)) || '';

  let date = null;
  const dm = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dm) {
    let y, mo, d;
    if (dm[1]) [y, mo, d] = [dm[1], dm[2], dm[3]];
    else {
      [mo, d, y] = [dm[4], dm[5], dm[6]];
      // INR receipts are usually day/month/year
      if (currency === 'INR' || Number(mo) > 12) [mo, d] = [d, mo];
      if (y.length === 2) y = '20' + y;
    }
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return { amount, currency, merchant: merchant.slice(0, 60), date };
}

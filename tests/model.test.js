import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const A = 'm_a', B = 'm_b', ids = [A, B];
const exp = o => ({ date: '2026-10-05', usd: 100, paidBy: A, forWhom: 'shared', split: null, categoryId: 'c1', ...o });

test('equal split', () => {
  assert.deepEqual(M.shares(exp({ usd: 10.01 }), ids), { [A]: 501, [B]: 500 });
});

test('custom split', () => {
  assert.deepEqual(M.shares(exp({ split: { [A]: 60, [B]: 40 } }), ids), { [A]: 6000, [B]: 4000 });
});

test('personal expense belongs to one person', () => {
  assert.deepEqual(M.shares(exp({ forWhom: B }), ids), { [B]: 10000 });
});

test('balances: shared, personal paid by other, settlement', () => {
  const es = [
    exp({ usd: 100 }),                       // A paid shared 100 → B owes 50
    exp({ usd: 30, paidBy: B, forWhom: A }), // B paid A's personal → A owes 30
    exp({ usd: 20, forWhom: A }),            // A's own personal → no effect
  ];
  const net = M.balances(es, [{ from: B, to: A, usd: 5 }], ids);
  // B owes 50 - 30 - 5 = 15
  assert.deepEqual(net, { [A]: 1500, [B]: -1500 });
  assert.deepEqual(M.whoOwes(net), { from: B, to: A, cents: 1500 });
  assert.equal(M.whoOwes({ [A]: 0, [B]: 0 }), null);
});

test('month summary', () => {
  const es = [exp({ usd: 100 }), exp({ usd: 40, forWhom: B, categoryId: 'c2' }), exp({ date: '2026-09-30', usd: 999 })];
  const s = M.monthSummary(es, '2026-10', ids);
  assert.equal(s.total, 14000);
  assert.equal(s.shared, 10000);
  assert.deepEqual(s.person[B], { personal: 4000, sharedPart: 5000, total: 9000 });
  assert.equal(s.byCat.c2.personal[B], 4000);
});

test('currency conversion', () => {
  assert.equal(M.toUSD(8300, 'INR', 83), 100);
  assert.equal(M.toUSD(12.345, 'USD', 83), 12.35);
});

test('recurring: back-fills months, skips existing, respects day and month length', () => {
  const rec = [{ id: 'r1', active: true, startMonth: '2026-08', day: 31 }];
  const have = new Set([M.recurringExpenseId('r1', '2026-08')]);
  const due = M.dueRecurring(rec, id => have.has(id), new Date(2026, 9, 20));
  assert.deepEqual(due.map(d => d.date), ['2026-09-30']); // Oct 31 not reached yet
  const due2 = M.dueRecurring([{ ...rec[0], day: 1 }], () => false, new Date(2026, 9, 20));
  assert.deepEqual(due2.map(d => d.date), ['2026-08-01', '2026-09-01', '2026-10-01']);
  assert.equal(M.dueRecurring([{ ...rec[0], active: false }], () => false, new Date(2026, 9, 20)).length, 0);
});

test('receipt parsing (USD)', () => {
  const r = M.parseReceipt('WHOLE FOODS MARKET\n10/14/2026\nBananas 1.99\nSubtotal 45.10\nTax 3.20\nTOTAL $48.30\nVISA ****1234');
  assert.equal(r.amount, 48.3);
  assert.equal(r.currency, 'USD');
  assert.equal(r.merchant, 'WHOLE FOODS MARKET');
  assert.equal(r.date, '2026-10-14');
});

test('receipt parsing (INR, day-first date, lakh commas)', () => {
  const r = M.parseReceipt('Spice Kitchen\nDate: 05/10/2026\nPaneer Tikka Rs. 450.00\nGrand Total ₹1,25,450.00');
  assert.equal(r.amount, 125450);
  assert.equal(r.currency, 'INR');
  assert.equal(r.date, '2026-10-05');
});

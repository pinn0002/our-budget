import * as C from './crypto.js';
import * as store from './store.js';
import * as M from './model.js';
import { clearRows, putRows } from './db.js';
import { testConnection, pullRows, normalizeUrl } from './sync.js';

// ---------- config & helpers ----------

const CFG_KEY = 'ob.cfg';
const RATE_KEY = 'ob.rate';
const AUTO_LOCK_MS = 3 * 60 * 1000;
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch { return null; } };
const saveCfg = () => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
const syncCfgOf = c => (c?.sync ? { ...c.sync, household: c.household } : null);

let cfg = loadCfg();
let rawBits = null; // data key bits, only in memory while unlocked (used to enroll Face ID)
let unsub = null;
let syncTimer = null;
let hiddenAt = null;
const ui = { tab: 'home', month: M.monthOf(M.todayISO()), filter: 'all', search: '' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const money = cents => usdFmt.format(cents / 100);
const moneyIn = (amt, cur) => (cur === 'INR' ? inrFmt : usdFmt).format(amt);
const parseNum = v => Number(String(v ?? '').replace(/[,\s₹$]/g, ''));
const newId = prefix => `${prefix}_${C.randomHex(8)}`;
const monthLabel = m => new Date(m + '-15').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dateLabel = d => {
  const t = M.todayISO();
  const y = M.todayISO(new Date(Date.now() - 864e5));
  if (d === t) return 'Today';
  if (d === y) return 'Yesterday';
  return new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), ms);
}

// ---------- data accessors ----------

const members = () => store.all('member').sort((a, b) => a.order - b.order);
const memberIds = () => members().map(m => m.id);
const nameOf = id => store.get(id)?.name ?? '—';
const me = () => store.get(cfg.meId);
const categories = () => store.all('category').filter(c => !c.archived).sort((a, b) => a.order - b.order);
const catOf = id => store.get(id) || { emoji: '📦', name: 'Uncategorized', limits: {} };
const expenses = () => store.all('expense');
const settings = () => store.get('settings') || { rateMode: 'auto', fixedRate: 83 };

function groupedCategories() {
  const groups = new Map();
  for (const c of categories()) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  return groups;
}

// ---------- exchange rate (INR per USD) ----------

async function refreshRate() {
  if (settings().rateMode !== 'auto') return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(RATE_KEY)); } catch {}
  if (cached?.date === M.todayISO()) return;
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR');
    const j = await r.json();
    if (j?.rates?.INR) localStorage.setItem(RATE_KEY, JSON.stringify({ date: M.todayISO(), rate: j.rates.INR }));
  } catch { /* offline: fall back to cached or fixed rate */ }
}

function currentRate() {
  const s = settings();
  if (s.rateMode === 'fixed') return { rate: s.fixedRate, label: 'your fixed rate' };
  let c = null;
  try { c = JSON.parse(localStorage.getItem(RATE_KEY)); } catch {}
  if (c?.rate) return { rate: c.rate, label: c.date === M.todayISO() ? "today's rate" : `rate from ${c.date}` };
  return { rate: s.fixedRate, label: 'fallback rate (offline)' };
}

// ---------- defaults & demo ----------

function defaultCategories() {
  const list = [
    ['Housing & utilities', '🏠', 'Rent / mortgage'],
    ['Housing & utilities', '💡', 'Utilities'],
    ['Housing & utilities', '📶', 'Internet & phone'],
    ['Groceries & dining', '🛒', 'Groceries'],
    ['Groceries & dining', '🍽️', 'Dining out'],
    ['Groceries & dining', '☕', 'Coffee & snacks'],
    ['Transport & travel', '🚗', 'Gas & transit'],
    ['Transport & travel', '🚕', 'Rideshare'],
    ['Transport & travel', '✈️', 'Travel'],
    ['Shopping, fun & subscriptions', '🛍️', 'Shopping'],
    ['Shopping, fun & subscriptions', '🎬', 'Entertainment'],
    ['Shopping, fun & subscriptions', '📺', 'Subscriptions'],
    ['Shopping, fun & subscriptions', '💊', 'Health'],
    ['Shopping, fun & subscriptions', '🎁', 'Gifts'],
    ['Other', '📦', 'Other'],
  ];
  return list.map(([group, emoji, name], i) => ({ id: newId('cat'), type: 'category', group, emoji, name, order: i, limits: {} }));
}

async function seedDemo() {
  const [a, b] = members();
  await store.save([{ ...a, name: 'Alex' }, { ...b, name: 'Sam', claimed: true }]);
  const cats = Object.fromEntries(categories().map(c => [c.name, c]));
  const limits = { 'Rent / mortgage': [2400, 0, 0], Groceries: [600, 0, 0], 'Dining out': [300, 100, 100], Shopping: [0, 200, 150], Subscriptions: [60, 20, 20], Utilities: [200, 0, 0], Rideshare: [0, 60, 60] };
  await store.save(Object.entries(limits).map(([n, [sh, la, lb]]) => ({ ...cats[n], limits: { shared: sh, [a.id]: la, [b.id]: lb } })));
  const rate = currentRate().rate;
  const month = M.monthOf(M.todayISO());
  const prev = M.addMonths(month, -1);
  const today = new Date().getDate();
  const day = (m, d) => `${m}-${String(m === month ? Math.min(d, today) : d).padStart(2, '0')}`;
  const ex = (m, d, desc, amount, currency, cat, paidBy, forWhom, split) => ({
    id: newId('exp'), type: 'expense', date: day(m, d), desc, amount, currency, rate,
    usd: M.toUSD(amount, currency, rate), categoryId: cats[cat].id, paidBy, forWhom, split: split || null,
  });
  await store.save([
    ex(prev, 3, 'Trader Joe’s', 142.3, 'USD', 'Groceries', a.id, 'shared'),
    ex(prev, 9, 'Electric bill', 88, 'USD', 'Utilities', b.id, 'shared'),
    ex(prev, 14, 'Sushi with friends (our share)', 96, 'USD', 'Dining out', a.id, 'shared'),
    ex(prev, 20, 'New sneakers', 120, 'USD', 'Shopping', b.id, b.id),
    ex(prev, 25, 'Flight to Mumbai deposit', 450, 'USD', 'Travel', a.id, 'shared', { [a.id]: 60, [b.id]: 40 }),
    ex(month, 2, 'Costco run', 186.45, 'USD', 'Groceries', b.id, 'shared'),
    ex(month, 4, 'Netflix', 15.49, 'USD', 'Subscriptions', a.id, 'shared'),
    ex(month, 5, 'Gift for Mom (sent from India)', 2500, 'INR', 'Gifts', a.id, a.id),
    ex(month, 7, 'Thai dinner with friends (our share)', 64, 'USD', 'Dining out', b.id, 'shared'),
    ex(month, 8, 'Uber to airport', 38.2, 'USD', 'Rideshare', a.id, a.id),
    ex(month, 10, 'Whole Foods', 97.12, 'USD', 'Groceries', a.id, 'shared'),
    ex(month, 11, 'Coffee', 6.75, 'USD', 'Coffee & snacks', b.id, b.id),
    ex(month, 12, 'Jacket', 89, 'USD', 'Shopping', a.id, a.id),
    ex(month, 13, 'Movie night', 32, 'USD', 'Entertainment', b.id, 'shared'),
  ]);
  const recId = newId('rec');
  await store.save({
    id: recId, type: 'recurring', desc: 'Rent', amount: 2400, currency: 'USD', categoryId: cats['Rent / mortgage'].id,
    paidBy: a.id, forWhom: 'shared', split: null, day: 1, startMonth: prev, active: true,
  });
  await store.save({ id: newId('set'), type: 'settlement', date: day(month, 6), from: b.id, to: a.id, usd: 1200, note: 'Half of last month’s rent' });

  // Money: accounts, balance history, paychecks, extra income, transfers.
  const acct = (name, kind, owner, currency) => ({ id: newId('acct'), type: 'account', name, kind, owner, currency });
  const k1 = acct('Fidelity 401k', '401k', a.id, 'USD');
  const k2 = acct('Vanguard 401k', '401k', b.id, 'USD');
  const brk = acct('Robinhood', 'brokerage', 'joint', 'USD');
  const hysa = acct('Ally savings', 'savings', 'joint', 'USD');
  const mf = acct('SBI mutual fund', 'india', a.id, 'INR');
  await store.save([k1, k2, brk, hysa, mf]);
  const bals = [];
  for (let i = 9; i >= 0; i--) {
    const m = M.addMonths(month, -i);
    const d = i === 0 ? M.todayISO() : `${m}-${String(M.daysInMonth(m)).padStart(2, '0')}`;
    const g = 9 - i;
    const b0 = (acc, start, step, noise) => bals.push({ id: newId('bal'), type: 'balance', accountId: acc.id, date: d, amount: Math.round(start + step * g + noise * Math.sin(g * 1.7)), currency: acc.currency, rate });
    b0(k1, 41000, 1350, 900); b0(k2, 28000, 980, 700); b0(brk, 12000, 520, 650); b0(hysa, 15000, 400, 0); b0(mf, 300000, 9000, 6000);
  }
  await store.save(bals);
  const pay = (member, desc, freq, extra, gross, k401, match, taxes, health, other) => ({
    id: newId('pay'), type: 'paySchedule', memberId: member.id, desc, freq, ...extra, currency: 'USD', active: true,
    gross, k401, match, taxes, health, other, net: M.computedNet({ gross, k401, taxes, health, other }), accountId: (member === a ? k1 : k2).id,
  });
  const anchor = M.todayISO(new Date(Date.now() - 7 * 864e5 * 6));
  await store.save([
    pay(a, 'Paycheck – Acme', 'biweekly', { anchor }, 3200, 320, 160, 760, 95, 25),
    pay(b, 'Paycheck – Globex', 'monthly', { day: 1, startMonth: prev }, 6500, 650, 325, 1550, 180, 0),
  ]);
  await store.save([
    { id: newId('inc'), type: 'income', kind: 'extra', memberId: a.id, date: day(month, 9), net: 450, currency: 'USD', rate, source: 'Freelance / side gig', desc: 'Logo design' },
    { id: newId('inc'), type: 'income', kind: 'extra', memberId: b.id, date: day(month, 3), net: 12000, currency: 'INR', rate, source: 'Rental income', desc: 'Pune flat rent' },
    { id: newId('ctb'), type: 'contribution', accountId: brk.id, memberId: 'joint', date: day(month, 5), amount: 600, currency: 'USD', rate, note: 'Index funds' },
    { id: newId('ctb'), type: 'contribution', accountId: hysa.id, memberId: b.id, date: day(month, 2), amount: 400, currency: 'USD', rate, note: '' },
    { id: newId('ctb'), type: 'contribution', accountId: mf.id, memberId: a.id, date: day(month, 10), amount: 10000, currency: 'INR', rate, note: 'Monthly SIP' },
  ]);
}

// ---------- boot / setup / unlock ----------

function boot() {
  cfg = loadCfg();
  if (!cfg) return renderWelcome();
  renderUnlock();
}

function screen(html) {
  closeSheet();
  $app.className = 'screen';
  $app.innerHTML = `<div class="setup">${html}</div>`;
}

function renderWelcome() {
  screen(`
    <div class="brand"><div class="logo">💸</div><h1>Our Budget</h1>
      <p class="muted">A private spending tracker for the two of you. Everything is encrypted on your phone before it's saved or synced, and no cards or banks are ever linked.</p></div>
    <button class="primary" data-act="go-create">Start a new household</button>
    <button class="secondary" data-act="go-join">Join my partner's household</button>
    <button class="ghost" data-act="go-restore">Restore from a backup file</button>
    <button class="ghost" data-act="go-demo">Try a demo with sample data</button>
  `);
}

function passFields() {
  return `
    <label>Shared passphrase<input name="pass" type="password" autocomplete="new-password" minlength="10" required></label>
    <label>Type it again<input name="pass2" type="password" autocomplete="new-password" required></label>
    <p class="hint">You'll both use this passphrase. Use 4 or more random words (like <i>maple-orbit-tiger-lamp</i>). <b>If you both forget it, the data can't be recovered.</b></p>`;
}

function syncFields(open = false) {
  return `
    <details class="sync-details" ${open ? 'open' : ''}><summary>Sync between our phones (Supabase)</summary>
      <label>Project URL<input name="url" placeholder="https://xxxx.supabase.co" autocomplete="off" autocapitalize="off"></label>
      <label>Publishable (anon) key<input name="key" placeholder="sb_publishable_… or eyJ…" autocomplete="off" autocapitalize="off"></label>
      <p class="hint">See README step 1. You can also add this later in Settings.</p>
    </details>`;
}

function renderCreate() {
  screen(`
    <button class="back" data-act="go-welcome">‹ Back</button>
    <h2>New household</h2>
    <form id="f-create">
      <label>Your name<input name="name" required autocomplete="given-name"></label>
      ${passFields()}
      ${syncFields()}
      <p class="err" id="err"></p>
      <button class="primary">Create</button>
    </form>`);
  bindForm('f-create', async fd => {
    if (fd.pass !== fd.pass2) throw new Error("The passphrases don't match.");
    if (fd.pass.length < 10) throw new Error('Use at least 10 characters.');
    const sync = fd.url && fd.key ? { url: normalizeUrl(fd.url), key: fd.key.trim() } : null;
    await createHousehold({ name: fd.name.trim(), pass: fd.pass, sync });
  }, 'Securing… this takes a few seconds');
}

async function createHousehold({ name, pass, sync, demo = false }) {
  const household = C.randomHex(24);
  if (sync) await testConnection({ ...sync, household });
  const bits = await C.deriveKeyBits(pass, household);
  const key = await C.importKey(bits);
  await clearRows();
  store.resetCursor();
  cfg = { household, meId: newId('m'), verifier: await C.seal(key, { check: 'ok' }, 'verifier'), sync, bio: null, demo };
  saveCfg();
  await store.init(key, syncCfgOf(cfg));
  await store.save([
    { id: 'verifier', type: 'verifier', check: 'ok' },
    { id: cfg.meId, type: 'member', name, order: 0, claimed: true },
    { id: newId('m'), type: 'member', name: 'Partner', order: 1, claimed: false },
    { id: 'settings', type: 'settings', rateMode: 'auto', fixedRate: 83 },
    ...defaultCategories(),
  ]);
  rawBits = bits;
  if (demo) { await refreshRate(); await seedDemo(); }
  afterUnlock();
}

// Invite codes are hex only (0-9, a-f) so WhatsApp/iMessage can't turn _ * ~ into formatting.
// The parser tolerates surrounding text, spaces, line breaks and quotes.
function parseInvite(code) {
  const v2 = String(code).match(/OB2\s*:([\s\S]*)/i);
  if (v2) {
    const hex = v2[1].replace(/[^0-9a-f]/gi, '');
    // Anything typed after the code got glued on; trim from the end until it decodes.
    for (let n = hex.length - (hex.length % 2); n >= Math.max(2, hex.length - 300); n -= 2) {
      try {
        const bytes = new Uint8Array(hex.slice(0, n).match(/../g).map(h => parseInt(h, 16)));
        const j = JSON.parse(new TextDecoder().decode(bytes));
        if (j.h && j.u && j.k) return j;
      } catch {}
    }
    throw new Error("That invite code doesn't look right. On the first phone, use Settings → Invite partner → Share code, and paste the whole message here.");
  }
  // Older OB1 (base64) codes.
  const s = String(code).replace(/^[\s\S]*?OB1\s*:/i, '').replace(/[\s"'“”‘’]/g, '');
  const b0 = (s.match(/^[A-Za-z0-9+/_=-]+/)?.[0] || '').replace(/=/g, '').replace(/-/g, '+').replace(/_/g, '/');
  for (let n = b0.length; n >= Math.max(0, b0.length - 300); n--) {
    try {
      const b = b0.slice(0, n) + '='.repeat((4 - (n % 4)) % 4);
      const j = JSON.parse(atob(b));
      if (j.h && j.u && j.k) return j;
    } catch {}
  }
  throw new Error("That invite code doesn't look right. On the first phone, use Settings → Invite partner → Share code, and paste the whole message here.");
}

const makeInvite = () => 'OB2:' + [...new TextEncoder().encode(JSON.stringify({ h: cfg.household, u: cfg.sync.url, k: cfg.sync.key }))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

function renderJoin() {
  screen(`
    <button class="back" data-act="go-welcome">‹ Back</button>
    <h2>Join household</h2>
    <p class="muted">On the first phone, go to <b>Settings → Invite partner</b> and send yourself the code.</p>
    <form id="f-join">
      <label>Invite code<textarea name="code" rows="3" required autocapitalize="off" spellcheck="false"></textarea></label>
      <label>Shared passphrase<input name="pass" type="password" autocomplete="current-password" required></label>
      <p class="err" id="err"></p>
      <button class="primary">Join</button>
    </form>`);
  bindForm('f-join', async fd => {
    const inv = parseInvite(fd.code);
    const sc = { url: inv.u, key: inv.k, household: inv.h };
    const { rows, cursor } = await pullRows(sc, null);
    const v = rows.find(r => r.id === 'verifier');
    if (!v) throw new Error('No household found. Check the invite code.');
    const bits = await C.deriveKeyBits(fd.pass, inv.h);
    const key = await C.importKey(bits);
    try { await C.open(key, v.data, 'verifier'); } catch { throw new Error('Wrong passphrase.'); }
    await clearRows();
    await putRows(rows.map(r => ({ ...r, dirty: 0 })));
    store.resetCursor();
    if (cursor) localStorage.setItem('ob.cursor', cursor);
    cfg = { household: inv.h, meId: null, verifier: await C.seal(key, { check: 'ok' }, 'verifier'), sync: { url: inv.u, key: inv.k }, bio: null };
    saveCfg();
    await store.init(key, syncCfgOf(cfg));
    rawBits = bits;
    afterUnlock();
  }, 'Unlocking…');
}

function renderRestore() {
  screen(`
    <button class="back" data-act="go-welcome">‹ Back</button>
    <h2>Restore from backup</h2>
    <p class="muted">Choose an encrypted backup file exported from Settings.</p>
    <form id="f-restore">
      <label>Backup file<input name="file" type="file" accept=".json,application/json" required></label>
      <label>Shared passphrase<input name="pass" type="password" autocomplete="current-password" required></label>
      <p class="err" id="err"></p>
      <button class="primary">Restore</button>
    </form>`);
  bindForm('f-restore', async (fd, form) => {
    const file = form.file.files[0];
    let b;
    try { b = JSON.parse(await file.text()); } catch { throw new Error("That file isn't an Our Budget backup."); }
    if (b.app !== 'our-budget' || !b.household || !Array.isArray(b.rows)) throw new Error("That file isn't an Our Budget backup.");
    const bits = await C.deriveKeyBits(fd.pass, b.household);
    const key = await C.importKey(bits);
    try { await C.open(key, b.verifier, 'verifier'); } catch { throw new Error('Wrong passphrase.'); }
    await clearRows();
    store.resetCursor();
    await putRows(b.rows.map(r => ({ ...r, dirty: 1 })));
    cfg = { household: b.household, meId: null, verifier: b.verifier, sync: null, bio: null };
    saveCfg();
    await store.init(key, null);
    rawBits = bits;
    afterUnlock();
  }, 'Restoring…');
}

function renderWhoAreYou() {
  const ms = members();
  const pick = ms.find(m => !m.claimed) || ms[1] || ms[0];
  screen(`
    <h2>Which one are you?</h2>
    <form id="f-who">
      ${ms.map(m => `<label class="radio-row"><input type="radio" name="who" value="${m.id}" ${m === pick ? 'checked' : ''}><span>${esc(m.claimed ? m.name : 'The partner (not set up yet)')}</span></label>`).join('')}
      <label>Your name<input name="name" required value="${esc(pick?.claimed ? pick.name : '')}" autocomplete="given-name"></label>
      <p class="err" id="err"></p>
      <button class="primary">Continue</button>
    </form>`);
  const form = document.getElementById('f-who');
  form.addEventListener('change', e => {
    if (e.target.name !== 'who') return;
    const m = store.get(e.target.value);
    form.name.value = m.claimed ? m.name : '';
  });
  bindForm('f-who', async fd => {
    const m = store.get(fd.who);
    await store.save({ ...m, name: fd.name.trim(), claimed: true });
    cfg.meId = m.id;
    saveCfg();
    afterUnlock();
  });
}

function renderUnlock(msg = '') {
  stopSession();
  screen(`
    <div class="brand"><div class="logo">🔒</div><h1>Our Budget</h1><p class="muted">Locked</p></div>
    ${cfg.bio ? '<button class="primary" data-act="unlock-bio">Unlock with Face ID</button><p class="or">or</p>' : ''}
    <form id="f-unlock">
      <label>Passphrase<input name="pass" type="password" autocomplete="current-password" required ${cfg.bio ? '' : 'autofocus'}></label>
      <p class="err" id="err">${esc(msg)}</p>
      <button class="${cfg.bio ? 'secondary' : 'primary'}">Unlock</button>
    </form>
    <button class="ghost small" data-act="reset-device">Forgot passphrase? Reset this phone</button>`);
  bindForm('f-unlock', async fd => {
    const bits = await C.deriveKeyBits(fd.pass, cfg.household);
    await unlockWith(bits);
  }, 'Unlocking…');
}

async function unlockWith(bits) {
  const key = await C.importKey(bits);
  try { await C.open(key, cfg.verifier, 'verifier'); } catch { throw new Error('Wrong passphrase.'); }
  await store.init(key, syncCfgOf(cfg));
  rawBits = bits;
  afterUnlock();
}

async function unlockBio() {
  try {
    await unlockWith(await C.unlockBiometric(cfg.bio));
  } catch (e) {
    const err = document.getElementById('err');
    if (err) err.textContent = e.name === 'NotAllowedError' ? 'Face ID was cancelled. Try again or use the passphrase.' : e.message;
  }
}

function lockNow() {
  store.lock();
  rawBits = null;
  renderUnlock();
}

function stopSession() {
  unsub?.();
  unsub = null;
  clearInterval(syncTimer);
}

async function afterUnlock() {
  if (!cfg.meId || !store.get(cfg.meId)) return renderWhoAreYou();
  stopSession();
  unsub = store.onChange(requestRender);
  renderMain();
  if (cfg.sync) { try { await store.sync(); } catch {} }
  await refreshRate();
  await runRecurring();
  await runPaychecks();
  renderMain();
  syncTimer = setInterval(() => { if (!document.hidden) store.sync().catch(() => {}); }, 30000);
}

async function runRecurring() {
  const due = M.dueRecurring(store.all('recurring'), store.exists);
  if (!due.length) return;
  const { rate } = currentRate();
  await store.save(due.map(d => {
    const r = store.get(d.recurringId);
    return {
      id: d.id, type: 'expense', date: d.date, desc: r.desc, amount: r.amount, currency: r.currency, rate,
      usd: M.toUSD(r.amount, r.currency, rate), categoryId: r.categoryId, paidBy: r.paidBy,
      forWhom: r.forWhom, split: r.split, recurringId: r.id,
      // Back-dated timestamp so a manual edit made on the other phone always wins.
      _ts: new Date(d.date + 'T00:00:00').getTime(),
    };
  }));
}

document.addEventListener('visibilitychange', () => {
  if (!cfg || !rawBits) return;
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) { hiddenAt = null; return lockNow(); }
  hiddenAt = null;
  store.sync().catch(() => {});
});

// ---------- main app ----------

const TABS = [
  ['home', '🏠', 'Home'],
  ['activity', '🧾', 'Activity'],
  ['budgets', '📊', 'Budgets'],
  ['money', '💰', 'Money'],
  ['settle', '🤝', 'Settle'],
  ['settings', '⚙️', 'Settings'],
];

function renderMain() {
  if (!rawBits || !me()) return;
  const scrollY = window.scrollY;
  const showMonth = ['home', 'activity', 'budgets', 'money'].includes(ui.tab);
  const thisMonth = M.monthOf(M.todayISO());
  const ss = store.getSyncState();
  const syncDot = !cfg.sync ? '<span class="sync off" title="Not syncing">Local only</span>'
    : `<button class="sync ${ss.status}" data-act="sync-now" title="${esc(ss.error || '')}">${{ idle: 'Synced', ok: 'Synced', syncing: 'Syncing…', error: 'Sync error', offline: 'Offline' }[ss.status]}</button>`;
  $app.className = 'main';
  $app.innerHTML = `
    <header class="top">
      ${showMonth ? `<div class="month">
        <button data-act="month" data-d="-1" aria-label="Previous month">‹</button>
        <span>${monthLabel(ui.month)}</span>
        <button data-act="month" data-d="1" aria-label="Next month" ${ui.month >= thisMonth ? 'disabled' : ''}>›</button>
      </div>` : `<h1 class="title">${TABS.find(t => t[0] === ui.tab)[2]}</h1>`}
      ${syncDot}
    </header>
    <main id="view">${VIEWS[ui.tab]()}</main>
    ${ui.tab === 'money' ? '<button class="fab" data-act="money-menu" aria-label="Add income or savings">＋</button>'
      : ui.tab !== 'settings' ? '<button class="fab" data-act="add-expense" aria-label="Add expense">＋</button>' : ''}
    <nav class="tabs">${TABS.map(([id, icon, label]) =>
      `<button data-act="tab" data-tab="${id}" class="${ui.tab === id ? 'on' : ''}"><span>${icon}</span>${label}</button>`).join('')}</nav>`;
  if (ui.tab === 'activity') wireActivity();
  if (ui.tab === 'money') wireChart();
  window.scrollTo(0, scrollY);
}

// Background syncs shouldn't wipe out a field you're typing in; re-render once you leave it.
const typing = () => { const a = document.activeElement; return !!a && $app.contains(a) && a.matches('input, select, textarea'); };
function requestRender() {
  if (typing()) { ui.pendingRender = true; return; }
  renderMain();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (ui.pendingRender && !typing()) { ui.pendingRender = false; renderMain(); }
}, 0));

function bar(spent, limit) {
  if (!limit) return '';
  const pct = Math.min(100, (spent / limit) * 100);
  const cls = spent > limit ? 'over' : pct >= 80 ? 'warn' : '';
  return `<div class="bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

function expenseRow(e) {
  const c = catOf(e.categoryId);
  const ids = memberIds();
  const who = e.forWhom === 'shared'
    ? (e.split ? `Shared ${e.split[ids[0]]}/${e.split[ids[1]]}` : 'Shared')
    : `${esc(nameOf(e.forWhom))}'s`;
  return `<button class="row" data-act="edit-exp" data-id="${e.id}">
    <span class="emoji">${esc(c.emoji)}</span>
    <span class="row-main"><b>${esc(e.desc || c.name)}${e.recurringId ? ' <span class="badge">🔁</span>' : ''}</b>
      <small>${who} · paid by ${esc(nameOf(e.paidBy))}</small></span>
    <span class="row-amt">${money(M.toCents(e.usd))}${e.currency === 'INR' ? `<small>${moneyIn(e.amount, 'INR')}</small>` : ''}</span>
  </button>`;
}

const VIEWS = {
  home() {
    const ids = memberIds();
    const s = M.monthSummary(expenses(), ui.month, ids);
    const owes = M.whoOwes(M.balances(expenses(), store.all('settlement'), ids));
    const sharedLimit = categories().reduce((a, c) => a + M.toCents(c.limits?.shared || 0), 0);
    const alerts = [];
    for (const c of categories()) {
      const sp = s.byCat[c.id];
      const check = (spent, limit, label) => {
        const l = M.toCents(limit || 0);
        if (l && spent >= l * 0.8) alerts.push(`<div class="alert ${spent > l ? 'over' : ''}">${esc(c.emoji)} ${esc(c.name)} (${esc(label)}): ${money(spent)} of ${money(l)}</div>`);
      };
      check(sp?.shared || 0, c.limits?.shared, 'shared');
      for (const id of ids) check(sp?.personal[id] || 0, c.limits?.[id], nameOf(id));
    }
    const top = Object.entries(s.byCat).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
    const recent = expenses().filter(e => M.monthOf(e.date) === ui.month).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts).slice(0, 5);
    const bioBanner = !cfg.bio && C.biometricSupported() && localStorage.getItem('ob.bioDismissed') !== '1'
      ? `<div class="card banner"><span>Turn on Face ID so you don't have to type the passphrase every time.</span>
          <div><button class="small primary" data-act="enroll-bio">Turn on</button><button class="small ghost" data-act="dismiss-bio">Not now</button></div></div>` : '';
    return `
      ${bioBanner}
      <section class="card hero">
        <small>Spent in ${monthLabel(ui.month).split(' ')[0]}</small>
        <div class="big">${money(s.total)}</div>
        <div class="split-line"><span>Shared ${money(s.shared)}${sharedLimit ? ` of ${money(sharedLimit)}` : ''}</span><span>Personal ${money(s.total - s.shared)}</span></div>
        ${bar(s.shared, sharedLimit)}
      </section>
      <button class="card owe" data-act="tab" data-tab="settle">
        ${owes ? `<span><b>${esc(nameOf(owes.from))}</b> owes <b>${esc(nameOf(owes.to))}</b></span><span class="amt">${money(owes.cents)}</span>` : '<span>You two are all square 🎉</span>'}
      </button>
      <section class="people">${ids.map(id => `
        <div class="card person">
          <small>${esc(nameOf(id))}</small>
          <div class="mid">${money(s.person[id].total)}</div>
          <small class="muted">${money(s.person[id].personal)} personal + ${money(s.person[id].sharedPart)} share of shared</small>
        </div>`).join('')}
      </section>
      ${(() => {
        const t = monthCashFlow(ui.month).total;
        return t.gross ? `<button class="card flow" data-act="tab" data-tab="money">
          <span><small>Take-home</small><b>${money(t.net)}</b></span>
          <span><small>Left over</small><b>${signed(t.leftOver)}</b></span>
          <span><small>Saving</small><b>${pct(t.rate)}</b></span></button>` : '';
      })()}
      ${alerts.length ? `<section><h3>Budget alerts</h3>${alerts.join('')}</section>` : ''}
      ${top.length ? `<section class="card"><h3>Top categories</h3>${top.map(([cid, v]) => `
        <div class="cat-line"><span>${esc(catOf(cid).emoji)} ${esc(catOf(cid).name)}</span><span>${money(v.total)}</span></div>
        <div class="bar thin"><i style="width:${((v.total / top[0][1].total) * 100).toFixed(1)}%"></i></div>`).join('')}</section>` : ''}
      <section><h3>Recent</h3>
        ${recent.length ? `<div class="list card">${recent.map(expenseRow).join('')}</div>` : '<p class="empty">No expenses this month yet. Tap ＋ to add one.</p>'}
      </section>`;
  },

  activity() {
    const ms = members();
    const chips = [['all', 'All'], ['shared', 'Shared'], ...ms.map(m => [m.id, m.name])];
    return `
      <input class="search" id="search" type="search" placeholder="Search" value="${esc(ui.search)}">
      <div class="chips">${chips.map(([v, l]) => `<button data-act="filter" data-v="${v}" class="${ui.filter === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
      <div id="list">${activityList()}</div>`;
  },

  budgets() {
    const ids = memberIds();
    const s = M.monthSummary(expenses(), ui.month, ids);
    const section = (title, scope) => {
      const rows = [];
      let totS = 0, totL = 0;
      for (const [group, cats] of groupedCategories()) {
        const inner = cats.map(c => {
          const sp = scope === 'shared' ? (s.byCat[c.id]?.shared || 0) : (s.byCat[c.id]?.personal[scope] || 0);
          const lim = M.toCents(c.limits?.[scope] || 0);
          totS += sp; totL += lim;
          if (!sp && !lim) return '';
          return `<button class="brow" data-act="edit-cat" data-id="${c.id}">
            <div class="brow-top"><span>${esc(c.emoji)} ${esc(c.name)}</span>
              <span class="${lim && sp > lim ? 'over-t' : ''}">${money(sp)}${lim ? ` <small>of ${money(lim)}</small>` : ' <small>no limit</small>'}</span></div>
            ${bar(sp, lim)}
            ${lim ? `<small class="muted">${sp > lim ? `${money(sp - lim)} over` : `${money(lim - sp)} left`}</small>` : ''}
          </button>`;
        }).join('');
        if (inner) rows.push(`<div class="group-l">${esc(group)}</div>${inner}`);
      }
      return `<section class="card"><div class="sec-head"><h3>${esc(title)}</h3><span>${money(totS)}${totL ? ` / ${money(totL)}` : ''}</span></div>
        ${bar(totS, totL)}
        ${rows.join('') || '<p class="empty">No limits or spending yet.</p>'}</section>`;
    };
    return `
      <p class="hint">Tap a category to set its monthly limits. Only categories with a limit or spending are shown. <button class="link" data-act="tab" data-tab="settings">All categories ›</button></p>
      ${section('Shared', 'shared')}
      ${ids.map(id => section(`${nameOf(id)} (personal)`, id)).join('')}`;
  },

  settle() {
    const ids = memberIds();
    const owes = M.whoOwes(M.balances(expenses(), store.all('settlement'), ids));
    const hist = store.all('settlement').sort((a, b) => b.date.localeCompare(a.date));
    return `
      <section class="card hero center">
        ${owes ? `<small><b>${esc(nameOf(owes.from))}</b> owes <b>${esc(nameOf(owes.to))}</b></small><div class="big">${money(owes.cents)}</div>`
          : '<div class="big">🎉</div><small>You two are all square</small>'}
        <button class="primary" data-act="add-settle">Record a payment</button>
      </section>
      <p class="hint">This counts every expense you've ever added: your share of shared costs, plus any personal expense the other person paid for. It doesn't reset each month.</p>
      <section><h3>Payments</h3>
        ${hist.length ? `<div class="list card">${hist.map(p => `
          <button class="row" data-act="edit-settle" data-id="${p.id}"><span class="emoji">🤝</span>
            <span class="row-main"><b>${esc(nameOf(p.from))} paid ${esc(nameOf(p.to))}</b><small>${dateLabel(p.date)}${p.note ? ' · ' + esc(p.note) : ''}</small></span>
            <span class="row-amt">${money(M.toCents(p.usd))}</span></button>`).join('')}</div>` : '<p class="empty">No payments recorded yet.</p>'}
      </section>`;
  },

  settings() {
    const s = settings();
    const r = currentRate();
    const ss = store.getSyncState();
    const recs = store.all('recurring').filter(x => !x.deleted);
    return `
      <section><h3>People</h3><div class="list card">
        ${members().map(m => `<button class="row" data-act="edit-name" data-id="${m.id}"><span class="emoji">${m.id === cfg.meId ? '🙋' : '💑'}</span>
          <span class="row-main"><b>${esc(m.name)}</b><small>${m.id === cfg.meId ? 'You (this phone)' : m.claimed ? 'Partner' : 'Partner (not joined yet)'}</small></span><span class="chev">›</span></button>`).join('')}
      </div></section>

      <section><h3>Regular paychecks</h3><div class="list card">
        ${store.all('paySchedule').map(x => `<button class="row" data-act="edit-sched" data-id="${x.id}"><span class="emoji">💵</span>
          <span class="row-main"><b>${esc(x.desc || 'Paycheck')}</b><small>${esc(nameOf(x.memberId))} · ${x.freq === 'biweekly' ? 'every 2 weeks' : `monthly on day ${x.day}`}${x.active ? '' : ' · paused'}</small></span>
          <span class="row-amt">${moneyIn(x.net, x.currency)}<small>take-home</small></span></button>`).join('')}
        <button class="row add" data-act="add-sched">＋ Add regular paycheck</button>
      </div><p class="hint">These are added automatically on payday. If one paycheck was different (overtime, bonus), edit it on the Money tab.</p></section>

      <section><h3>Recurring expenses</h3><div class="list card">
        ${recs.map(x => `<button class="row" data-act="edit-rec" data-id="${x.id}"><span class="emoji">${esc(catOf(x.categoryId).emoji)}</span>
          <span class="row-main"><b>${esc(x.desc)}</b><small>Day ${x.day} of each month · ${x.forWhom === 'shared' ? 'Shared' : esc(nameOf(x.forWhom)) + "'s"}${x.active ? '' : ' · paused'}</small></span>
          <span class="row-amt">${moneyIn(x.amount, x.currency)}</span></button>`).join('')}
        <button class="row add" data-act="add-rec">＋ Add recurring expense</button>
      </div><p class="hint">These are added automatically each month. If you paid a different amount one month, just edit that month's expense.</p></section>

      <section><h3>Categories & limits</h3><div class="list card">
        ${[...groupedCategories()].map(([g, cats]) => `<div class="group-l pad">${esc(g)}</div>` + cats.map(c => `
          <button class="row" data-act="edit-cat" data-id="${c.id}"><span class="emoji">${esc(c.emoji)}</span>
          <span class="row-main"><b>${esc(c.name)}</b><small>${limitSummary(c)}</small></span><span class="chev">›</span></button>`).join('')).join('')}
        <button class="row add" data-act="add-cat">＋ Add category</button>
      </div></section>

      <section><h3>Currency</h3><div class="card pad">
        <form id="f-rate">
          ${seg('rateMode', [['auto', 'Daily rate'], ['fixed', 'Fixed rate']], s.rateMode)}
          <label class="inline">Fixed / fallback rate: ₹<input name="fixedRate" inputmode="decimal" value="${s.fixedRate}"> = $1</label>
          <p class="hint">Using ${r.label}: ₹${r.rate.toFixed(2)} = $1. Each expense keeps the rate from when it was added. The daily rate comes from frankfurter.dev, and no data of yours is sent.</p>
          <button class="secondary small">Save currency settings</button>
        </form></div></section>

      <section><h3>Sync</h3><div class="card pad">
        ${cfg.sync ? `<p>Syncing with your Supabase project.<br><small class="muted">${esc(new URL(cfg.sync.url).host)} · ${ss.last ? 'last synced ' + new Date(ss.last).toLocaleTimeString() : 'not synced yet'}</small></p>
          ${ss.error ? `<p class="err">${esc(ss.error)}</p>` : ''}
          <div class="btns"><button class="secondary small" data-act="sync-now">Sync now</button><button class="primary small" data-act="invite">Invite partner</button></div>`
        : `<p class="muted">This phone is local-only. Connect Supabase to sync with your partner.</p>
          <form id="f-sync">${syncFields(true).replace('<details', '<div').replace('</details>', '</div>').replace(/<summary>.*?<\/summary>/, '')}<p class="err" id="err"></p><button class="primary small">Connect</button></form>`}
      </div></section>

      <section><h3>Security</h3><div class="list card">
        ${C.biometricSupported() ? `<button class="row" data-act="${cfg.bio ? 'disable-bio' : 'enroll-bio'}"><span class="emoji">🪪</span>
          <span class="row-main"><b>Face ID unlock</b><small>${cfg.bio ? 'On' : 'Off'}</small></span><span class="chev">${cfg.bio ? 'Turn off' : 'Turn on'}</span></button>` : ''}
        <button class="row" data-act="lock"><span class="emoji">🔒</span><span class="row-main"><b>Lock now</b><small>Locks automatically after 3 minutes in the background</small></span></button>
      </div></section>

      <section><h3>Backup</h3><div class="list card">
        <button class="row" data-act="export"><span class="emoji">⬇️</span><span class="row-main"><b>Export encrypted backup</b><small>A file that only your passphrase can open</small></span></button>
        <label class="row"><span class="emoji">⬆️</span><span class="row-main"><b>Import backup</b><small>Merges with what's here</small></span><input type="file" id="import-file" accept=".json,application/json" hidden></label>
      </div></section>

      <section><div class="list card">
        <button class="row danger-t" data-act="reset-device"><span class="emoji">🗑️</span><span class="row-main"><b>Remove from this phone</b><small>${cfg.sync ? 'Synced data stays in your Supabase project' : 'Export a backup first!'}</small></span></button>
      </div></section>
      ${cfg.demo ? '<p class="hint center">Demo household · passphrase: <b>demo-passphrase</b></p>' : ''}
      <p class="hint center">Our Budget · end-to-end encrypted · AES-256-GCM</p>`;
  },
};

function limitSummary(c) {
  const parts = [];
  if (c.limits?.shared) parts.push(`Shared ${money(M.toCents(c.limits.shared))}`);
  for (const m of members()) if (c.limits?.[m.id]) parts.push(`${m.name} ${money(M.toCents(c.limits[m.id]))}`);
  return parts.length ? parts.join(' · ') : 'No limit';
}

function activityList() {
  const q = ui.search.trim().toLowerCase();
  const items = expenses().filter(e => M.monthOf(e.date) === ui.month)
    .filter(e => ui.filter === 'all' || e.forWhom === ui.filter)
    .filter(e => !q || (e.desc || '').toLowerCase().includes(q) || catOf(e.categoryId).name.toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  if (!items.length) return '<p class="empty">Nothing here.</p>';
  const total = items.reduce((a, e) => a + M.toCents(e.usd), 0);
  const byDay = new Map();
  for (const e of items) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  return `<p class="hint">${items.length} expense${items.length > 1 ? 's' : ''} · ${money(total)}</p>` +
    [...byDay].map(([d, list]) => `<div class="day">${dateLabel(d)}</div><div class="list card">${list.map(expenseRow).join('')}</div>`).join('');
}

function wireActivity() {
  const s = document.getElementById('search');
  s.addEventListener('input', () => { ui.search = s.value; document.getElementById('list').innerHTML = activityList(); });
}

// ---------- form widgets ----------

function seg(name, opts, val) {
  return `<div class="seg">${opts.map(([v, l]) =>
    `<label><input type="radio" name="${name}" value="${esc(v)}" ${v === val ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
}

function categorySelect(selected) {
  return `<select name="categoryId">${[...groupedCategories()].map(([g, cats]) =>
    `<optgroup label="${esc(g)}">${cats.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
}

function payFields(f) {
  const ms = members();
  const pct = f.split ? f.split[ms[0].id] : 50;
  return `
    <div class="field"><span class="lbl">Paid by</span>${seg('paidBy', ms.map(m => [m.id, m.name]), f.paidBy)}</div>
    <div class="field"><span class="lbl">For</span>${seg('forWhom', [['shared', 'Both of us'], ...ms.map(m => [m.id, m.name + ' only'])], f.forWhom)}</div>
    <div class="field" id="split-box"><span class="lbl">Split</span>
      ${seg('splitMode', [['equal', '50 / 50'], ['custom', 'Custom']], f.split ? 'custom' : 'equal')}
      <div id="split-custom"><input type="range" name="splitPct" min="0" max="100" step="5" value="${pct}"><div id="split-label" class="hint"></div></div>
    </div>`;
}

function wirePayFields(form, getUSD) {
  const ms = members();
  const update = () => {
    const shared = form.forWhom.value === 'shared';
    const custom = form.splitMode.value === 'custom';
    form.querySelector('#split-box').hidden = !shared;
    form.querySelector('#split-custom').hidden = !custom;
    const pct = Number(form.splitPct.value);
    const usd = getUSD();
    const amt = p => (usd ? ` (${money(Math.round(usd * p))})` : '');
    form.querySelector('#split-label').textContent = `${ms[0].name} ${pct}%${amt(pct)} · ${ms[1].name} ${100 - pct}%${amt(100 - pct)}`;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
  return update;
}

function readPay(fd) {
  const ms = members();
  const split = fd.forWhom === 'shared' && fd.splitMode === 'custom' && Number(fd.splitPct) !== 50
    ? { [ms[0].id]: Number(fd.splitPct), [ms[1].id]: 100 - Number(fd.splitPct) } : null;
  return { paidBy: fd.paidBy, forWhom: fd.forWhom, split };
}

// ---------- sheets ----------

function openSheet(html) {
  $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div><div class="panel" role="dialog" aria-modal="true">${html}</div>`;
  $sheet.classList.add('open');
  document.body.classList.add('noscroll');
}

function closeSheet() {
  $sheet.classList.remove('open');
  $sheet.innerHTML = '';
  document.body.classList.remove('noscroll');
}

const sheetHead = title => `<div class="sheet-head"><h2>${title}</h2><button type="button" class="x" data-act="close-sheet" aria-label="Close">✕</button></div>`;

function bindForm(id, handler, busyText) {
  const form = document.getElementById(id);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button.primary, button:not([type])');
    const err = form.querySelector('.err');
    const label = btn?.textContent;
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; if (busyText) btn.textContent = busyText; }
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (ex) {
      console.error(ex);
      if (err) err.textContent = ex.message; else toast(ex.message);
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
  });
  return form;
}

function expenseSheet(existing) {
  const thisMonth = M.monthOf(M.todayISO());
  const f = existing || {
    date: ui.month === thisMonth ? M.todayISO() : `${ui.month}-01`, currency: 'USD', paidBy: cfg.meId,
    forWhom: 'shared', split: null, desc: '', amount: '',
    categoryId: [localStorage.getItem('ob.lastCat'), categories().find(c => c.name === 'Groceries')?.id]
      .find(id => id && store.get(id) && !store.get(id).archived) || categories()[0]?.id,
  };
  openSheet(`
    ${sheetHead(existing ? 'Edit expense' : 'Add expense')}
    <form id="f-exp">
      ${existing ? '' : `<button type="button" class="scan" id="scan-btn">📷 Scan a receipt</button>
        <input type="file" accept="image/*" id="scan-file" hidden><p class="hint" id="scan-status"></p>`}
      <div class="amount-row">
        <input name="amount" inputmode="decimal" placeholder="0.00" required value="${f.amount}" aria-label="Amount">
        ${seg('currency', [['USD', '$ USD'], ['INR', '₹ INR']], f.currency)}
      </div>
      <p class="hint" id="conv"></p>
      <label>Description<input name="desc" value="${esc(f.desc)}" placeholder="e.g. Dinner with friends (our share)"></label>
      <label>Category${categorySelect(f.categoryId)}</label>
      <label>Date<input type="date" name="date" value="${f.date}" required></label>
      ${payFields(f)}
      ${f.recurringId ? `<p class="hint">🔁 Added automatically from the recurring expense "${esc(store.get(f.recurringId)?.desc || '')}". If you paid a different amount this month, change it here.</p>` : ''}
      <p class="err" id="err"></p>
      <button class="primary">${existing ? 'Save changes' : 'Add expense'}</button>
      ${existing ? '<button type="button" class="danger" data-act="del-exp">Delete expense</button>' : ''}
    </form>`);
  const form = document.getElementById('f-exp');
  const getUSD = () => {
    const amt = parseNum(form.amount.value);
    if (!(amt > 0)) return 0;
    const cur = form.currency.value;
    const rate = existing && existing.currency === cur && existing.amount === amt ? existing.rate : currentRate().rate;
    return { usd: M.toUSD(amt, cur, rate), rate };
  };
  const updateConv = () => {
    const r = getUSD();
    form.querySelector('#conv').textContent = form.currency.value === 'INR' && r
      ? `≈ ${usdFmt.format(r.usd)} at ₹${r.rate.toFixed(2)} = $1 (${existing?.currency === 'INR' && existing.amount === parseNum(form.amount.value) ? 'rate when added' : currentRate().label})` : '';
  };
  form.addEventListener('input', updateConv);
  form.addEventListener('change', updateConv);
  updateConv();
  wirePayFields(form, () => getUSD().usd || 0);
  if (!existing) setTimeout(() => form.amount.focus(), 250);

  if (!existing) {
    const file = form.querySelector('#scan-file');
    const status = form.querySelector('#scan-status');
    form.querySelector('#scan-btn').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try {
        const { scanReceipt } = await import('./ocr.js');
        const r = await scanReceipt(file.files[0], msg => { status.textContent = msg; });
        if (r.amount) form.amount.value = r.amount.toFixed(2);
        if (r.currency) form.querySelector(`input[name=currency][value=${r.currency}]`).checked = true;
        if (r.merchant && !form.desc.value) form.desc.value = r.merchant;
        if (r.date && r.date <= M.todayISO()) form.date.value = r.date;
        status.textContent = r.amount ? '✓ Filled in from the receipt. Please double-check the numbers.' : "Couldn't find a total. Please type it in.";
        form.dispatchEvent(new Event('change'));
      } catch (e) {
        status.textContent = e.message;
      } finally {
        file.value = '';
      }
    });
  }

  form.querySelector('[data-act=del-exp]')?.addEventListener('click', async () => {
    if (!confirm('Delete this expense?')) return;
    await store.remove(existing);
    closeSheet();
    toast('Expense deleted');
  });

  bindForm('f-exp', async fd => {
    const amount = parseNum(fd.amount);
    if (!(amount > 0)) throw new Error('Enter an amount.');
    const { usd, rate } = getUSD();
    await store.save({
      ...(existing || { id: newId('exp'), type: 'expense' }),
      amount, currency: fd.currency, rate, usd, desc: fd.desc.trim(), categoryId: fd.categoryId, date: fd.date,
      ...readPay(fd),
    });
    localStorage.setItem('ob.lastCat', fd.categoryId);
    closeSheet();
    toast(existing ? 'Saved' : 'Expense added');
  });
}

function recurringSheet(existing) {
  const thisMonth = M.monthOf(M.todayISO());
  const f = existing || { desc: '', amount: '', currency: 'USD', categoryId: categories()[0]?.id, paidBy: cfg.meId, forWhom: 'shared', split: null, day: 1, active: true };
  openSheet(`
    ${sheetHead(existing ? 'Edit recurring' : 'New recurring expense')}
    <form id="f-rec">
      <label>Name<input name="desc" required value="${esc(f.desc)}" placeholder="e.g. Rent, Netflix, Phone bill"></label>
      <div class="amount-row">
        <input name="amount" inputmode="decimal" placeholder="0.00" required value="${f.amount}" aria-label="Usual amount">
        ${seg('currency', [['USD', '$ USD'], ['INR', '₹ INR']], f.currency)}
      </div>
      <label>Category${categorySelect(f.categoryId)}</label>
      <label class="inline">Add it on day <input name="day" type="number" min="1" max="31" value="${f.day}" required> of each month</label>
      ${existing ? '' : `<div class="field"><span class="lbl">Start</span>${seg('start', [[thisMonth, 'This month'], [M.addMonths(thisMonth, 1), 'Next month']], thisMonth)}</div>`}
      ${payFields(f)}
      ${existing ? `<label class="check"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Active (uncheck to pause)</label>
        <p class="hint">Changes apply to future months. Months already added stay the same, so edit those directly.</p>` : ''}
      <p class="err" id="err"></p>
      <button class="primary">${existing ? 'Save changes' : 'Create'}</button>
      ${existing ? '<button type="button" class="danger" data-act="del-rec">Delete recurring</button>' : ''}
    </form>`);
  const form = document.getElementById('f-rec');
  wirePayFields(form, () => 0);
  form.querySelector('[data-act=del-rec]')?.addEventListener('click', async () => {
    if (!confirm('Stop this recurring expense? Months already added stay.')) return;
    await store.remove(existing);
    closeSheet();
  });
  bindForm('f-rec', async fd => {
    const amount = parseNum(fd.amount);
    if (!(amount > 0)) throw new Error('Enter an amount.');
    await store.save({
      ...(existing || { id: newId('rec'), type: 'recurring', startMonth: fd.start }),
      desc: fd.desc.trim(), amount, currency: fd.currency, categoryId: fd.categoryId,
      day: Math.max(1, Math.min(31, Number(fd.day) || 1)), active: existing ? fd.active === 'on' : true,
      ...readPay(fd),
    });
    await runRecurring();
    closeSheet();
    toast('Recurring expense saved');
  });
}

function categorySheet(existing) {
  const ms = members();
  const f = existing || { emoji: '📦', name: '', group: 'Other', limits: {} };
  const groups = [...new Set(categories().map(c => c.group))];
  openSheet(`
    ${sheetHead(existing ? 'Category' : 'New category')}
    <form id="f-cat">
      <div class="emoji-row"><input name="emoji" class="emoji-in" value="${esc(f.emoji)}" maxlength="4" aria-label="Emoji">
        <label>Name<input name="name" required value="${esc(f.name)}"></label></div>
      <label>Group<input name="group" list="groups" value="${esc(f.group)}" required><datalist id="groups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <h3>Monthly limits (USD)</h3>
      <p class="hint">Leave blank for no limit.</p>
      <label class="inline">Shared <input name="lim_shared" inputmode="decimal" placeholder="—" value="${f.limits?.shared || ''}"></label>
      ${ms.map(m => `<label class="inline">${esc(m.name)} (personal) <input name="lim_${m.id}" inputmode="decimal" placeholder="—" value="${f.limits?.[m.id] || ''}"></label>`).join('')}
      <p class="err" id="err"></p>
      <button class="primary">Save</button>
      ${existing ? '<button type="button" class="danger" data-act="del-cat">Hide category</button>' : ''}
    </form>`);
  document.querySelector('[data-act=del-cat]')?.addEventListener('click', async () => {
    if (!confirm('Hide this category? Past expenses keep it.')) return;
    await store.save({ ...existing, archived: true });
    closeSheet();
  });
  bindForm('f-cat', async fd => {
    const limits = {};
    for (const k of ['shared', ...ms.map(m => m.id)]) {
      const v = parseNum(fd['lim_' + k]);
      if (v > 0) limits[k] = v;
    }
    await store.save({
      ...(existing || { id: newId('cat'), type: 'category', order: Date.now() }),
      emoji: fd.emoji.trim() || '📦', name: fd.name.trim(), group: fd.group.trim() || 'Other', limits,
    });
    closeSheet();
  });
}

function settleSheet(existing) {
  const ms = members();
  const owes = M.whoOwes(M.balances(expenses(), store.all('settlement'), memberIds()));
  const f = existing || { from: owes?.from || ms[1].id, usd: owes ? owes.cents / 100 : '', date: M.todayISO(), note: '' };
  openSheet(`
    ${sheetHead(existing ? 'Payment' : 'Record a payment')}
    <form id="f-set">
      <div class="field"><span class="lbl">Who paid</span>${seg('from', ms.map(m => [m.id, m.name]), f.from)}</div>
      <p class="hint" id="to-label"></p>
      <label>Amount (USD)<input name="usd" inputmode="decimal" required value="${f.usd}"></label>
      <label>Date<input type="date" name="date" required value="${f.date}"></label>
      <label>Note<input name="note" value="${esc(f.note)}" placeholder="e.g. Zelle / UPI"></label>
      <p class="err" id="err"></p>
      <button class="primary">Save</button>
      ${existing ? '<button type="button" class="danger" data-act="del-set">Delete payment</button>' : ''}
    </form>`);
  const form = document.getElementById('f-set');
  const upd = () => { form.querySelector('#to-label').textContent = `…to ${nameOf(ms.find(m => m.id !== form.from.value).id)}`; };
  form.addEventListener('change', upd);
  upd();
  form.querySelector('[data-act=del-set]')?.addEventListener('click', async () => {
    if (!confirm('Delete this payment?')) return;
    await store.remove(existing);
    closeSheet();
  });
  bindForm('f-set', async fd => {
    const usd = parseNum(fd.usd);
    if (!(usd > 0)) throw new Error('Enter an amount.');
    await store.save({
      ...(existing || { id: newId('set'), type: 'settlement' }),
      from: fd.from, to: ms.find(m => m.id !== fd.from).id, usd: Math.round(usd * 100) / 100, date: fd.date, note: fd.note.trim(),
    });
    closeSheet();
    toast('Payment recorded');
  });
}

function nameSheet(m) {
  openSheet(`${sheetHead('Name')}
    <form id="f-name"><label>Name<input name="name" required value="${esc(m.name)}"></label><p class="err" id="err"></p><button class="primary">Save</button></form>`);
  bindForm('f-name', async fd => { await store.save({ ...m, name: fd.name.trim() }); closeSheet(); });
}

function inviteSheet() {
  const code = makeInvite();
  openSheet(`${sheetHead('Invite your partner')}
    <ol class="steps">
      <li>On their iPhone, open this app's link in Safari and add it to the Home Screen.</li>
      <li>They tap <b>Join my partner's household</b> and paste this code:</li>
    </ol>
    <textarea readonly rows="4" class="code" id="invite-code">${esc(code)}</textarea>
    ${navigator.share ? '<button class="primary" data-act="share-invite">Share code…</button><button class="secondary" data-act="copy-invite">Copy code</button>'
      : '<button class="primary" data-act="copy-invite">Copy code</button>'}
    <ol class="steps" start="3"><li>Tell them the <b>passphrase</b> in person or by phone, not in the same message as the code.</li></ol>
    <p class="hint">The code alone can't read anything. It only lets the app find your encrypted data.</p>`);
}

// ---------- settings actions ----------

async function exportBackup() {
  const body = JSON.stringify({ app: 'our-budget', v: 1, household: cfg.household, verifier: cfg.verifier, exported: new Date().toISOString(), rows: await store.exportRows() });
  const name = `our-budget-backup-${M.todayISO()}.json`;
  const file = new File([body], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Our Budget backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  let b;
  try { b = JSON.parse(await file.text()); } catch { return toast("That file isn't an Our Budget backup."); }
  if (b.app !== 'our-budget' || !Array.isArray(b.rows)) return toast("That file isn't an Our Budget backup.");
  if (b.household !== cfg.household) return toast('That backup is from a different household.');
  const n = await store.mergeRows(b.rows);
  if (cfg.sync) { await store.markAllDirty(); store.sync().catch(() => {}); }
  toast(`Imported ${n} change${n === 1 ? '' : 's'}`);
}

async function resetDevice() {
  const msg = cfg?.sync
    ? 'Remove all budget data from THIS phone? Your synced data stays in Supabase, and you can join again with the invite code and passphrase.'
    : 'Remove all budget data from this phone? This phone is not syncing, so without a backup file the data is GONE.';
  if (!confirm(msg)) return;
  stopSession();
  store.lock();
  rawBits = null;
  await clearRows();
  Object.keys(localStorage).filter(k => k.startsWith('ob.')).forEach(k => localStorage.removeItem(k));
  cfg = null;
  boot();
}

// ---------- event delegation ----------

const ACTIONS = {
  'go-welcome': renderWelcome,
  'go-create': renderCreate,
  'go-join': renderJoin,
  'go-restore': renderRestore,
  'go-demo': async () => {
    $app.innerHTML = '<div class="setup"><p class="center muted">Setting up the demo…</p></div>';
    await createHousehold({ name: 'Alex', pass: 'demo-passphrase', sync: null, demo: true });
  },
  'unlock-bio': unlockBio,
  'reset-device': resetDevice,
  tab: d => { ui.tab = d.tab; renderMain(); window.scrollTo(0, 0); },
  month: d => { ui.month = M.addMonths(ui.month, Number(d.d)); renderMain(); },
  filter: d => { ui.filter = d.v; renderMain(); },
  'add-expense': () => expenseSheet(),
  'edit-exp': d => expenseSheet(store.get(d.id)),
  'add-rec': () => recurringSheet(),
  'edit-rec': d => recurringSheet(store.get(d.id)),
  'add-cat': () => categorySheet(),
  'edit-cat': d => categorySheet(store.get(d.id)),
  'add-settle': () => settleSheet(),
  'edit-settle': d => settleSheet(store.get(d.id)),
  'edit-name': d => nameSheet(store.get(d.id)),
  'close-sheet': closeSheet,
  invite: inviteSheet,
  'share-invite': async () => {
    try { await navigator.share({ text: document.getElementById('invite-code').value }); } catch {}
  },
  'copy-invite': async () => {
    const t = document.getElementById('invite-code');
    try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
    toast('Invite code copied');
  },
  'sync-now': () => store.sync().then(() => toast('Synced'), e => toast(e.message)),
  lock: lockNow,
  export: exportBackup,
  'enroll-bio': async () => {
    try {
      cfg.bio = await C.enrollBiometric(rawBits, me().name);
      saveCfg();
      toast('Face ID is on');
      renderMain();
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Face ID setup was cancelled' : e.message, 4000);
    }
  },
  'disable-bio': () => { cfg.bio = null; saveCfg(); renderMain(); toast('Face ID is off'); },
  'dismiss-bio': () => { localStorage.setItem('ob.bioDismissed', '1'); renderMain(); },
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const fn = ACTIONS[t.dataset.act];
  if (fn) { e.preventDefault(); fn(t.dataset, t); }
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'f-rate') {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const rate = parseNum(fd.fixedRate);
    if (!(rate > 0)) return toast('Enter a valid rate');
    await store.save({ ...settings(), id: 'settings', type: 'settings', rateMode: fd.rateMode, fixedRate: rate });
    await refreshRate();
    renderMain();
    toast('Currency settings saved');
  } else if (e.target.id === 'f-sync') {
    e.preventDefault();
    const form = e.target;
    const fd = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.err');
    try {
      if (!fd.url.trim() || !fd.key.trim()) throw new Error('Enter both the URL and the key.');
      const sync = { url: normalizeUrl(fd.url), key: fd.key.trim() };
      await testConnection({ ...sync, household: cfg.household });
      cfg.sync = sync;
      cfg.demo = false;
      saveCfg();
      store.setSyncConfig(syncCfgOf(cfg));
      store.resetCursor();
      await store.markAllDirty();
      await store.sync();
      toast('Connected and synced');
      if (!syncTimer) syncTimer = setInterval(() => { if (!document.hidden) store.sync().catch(() => {}); }, 30000);
      renderMain();
    } catch (ex) {
      err.textContent = ex.message;
    }
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'import-file' && e.target.files[0]) {
    importBackup(e.target.files[0]);
    e.target.value = '';
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && $sheet.classList.contains('open')) closeSheet(); });

// ---------- money: income, savings, net worth ----------

const ACCOUNT_KINDS = {
  '401k': ['🏦', '401k'],
  brokerage: ['📈', 'Stocks / brokerage'],
  savings: ['🐷', 'Savings'],
  india: ['🇮🇳', 'India investments'],
};
const EXTRA_SOURCES = ['Bonus', 'Freelance / side gig', 'Rental income', 'Interest & dividends', 'Gift', 'Refund / reimbursement', 'Other'];
const accounts = () => store.all('account').filter(a => !a.archived)
  .sort((a, b) => Object.keys(ACCOUNT_KINDS).indexOf(a.kind) - Object.keys(ACCOUNT_KINDS).indexOf(b.kind) || a.name.localeCompare(b.name));
const incomes = () => store.all('income');
const ownerLabel = o => (o === 'joint' ? 'Joint' : nameOf(o));
const pct = r => (r == null ? '—' : `${Math.round(r * 100)}%`);
const signed = c => (c < 0 ? '−' + money(-c) : money(c));
const compact = c => {
  const d = Math.abs(c / 100);
  const s = d >= 1e6 ? (d / 1e6).toFixed(d >= 1e7 ? 0 : 1) + 'M' : d >= 1e3 ? (d / 1e3).toFixed(d >= 1e4 ? 0 : 1) + 'K' : d.toFixed(0);
  return (c < 0 ? '−$' : '$') + s.replace(/\.0(?=[KM])/, '');
};

// Each account's contributions in a month: manual transfers + 401k/match from linked paychecks.
function accountContribs(month) {
  const out = {};
  for (const k of store.all('contribution')) if (M.monthOf(k.date) === month) out[k.accountId] = (out[k.accountId] || 0) + M.usdCents(k.amount, k.currency, k.rate);
  for (const i of incomes()) if (i.kind === 'paycheck' && i.accountId && M.monthOf(i.date) === month) {
    out[i.accountId] = (out[i.accountId] || 0) + M.usdCents((+i.k401 || 0) + (+i.match || 0), i.currency, i.rate);
  }
  return out;
}

function monthCashFlow(month) {
  const ids = memberIds();
  const sp = M.monthSummary(expenses(), month, ids);
  return M.cashFlow(incomes(), store.all('contribution'), month, ids, Object.fromEntries(ids.map(id => [id, sp.person[id].total])));
}

const kv = (label, cents, cls = '') => `<div class="kv ${cls}"><span>${label}</span><span>${signed(cents)}</span></div>`;

VIEWS.money = function () {
  const ids = memberIds();
  const cf = monthCashFlow(ui.month);
  const t = cf.total;
  const monthEnd = `${ui.month}-${String(M.daysInMonth(ui.month)).padStart(2, '0')}`;
  const asOf = ui.month === M.monthOf(M.todayISO()) ? M.todayISO() : monthEnd;
  const accts = accounts();
  const bal = M.balancesAt(accts, store.all('balance'), asOf);
  const worth = Object.values(bal).reduce((s, b) => s + b.cents, 0);
  const contribs = accountContribs(ui.month);
  const inc = incomes().filter(i => M.monthOf(i.date) === ui.month).sort((a, b) => b.date.localeCompare(a.date));
  const transfers = store.all('contribution').filter(k => M.monthOf(k.date) === ui.month).sort((a, b) => b.date.localeCompare(a.date));
  const noSchedules = !store.all('paySchedule').length;

  return `
    ${noSchedules ? `<div class="card banner"><span>Set up your regular paychecks once, and they'll be added automatically on every payday.</span>
      <div><button class="small primary" data-act="add-sched">Set up a paycheck</button></div></div>` : ''}

    <section class="card">
      <div class="sec-head"><h3>Cash flow</h3></div>
      ${kv('Take-home income', t.net)}
      ${kv('Spending', -t.spending)}
      ${kv('Moved to savings & investments', -t.transfers)}
      ${kv('Left over', t.leftOver, 'total ' + (t.leftOver < 0 ? 'neg' : ''))}
      <p class="hint">Also saved straight from paychecks: 401k ${money(t.k401)} + employer match ${money(t.match)}.</p>
    </section>

    <section class="card hero">
      <small>Savings rate</small>
      <div class="big">${pct(t.rate)}</div>
      <small class="muted">${money(t.saved)} saved of ${money(t.gross + t.match)} (gross income + employer match)</small>
      ${t.rate != null ? `<div class="bar"><i style="width:${Math.min(100, Math.max(0, t.rate * 100)).toFixed(1)}%"></i></div>` : ''}
    </section>

    <section class="people">${ids.map(id => {
      const p = cf.person[id];
      return `<div class="card person">
        <small>${esc(nameOf(id))}</small>
        <div class="mid">${signed(p.leftOver)}</div>
        <small class="muted">left over · saving ${pct(p.rate)}</small>
        <details class="mini"><summary>Details</summary>
          ${kv('Gross pay', p.gross - p.extra)}${kv('Extra income', p.extra)}${kv('401k', -p.k401)}${kv('Taxes', -p.taxes)}
          ${kv('Health & other', -p.deductions)}${kv('Take-home', p.net, 'total')}
          ${kv('Spending', -p.spending)}${kv('To savings', -p.transfers)}${kv('Employer match', p.match)}
        </details>
      </div>`;
    }).join('')}</section>

    <section><h3>Income this month</h3><div class="list card">
      ${inc.map(i => `<button class="row" data-act="edit-income" data-id="${i.id}">
        <span class="emoji">${i.kind === 'paycheck' ? '💵' : '✨'}</span>
        <span class="row-main"><b>${esc(i.desc || (i.kind === 'paycheck' ? 'Paycheck' : i.source || 'Extra income'))}${i.scheduleId ? ' <span class="badge">🔁</span>' : ''}</b>
          <small>${esc(nameOf(i.memberId))} · ${dateLabel(i.date)}${i.kind === 'paycheck' ? ` · gross ${moneyIn(i.gross, i.currency)}` : ''}</small></span>
        <span class="row-amt">${moneyIn(i.net, i.currency)}${i.kind === 'paycheck' ? '<small>take-home</small>' : ''}</span></button>`).join('')}
      <div class="row-pair"><button class="row add" data-act="add-paycheck">＋ Paycheck</button><button class="row add" data-act="add-extra">＋ Extra income</button></div>
    </div></section>

    <section><h3>Moved to savings this month</h3><div class="list card">
      ${transfers.map(k => {
        const a = store.get(k.accountId);
        return `<button class="row" data-act="edit-contrib" data-id="${k.id}"><span class="emoji">${ACCOUNT_KINDS[a?.kind]?.[0] || '💰'}</span>
          <span class="row-main"><b>${esc(a?.name || 'Account')}</b><small>${esc(ownerLabel(k.memberId))} · ${dateLabel(k.date)}${k.note ? ' · ' + esc(k.note) : ''}</small></span>
          <span class="row-amt">${moneyIn(k.amount, k.currency)}</span></button>`;
      }).join('')}
      <button class="row add" data-act="add-contrib">＋ Add to savings / investments</button>
    </div><p class="hint">401k and employer match from paychecks are counted automatically, so don't add them here.</p></section>

    <section class="card">
      <div class="sec-head"><h3>Net worth</h3><span class="muted small-t">${ui.month === M.monthOf(M.todayISO()) ? 'today' : 'end of ' + monthLabel(ui.month)}</span></div>
      <div class="big-mid">${money(worth)}</div>
      ${netWorthChart(M.netWorthSeries(accts, store.all('balance'), ui.month, 12))}
    </section>

    <section><h3>Accounts</h3><div class="list card">
      ${accts.map(a => {
        const b = bal[a.id];
        const c = contribs[a.id];
        return `<button class="row" data-act="open-account" data-id="${a.id}"><span class="emoji">${ACCOUNT_KINDS[a.kind][0]}</span>
          <span class="row-main"><b>${esc(a.name)}</b><small>${esc(ownerLabel(a.owner))} · ${b ? 'updated ' + dateLabel(b.date) : 'no balance yet'}${c ? ` · +${money(c)} this month` : ''}</small></span>
          <span class="row-amt">${b ? moneyIn(b.amount, b.currency) : '—'}${b && b.currency === 'INR' ? `<small>${money(b.cents)}</small>` : ''}</span></button>`;
      }).join('')}
      <button class="row add" data-act="add-account">＋ Add account</button>
    </div><p class="hint">Update balances whenever you check your accounts. Once a month is plenty. INR accounts count toward net worth in USD.</p></section>`;
};

// Single-series trend: 2px line + 10% area wash, end dot with surface ring, labeled end value,
// hairline grid with compact ticks, tap/hover crosshair + tooltip.
function netWorthChart(series) {
  const first = series.findIndex(p => p.has);
  const pts = first < 0 ? [] : series.slice(first);
  if (pts.length < 2) return '<p class="hint">Add account balances in at least two different months to see the trend here.</p>';
  const W = 340, H = 170, L = 44, R = 14, T = 22, B = 24;
  const max = Math.max(...pts.map(p => p.cents), 1);
  const step = Math.pow(10, Math.floor(Math.log10(max / 100))) * 100;
  const top = Math.ceil(max / (step / 2)) * (step / 2) || 1;
  const x = i => L + (i * (W - L - R)) / (pts.length - 1);
  const y = c => T + (H - T - B) * (1 - c / top);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const ticks = [0, top / 2, top];
  const mon = m => new Date(m + '-15').toLocaleDateString(undefined, { month: 'short' });
  const labelIdx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
  const last = pts[pts.length - 1];
  const lx = x(pts.length - 1), ly = y(last.cents);
  return `<div class="chart" id="nw-chart" data-pts='${esc(JSON.stringify(pts.map((p, i) => ({ m: monthLabel(p.month), v: money(p.cents), x: x(i), y: y(p.cents) }))))}'>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net worth by month, latest ${money(last.cents)}">
      ${ticks.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}
      ${labelIdx.map(i => `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${mon(pts[i].month)}</text>`).join('')}
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <line class="cross" id="nw-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <circle class="dot" id="nw-dot" r="4" cx="${lx}" cy="${ly}"/>
      <text class="end-label" x="${lx}" y="${ly - 10}" text-anchor="end">${compact(last.cents)}</text>
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
    </svg>
    <div class="tip" id="nw-tip" hidden></div>
    <details class="mini"><summary>Show as table</summary>
      ${pts.slice().reverse().map(p => `<div class="kv"><span>${monthLabel(p.month)}</span><span>${money(p.cents)}</span></div>`).join('')}
    </details>
  </div>`;
}

function wireChart() {
  const box = document.getElementById('nw-chart');
  if (!box) return;
  const pts = JSON.parse(box.dataset.pts);
  const svg = box.querySelector('svg');
  const tip = box.querySelector('#nw-tip');
  const cross = box.querySelector('#nw-cross');
  const dot = box.querySelector('#nw-dot');
  const reset = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    const p = pts[pts.length - 1];
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
  };
  const show = e => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
    cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', best.x); dot.setAttribute('cy', best.y);
    tip.innerHTML = `<b>${esc(best.v)}</b><br><small>${esc(best.m)}</small>`;
    tip.hidden = false;
    const px = (best.x / svg.viewBox.baseVal.width) * r.width;
    tip.style.left = Math.min(Math.max(px, 50), r.width - 50) + 'px';
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', reset);
}

async function runPaychecks() {
  const due = M.duePaychecks(store.all('paySchedule'), store.exists);
  if (!due.length) return;
  const { rate } = currentRate();
  await store.save(due.map(d => {
    const s = store.get(d.scheduleId);
    return {
      id: d.id, type: 'income', kind: 'paycheck', memberId: s.memberId, date: d.date, desc: s.desc,
      currency: s.currency, rate, gross: s.gross, k401: s.k401, match: s.match, taxes: s.taxes,
      health: s.health, other: s.other, net: s.net, accountId: s.accountId || null, scheduleId: s.id,
      _ts: new Date(d.date + 'T00:00:00').getTime(),
    };
  }));
}

const numIn = (name, label, val, hint = '') =>
  `<label class="inline">${label}${hint ? ` <small class="muted">${hint}</small>` : ''}<input name="${name}" inputmode="decimal" placeholder="0.00" value="${val ?? ''}"></label>`;

function accountOptions(selected, filter = () => true, none = '') {
  return `${none ? `<option value="">${esc(none)}</option>` : ''}${accounts().filter(filter).map(a =>
    `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${ACCOUNT_KINDS[a.kind][0]} ${esc(a.name)} (${esc(ownerLabel(a.owner))})</option>`).join('')}`;
}

// Paycheck form, used for a single paycheck (income record) and for a regular schedule.
function paycheckSheet(existing, { schedule = false } = {}) {
  const ms = members();
  const thisMonth = M.monthOf(M.todayISO());
  const f = existing || { memberId: cfg.meId, currency: 'USD', date: ui.month === thisMonth ? M.todayISO() : `${ui.month}-01`, freq: 'monthly', day: 1, active: true, desc: 'Paycheck' };
  const locked = schedule && existing; // dates of an existing schedule are fixed so paydays never duplicate
  openSheet(`
    ${sheetHead(schedule ? (existing ? 'Regular paycheck' : 'New regular paycheck') : existing ? 'Paycheck' : 'Add paycheck')}
    <form id="f-pay">
      <div class="field"><span class="lbl">Whose paycheck</span>${seg('memberId', ms.map(m => [m.id, m.name]), f.memberId)}</div>
      <label>Name<input name="desc" value="${esc(f.desc || 'Paycheck')}" placeholder="e.g. Paycheck – Acme Inc."></label>
      ${schedule ? (locked
        ? `<p class="hint">${f.freq === 'biweekly' ? `Every 2 weeks, starting ${esc(f.anchor)}` : `Monthly on day ${f.day}`}. To change the schedule, delete this one and create a new one.</p>`
        : `<div class="field"><span class="lbl">How often</span>${seg('freq', [['monthly', 'Monthly'], ['biweekly', 'Every 2 weeks']], f.freq)}</div>
          <div id="freq-monthly">
            <label class="inline">Paid on day <input name="day" type="number" min="1" max="31" value="${f.day}"> of the month</label>
            <div class="field"><span class="lbl">Start</span>${seg('start', [[thisMonth, 'This month'], [M.addMonths(thisMonth, 1), 'Next month']], thisMonth)}</div>
          </div>
          <div id="freq-biweekly"><label>First payday to add<input type="date" name="anchor" value="${M.todayISO()}"></label>
            <p class="hint">That payday and every 2 weeks after it get added. Pick your next payday to skip past ones.</p></div>`)
        : `<label>Date<input type="date" name="date" value="${f.date}" required></label>`}
      <div class="field"><span class="lbl">Currency</span>${seg('currency', [['USD', '$ USD'], ['INR', '₹ INR']], f.currency)}</div>
      <h3>From the pay stub</h3>
      ${numIn('gross', 'Gross pay', f.gross)}
      ${numIn('k401', '401k (yours)', f.k401)}
      ${numIn('taxes', 'Taxes', f.taxes, 'fed + state + FICA')}
      ${numIn('health', 'Health insurance', f.health)}
      ${numIn('other', 'Other deductions', f.other)}
      ${numIn('net', 'Take-home', f.net)}
      <p class="hint" id="net-hint"></p>
      ${numIn('match', 'Employer 401k match', f.match)}
      <label>Count 401k + match toward<select name="accountId">${accountOptions(f.accountId, a => a.kind === '401k', 'No account (still counted as saved)')}</select></label>
      ${schedule && existing ? `<label class="check"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Active (uncheck to pause)</label>
        <p class="hint">Changes apply to future paydays. Paychecks already added stay as they are.</p>` : ''}
      ${!schedule && f.scheduleId ? '<p class="hint">🔁 Added automatically. Edit it if this paycheck was different.</p>' : ''}
      <p class="err" id="err"></p>
      <button class="primary">${existing ? 'Save changes' : schedule ? 'Create' : 'Add paycheck'}</button>
      ${existing ? `<button type="button" class="danger" data-act="del-pay">Delete ${schedule ? 'regular paycheck' : 'paycheck'}</button>` : ''}
    </form>`);
  const form = document.getElementById('f-pay');
  const upd = () => {
    if (form.freq && !locked) {
      form.querySelector('#freq-monthly').hidden = form.freq.value !== 'monthly';
      form.querySelector('#freq-biweekly').hidden = form.freq.value !== 'biweekly';
    }
    const fd = Object.fromEntries(new FormData(form));
    const calc = M.computedNet(Object.fromEntries(['gross', 'k401', 'taxes', 'health', 'other'].map(k => [k, parseNum(fd[k])])));
    form.net.placeholder = calc > 0 ? calc.toFixed(2) : '0.00';
    const entered = parseNum(fd.net);
    const diff = Math.round((entered - calc) * 100) / 100;
    form.querySelector('#net-hint').textContent = !fd.net ? (calc > 0 ? `Leave blank to use ${moneyIn(calc, fd.currency)} (gross minus deductions).` : '')
      : Math.abs(diff) >= 0.01 ? `Differs from gross minus deductions by ${moneyIn(Math.abs(diff), fd.currency)}. Double-check the numbers, or put the difference in "Other deductions".` : '✓ Matches the breakdown.';
  };
  form.addEventListener('input', upd);
  form.addEventListener('change', upd);
  upd();
  form.querySelector('[data-act=del-pay]')?.addEventListener('click', async () => {
    if (!confirm(schedule ? 'Stop this regular paycheck? Paychecks already added stay.' : 'Delete this paycheck?')) return;
    await store.remove(existing);
    closeSheet();
  });
  bindForm('f-pay', async fd => {
    const n = k => Math.round(parseNum(fd[k]) * 100) / 100 || 0;
    const fields = { gross: n('gross'), k401: n('k401'), match: n('match'), taxes: n('taxes'), health: n('health'), other: n('other') };
    const net = fd.net ? n('net') : M.computedNet(fields);
    if (!(fields.gross > 0) && !(net > 0)) throw new Error('Enter at least the gross pay or take-home.');
    const common = { memberId: fd.memberId, desc: fd.desc.trim() || 'Paycheck', currency: fd.currency, ...fields, net, accountId: fd.accountId || null };
    if (schedule) {
      const s = existing ? { ...existing, ...common, active: fd.active === 'on' } : {
        id: newId('pay'), type: 'paySchedule', active: true, freq: fd.freq, ...common,
        ...(fd.freq === 'biweekly' ? { anchor: fd.anchor } : { day: Math.max(1, Math.min(31, Number(fd.day) || 1)), startMonth: fd.start }),
      };
      if (s.freq === 'biweekly' && !s.anchor) throw new Error('Pick the first payday.');
      await store.save(s);
      await runPaychecks();
      toast('Regular paycheck saved');
    } else {
      const rate = existing && existing.currency === fd.currency ? existing.rate : currentRate().rate;
      await store.save({ ...(existing || { id: newId('inc'), type: 'income', kind: 'paycheck' }), ...common, date: fd.date, rate });
      toast(existing ? 'Saved' : 'Paycheck added');
    }
    closeSheet();
  });
}

function extraIncomeSheet(existing) {
  const ms = members();
  const thisMonth = M.monthOf(M.todayISO());
  const f = existing || { memberId: cfg.meId, currency: 'USD', date: ui.month === thisMonth ? M.todayISO() : `${ui.month}-01`, source: EXTRA_SOURCES[0], net: '' };
  openSheet(`
    ${sheetHead(existing ? 'Extra income' : 'Add extra income')}
    <form id="f-extra">
      <div class="field"><span class="lbl">Whose income</span>${seg('memberId', ms.map(m => [m.id, m.name]), f.memberId)}</div>
      <div class="amount-row">
        <input name="net" inputmode="decimal" placeholder="0.00" required value="${f.net}" aria-label="Amount">
        ${seg('currency', [['USD', '$ USD'], ['INR', '₹ INR']], f.currency)}
      </div>
      <label>Type<select name="source">${EXTRA_SOURCES.map(s => `<option ${s === f.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label>Note<input name="desc" value="${esc(f.desc || '')}" placeholder="e.g. Q3 bonus, Etsy sales"></label>
      <label>Date<input type="date" name="date" value="${f.date}" required></label>
      <p class="hint">Enter what you actually received (after any tax withheld).</p>
      <p class="err" id="err"></p>
      <button class="primary">${existing ? 'Save changes' : 'Add income'}</button>
      ${existing ? '<button type="button" class="danger" data-act="del-extra">Delete</button>' : ''}
    </form>`);
  document.querySelector('[data-act=del-extra]')?.addEventListener('click', async () => {
    if (!confirm('Delete this income?')) return;
    await store.remove(existing);
    closeSheet();
  });
  bindForm('f-extra', async fd => {
    const amt = parseNum(fd.net);
    if (!(amt > 0)) throw new Error('Enter an amount.');
    const rate = existing && existing.currency === fd.currency ? existing.rate : currentRate().rate;
    await store.save({
      ...(existing || { id: newId('inc'), type: 'income', kind: 'extra' }),
      memberId: fd.memberId, net: Math.round(amt * 100) / 100, currency: fd.currency, rate, source: fd.source, desc: fd.desc.trim(), date: fd.date,
    });
    closeSheet();
    toast(existing ? 'Saved' : 'Income added');
  });
}

function accountSheet(existing) {
  const ms = members();
  const f = existing || { name: '', kind: '401k', owner: cfg.meId, currency: 'USD' };
  openSheet(`
    ${sheetHead(existing ? 'Edit account' : 'New account')}
    <form id="f-acct">
      <label>Type<select name="kind">${Object.entries(ACCOUNT_KINDS).map(([k, [e, l]]) => `<option value="${k}" ${k === f.kind ? 'selected' : ''}>${e} ${l}</option>`).join('')}</select></label>
      <label>Name<input name="name" required value="${esc(f.name)}" placeholder="e.g. Fidelity 401k, Robinhood, SBI FD"></label>
      <div class="field"><span class="lbl">Belongs to</span>${seg('owner', [...ms.map(m => [m.id, m.name]), ['joint', 'Joint']], f.owner)}</div>
      <div class="field"><span class="lbl">Currency</span>${seg('currency', [['USD', '$ USD'], ['INR', '₹ INR']], f.currency)}</div>
      ${existing ? '' : `<label>Current balance (optional)<input name="balance" inputmode="decimal" placeholder="0.00"></label>`}
      <p class="err" id="err"></p>
      <button class="primary">${existing ? 'Save changes' : 'Add account'}</button>
      ${existing ? '<button type="button" class="danger" data-act="del-acct">Hide account</button>' : ''}
    </form>`);
  const form = document.getElementById('f-acct');
  if (!existing) form.kind.addEventListener('change', () => {
    form.querySelector(`input[name=currency][value=${form.kind.value === 'india' ? 'INR' : 'USD'}]`).checked = true;
  });
  form.querySelector('[data-act=del-acct]')?.addEventListener('click', async () => {
    if (!confirm('Hide this account? It stops counting toward net worth; its history is kept.')) return;
    await store.save({ ...existing, archived: true });
    closeSheet();
  });
  bindForm('f-acct', async fd => {
    const a = { ...(existing || { id: newId('acct'), type: 'account' }), name: fd.name.trim(), kind: fd.kind, owner: fd.owner, currency: fd.currency };
    const saves = [a];
    const b = parseNum(fd.balance);
    if (!existing && b > 0) saves.push({ id: newId('bal'), type: 'balance', accountId: a.id, date: M.todayISO(), amount: b, currency: a.currency, rate: currentRate().rate });
    await store.save(saves);
    closeSheet();
    toast(existing ? 'Saved' : 'Account added');
  });
}

function accountDetailSheet(a) {
  const hist = store.all('balance').filter(b => b.accountId === a.id).sort((x, y) => y.date.localeCompare(x.date) || y.ts - x.ts);
  openSheet(`
    ${sheetHead(`${ACCOUNT_KINDS[a.kind][0]} ${esc(a.name)}`)}
    <p class="muted">${esc(ACCOUNT_KINDS[a.kind][1])} · ${esc(ownerLabel(a.owner))} · ${a.currency}</p>
    <form id="f-bal">
      <h3>Update balance</h3>
      <div class="amount-row"><input name="amount" inputmode="decimal" placeholder="Current value" required aria-label="Balance">
        <span class="cur">${a.currency === 'INR' ? '₹ INR' : '$ USD'}</span></div>
      <label>As of<input type="date" name="date" value="${M.todayISO()}" required></label>
      <p class="err" id="err"></p>
      <button class="primary">Save balance</button>
    </form>
    <button class="secondary" data-act="contrib-to" data-id="${a.id}">＋ Add a contribution</button>
    <button class="ghost" data-act="edit-account" data-id="${a.id}">Edit account</button>
    ${hist.length ? `<h3>Balance history</h3><div class="list card">${hist.slice(0, 24).map(b => `
      <div class="row"><span class="row-main"><b>${moneyIn(b.amount, b.currency)}</b><small>${dateLabel(b.date)}</small></span>
        <button class="x" data-act="del-bal" data-id="${b.id}" aria-label="Delete balance">✕</button></div>`).join('')}</div>` : ''}`);
  bindForm('f-bal', async fd => {
    const amt = parseNum(fd.amount);
    if (!(amt >= 0) || fd.amount === '') throw new Error('Enter the balance.');
    await store.save({ id: newId('bal'), type: 'balance', accountId: a.id, date: fd.date, amount: Math.round(amt * 100) / 100, currency: a.currency, rate: currentRate().rate });
    closeSheet();
    toast('Balance updated');
  });
}

function contributionSheet(existing, accountId) {
  const ms = members();
  if (!accounts().length) {
    toast('Add an account first');
    return accountSheet();
  }
  const thisMonth = M.monthOf(M.todayISO());
  const first = store.get(accountId) || accounts().find(a => a.kind !== '401k') || accounts()[0];
  const f = existing || { accountId: first.id, memberId: first.owner, currency: first.currency, date: ui.month === thisMonth ? M.todayISO() : `${ui.month}-01`, amount: '', note: '' };
  openSheet(`
    ${sheetHead(existing ? 'Contribution' : 'Add to savings / investments')}
    <form id="f-contrib">
      <label>Account<select name="accountId">${accountOptions(f.accountId)}</select></label>
      <div class="amount-row">
        <input name="amount" inputmode="decimal" placeholder="0.00" required value="${f.amount}" aria-label="Amount">
        ${seg('currency', [['USD', '$ USD'], ['INR', '₹ INR']], f.currency)}
      </div>
      <div class="field"><span class="lbl">From whose money</span>${seg('memberId', [...ms.map(m => [m.id, m.name]), ['joint', 'Both 50/50']], f.memberId)}</div>
      <label>Date<input type="date" name="date" value="${f.date}" required></label>
      <label>Note<input name="note" value="${esc(f.note || '')}" placeholder="e.g. monthly SIP, bought VTI"></label>
      <p class="err" id="err"></p>
      <button class="primary">${existing ? 'Save changes' : 'Add'}</button>
      ${existing ? '<button type="button" class="danger" data-act="del-contrib">Delete</button>' : ''}
    </form>`);
  const form = document.getElementById('f-contrib');
  if (!existing) form.accountId.addEventListener('change', () => {
    const a = store.get(form.accountId.value);
    form.querySelector(`input[name=currency][value=${a.currency}]`).checked = true;
    form.querySelector(`input[name=memberId][value="${a.owner}"]`).checked = true;
  });
  form.querySelector('[data-act=del-contrib]')?.addEventListener('click', async () => {
    if (!confirm('Delete this contribution?')) return;
    await store.remove(existing);
    closeSheet();
  });
  bindForm('f-contrib', async fd => {
    const amt = parseNum(fd.amount);
    if (!(amt > 0)) throw new Error('Enter an amount.');
    const rate = existing && existing.currency === fd.currency ? existing.rate : currentRate().rate;
    await store.save({
      ...(existing || { id: newId('ctb'), type: 'contribution' }),
      accountId: fd.accountId, memberId: fd.memberId, amount: Math.round(amt * 100) / 100, currency: fd.currency, rate, date: fd.date, note: fd.note.trim(),
    });
    closeSheet();
    toast(existing ? 'Saved' : 'Added');
  });
}

function moneyMenu() {
  openSheet(`${sheetHead('Add')}
    <div class="list card">
      <button class="row" data-act="add-paycheck"><span class="emoji">💵</span><span class="row-main"><b>Paycheck</b><small>One paycheck, with the full breakdown</small></span></button>
      <button class="row" data-act="add-extra"><span class="emoji">✨</span><span class="row-main"><b>Extra income</b><small>Bonus, side gig, dividends, gifts…</small></span></button>
      <button class="row" data-act="add-contrib"><span class="emoji">📈</span><span class="row-main"><b>Add to savings / investments</b><small>Money moved to stocks, savings, India</small></span></button>
      <button class="row" data-act="pick-balance"><span class="emoji">🔄</span><span class="row-main"><b>Update a balance</b><small>What an account is worth now</small></span></button>
    </div>`);
}

function pickBalanceSheet() {
  if (!accounts().length) return accountSheet();
  openSheet(`${sheetHead('Which account?')}<div class="list card">${accounts().map(a =>
    `<button class="row" data-act="open-account" data-id="${a.id}"><span class="emoji">${ACCOUNT_KINDS[a.kind][0]}</span><span class="row-main"><b>${esc(a.name)}</b><small>${esc(ownerLabel(a.owner))}</small></span><span class="chev">›</span></button>`).join('')}
    <button class="row add" data-act="add-account">＋ Add account</button></div>`);
}

Object.assign(ACTIONS, {
  'money-menu': moneyMenu,
  'add-paycheck': () => paycheckSheet(),
  'add-extra': () => extraIncomeSheet(),
  'edit-income': d => { const i = store.get(d.id); i.kind === 'paycheck' ? paycheckSheet(i) : extraIncomeSheet(i); },
  'add-sched': () => paycheckSheet(null, { schedule: true }),
  'edit-sched': d => paycheckSheet(store.get(d.id), { schedule: true }),
  'add-account': () => accountSheet(),
  'edit-account': d => accountSheet(store.get(d.id)),
  'open-account': d => accountDetailSheet(store.get(d.id)),
  'pick-balance': pickBalanceSheet,
  'add-contrib': () => contributionSheet(),
  'contrib-to': d => contributionSheet(null, d.id),
  'edit-contrib': d => contributionSheet(store.get(d.id)),
  'del-bal': async (d, el) => {
    if (!confirm('Delete this balance entry?')) return;
    await store.remove(store.get(d.id));
    el.closest('.row').remove();
  },
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

boot();

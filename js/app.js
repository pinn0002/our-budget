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
  ['settle', '🤝', 'Settle up'],
  ['settings', '⚙️', 'Settings'],
];

function renderMain() {
  if (!rawBits || !me()) return;
  const scrollY = window.scrollY;
  const showMonth = ['home', 'activity', 'budgets'].includes(ui.tab);
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
    ${ui.tab !== 'settings' ? '<button class="fab" data-act="add-expense" aria-label="Add expense">＋</button>' : ''}
    <nav class="tabs">${TABS.map(([id, icon, label]) =>
      `<button data-act="tab" data-tab="${id}" class="${ui.tab === id ? 'on' : ''}"><span>${icon}</span>${label}</button>`).join('')}</nav>`;
  if (ui.tab === 'activity') wireActivity();
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

boot();

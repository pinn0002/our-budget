// Talks to your own Supabase project over its REST API.
// Supabase only ever receives: household id (random), record id, ciphertext, timestamp.

function headers(cfg, extra = {}) {
  const h = { apikey: cfg.key, 'x-household': cfg.household, 'Content-Type': 'application/json', ...extra };
  // Legacy anon keys are JWTs and go in Authorization too; new publishable keys must not.
  if (!cfg.key.startsWith('sb_')) h.Authorization = 'Bearer ' + cfg.key;
  return h;
}

// Accepts "https://x.supabase.co", ".../rest/v1/", or the dashboard link ".../project/<ref>".
export function normalizeUrl(input) {
  const s = String(input || '').trim();
  const dash = s.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1]}.supabase.co`;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { throw new Error("That Project URL doesn't look right. It should be like https://abcd.supabase.co"); }
  return u.origin;
}

function base(cfg) {
  return normalizeUrl(cfg.url) + '/rest/v1/records';
}

async function check(res) {
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); msg = j.message || j.hint || msg; } catch {}
    throw new Error('Sync error: ' + msg);
  }
  return res;
}

export async function testConnection(cfg) {
  await check(await fetch(base(cfg) + '?select=id&limit=1', { headers: headers(cfg) }));
}

export async function pushRows(cfg, rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const body = rows.slice(i, i + 200).map(r => ({ household: cfg.household, id: r.id, data: r.data, client_ts: r.ts }));
    await check(await fetch(base(cfg) + '?on_conflict=household,id', {
      method: 'POST',
      headers: headers(cfg, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(body),
    }));
  }
}

// Returns { rows, cursor }. `since` is an ISO timestamp or null for everything.
export async function pullRows(cfg, since) {
  const out = [];
  let cursor = since;
  for (;;) {
    let q = '?select=id,data,client_ts,server_ts&order=server_ts.asc&limit=1000';
    if (cursor) q += '&server_ts=gt.' + encodeURIComponent(cursor);
    const res = await check(await fetch(base(cfg) + q, { headers: headers(cfg) }));
    const batch = await res.json();
    out.push(...batch);
    if (batch.length) cursor = batch[batch.length - 1].server_ts;
    if (batch.length < 1000) break;
  }
  return { rows: out.map(r => ({ id: r.id, data: r.data, ts: Number(r.client_ts) })), cursor };
}

// In-memory decrypted records + encrypted persistence and sync.
// Decrypted data exists only in memory while the app is unlocked.

import { seal, open } from './crypto.js';
import { getAllRows, putRows, getRow } from './db.js';
import { pushRows, pullRows } from './sync.js';

let key = null;
let syncCfg = null; // { url, key, household } or null for local-only
const records = new Map();
const knownIds = new Set(); // every id ever seen, including deleted
const listeners = new Set();
let syncing = null;
let syncState = { status: 'idle', error: null, last: null };

const CURSOR_KEY = 'ob.cursor';

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach(fn => fn());

export const getSyncState = () => syncState;

export async function init(aesKey, cfg) {
  key = aesKey;
  syncCfg = cfg;
  records.clear();
  knownIds.clear();
  const rows = await getAllRows();
  for (const row of rows) await absorb(row);
}

export function lock() {
  key = null;
  records.clear();
  knownIds.clear();
}

export function setSyncConfig(cfg) { syncCfg = cfg; }

async function absorb(row) {
  knownIds.add(row.id);
  try {
    const obj = await open(key, row.data, row.id);
    if (obj.deleted) records.delete(row.id); else records.set(row.id, obj);
  } catch {
    console.warn('Could not decrypt record', row.id);
  }
}

export const exists = id => knownIds.has(id);
export const get = id => records.get(id);
export const all = type => [...records.values()].filter(r => r.type === type);

export async function save(objs) {
  const list = Array.isArray(objs) ? objs : [objs];
  const rows = [];
  const ts = Date.now();
  for (const { _ts, ...o } of list) {
    const rec = { ...o, ts: _ts ?? ts };
    rows.push({ id: rec.id, data: await seal(key, rec, rec.id), ts: rec.ts, dirty: 1 });
    knownIds.add(rec.id);
    if (rec.deleted) records.delete(rec.id); else records.set(rec.id, rec);
  }
  await putRows(rows);
  emit();
  scheduleSync();
}

export function remove(obj) {
  // Soft delete: a tombstone syncs to the other phone.
  return save({ id: obj.id, type: obj.type, deleted: true });
}

// Merge rows from the server or a backup file. Newer client timestamp wins.
export async function mergeRows(incoming) {
  const toPut = [];
  for (const r of incoming) {
    const local = await getRow(r.id);
    if (local && local.ts > r.ts) continue;
    if (local && local.ts === r.ts && local.data === r.data) { knownIds.add(r.id); continue; }
    // Verify it decrypts before accepting it.
    try { await open(key, r.data, r.id); } catch { continue; }
    toPut.push({ id: r.id, data: r.data, ts: r.ts, dirty: 0 });
  }
  if (toPut.length) {
    await putRows(toPut);
    for (const row of toPut) await absorb(row);
    emit();
  }
  return toPut.length;
}

let timer;
function scheduleSync() {
  if (!syncCfg) return;
  clearTimeout(timer);
  timer = setTimeout(() => sync().catch(() => {}), 800);
}

export function sync() {
  if (!syncCfg || !key) return Promise.resolve();
  if (syncing) return syncing;
  syncState = { ...syncState, status: 'syncing', error: null };
  emit();
  syncing = (async () => {
    try {
      const dirty = (await getAllRows()).filter(r => r.dirty);
      if (dirty.length) {
        await pushRows(syncCfg, dirty);
        // Only clear the flag on rows that haven't changed again since we read them.
        const fresh = [];
        for (const r of dirty) {
          const now = await getRow(r.id);
          if (now && now.ts === r.ts) fresh.push({ ...now, dirty: 0 });
        }
        await putRows(fresh);
      }
      // Re-read a 10-minute overlap so rows committed slightly out of order aren't missed.
      const since = localStorage.getItem(CURSOR_KEY);
      const overlap = since ? new Date(new Date(since).getTime() - 10 * 60 * 1000).toISOString() : null;
      const { rows, cursor } = await pullRows(syncCfg, overlap);
      await mergeRows(rows);
      if (cursor) localStorage.setItem(CURSOR_KEY, cursor);
      syncState = { status: 'ok', error: null, last: Date.now() };
    } catch (e) {
      syncState = { ...syncState, status: navigator.onLine ? 'error' : 'offline', error: e.message };
      throw e;
    } finally {
      syncing = null;
      emit();
    }
  })();
  return syncing;
}

export async function markAllDirty() {
  const rows = await getAllRows();
  await putRows(rows.map(r => ({ ...r, dirty: 1 })));
}

export async function exportRows() {
  return (await getAllRows()).map(({ id, data, ts }) => ({ id, data, ts }));
}

export function resetCursor() { localStorage.removeItem(CURSOR_KEY); }

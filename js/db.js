// Local cache in IndexedDB. Rows are stored exactly as synced: encrypted.
// row = { id, data (ciphertext), ts (client modified ms), dirty (needs upload) }

const DB_NAME = 'our-budget';
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('rows', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction('rows', mode);
    const result = fn(t.objectStore('rows'));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export const getAllRows = () => tx('readonly', s => s.getAll());
export const getRow = id => tx('readonly', s => s.get(id));
export const putRows = rows => tx('readwrite', s => { rows.forEach(r => s.put(r)); });
export const clearRows = () => tx('readwrite', s => { s.clear(); });

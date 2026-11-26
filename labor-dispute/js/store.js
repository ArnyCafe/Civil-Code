// 本機儲存：IndexedDB（失敗時退回 localStorage，再不行則僅存在記憶體）
const DB_NAME = 'labor-dispute-notes';
const STORE = 'kv';
let dbp = null;
let mode = 'idb';
const mem = new Map();
const LS_PREFIX = 'ldn:';

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  }).catch((e) => {
    try { localStorage.setItem(LS_PREFIX + '_t', '1'); mode = 'ls'; } catch { mode = 'mem'; }
    console.warn('IndexedDB 無法使用，改用', mode, e);
    return null;
  });
  return dbp;
}

function tx(db, kind) { return db.transaction(STORE, kind).objectStore(STORE); }
function wrap(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

export async function getAll() {
  const db = await openDB();
  const out = {};
  if (db) {
    const store = tx(db, 'readonly');
    const [keys, vals] = await Promise.all([wrap(store.getAllKeys()), wrap(store.getAll())]);
    keys.forEach((k, i) => { out[k] = vals[i]; });
    return out;
  }
  if (mode === 'ls') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(LS_PREFIX) && k !== LS_PREFIX + '_t') out[k.slice(LS_PREFIX.length)] = JSON.parse(localStorage.getItem(k));
      }
    } catch {}
    return out;
  }
  mem.forEach((v, k) => { out[k] = v; });
  return out;
}

export async function put(key, value) {
  const db = await openDB();
  if (db) return wrap(tx(db, 'readwrite').put(value, key));
  if (mode === 'ls') { try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); return; } catch (e) { mode = 'mem'; } }
  mem.set(key, value);
}

export async function del(key) {
  const db = await openDB();
  if (db) return wrap(tx(db, 'readwrite').delete(key));
  if (mode === 'ls') { try { localStorage.removeItem(LS_PREFIX + key); } catch {} return; }
  mem.delete(key);
}

export async function clearAll() {
  const db = await openDB();
  if (db) return wrap(tx(db, 'readwrite').clear());
  if (mode === 'ls') { try { Object.keys(localStorage).filter((k) => k.startsWith(LS_PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch {} return; }
  mem.clear();
}

export function storageMode() { return mode; }

export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      return already || await navigator.storage.persist();
    }
  } catch {}
  return false;
}

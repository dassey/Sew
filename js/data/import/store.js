const DB_NAME = 'skyline-forge';
const STORE = 'imports';
const VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function transact(mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const request = work(store);
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export async function saveDataset(dataset) {
  try {
    await transact('readwrite', (store) => store.put(dataset));
    return true;
  } catch {
    return false;
  }
}

export async function loadDatasets() {
  try {
    const all = await transact('readonly', (store) => store.getAll());
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

export async function deleteDataset(id) {
  try {
    await transact('readwrite', (store) => store.delete(id));
    return true;
  } catch {
    return false;
  }
}

export async function clearDatasets() {
  try {
    await transact('readwrite', (store) => store.clear());
    return true;
  } catch {
    return false;
  }
}

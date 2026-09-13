/** Device-only storage. Audio and metadata publish in one IndexedDB transaction. */
export const DB_NAME = 'epub-reader-device';
const stores = ['downloads', 'audio', 'progress', 'positions', 'download_batches'] as const;
export type StoreName = typeof stores[number];
export function openDeviceDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Device storage is unavailable in this browser.')); return; }
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => { for (const name of stores) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other reader tabs to open device storage.'));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}
export async function transaction<T>(names: StoreName[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDeviceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode); let value: T;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error?.message ? tx.error : new Error('Device storage transaction failed. Free storage or check browser permissions, then retry.')); };
    try { run(tx, (next) => { value = next; }); } catch (error) { tx.abort(); reject(error); }
  });
}
export function get<T>(name: StoreName, key: string): Promise<T | undefined> {
  return transaction([name], 'readonly', (tx, done) => { tx.objectStore(name).get(key).onsuccess = (e) => done((e.target as IDBRequest).result); });
}
export function all<T>(name: StoreName): Promise<T[]> {
  return transaction([name], 'readonly', (tx, done) => { tx.objectStore(name).getAll().onsuccess = (e) => done((e.target as IDBRequest).result); });
}
export function change<T>(name: StoreName, key: string, update: (old: T | undefined) => T): Promise<T> {
  return transaction([name], 'readwrite', (tx, done) => {
    const store = tx.objectStore(name);
    store.get(key).onsuccess = (e) => { const value = update((e.target as IDBRequest).result); store.put(value, key); done(value); };
  });
}
export function deviceChanged() { window.dispatchEvent(new Event('device-library-change')); }

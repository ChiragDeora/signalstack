/**
 * IndexedDB persistence for active monitoring list.
 * Survives refresh and allows re-registering with the server on load.
 */

const DB_NAME = 'signalstack-db';
const STORE = 'monitored';
const DB_VERSION = 1;

export interface MonitoredWatch {
  symbol: string;
  timeframe: string;
  emaPeriods: number[];
  trackBullish: boolean;
  trackBearish: boolean;
  exchange: string;
  currency: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'userId' });
      }
    };
  });
}

/** Get all monitored watches for a user (keyed by userId). */
export async function getMonitoredWatches(userId: string): Promise<MonitoredWatch[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.get(userId);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const row = req.result;
      resolve(Array.isArray(row?.watches) ? row.watches : []);
    };
    db.close();
  });
}

/** Replace the full list of monitored watches for a user. */
export async function setMonitoredWatches(userId: string, watches: MonitoredWatch[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (watches.length === 0) {
      store.delete(userId);
    } else {
      store.put({ userId, watches });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    db.close();
  });
}

/** Add one watch; merge with existing list (avoid duplicate symbol+timeframe). */
export async function addMonitoredWatch(userId: string, watch: MonitoredWatch): Promise<void> {
  const list = await getMonitoredWatches(userId);
  const key = (w: MonitoredWatch) => `${w.symbol}:${w.timeframe}`;
  const newKey = key(watch);
  const next = list.filter((w) => key(w) !== newKey);
  next.push(watch);
  await setMonitoredWatches(userId, next);
}

/** Remove one watch by symbol and timeframe. */
export async function removeMonitoredWatch(userId: string, symbol: string, timeframe: string): Promise<void> {
  const list = await getMonitoredWatches(userId);
  const next = list.filter((w) => w.symbol !== symbol || w.timeframe !== timeframe);
  await setMonitoredWatches(userId, next);
}

/** Remove all monitored watches for a user. */
export async function clearMonitoredWatches(userId: string): Promise<void> {
  await setMonitoredWatches(userId, []);
}
